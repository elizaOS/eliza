# Feed web service — Railway/Docker build.
#
# Built from the elizaOS repo root (the feed web app depends on the workspace:
# @elizaos/shared via file:../../../shared and the @feed/* packages). The build
# context must be the repo root; a root .dockerignore prunes everything the feed
# build does not need. `output: standalone` is disabled in next.config, so the
# runtime image keeps node_modules + .next (single stage).
FROM oven/bun:canary

# git is used by next.config for the service-worker revision (falls back to a
# random uuid if absent); bash runs the start wrapper.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the (pruned) workspace and install. --no-frozen-lockfile tolerates the
# pruned workspace (os/benchmarks/native/plugins excluded via .dockerignore).
COPY . .
# Strip workspace:* deps pointing to packages excluded from this build context
# (and prune root workspace entries), so `bun install` resolves cleanly.
# Keep bun.lock — it encodes the workspace-override resolutions (e.g. the feed
# app's npm-pinned @elizaos/core), which a fresh resolve would get wrong.
RUN bun packages/feed/scripts/railway-prune-workspace.mjs
RUN bun install --no-frozen-lockfile

# Build the @elizaos workspace packages the feed app consumes as built dist.
# next.config only transpiles @elizaos/shared + @feed/*; @elizaos/core (and the
# @elizaos/shared/* subpath exports) resolve to dist/, which is produced by each
# package's own build, not by install. turbo builds them in dependency order
# (contracts/logger/prompts -> core -> shared).
RUN bunx turbo run build --filter=@elizaos/shared --filter=@elizaos/core

# Build the Next.js app (webpack; standalone disabled). Heap capped at 6144 MB so
# the build keeps ~2 GB of headroom on Railway's ~8 GB builder; 7168 left too
# little and thrash-stalled in "Collecting page data" (source maps are already
# disabled in next.config). The package.json build script's NODE_OPTIONS is the
# effective cap and is kept in sync with this value.
ENV NODE_ENV=production
RUN NODE_OPTIONS=--max-old-space-size=6144 bun run --cwd packages/feed/apps/web build

EXPOSE 3000
# Ensure schema, then start the server (binds $PORT).
CMD ["bash", "packages/feed/scripts/railway-start.sh"]
