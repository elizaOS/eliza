#!/usr/bin/env bash
# Stoppt Firecrawl Container

if command -v podman &> /dev/null; then
    CONTAINER_CMD="podman"
elif command -v docker &> /dev/null; then
    CONTAINER_CMD="docker"
else
    echo "❌ Docker oder Podman nicht gefunden!"
    exit 1
fi

echo "🛑 Stoppe Firecrawl Container..."
$CONTAINER_CMD stop firecrawl-api firecrawl-redis 2>/dev/null || true
$CONTAINER_CMD rm firecrawl-api firecrawl-redis 2>/dev/null || true

echo "✅ Container gestoppt und entfernt."
