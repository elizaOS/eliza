FROM oven/bun:1.3.13-alpine

WORKDIR /app

COPY package.json ./
COPY server.ts ./
COPY public ./public

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["bun", "run", "server.ts"]
