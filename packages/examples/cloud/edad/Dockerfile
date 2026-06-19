# BUN_BASE selects the Bun base image. Default targets linux/amd64 + linux/arm64
# via upstream oven/bun. For linux/riscv64 (no upstream image — oven-sh/bun#6266,
# #21923), build a local Bun image via packages/app-core/scripts/bun-riscv64/build.sh
# and pass --build-arg BUN_BASE=<local-tag>.
ARG BUN_BASE=oven/bun:canary-alpine

FROM ${BUN_BASE}

WORKDIR /app

COPY package.json ./
COPY server.ts ./
COPY db.ts ./
COPY public ./public

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["bun", "run", "server.ts"]
