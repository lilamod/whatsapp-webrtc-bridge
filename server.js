'use strict';



require('dotenv').config();

const express    = require('express');
const fetch      = require('node-fetch');
const fs         = require('fs');
const path       = require('path');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// Use bundled ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

const {
    RTCPeerConnection,
    MediaStream,
    nonstandard: { RTCAudioSource },
} = require('@roamhq/wrtc');

// ── Configuration ─────────────────────────────────────────────────────
const PORT         = process.env.PORT          || 3500;
const TURN_SERVER  = process.env.TURN_SERVER   || '217.216.79.253';
const TURN_PORT    = process.env.TURN_PORT     || '3478';
const TURN_USER    = process.env.TURN_USERNAME || 'x6yt76';
const TURN_PASS    = process.env.TURN_PASSWORD || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN  || 'whinta_bridge_secret_2024';

// ── Express setup ─────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

// Auth middleware — all requests except /health require token
app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const token = req.headers['x-bridge-token'] || req.body?.token;
    if (token !== BRIDGE_TOKEN) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
});

// Active calls: callId → { pc, audioSource, status }
const activeCalls = new Map();

// ── Routes ────────────────────────────────────────────────────────────

/**
 * GET /health
 * Laravel can ping this to verify bridge is running
 */
app.get('/health', (req, res) => {
    res.json({
        status:       'ok',
        active_calls: activeCalls.size,
        node_version: process.version,
        turn_server:  `${TURN_SERVER}:${TURN_PORT}`,
        uptime_secs:  Math.floor(process.uptime()),
    });
});

/**
 * POST /bridge
 * Called by Laravel after pre_accept succeeds.
 * 
 * Request body:
 *   call_id   - WhatsApp call ID
 *   sdp_offer - Caller's SDP offer from webhook
 *   audio_url - URL of TTS MP3 to play when connected
 *   token     - Auth token (or use x-bridge-token header)
 * 
 * Response:
 *   success    - true/false
 *   sdp_answer - SDP answer to send to Meta accept API
 */
app.post('/bridge', async (req, res) => {
    const { call_id, sdp_offer, audio_url } = req.body;

    if (!call_id || !sdp_offer) {
        return res.status(400).json({ success: false, error: 'Missing call_id or sdp_offer' });
    }

    log(call_id, `Bridge request | audio=${audio_url ? 'yes' : 'no'}`);

    try {
        const { sdpAnswer } = await createWebRTCBridge(call_id, sdp_offer, audio_url);
        log(call_id, `SDP answer ready (${sdpAnswer.length} bytes)`);
        res.json({ success: true, sdp_answer: sdpAnswer });
    } catch (err) {
        logError(call_id, 'Bridge failed: ' + err.message);
        cleanupCall(call_id);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /end
 * Called by Laravel when call terminates.
 */
app.post('/end', (req, res) => {
    const { call_id } = req.body;
    cleanupCall(call_id);
    res.json({ success: true });
});

/**
 * GET /calls
 * Debug: list active calls
 */
app.get('/calls', (req, res) => {
    const calls = [];
    activeCalls.forEach((v, k) => calls.push({ call_id: k, status: v.status }));
    res.json({ count: calls.length, calls });
});

// ── WebRTC Bridge Core ────────────────────────────────────────────────

async function createWebRTCBridge(callId, sdpOffer, audioUrl) {
    // ICE servers — STUN + Coturn TURN
    const iceServers = [
        {
            urls: 'stun:stun.l.google.com:19302',
        },
        {
            urls:       `turn:${TURN_SERVER}:${TURN_PORT}`,
            username:   TURN_USER,
            credential: TURN_PASS,
        },
        {
            urls:       `turn:${TURN_SERVER}:${TURN_PORT}?transport=udp`,
            username:   TURN_USER,
            credential: TURN_PASS,
        },
        {
            urls:       `turn:${TURN_SERVER}:${TURN_PORT}?transport=tcp`,
            username:   TURN_USER,
            credential: TURN_PASS,
        },
    ];

    log(callId, `Creating RTCPeerConnection (TURN: ${TURN_SERVER}:${TURN_PORT})`);

    const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'all', // try direct first, fallback to TURN
    });

    // Audio source — we'll push PCM frames here to send to caller
    const audioSource = new RTCAudioSource();
    const audioTrack  = audioSource.createTrack();
    const stream      = new MediaStream([audioTrack]);
    pc.addTrack(audioTrack, stream);

    // Store call state
    activeCalls.set(callId, {
        pc,
        audioSource,
        audioTrack,
        status:    'connecting',
        audioUrl,
        startTime: Date.now(),
    });

    // Handle incoming audio from WhatsApp caller (we receive but don't process it)
    pc.ontrack = (event) => {
        log(callId, `Received audio track from WhatsApp caller`);
    };

    // Clean offer SDP (mirrors CallWidget.vue cleanSdp)
    const cleanedSdp = cleanSdp(sdpOffer);
    log(callId, `Setting remote description...`);

    // Set Meta's SDP offer
    await pc.setRemoteDescription({ type: 'offer', sdp: cleanedSdp });

    // Generate our SDP answer
    log(callId, `Creating SDP answer...`);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Wait for ICE gathering
    log(callId, `Gathering ICE candidates...`);
    await waitForIceGathering(pc);

    // Fix setup direction: active → passive (Meta requires passive)
    let finalSdp = pc.localDescription.sdp;
    finalSdp = finalSdp.replace(/a=setup:active/g, 'a=setup:passive');

    // Monitor ICE connection state
    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        log(callId, `ICE state → ${state}`);

        const call = activeCalls.get(callId);
        if (call) call.status = state;

        if (state === 'connected' || state === 'completed') {
            log(callId, `🎉 WebRTC CONNECTED via Coturn TURN!`);
            const url = call?.audioUrl || audioUrl;
            if (url) {
                // Small delay to let connection stabilize before streaming
                setTimeout(() => streamTtsToCall(callId, url, audioSource), 800);
            } else {
                log(callId, `No audio URL — call connected but silent`);
            }
        }

        if (state === 'failed') {
            logError(callId, 'ICE failed — check TURN credentials');
            setTimeout(() => cleanupCall(callId), 3000);
        }

        if (state === 'disconnected' || state === 'closed') {
            setTimeout(() => cleanupCall(callId), 2000);
        }
    };

    pc.onicecandidateerror = (e) => {
        // Non-fatal, just log
        if (e.errorCode !== 701) { // 701 = STUN binding error (normal)
            log(callId, `ICE candidate error: ${e.errorCode} ${e.errorText}`);
        }
    };

    return { sdpAnswer: finalSdp };
}

