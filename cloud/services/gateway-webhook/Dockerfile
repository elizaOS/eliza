# Webhook Gateway Service
# Multi-platform webhook gateway for Eliza Cloud

FROM oven/bun:1.3.13-alpine AS base

WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json ./
RUN bun install --frozen-lockfile --production

# Build stage
FROM base AS builder
COPY package.json tsconfig.json ./
COPY src ./src
COPY --from=deps /app/node_modules ./node_modules
RUN bun build src/index.ts --outdir dist --target node

# Production stage
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 gateway

COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

USER gateway

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "dist/index.js"]
