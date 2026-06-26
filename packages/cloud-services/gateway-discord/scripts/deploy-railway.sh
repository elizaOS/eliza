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
# LONG-TERM FIX: reconnect the Railway service to the GitHub repo (Railway
# dashboard) so it auto-deploys on push as documented in railway.toml /
# .github/workflows/cloud-gateway-discord.yml, and/or make the Dockerfile build
# from the monorepo root. Until then, run this from the package directory:
#
#   railway link --project eliza-cloud --service gateway-discord --environment production
#   bun run scripts/deploy-railway.sh
#
# zlib-sync is intentionally omitted: it is an optional native dep of the Discord
# WS lib (lazy require -> graceful fallback to no compression).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGES_DIR="$(cd "$HERE/../.." && pwd)"
CLEANUP_HELPER="$PACKAGES_DIR/scripts/rm-path-recursive.mjs"
STAGE="$(mktemp -d)"
cleanup_stage() {
  node "$CLEANUP_HELPER" "$STAGE"
}
trap cleanup_stage EXIT

echo "[deploy] building self-contained bundle from $HERE ..."
( cd "$HERE" && bun build src/index.ts --outdir "$STAGE/dist" --target node --external zlib-sync )

cat > "$STAGE/package.json" <<'JSON'
{ "name": "gateway-discord", "private": true, "type": "module" }
JSON

cat > "$STAGE/Dockerfile" <<'DOCKER'
FROM oven/bun:canary-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 gateway
COPY dist ./dist
COPY package.json ./
USER gateway
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=8s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "dist/index.js"]
DOCKER

cp "$HERE/railway.toml" "$STAGE/railway.toml" 2>/dev/null || true

echo "[deploy] railway up from staged bundle ..."
( cd "$STAGE" && railway up --service gateway-discord --environment production --detach )
echo "[deploy] done — current deployment stays live until the new one passes healthcheck."
