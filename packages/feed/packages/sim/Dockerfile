# ---------------------------------------------------------
# @feed/sim — standalone simulation engine
#
# Must be built from the monorepo root:
#
#   docker build -f packages/sim/Dockerfile -t feed-sim .
#
# Run modes:
#   docker run feed-sim                          # loop (default)
#   docker run -e SIM_ONCE=1 feed-sim            # single tick
#   docker run feed-sim --once                   # single tick (alt)
#   docker run -e TICK_INTERVAL_MS=30000 feed-sim
# ---------------------------------------------------------

FROM oven/bun:canary AS base

# -- Install stage: resolve workspace deps -----------------------------------
FROM base AS install

WORKDIR /app

# Copy every package.json so bun can resolve the workspace graph.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/a2a/package.json packages/a2a/
COPY packages/agents/package.json packages/agents/
COPY packages/api/package.json packages/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/examples/package.json packages/examples/
COPY packages/mcp/package.json packages/mcp/
COPY packages/shared/package.json packages/shared/
COPY packages/sim/package.json packages/sim/
COPY packages/testing/package.json packages/testing/
COPY packages/training/package.json packages/training/

RUN bun install --ignore-scripts

# -- Build stage: bundle the sim entry ---------------------------------------
FROM base AS build

WORKDIR /app

# Bun hoists everything to root node_modules
COPY --from=install /app/node_modules ./node_modules

# Copy workspace source — engine has deep cross-package deps so we
# copy everything. The runtime stage only keeps the build output.
COPY tsconfig.json ./
COPY packages/ packages/

WORKDIR /app/packages/sim
RUN bun run cli/index.ts build --target bun

# -- Runtime stage: slim -----------------------------------------------------
FROM base AS runtime

WORKDIR /app/packages/sim

# The 9MB bundle has everything inlined except externalized deps.
# c12 is needed at runtime for config loading (loadFeedConfig).
# node-fetch-native is externalized by the bundler.
RUN bun add --no-save node-fetch-native c12

# Build output (self-contained bundle)
COPY --from=build /app/packages/sim/.output ./.output

# Config + core (needed for feed.config.ts relative imports)
COPY --from=build /app/packages/sim/feed.config.ts* ./
COPY --from=build /app/packages/sim/core/ ./core/

ENV NODE_ENV=production
ENV TICK_INTERVAL_MS=60000

ENTRYPOINT ["bun", ".output/server.js"]
