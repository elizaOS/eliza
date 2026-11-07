FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY patches ./patches
COPY packages ./packages
COPY plugins ./plugins
RUN bun install --filter @elizaos/auth --production --ignore-scripts --frozen-lockfile
RUN bun build packages/core/src/index.ts --target=bun --packages=external --outdir=packages/core/dist

FROM oven/bun:1.4.2
WORKDIR /app
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json /app/bunfig.toml /app/tsconfig.json ./
COPY --from=build --chown=bun:bun /app/packages/auth ./packages/auth
COPY --from=build --chown=bun:bun /app/packages/core ./packages/core
COPY --from=build --chown=bun:bun /app/packages/host ./packages/host
COPY --from=build --chown=bun:bun /app/packages/contracts ./packages/contracts
USER bun
ENV NODE_ENV=production LOGIN_BIND_HOST=0.0.0.0 PORT=3200
EXPOSE 3200
CMD ["bun", "--conditions=eliza-source", "packages/auth/src/server/start.ts"]
