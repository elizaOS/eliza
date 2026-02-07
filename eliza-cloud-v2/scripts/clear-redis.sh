#!/bin/bash
# Clear all Redis cache data

REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"

echo "🧹 Clearing Redis cache at $REDIS_HOST:$REDIS_PORT..."

if command -v redis-cli &> /dev/null; then
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" FLUSHALL
  echo "✓ Redis cache cleared successfully"
else
  # Use Docker if redis-cli not installed locally
  docker exec eliza-local-redis redis-cli FLUSHALL
  echo "✓ Redis cache cleared via Docker"
fi
