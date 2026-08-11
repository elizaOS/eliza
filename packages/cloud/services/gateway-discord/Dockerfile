# Discord Gateway Service
# Multi-tenant Discord gateway for Eliza Cloud
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory. The service depends
# on the `@elizaos/cloud-services-common` workspace package, and `workspace:*`
# cannot resolve from a context that contains only this package — which is why
# every build since that dependency landed failed and the deployed image stayed
# frozen. Matching the gateway-webhook pattern (#17841), the deps stage writes a
# pruned workspace root containing just this service and the one package it
# needs, so `bun install` resolves the workspace link without installing the
# whole monorepo.
#
#   docker build -f packages/cloud/services/gateway-discord/Dockerfile .

# BUN_BASE selects the Bun base image. Default targets linux/amd64 + linux/arm64
# via upstream oven/bun. For linux/riscv64 (no upstream image — oven-sh/bun#6266,
# #21923), build a local Bun image via elizaOS/os packages/os/toolchains/bun-riscv64/build.sh
# and pass --build-arg BUN_BASE=<local-tag>.
ARG BUN_BASE=oven/bun:canary-alpine

FROM ${BUN_BASE} AS base

WORKDIR /app

ARG SERVICE_DIR=packages/cloud/services/gateway-discord
ARG COMMON_DIR=packages/cloud/services/_common

# Install dependencies
FROM base AS deps
ARG SERVICE_DIR
ARG COMMON_DIR
COPY ${SERVICE_DIR}/package.json ${SERVICE_DIR}/
COPY ${COMMON_DIR}/package.json ${COMMON_DIR}/
RUN printf '{"name":"gateway-discord-build","private":true,"workspaces":["packages/cloud/services/*"]}\n' > package.json \
    && bun install --production

# Build stage
FROM deps AS builder
ARG SERVICE_DIR
ARG COMMON_DIR
COPY ${COMMON_DIR}/src ${COMMON_DIR}/src
COPY ${SERVICE_DIR}/tsconfig.json ${SERVICE_DIR}/
COPY ${SERVICE_DIR}/src ${SERVICE_DIR}/src
WORKDIR /app/${SERVICE_DIR}
RUN bun build src/index.ts --outdir dist --target node --external zlib-sync

# Production stage
FROM base AS runner
ARG SERVICE_DIR
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 gateway

# The bundle still resolves a few dependencies at runtime (ioredis reaches into
# its own package internals), so the installed tree ships with it. bun's store
# lives at the workspace root and the member directory holds the links, so both
# have to keep their original paths.
#
# Note: only `${SERVICE_DIR}/node_modules` is copied below, not `${COMMON_DIR}`.
# The workspace link `node_modules/@elizaos/cloud-services-common` in the
# service tree therefore points at a directory that is absent from this stage.
# That is intentional: `bun build` inlines the workspace package (only
# `zlib-sync` stays external), so nothing resolves that specifier at runtime in
# this image. Do not "fix" this by copying `${COMMON_DIR}` unless the entrypoint
# stops bundling the workspace source.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/${SERVICE_DIR}/node_modules ./${SERVICE_DIR}/node_modules
COPY --from=builder /app/${SERVICE_DIR}/dist ./${SERVICE_DIR}/dist
COPY ${SERVICE_DIR}/package.json ./${SERVICE_DIR}/

WORKDIR /app/${SERVICE_DIR}

USER gateway

EXPOSE 3000

# Health check using bun (guaranteed to be available)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "dist/index.js"]
