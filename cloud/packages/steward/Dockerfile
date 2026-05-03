# ──────────────────────────────────────────────────────────────────────────────
# Steward — Multi-stage Dockerfile
#
# Stages:
#   base      common base image + workdir
#   deps      install ALL dependencies (including dev) for building
#   build     compile TypeScript, run turbo build
#   runtime   production image — only prod deps + compiled output, non-root user
#
# Entry points:
#   API   (default): bun packages/api/src/index.ts   — port 3200
#   Proxy (override): bun packages/proxy/src/index.ts — port 8080
#
# Build:
#   docker build -t steward:latest .
#
# Run API:
#   docker run -e STEWARD_MASTER_PASSWORD=xxx -e DATABASE_URL=xxx steward:latest
#
# Run Proxy:
#   docker run -e STEWARD_MASTER_PASSWORD=xxx -e DATABASE_URL=xxx \
#     steward:latest bun packages/proxy/src/index.ts
# ──────────────────────────────────────────────────────────────────────────────

# ── Stage 0: Base ─────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS base

WORKDIR /app

# ── Stage 1: Dependencies (all — includes dev deps for build) ─────────────────
FROM base AS deps

# Cache buster (set via build-arg in CI to force fresh install)
ARG CACHE_BUST=1

# Copy manifests only — layer-cached until lockfile changes
COPY package.json bun.lock turbo.json tsconfig.json ./

# Create stub for excluded workspaces so bun doesn't fail on missing references
RUN mkdir -p web && echo '{"name":"web","version":"0.0.0","private":true}' > web/package.json

# Package manifests for every workspace package
COPY packages/api/package.json       packages/api/package.json
COPY packages/auth/package.json      packages/auth/package.json
COPY packages/db/package.json        packages/db/package.json
COPY packages/policy-engine/package.json packages/policy-engine/package.json
COPY packages/proxy/package.json     packages/proxy/package.json
COPY packages/redis/package.json     packages/redis/package.json
COPY packages/shared/package.json    packages/shared/package.json
COPY packages/sdk/package.json       packages/sdk/package.json
COPY packages/vault/package.json     packages/vault/package.json
COPY packages/webhooks/package.json  packages/webhooks/package.json

RUN BUN_FROZEN_LOCKFILE=0 bun install

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM base AS build

COPY package.json bun.lock turbo.json tsconfig.json ./

# Copy package.json files for workspace resolution
COPY packages/api/package.json       packages/api/package.json
COPY packages/auth/package.json      packages/auth/package.json
COPY packages/db/package.json        packages/db/package.json
COPY packages/policy-engine/package.json packages/policy-engine/package.json
COPY packages/proxy/package.json     packages/proxy/package.json
COPY packages/redis/package.json     packages/redis/package.json
COPY packages/shared/package.json    packages/shared/package.json
COPY packages/sdk/package.json       packages/sdk/package.json
COPY packages/vault/package.json     packages/vault/package.json
COPY packages/webhooks/package.json  packages/webhooks/package.json

# Create stub for excluded workspaces
RUN mkdir -p web && echo '{"name":"web","version":"0.0.0","private":true}' > web/package.json

# Install deps fresh in build stage (bun symlinks don't survive COPY --from in BuildKit)
RUN BUN_FROZEN_LOCKFILE=0 bun install

# Copy full source for all packages needed by api + proxy
COPY packages/api         packages/api
COPY packages/auth        packages/auth
COPY packages/db          packages/db
COPY packages/policy-engine packages/policy-engine
COPY packages/proxy       packages/proxy
COPY packages/redis       packages/redis
COPY packages/shared      packages/shared
COPY packages/sdk         packages/sdk
COPY packages/vault       packages/vault
COPY packages/webhooks    packages/webhooks

# Create workspace symlinks (Bun 1.3 doesn't auto-link in Docker)
RUN mkdir -p node_modules/@stwd && \
    ln -sf ../../../packages/shared        node_modules/@stwd/shared && \
    ln -sf ../../../packages/sdk           node_modules/@stwd/sdk && \
    ln -sf ../../../packages/auth          node_modules/@stwd/auth && \
    ln -sf ../../../packages/db            node_modules/@stwd/db && \
    ln -sf ../../../packages/vault         node_modules/@stwd/vault && \
    ln -sf ../../../packages/redis         node_modules/@stwd/redis && \
    ln -sf ../../../packages/proxy         node_modules/@stwd/proxy && \
    ln -sf ../../../packages/webhooks      node_modules/@stwd/webhooks && \
    ln -sf ../../../packages/policy-engine node_modules/@stwd/policy-engine

