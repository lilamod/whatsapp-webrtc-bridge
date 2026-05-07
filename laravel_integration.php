<?php

/**
 * ═══════════════════════════════════════════════════════════
 *  Laravel Integration — WebRTC Bridge
 *  
 *  Add these changes to your ProcessCallWebhook.php
 *  to make calls use the Node.js WebRTC bridge.
 * ═══════════════════════════════════════════════════════════
 */

// ── Step 1: Add to .env on cPanel ────────────────────────────────────
/*
WEBRTC_BRIDGE_URL=http://YOUR_VPS_IP:3500
WEBRTC_BRIDGE_TOKEN=whinta_bridge_secret_2024
*/

// ── Step 2: Add to modules/WhatsAppCalling/config/whatsappcalling.php ─
/*
'webrtc_bridge_url'   => env('WEBRTC_BRIDGE_URL', ''),
'webrtc_bridge_token' => env('WEBRTC_BRIDGE_TOKEN', 'whinta_bridge_secret_2024'),
*/

// ── Step 3: Replace handleAiCall() in ProcessCallWebhook.php ─────────
/*
Replace the current handleAiCall() method with this version:
*/

// private function handleAiCall(
//     string $callId,
//     string $from,
//     string $sdpOffer,
//     string $accessToken,
//     string $phoneNumId,
//     WhatsAppCallingService $service,
// ): void {
//     Log::info('WhatsAppCalling AI auto-answer START', ['call_id' => $callId]);
// 
//     try {
//         // Step 1: pre_accept (send generated SDP answer)
//         $preAccept = $service->preAcceptCall($callId, $accessToken, $phoneNumId, $sdpOffer);
//         Log::info('WhatsAppCalling pre_accept result', [
//             'call_id' => $callId, 'success' => $preAccept['success'],
//         ]);
// 
//         if (!$preAccept['success']) {
//             Log::error('WhatsAppCalling pre_accept FAILED', ['call_id' => $callId]);
//             return;
//         }
// 
//         usleep(300000); // 300ms
// 
//         // Step 2: Check if WebRTC bridge is configured
//         $bridgeUrl   = config('whatsappcalling.webrtc_bridge_url');
//         $bridgeToken = config('whatsappcalling.webrtc_bridge_token');
// 
//         if ($bridgeUrl) {
//             // ── WITH WebRTC Bridge (AI voice) ─────────────────────
//             Log::info('WhatsAppCalling using WebRTC bridge', [
//                 'call_id' => $callId, 'bridge' => $bridgeUrl,
//             ]);
// 
//             // Generate TTS greeting first
//             $org      = \App\Models\Organization::find($this->organizationId);
//             $meta     = is_string($org?->metadata) ? json_decode($org->metadata, true) : ($org?->metadata ?? []);
//             $orgName  = $meta['name'] ?? $org?->name ?? 'our company';
//             $greeting = "Hello! Thank you for calling {$orgName}. How can I help you today?";
// 
//             $audioPath = $this->ttsElevenLabs($greeting);
//             $audioUrl  = null;
// 
//             if ($audioPath && file_exists($audioPath)) {
//                 $filename = 'tts/greeting_' . $callId . '_' . time() . '.mp3';
//                 \Illuminate\Support\Facades\Storage::disk('public')->put($filename, file_get_contents($audioPath));
//                 $audioUrl = \Illuminate\Support\Facades\Storage::disk('public')->url($filename);
//                 @unlink($audioPath);
//                 Log::info('WhatsAppCalling TTS ready', ['call_id' => $callId, 'url' => $audioUrl]);
//             }
// 
//             // Call Node.js bridge — it creates WebRTC connection and returns SDP answer
//             $bridgeResponse = \Illuminate\Support\Facades\Http::timeout(15)
//                 ->withHeaders(['x-bridge-token' => $bridgeToken])
//                 ->post("{$bridgeUrl}/bridge", [
//                     'call_id'   => $callId,
//                     'sdp_offer' => $sdpOffer,
//                     'audio_url' => $audioUrl,
//                 ]);
// 
//             if (!$bridgeResponse->successful() || !$bridgeResponse->json('success')) {
//                 Log::error('WhatsAppCalling WebRTC bridge failed', [
//                     'call_id' => $callId,
//                     'status'  => $bridgeResponse->status(),
//                     'body'    => $bridgeResponse->body(),
//                 ]);
//                 return;
//             }
// 
//             $sdpAnswer = $bridgeResponse->json('sdp_answer');
//             Log::info('WhatsAppCalling bridge SDP answer received', [
//                 'call_id' => $callId, 'sdp_len' => strlen($sdpAnswer),
//             ]);
// 
//         } else {
//             // ── WITHOUT WebRTC Bridge (silent answer) ─────────────
//             Log::info('WhatsAppCalling no bridge configured, using generated SDP', ['call_id' => $callId]);
//             $sdpAnswer = $preAccept['generated_sdp'] ?? $sdpOffer;
//         }
// 
//         // Step 3: Accept call with SDP answer
//         $accept = $service->acceptCall($callId, $sdpAnswer, $accessToken, $phoneNumId);
//         Log::info('WhatsAppCalling acceptCall result', [
//             'call_id' => $callId, 'success' => $accept['success'],
//         ]);
// 
//         if (!$accept['success']) {
//             Log::error('WhatsAppCalling acceptCall FAILED', ['call_id' => $callId]);
//             // Tell bridge to cleanup
//             if ($bridgeUrl ?? false) {
//                 \Illuminate\Support\Facades\Http::timeout(5)
//                     ->withHeaders(['x-bridge-token' => $bridgeToken])
//                     ->post("{$bridgeUrl}/end", ['call_id' => $callId]);
//             }
//             return;
//         }
// 
//         // Update DB
//         $waCall = \Modules\WhatsAppCalling\Models\WaCall::where('call_id', $callId)->first();
//         if ($waCall) {
//             $waCall->update([
//                 'status'      => 'answered',
//                 'agent_id'    => null,
//                 'sdp_answer'  => $sdpAnswer,
//                 'answered_at' => now(),
//             ]);
//         }
// 
//         Log::info('WhatsAppCalling AI call answered ✅', ['call_id' => $callId]);
// 
//         event(new \Modules\WhatsAppCalling\Events\CallStatusUpdated(
//             callId:         $callId,
//             status:         'ai_answering',
//             organizationId: $this->organizationId,
//         ));
// 
//         // If no bridge, send greeting normally
//         if (!($bridgeUrl ?? false)) {
//             $this->sendAiGreeting($callId, $from);
//         }
// 
//     } catch (\Exception $e) {
//         Log::error('WhatsAppCalling handleAiCall ERROR: ' . $e->getMessage(), [
//             'call_id' => $callId, 'trace' => $e->getTraceAsString(),
//         ]);
//     }
// }
