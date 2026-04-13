#!/usr/bin/env bash
# Firecrawl Self-Hosted mit Docker Compose

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔥 Firecrawl Self-Hosted (Docker Compose)"
echo ""

# Prüfe ob Docker Compose V2 verfügbar (bevorzugt)
if command -v docker &> /dev/null && docker compose version &> /dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif command -v podman-compose &> /dev/null; then
    COMPOSE_CMD="podman-compose"
else
    echo "❌ Docker Compose V2 nicht gefunden!"
    echo "   Deine docker-compose Version ist zu alt."
    echo ""
    echo "   Update Docker:"
    echo "   curl -fsSL https://get.docker.com | sudo sh"
    echo ""
    echo "   Oder nutze Podman:"
    echo "   sudo apt install podman-compose"
    exit 1
fi

# Prüfe ob Firecrawl-Repo existiert (wir nutzen das offizielle docker-compose)
if [ ! -d "$SCRIPT_DIR/firecrawl-src" ]; then
    echo "� Klone Firecrawl Repository..."
    git clone --depth 1 https://github.com/mendableai/firecrawl.git firecrawl-src
fi

# Nutze das offizielle Docker Compose aus dem Firecrawl Repo
cd "$SCRIPT_DIR/firecrawl-src"

# Erstelle .env wenn nicht vorhanden
if [ ! -f .env ]; then
    echo "📝 Erstelle .env..."
    cat > .env << 'EOF'
USE_DB_AUTHENTICATION=false
SUPABASE_ANON_TOKEN=
SUPABASE_URL=
SUPABASE_SERVICE_TOKEN=
PLAYWRIGHT_MICROSERVICE_URL=http://playwright-service:3000
EOF
fi

echo "🚀 Starte Firecrawl mit Docker Compose..."
$COMPOSE_CMD up -d

echo ""
echo "✅ Firecrawl läuft!"
echo ""
echo "📋 API URL: http://localhost:3002"
echo ""
echo "📋 Logs anzeigen:"
echo "   $COMPOSE_CMD logs -f"
echo ""
echo "📋 Stoppen:"
echo "   $COMPOSE_CMD down"
