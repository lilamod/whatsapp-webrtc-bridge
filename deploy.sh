#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  WhatsApp WebRTC Bridge — Ubuntu 22.04 Deploy Script
#  Run as root on your VPS: bash deploy.sh
# ═══════════════════════════════════════════════════════════

set -e

echo ""
echo "═══════════════════════════════════════════════"
echo "  WhatsApp WebRTC Bridge — Deploy Script"
echo "═══════════════════════════════════════════════"
echo ""

# 1. Update system
echo "[1/6] Updating system..."
apt-get update -qq

# 2. Install Node.js 18
echo "[2/6] Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# 3. Install ffmpeg
echo "[3/6] Installing ffmpeg..."
apt-get install -y ffmpeg

# 4. Create app directory
echo "[4/6] Setting up app directory..."
mkdir -p /opt/whatsapp-webrtc
cd /opt/whatsapp-webrtc

# 5. Install dependencies
echo "[5/6] Installing Node.js dependencies..."
npm install

# 6. Install PM2
echo "[6/6] Installing PM2 process manager..."
npm install -g pm2

echo ""
echo "═══════════════════════════════════════════════"
echo "  Installation complete!"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Copy your files to /opt/whatsapp-webrtc/"
echo "     - server.js"
echo "     - package.json"
echo "     - .env  (copy from .env.example and fill in)"
echo ""
echo "  2. Start the server:"
echo "     cd /opt/whatsapp-webrtc"
echo "     pm2 start server.js --name whatsapp-webrtc"
echo "     pm2 save"
echo "     pm2 startup  (follow the printed command)"
echo ""
echo "  3. Test it:"
echo "     curl http://localhost:3500/health"
echo ""
echo "  4. Add to Laravel .env on cPanel:"
echo "     WEBRTC_BRIDGE_URL=http://YOUR_VPS_IP:3500"
echo "     WEBRTC_BRIDGE_TOKEN=whinta_bridge_secret_2024"
echo ""