# Build api and proxy (and their deps) via turborepo
RUN bunx turbo run build --filter=@stwd/api --filter=@stwd/proxy

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3200

# Install production dependencies only (no dev/build tools)
COPY package.json bun.lock turbo.json tsconfig.json ./

# Create stub for excluded workspaces
RUN mkdir -p web && echo '{"name":"web","version":"0.0.0","private":true}' > web/package.json

COPY packages/api/package.json       packages/api/package.json
COPY packages/auth/package.json      packages/auth/package.json
COPY packages/db/package.json        packages/db/package.json
COPY packages/policy-engine/package.json packages/policy-engine/package.json
COPY packages/proxy/package.json     packages/proxy/package.json
COPY packages/redis/package.json     packages/redis/package.json
COPY packages/shared/package.json    packages/shared/package.json
COPY packages/sdk/package.json       packages/sdk/package.json
COPY packages/vault/package.json     packages/vault/package.json
COPY packages/webhooks/package.json  packages/webhooks/package.json

COPY --from=deps /app/bun.lock ./bun.lock
RUN bun install --production

# Copy compiled output from build stage
COPY --from=build /app/packages/api         packages/api
COPY --from=build /app/packages/auth        packages/auth
COPY --from=build /app/packages/db          packages/db
COPY --from=build /app/packages/policy-engine packages/policy-engine
COPY --from=build /app/packages/proxy       packages/proxy
COPY --from=build /app/packages/redis       packages/redis
COPY --from=build /app/packages/shared      packages/shared
COPY --from=build /app/packages/sdk         packages/sdk
COPY --from=build /app/packages/vault       packages/vault
COPY --from=build /app/packages/webhooks    packages/webhooks

# Create workspace symlinks manually — bun 1.3 doesn't auto-link workspace packages
RUN mkdir -p node_modules/@stwd && \
    ln -sf ../../../packages/shared        node_modules/@stwd/shared && \
    ln -sf ../../../packages/sdk           node_modules/@stwd/sdk && \
    ln -sf ../../../packages/auth          node_modules/@stwd/auth && \
    ln -sf ../../../packages/db            node_modules/@stwd/db && \
    ln -sf ../../../packages/vault         node_modules/@stwd/vault && \
    ln -sf ../../../packages/redis         node_modules/@stwd/redis && \
    ln -sf ../../../packages/api           node_modules/@stwd/api && \
    ln -sf ../../../packages/proxy         node_modules/@stwd/proxy && \
    ln -sf ../../../packages/webhooks      node_modules/@stwd/webhooks && \
    ln -sf ../../../packages/policy-engine node_modules/@stwd/policy-engine && \
    ln -sf ../../../packages/eliza-plugin  node_modules/@stwd/eliza-plugin 2>/dev/null; true

# ── Non-root user ─────────────────────────────────────────────────────────────
# bun image already has a 'bun' user (uid 1000); use it.
USER bun

# ── Ports ─────────────────────────────────────────────────────────────────────
# API: 3200   Proxy: 8080
EXPOSE 3200 8080

# ── Health check ──────────────────────────────────────────────────────────────
# Uses /ready for the API (deep check: db + migrations + vault).
# Proxy overrides CMD, so it checks /health on its own port at startup.
# The CMD-level health check targets whichever process is running:
#   API   → check :3200/ready
#   Proxy → check :8080/health  (set via compose healthcheck override)
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD bun -e "const r=await fetch('http://127.0.0.1:'+( \
    process.env.STEWARD_PROXY_PORT \
      ? process.env.STEWARD_PROXY_PORT \
      : (process.env.PORT||'3200') \
  )+(process.env.STEWARD_PROXY_PORT?'/health':'/ready') \
  );process.exit(r.ok?0:1);"

# ── Default command: API server ───────────────────────────────────────────────
# Override for proxy: CMD ["bun", "packages/proxy/src/index.ts"]
CMD ["bun", "packages/api/src/index.ts"]