// ── TTS Audio Streaming ───────────────────────────────────────────────

async function streamTtsToCall(callId, audioUrl, audioSource) {
    const tmpFile = `/tmp/tts_bridge_${callId}_${Date.now()}.mp3`;

    try {
        log(callId, `Downloading TTS: ${audioUrl}`);

        const response = await fetch(audioUrl, { timeout: 15000 });
        if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

        const audioBuffer = await response.buffer();
        fs.writeFileSync(tmpFile, audioBuffer);

        log(callId, `TTS downloaded: ${audioBuffer.length} bytes`);

        // Convert MP3 to PCM and stream frame by frame to WebRTC
        await streamPcmFrames(callId, tmpFile, audioSource);

        log(callId, `✅ TTS playback complete`);

    } catch (err) {
        logError(callId, 'TTS stream error: ' + err.message);
    } finally {
        try {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        } catch(e) {}
    }
}

function streamPcmFrames(callId, mp3File, audioSource) {
    return new Promise((resolve, reject) => {
        /**
         * WhatsApp Calling uses 8kHz mono 16-bit PCM audio.
         * We send 10ms frames = 80 samples = 160 bytes per frame.
         */
        const SAMPLE_RATE       = 8000;
        const CHANNELS          = 1;
        const FRAME_DURATION_MS = 10;
        const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 80
        const BYTES_PER_FRAME   = SAMPLES_PER_FRAME * 2; // 16-bit = 2 bytes/sample = 160

        let pcmBuffer    = Buffer.alloc(0);
        let streamOffset = 0;
        let isStreaming  = false;
        let frameTimer;
        let decodeEnded  = false;

        const startStreaming = () => {
            if (isStreaming) return;
            isStreaming = true;
            log(callId, `Streaming PCM to caller (${SAMPLE_RATE}Hz mono 16-bit)...`);

            frameTimer = setInterval(() => {
                // Stop if call ended
                if (!activeCalls.has(callId)) {
                    clearInterval(frameTimer);
                    return resolve();
                }

                // Wait if not enough data yet
                if (streamOffset + BYTES_PER_FRAME > pcmBuffer.length) {
                    // If decode is done and we've streamed everything, finish
                    if (decodeEnded) {
                        clearInterval(frameTimer);
                        log(callId, `PCM stream finished`);
                        return resolve();
                    }
                    return; // wait for more data
                }

                // Extract 10ms PCM frame
                const frameSlice = pcmBuffer.slice(streamOffset, streamOffset + BYTES_PER_FRAME);
                streamOffset += BYTES_PER_FRAME;

                // Push to WebRTC audio source
                try {
                    audioSource.onData({
                        samples:        new Int16Array(
                                            frameSlice.buffer,
                                            frameSlice.byteOffset,
                                            SAMPLES_PER_FRAME
                                        ),
                        sampleRate:     SAMPLE_RATE,
                        bitsPerSample:  16,
                        channelCount:   CHANNELS,
                        numberOfFrames: SAMPLES_PER_FRAME,
                    });
                } catch (e) {
                    // Call may have ended
                    clearInterval(frameTimer);
                    resolve();
                }
            }, FRAME_DURATION_MS);
        };

        // Use ffmpeg to decode MP3 → raw PCM
        ffmpeg(mp3File)
            .audioFrequency(SAMPLE_RATE)
            .audioChannels(CHANNELS)
            .audioCodec('pcm_s16le')
            .format('s16le')
            .on('start', (cmd) => {
                log(callId, `ffmpeg decoding MP3...`);
            })
            .on('error', (err) => {
                logError(callId, 'ffmpeg error: ' + err.message);
                clearInterval(frameTimer);
                reject(err);
            })
            .pipe()
            .on('data', (chunk) => {
                pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

                // Start streaming once we have at least 500ms of audio buffered
                if (!isStreaming && pcmBuffer.length >= BYTES_PER_FRAME * 50) {
                    startStreaming();
                }
            })
            .on('end', () => {
                decodeEnded = true;
                const durationSecs = Math.floor((pcmBuffer.length / BYTES_PER_FRAME) * FRAME_DURATION_MS / 1000);
                log(callId, `MP3 decoded: ${pcmBuffer.length} bytes = ~${durationSecs}s audio`);

                // Start streaming if not started yet
                if (!isStreaming) startStreaming();
            });
    });
}

