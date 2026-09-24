# Agent Server Service
# Hosts live Eliza agent runtimes for Eliza Cloud pods.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory. The service depends
# on `@elizaos/*` workspace packages (and their transitive workspace
# closure), and `workspace:*` cannot resolve from a context that contains only
# this package — the same failure mode fixed for gateway-webhook (#17841) and
# gateway-discord (#17929).
#
#   docker build -f packages/cloud/services/agent-server/Dockerfile .
#
# The deps stage writes a pruned workspace root containing just this service and
# the workspace packages it (transitively) needs, so `bun install` resolves the
# workspace links without installing the whole monorepo. The runner ships those
# packages as TypeScript source and starts bun with `--conditions=eliza-source`,
# the repo's source-execution export condition, so no monorepo build step is
# required inside the image.

# BUN_BASE selects the Bun base image. Default targets linux/amd64 + linux/arm64
# via upstream oven/bun, pinned to the canonical version in
# .github/ci-bun-version.json so the deployed runtime is the one CI validates.
# For linux/riscv64 (no upstream image — oven-sh/bun#6266, #21923), build a local
# Bun image via elizaOS/os packages/os/toolchains/bun-riscv64/build.sh and pass
# --build-arg BUN_BASE=<local-tag>.
ARG BUN_BASE=oven/bun:1.4.2-alpine

FROM ${BUN_BASE} AS base
WORKDIR /app

ARG SERVICE_DIR=packages/cloud/services/agent-server

# Install dependencies against a pruned workspace root. The list below is the
# transitive `workspace:*` closure of this service's dependencies; the guard
# test in packages/cloud/services/gateway-webhook/__tests__/
# dockerfile-workspace-context.test.ts fails if a direct dependency's directory
# is missing from this file.
FROM base AS deps
ARG SERVICE_DIR
COPY ${SERVICE_DIR}/package.json ${SERVICE_DIR}/
COPY packages/cloud/sdk/package.json packages/cloud/sdk/
COPY packages/cloud/services/_common/package.json packages/cloud/services/_common/
COPY packages/core/package.json packages/core/
COPY plugins/plugin-assistant/package.json plugins/plugin-assistant/
COPY plugins/plugin-elizacloud/package.json plugins/plugin-elizacloud/
COPY plugins/plugin-openai/package.json plugins/plugin-openai/
COPY plugins/plugin-sql/package.json plugins/plugin-sql/
COPY plugins/plugin-workflow/package.json plugins/plugin-workflow/
# The headless host does not install test dependencies or optional UI peers.
RUN printf '{"name":"agent-server-build","private":true,"workspaces":["packages/cloud/services/agent-server","packages/cloud/sdk","packages/cloud/services/_common","packages/core","plugins/plugin-assistant","plugins/plugin-elizacloud","plugins/plugin-openai","plugins/plugin-sql","plugins/plugin-workflow"]}\n' > package.json \
    && bun -e 'const root = await Bun.file("package.json").json(); for (const dir of root.workspaces) { const path = `${dir}/package.json`; const manifest = await Bun.file(path).json(); delete manifest.devDependencies; for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) { if (meta.optional) delete manifest.peerDependencies?.[name]; } await Bun.write(path, JSON.stringify(manifest)); }' \
    && bun install --production

# Production stage: run the service straight from TypeScript source, resolving
# workspace packages through their `eliza-source` export condition.
FROM base AS runner
ARG SERVICE_DIR
WORKDIR /app

ENV NODE_ENV=production

RUN adduser -D -u 1001 appuser && mkdir -p /app/cache && chown appuser /app/cache

# bun's store lives at the workspace root and each member directory holds its
# links, so both keep their original paths.
COPY --from=deps /app/ ./
COPY packages/cloud/sdk packages/cloud/sdk
COPY packages/cloud/services/_common packages/cloud/services/_common
COPY packages/core packages/core
COPY plugins/plugin-assistant plugins/plugin-assistant
COPY plugins/plugin-elizacloud plugins/plugin-elizacloud
COPY plugins/plugin-openai plugins/plugin-openai
COPY plugins/plugin-sql plugins/plugin-sql
COPY plugins/plugin-workflow plugins/plugin-workflow
COPY ${SERVICE_DIR}/package.json ${SERVICE_DIR}/
COPY ${SERVICE_DIR}/tsconfig.json ${SERVICE_DIR}/
COPY ${SERVICE_DIR}/src ${SERVICE_DIR}/src

WORKDIR /app/${SERVICE_DIR}
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1))"
CMD ["bun", "--conditions=eliza-source", "run", "src/index.ts"]
