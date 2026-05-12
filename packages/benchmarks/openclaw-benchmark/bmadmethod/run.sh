#!/bin/bash
# Startet die isolierte Benchmark-Umgebung für BMAD-METHOD

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Eindeutige Naming-Convention für Benchmarks
IMAGE_NAME="benchmark/bmadmethod"
CONTAINER_NAME="benchmark--bmadmethod"

# Finde den richtigen User-Home (auch bei sudo)
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)

echo "🔨 Building container..."
docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 AGENT BENCHMARK: BMAD-METHOD"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   Image:     $IMAGE_NAME"
echo "   Container: $CONTAINER_NAME"
echo ""
echo "📋 SETUP:"
echo "   npx bmad-method init"
echo ""
echo "📋 TESTEN:"
echo "   npx bmad-method dev"
echo ""
echo "🔍 Container-Filter: docker ps --filter 'label=project=benchmark'"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Langfuse Konfiguration (für Token-Tracking, optional)
LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-}"
LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-}"
LANGFUSE_HOST="${LANGFUSE_HOST:-https://cloud.langfuse.com}"

# Lade globale .env aus benchmark/ (falls vorhanden)
BENCHMARK_DIR="$(dirname "$SCRIPT_DIR")/benchmark"
if [ -f "$BENCHMARK_DIR/.env" ]; then
    export $(grep -v '^#' "$BENCHMARK_DIR/.env" | xargs 2>/dev/null) || true
fi

# Lade lokale .env als Override (falls vorhanden)
if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs 2>/dev/null) || true
fi

docker run -it --rm \
    --name "$CONTAINER_NAME" \
    --label "project=benchmark" \
    --label "component=bmadmethod" \
    --label "purpose=benchmark" \
    -e "LANGFUSE_PUBLIC_KEY=$LANGFUSE_PUBLIC_KEY" \
    -e "LANGFUSE_SECRET_KEY=$LANGFUSE_SECRET_KEY" \
    -e "LANGFUSE_HOST=$LANGFUSE_HOST" \
    "$IMAGE_NAME"

echo "✅ Container '$CONTAINER_NAME' beendet und gelöscht."
