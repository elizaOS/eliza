# Webhook Gateway Service
# Multi-platform webhook gateway for Eliza Cloud
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory. The service depends
# on the `@elizaos/cloud-services-common` workspace package, and `workspace:*`
# cannot resolve from a context that contains only this package — which is why
# every build since that dependency landed (a07084e9cbc, 2026-06-28) failed and
# the deployed image stayed frozen on the last one that succeeded.
#
#   docker build -f packages/cloud/services/gateway-webhook/Dockerfile .
#
# The deps stage writes a pruned workspace root containing just this service and
# the workspace packages it needs, so `bun install` resolves every link without
# installing the whole monorepo (32 packages rather than several thousand).

# BUN_BASE selects the Bun base image. Default targets linux/amd64 + linux/arm64
# via upstream oven/bun, pinned to the canonical version in
# .github/ci-bun-version.json so the deployed runtime is the one CI validates.
# For linux/riscv64 (no upstream image — oven-sh/bun#6266, #21923), build a local
# Bun image via elizaOS/os packages/os/toolchains/bun-riscv64/build.sh and pass
# --build-arg BUN_BASE=<local-tag>.
ARG BUN_BASE=oven/bun:1.3.14-alpine

FROM ${BUN_BASE} AS base

WORKDIR /app

ARG SERVICE_DIR=packages/cloud/services/gateway-webhook
ARG COMMON_DIR=packages/cloud/services/_common
ARG CORE_DIR=packages/core

# Install dependencies
FROM base AS deps
ARG SERVICE_DIR
ARG COMMON_DIR
ARG CORE_DIR
COPY ${SERVICE_DIR}/package.json ${SERVICE_DIR}/
COPY ${COMMON_DIR}/package.json ${COMMON_DIR}/
COPY ${CORE_DIR}/package.json ${CORE_DIR}/
# Production dependency resolution must not traverse test-only workspace links;
# doing so would require vendoring cloud-shared's entire transitive workspace.
RUN bun -e 'const path = Bun.argv.at(-1); const manifest = await Bun.file(path).json(); delete manifest.devDependencies; await Bun.write(path, JSON.stringify(manifest));' "${SERVICE_DIR}/package.json" \
    && bun -e 'const path = Bun.argv.at(-1); const manifest = await Bun.file(path).json(); await Bun.write(path, JSON.stringify({name:manifest.name,version:manifest.version,type:"module",exports:"./src/errors.ts"}));' "${CORE_DIR}/package.json" \
    && printf '{"name":"gateway-webhook-build","private":true,"workspaces":["packages/cloud/services/*","packages/core"]}\n' > package.json \
    && bun install --production

# Build stage
FROM deps AS builder
ARG SERVICE_DIR
ARG COMMON_DIR
ARG CORE_DIR
COPY ${COMMON_DIR}/src ${COMMON_DIR}/src
COPY ${CORE_DIR}/src/errors.ts ${CORE_DIR}/src/errors.ts
COPY ${SERVICE_DIR}/tsconfig.json ${SERVICE_DIR}/
COPY ${SERVICE_DIR}/src ${SERVICE_DIR}/src
WORKDIR /app/${SERVICE_DIR}
RUN bun build src/index.ts --outdir dist --target node

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
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/${SERVICE_DIR}/node_modules ./${SERVICE_DIR}/node_modules
COPY --from=builder /app/${SERVICE_DIR}/dist ./${SERVICE_DIR}/dist
COPY ${SERVICE_DIR}/package.json ./${SERVICE_DIR}/

WORKDIR /app/${SERVICE_DIR}

USER gateway

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "dist/index.js"]
