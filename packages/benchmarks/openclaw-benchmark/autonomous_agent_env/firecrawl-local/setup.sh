#!/usr/bin/env bash
# Firecrawl Self-Hosted Setup (ohne Docker, mit Nix)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/.firecrawl-data"

# Erstelle Verzeichnisse
mkdir -p "$DATA_DIR"/{redis,postgres}

# Clone Firecrawl wenn nicht vorhanden
if [ ! -d "$SCRIPT_DIR/firecrawl-src" ]; then
    echo "📥 Klone Firecrawl Repository..."
    git clone https://github.com/mendableai/firecrawl.git "$SCRIPT_DIR/firecrawl-src"
fi

# Installiere Dependencies
echo "📦 Installiere Dependencies..."
cd "$SCRIPT_DIR/firecrawl-src/apps/api"
pnpm install

# Erstelle .env wenn nicht vorhanden
if [ ! -f "$SCRIPT_DIR/firecrawl-src/apps/api/.env" ]; then
    echo "📝 Erstelle .env Konfiguration..."
    cat > "$SCRIPT_DIR/firecrawl-src/apps/api/.env" << 'EOF'
# Firecrawl Self-Hosted Config
NODE_ENV=development
PORT=3002
HOST=0.0.0.0

# Redis (lokal)
REDIS_URL=redis://localhost:6379

# PostgreSQL (lokal) 
DATABASE_URL=postgresql://localhost:5432/firecrawl

# Playwright (Nix-managed Chromium)
PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Keine API-Key-Validierung für lokale Instanz
SELF_HOSTED=true
SKIP_API_KEY_VALIDATION=true
EOF
fi

echo ""
echo "✅ Firecrawl Setup abgeschlossen!"
echo ""
echo "📋 NUTZUNG:"
echo "   nix develop          # Shell mit allen Dependencies"
echo "   ./start.sh           # Services + Firecrawl starten"
echo ""
echo "📋 CLI:"
echo "   firecrawl --api-url http://localhost:3002 scrape https://example.com"
