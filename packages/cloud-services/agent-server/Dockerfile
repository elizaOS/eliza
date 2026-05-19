# BUN_BASE selects the Bun base image. Default targets linux/amd64 + linux/arm64
# via upstream oven/bun. For linux/riscv64 (no upstream image — oven-sh/bun#6266,
# #21923), build a local Bun image via packages/app-core/scripts/bun-riscv64/build.sh
# and pass --build-arg BUN_BASE=<local-tag>.
ARG BUN_BASE=oven/bun:1.3.13-alpine

FROM ${BUN_BASE} AS deps
WORKDIR /app
COPY package.json ./
RUN bun install

FROM ${BUN_BASE} AS runner
WORKDIR /app
RUN adduser -D -u 1001 appuser && mkdir -p /app/cache && chown appuser /app/cache
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY tsconfig.json ./
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1))"
CMD ["bun", "run", "src/index.ts"]
