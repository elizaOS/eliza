# Agent Server Service
# Hosts live Eliza agent runtimes for Eliza Cloud pods.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory. The service depends
# on six `@elizaos/*` workspace packages (and their transitive workspace
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
ARG BUN_BASE=oven/bun:1.3.14-alpine

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
COPY packages/cloud/services/_common/package.json packages/cloud/services/_common/
COPY packages/cloud/routing/package.json packages/cloud/routing/
COPY packages/cloud/sdk/package.json packages/cloud/sdk/
COPY packages/cloud/shared/package.json packages/cloud/shared/
COPY packages/core/package.json packages/core/
COPY packages/logger/package.json packages/logger/
COPY packages/prompts/package.json packages/prompts/
COPY packages/registry/package.json packages/registry/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY plugins/plugin-cloud-apps/package.json plugins/plugin-cloud-apps/
COPY plugins/plugin-elizacloud/package.json plugins/plugin-elizacloud/
COPY plugins/plugin-native-agent/package.json plugins/plugin-native-agent/
COPY plugins/plugin-native-bun-runtime/package.json plugins/plugin-native-bun-runtime/
COPY plugins/plugin-native-camera/package.json plugins/plugin-native-camera/
COPY plugins/plugin-native-llama/package.json plugins/plugin-native-llama/
COPY plugins/plugin-openai/package.json plugins/plugin-openai/
COPY plugins/plugin-scheduling/package.json plugins/plugin-scheduling/
COPY plugins/plugin-sql/package.json plugins/plugin-sql/
COPY plugins/plugin-todos/package.json plugins/plugin-todos/
COPY plugins/plugin-web-search/package.json plugins/plugin-web-search/
COPY plugins/plugin-workflow/package.json plugins/plugin-workflow/
RUN printf '{"name":"agent-server-build","private":true,"workspaces":["packages/cloud/services/agent-server","packages/cloud/services/_common","packages/cloud/routing","packages/cloud/sdk","packages/cloud/shared","packages/core","packages/logger","packages/prompts","packages/registry","packages/shared","packages/ui","plugins/plugin-cloud-apps","plugins/plugin-elizacloud","plugins/plugin-native-agent","plugins/plugin-native-bun-runtime","plugins/plugin-native-camera","plugins/plugin-native-llama","plugins/plugin-openai","plugins/plugin-scheduling","plugins/plugin-sql","plugins/plugin-todos","plugins/plugin-web-search","plugins/plugin-workflow"]}\n' > package.json \
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
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/${SERVICE_DIR}/node_modules ./${SERVICE_DIR}/node_modules
COPY packages/cloud/services/_common packages/cloud/services/_common
COPY packages/cloud/routing packages/cloud/routing
COPY packages/cloud/sdk packages/cloud/sdk
COPY packages/cloud/shared packages/cloud/shared
COPY packages/core packages/core
COPY packages/logger packages/logger
COPY packages/prompts packages/prompts
COPY packages/registry packages/registry
COPY packages/shared packages/shared
COPY packages/ui packages/ui
COPY plugins/plugin-cloud-apps plugins/plugin-cloud-apps
COPY plugins/plugin-elizacloud plugins/plugin-elizacloud
COPY plugins/plugin-native-agent plugins/plugin-native-agent
COPY plugins/plugin-native-bun-runtime plugins/plugin-native-bun-runtime
COPY plugins/plugin-native-camera plugins/plugin-native-camera
COPY plugins/plugin-native-llama plugins/plugin-native-llama
COPY plugins/plugin-openai plugins/plugin-openai
COPY plugins/plugin-scheduling plugins/plugin-scheduling
COPY plugins/plugin-sql plugins/plugin-sql
COPY plugins/plugin-todos plugins/plugin-todos
COPY plugins/plugin-web-search plugins/plugin-web-search
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
