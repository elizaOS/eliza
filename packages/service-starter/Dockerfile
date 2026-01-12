# MCP + A2A Service Dockerfile
# Build and deploy to elizaOS cloud
#
# Supports both ARM64 (Graviton) and AMD64 architectures
# Health check at /health endpoint

FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Install dependencies
FROM base AS deps
COPY package.json bun.lock* ./
# Use --frozen-lockfile only if lock file exists
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi

# Build the application
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# Production image
FROM base AS runner
WORKDIR /app

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

# Copy jeju-manifest.json if it exists
COPY --from=builder /app/jeju-manifest.json* ./

# Install production dependencies only
COPY --from=deps /app/node_modules ./node_modules

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 service && \
    chown -R service:nodejs /app

USER service

EXPOSE 3000

# Health check (required for elizaOS cloud)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

# Start the service
CMD ["bun", "run", "dist/index.js"]