// ── SDP Utilities ─────────────────────────────────────────────────────

/**
 * Clean SDP — mirrors CallWidget.vue cleanSdp() exactly
 */
function cleanSdp(sdp) {
    const normalized = sdp.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    return normalized
        .split('\n')
        .map(line => {
            const l = line.trim();
            // Remove duplicate codecs from m=audio line
            if (l.startsWith('m=audio')) {
                const parts = l.split(' ');
                const uniqueCodecs = [...new Set(parts.slice(4))];
                return parts.slice(0, 4).join(' ') + ' ' + uniqueCodecs.join(' ');
            }
            return l;
        })
        .filter(line => {
            const l = line.trim();
            if (!l) return false;
            return (
                l.startsWith('v=')               ||
                l.startsWith('o=')               ||
                l.startsWith('s=')               ||
                l.startsWith('t=')               ||
                l.startsWith('m=')               ||
                l.startsWith('c=')               ||
                l.startsWith('b=')               ||
                l.startsWith('a=group:')         ||
                l.startsWith('a=msid-semantic:') ||
                l.startsWith('a=ice-lite')       ||
                l.startsWith('a=ice-ufrag:')     ||
                l.startsWith('a=ice-pwd:')       ||
                l.startsWith('a=fingerprint:')   ||
                l.startsWith('a=setup:')         ||
                l.startsWith('a=mid:')           ||
                l.startsWith('a=sendrecv')       ||
                l.startsWith('a=rtcp-mux')       ||
                l.startsWith('a=rtpmap:111')     ||
                l.startsWith('a=candidate:')     ||
                l.startsWith('a=rtcp:')
            );
        })
        .join('\r\n') + '\r\n';
}

/**
 * Wait for ICE gathering to complete (max 5 seconds)
 */
function waitForIceGathering(pc) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();

        const onStateChange = () => {
            if (pc.iceGatheringState === 'complete') {
                pc.removeEventListener('icegatheringstatechange', onStateChange);
                resolve();
            }
        };

        pc.addEventListener('icegatheringstatechange', onStateChange);
        // 5 second timeout fallback
        setTimeout(() => {
            pc.removeEventListener('icegatheringstatechange', onStateChange);
            resolve();
        }, 5000);
    });
}

// ── Call Management ───────────────────────────────────────────────────

function cleanupCall(callId) {
    const call = activeCalls.get(callId);
    if (call) {
        try { call.pc.close(); } catch(e) {}
        activeCalls.delete(callId);
        log(callId, `Cleaned up`);
    }
}

// ── Logging ───────────────────────────────────────────────────────────

function log(callId, msg) {
    const id = callId ? callId.slice(-12) : '??';
    console.log(`[${new Date().toISOString()}] [${id}] ${msg}`);
}

function logError(callId, msg) {
    const id = callId ? callId.slice(-12) : '??';
    console.error(`[${new Date().toISOString()}] [${id}] ❌ ${msg}`);
}

// ── Start Server ──────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('  WhatsApp Calling AI — WebRTC Audio Bridge');
    console.log('═══════════════════════════════════════════════');
    console.log(`  Port:         ${PORT}`);
    console.log(`  TURN Server:  ${TURN_SERVER}:${TURN_PORT}`);
    console.log(`  TURN User:    ${TURN_USER}`);
    console.log(`  Node.js:      ${process.version}`);
    console.log(`  ffmpeg:       ${ffmpegPath}`);
    console.log('═══════════════════════════════════════════════');
    console.log('');
    console.log(`  Health:  GET  http://localhost:${PORT}/health`);
    console.log(`  Bridge:  POST http://localhost:${PORT}/bridge`);
    console.log(`  End:     POST http://localhost:${PORT}/end`);
    console.log('');
});

// Graceful error handling
process.on('uncaughtException', (err) => {
    console.error(`[FATAL] Uncaught exception: ${err.message}`);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error(`[FATAL] Unhandled rejection: ${reason}`);
});
