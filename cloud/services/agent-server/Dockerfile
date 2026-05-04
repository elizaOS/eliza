FROM oven/bun:1.3.13-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN bun install

FROM oven/bun:1.3.13-alpine AS runner
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
