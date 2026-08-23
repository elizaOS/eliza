# Discord Gateway Service
# Multi-tenant Discord gateway for Eliza Cloud
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory. The service depends
# on the `@elizaos/cloud-services-common` and `@elizaos/shared` workspace packages, and `workspace:*`
# cannot resolve from a context that contains only this package — which is why
# every build since that dependency landed failed and the deployed image stayed
# frozen. Matching the gateway-webhook pattern (#17841), the deps stage writes a
# pruned workspace root containing just this service and the packages it
# needs, so `bun install` resolves the workspace link without installing the
# whole monorepo.
#
#   docker build -f packages/cloud/services/gateway-discord/Dockerfile .

# BUN_BASE selects the Bun base image. Default targets linux/amd64 + linux/arm64
# via upstream oven/bun, pinned to the canonical version in
# .github/ci-bun-version.json so the deployed runtime is the one CI validates.
# The verified @discordjs/opus release used below publishes Alpine binaries for
# amd64 and arm64 only. A different architecture fails closed in the selector;
# do not treat a custom Bun base as sufficient native-addon evidence.
ARG BUN_BASE=oven/bun:1.3.14-alpine

FROM ${BUN_BASE} AS base

WORKDIR /app

ARG SERVICE_DIR=packages/cloud/services/gateway-discord
ARG COMMON_DIR=packages/cloud/services/_common
ARG SHARED_DIR=packages/shared
ARG CORE_DIR=packages/core
# @discordjs/opus publishes portable N-API v3 Alpine binaries, but its bundled
# legacy node-pre-gyp crosswalk stops at Node 18 while Bun 1.3.14 identifies its
# compatibility ABI as 137. Selecting the published Node 18 ABI only for native
# dependency installation lets amd64 and arm64 use that N-API artifact instead
# of entering the upstream ARM64-musl source-build failure. The service itself
# still runs on the pinned Bun image above.
ARG OPUS_PREBUILD_NODE_TARGET=18.4.0

# Install dependencies
FROM base AS deps
ARG SERVICE_DIR
ARG COMMON_DIR
ARG SHARED_DIR
ARG CORE_DIR
ARG OPUS_PREBUILD_NODE_TARGET
ARG TARGETARCH
RUN apk add --no-cache python3 make g++ pkgconf opus-dev
COPY ${SERVICE_DIR}/package.json ${SERVICE_DIR}/
COPY ${SERVICE_DIR}/scripts/select-opus-prebuild.ts ${SERVICE_DIR}/scripts/
COPY ${COMMON_DIR}/package.json ${COMMON_DIR}/
COPY ${SHARED_DIR}/package.json ${SHARED_DIR}/
COPY ${CORE_DIR}/package.json ${CORE_DIR}/
RUN bun -e 'const path = Bun.argv.at(-1); const manifest = await Bun.file(path).json(); await Bun.write(path, JSON.stringify({name:manifest.name,version:manifest.version,type:"module",exports:{"./discord-dm-policy":"./src/discord-dm-policy.ts"}}));' "${SHARED_DIR}/package.json" \
    && bun -e 'const path = Bun.argv.at(-1); const manifest = await Bun.file(path).json(); await Bun.write(path, JSON.stringify({name:manifest.name,version:manifest.version,type:"module",exports:{"./errors":"./src/errors.ts"}}));' "${CORE_DIR}/package.json" \
    && printf '{"name":"gateway-discord-build","private":true,"workspaces":["packages/shared","packages/cloud/services/*","packages/core"]}\n' > package.json \
    && npm_config_target="${OPUS_PREBUILD_NODE_TARGET}" bun install --production \
    && bun "${SERVICE_DIR}/scripts/select-opus-prebuild.ts" "${SERVICE_DIR}" "${TARGETARCH}"

# Build stage
FROM deps AS builder
ARG SERVICE_DIR
ARG COMMON_DIR
ARG SHARED_DIR
ARG CORE_DIR
COPY ${COMMON_DIR}/src ${COMMON_DIR}/src
COPY ${SHARED_DIR}/src ${SHARED_DIR}/src
COPY ${CORE_DIR}/src/errors.ts ${CORE_DIR}/src/errors.ts
COPY ${SERVICE_DIR}/tsconfig.json ${SERVICE_DIR}/
COPY ${SERVICE_DIR}/src ${SERVICE_DIR}/src
WORKDIR /app/${SERVICE_DIR}
RUN bun build src/index.ts --outdir dist --target node --conditions eliza-source \
    --external zlib-sync \
    --external @discordjs/voice \
    --external @discordjs/opus \
    --external prism-media \
    --external libsodium-wrappers

# Production stage
FROM base AS runner
ARG SERVICE_DIR
WORKDIR /app

RUN apk add --no-cache ffmpeg opus

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
