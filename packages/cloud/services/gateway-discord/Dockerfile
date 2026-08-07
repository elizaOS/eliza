# Discord Gateway Service
# Multi-tenant Discord gateway for Eliza Cloud
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory. The service depends
# on the `@elizaos/cloud-services-common` workspace package, so a package-only
# context cannot resolve its `workspace:*` dependency.
#
#   docker build -f packages/cloud/services/gateway-discord/Dockerfile .
#
# The deps stage creates a pruned workspace containing only this service and
# the shared Cloud service package. That keeps installs small while preserving
# Bun's workspace resolution and the runtime node_modules layout.

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

# The bundle leaves a few dependencies external at runtime. Bun's package store
# lives at the workspace root and the member directory holds its links, so both
# paths must retain their build-stage layout.
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
