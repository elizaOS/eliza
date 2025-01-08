# Use a specific Node.js version for better reproducibility
FROM node:23.3.0-slim AS builder

# Install pnpm globally and install necessary build tools
RUN npm install -g pnpm@9.4.0 && \
    apt-get update && \
    apt-get install -y git python3 make g++ && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set Python 3 as the default python
RUN ln -s /usr/bin/python3 /usr/bin/python

# Set the working directory
WORKDIR /app

# Copy package files first to leverage Docker cache
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY packages/*/package.json ./packages/

# Install dependencies only
RUN pnpm install --frozen-lockfile

# Copy the rest of the application code
COPY . .

# Build in stages with error handling
RUN set -e; \
    echo "Building core plugins..." && \
    pnpm build-docker --filter "@ai16z/plugin-solana" --filter "@ai16z/plugin-trustdb" && \
    echo "Building remaining packages..." && \
    pnpm build-docker || (echo "Build failed. Check logs above." && exit 1) && \
    echo "Pruning development dependencies..." && \
    pnpm prune --prod

# Create a new stage for the final image
FROM node:23.3.0-slim

# Install runtime dependencies
RUN npm install -g pnpm@9.4.0 && \
    apt-get update && \
    apt-get install -y git python3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/.npmrc ./
COPY --from=builder /app/turbo.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/characters ./characters

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pnpm healthcheck || exit 1

# Set environment variables
ENV NODE_ENV=production

# Set the command to run the application
CMD ["pnpm", "start", "--non-interactive"]
