#!/usr/bin/env bash
# Reproducible Railway deploy for gateway-discord.
#
# WHY THIS EXISTS
# The in-repo Dockerfile does `bun install --frozen-lockfile` against this
# package's own context, which can't resolve the `@elizaos/cloud-services-common`
# workspace:* dependency when `railway up` uploads only the package directory
# (no monorepo). `bun build` (the `build` script) DOES resolve + inline that dep
# from the monorepo, producing a self-contained bundle — so we build the bundle
# here and ship a runtime-only image.
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
DOCKER_BUILD_ONLY=0
case "${1:-}" in
  "") ;;
  --build-only) BUILD_ONLY=1 ;;
  --docker-build-only) DOCKER_BUILD_ONLY=1 ;;
  *)
    echo "usage: $0 [--build-only|--docker-build-only]" >&2
    exit 2
    ;;
esac
if [ "$#" -gt 1 ]; then
  echo "usage: $0 [--build-only|--docker-build-only]" >&2
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

cp "$HERE/scripts/railway-runtime-package.json" "$STAGE/package.json"
cp "$HERE/scripts/Railway.Dockerfile" "$STAGE/Dockerfile"
cp "$HERE/scripts/install-portable-opus.mjs" "$STAGE/install-portable-opus.mjs"

cp "$HERE/railway.toml" "$STAGE/railway.toml" 2>/dev/null || true

if [ "$BUILD_ONLY" = "1" ]; then
  echo "[deploy] build-only proof passed"
  exit 0
fi

if [ "$DOCKER_BUILD_ONLY" = "1" ]; then
  DOCKER_PLATFORM="${GATEWAY_DISCORD_DOCKER_PLATFORM:-linux/amd64}"
  DOCKER_TAG="${GATEWAY_DISCORD_DOCKER_TAG:-gateway-discord:railway-proof}"
  echo "[deploy] building staged Railway image for $DOCKER_PLATFORM ..."
  docker buildx build --platform "$DOCKER_PLATFORM" --load \
    --tag "$DOCKER_TAG" "$STAGE"
  echo "[deploy] staged Railway image proof passed"
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
