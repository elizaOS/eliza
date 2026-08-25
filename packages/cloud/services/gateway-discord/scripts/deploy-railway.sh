#!/usr/bin/env bash
# Reproducible Railway deploy for gateway-discord.
#
# WHY THIS EXISTS
# The tracked Dockerfile builds from the repository root, but the operator-owned
# Railway upload stages a self-contained bundle so it can ship without uploading
# the monorepo. Native dependency selection in the staged Dockerfile must use the
# same verified helper as the tracked image; `--container-build-only` exercises
# that exact staged boundary without contacting Railway.
#
# The Railway service currently has no connected repository source. Until a
# protected deploy workflow owns exact-source uploads, an authorized operator
# runs this script from the package directory:
#
#   railway link --project eliza-cloud --service gateway-discord --environment production
#   bun run deploy:railway
#
# zlib-sync is intentionally omitted: it is an optional native dep of the Discord
# WS lib (lazy require -> graceful fallback to no compression).
set -euo pipefail
BUILD_ONLY=0
CONTAINER_BUILD_ONLY=0
case "${1:-}" in
  "") ;;
  --build-only) BUILD_ONLY=1 ;;
  --container-build-only) CONTAINER_BUILD_ONLY=1 ;;
  *)
    echo "usage: $0 [--build-only|--container-build-only]" >&2
    exit 2
    ;;
esac
if [ "$#" -gt 1 ]; then
  echo "usage: $0 [--build-only|--container-build-only]" >&2
  exit 2
fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGES_DIR="$(cd "$HERE/../../.." && pwd)"
CLEANUP_HELPER="$PACKAGES_DIR/scripts/rm-path-recursive.mjs"
STAGE="$(mktemp -d)"
cleanup_stage() {
  node "$CLEANUP_HELPER" "$STAGE"
}
trap cleanup_stage EXIT

echo "[deploy] building self-contained bundle from $HERE ..."
( cd "$HERE" && bun build src/index.ts --outdir "$STAGE/dist" --target node \
  --conditions eliza-source \
  --external zlib-sync \
  --external @discordjs/voice \
  --external @discordjs/opus \
  --external prism-media \
  --external libsodium-wrappers )

cat > "$STAGE/package.json" <<'JSON'
{
  "name": "gateway-discord",
  "private": true,
  "type": "module",
  "dependencies": {
    "@discordjs/opus": "0.10.0",
    "@discordjs/voice": "^0.19.2",
    "libsodium-wrappers": "^0.8.0",
    "prism-media": "1.3.5"
  }
}
JSON

cp "$HERE/scripts/select-opus-prebuild.ts" "$STAGE/select-opus-prebuild.ts"

cat > "$STAGE/Dockerfile" <<'DOCKER'
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
ARG OPUS_PREBUILD_NODE_TARGET=18.4.0
ARG TARGETARCH
RUN apk add --no-cache python3 make g++ pkgconf opus-dev
COPY package.json ./
COPY select-opus-prebuild.ts ./
RUN npm_config_target="${OPUS_PREBUILD_NODE_TARGET}" bun install --production \
    && bun ./select-opus-prebuild.ts . "${TARGETARCH}"

FROM oven/bun:1.3.14-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg opus
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 gateway
COPY --from=deps /app/node_modules ./node_modules
COPY dist ./dist
COPY package.json ./
USER gateway
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=8s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "dist/index.js"]
DOCKER

cp "$HERE/railway.toml" "$STAGE/railway.toml" 2>/dev/null || true

if [ "$CONTAINER_BUILD_ONLY" = "1" ]; then
  GATEWAY_DISCORD_BUILD_PLATFORM="${GATEWAY_DISCORD_BUILD_PLATFORM:-linux/amd64}"
  GATEWAY_DISCORD_BUILD_TAG="${GATEWAY_DISCORD_BUILD_TAG:-gateway-discord:build-only}"
  docker build \
    --platform "$GATEWAY_DISCORD_BUILD_PLATFORM" \
    --tag "$GATEWAY_DISCORD_BUILD_TAG" \
    "$STAGE"
  echo "[deploy] container build-only proof passed: $GATEWAY_DISCORD_BUILD_TAG ($GATEWAY_DISCORD_BUILD_PLATFORM)"
  exit 0
fi

if [ "$BUILD_ONLY" = "1" ]; then
  echo "[deploy] build-only proof passed"
  exit 0
fi

echo "[deploy] railway up from staged bundle ..."
(
  cd "$STAGE"
  railway link \
    --project "${RAILWAY_PROJECT:-eliza-cloud}" \
    --service "${RAILWAY_SERVICE:-gateway-discord}" \
    --environment "${RAILWAY_ENVIRONMENT:-production}" \
    >/dev/null
  railway up \
    --service "${RAILWAY_SERVICE:-gateway-discord}" \
    --environment "${RAILWAY_ENVIRONMENT:-production}" \
    --detach
)
echo "[deploy] done — current deployment stays live until the new one passes healthcheck."
