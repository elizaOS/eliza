FROM node:23.3.0-slim AS builder

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    g++ \
    git \
    make \
    python3 \
    unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g bun@1.2.5 turbo@2.3.3

RUN ln -s /usr/bin/python3 /usr/bin/python

# Clear any existing Playwright caches that might cause lockfile issues
RUN rm -rf /root/.cache/ms-playwright

# Add TypeScript types for node and dotenv globally
RUN npm install -g @types/node @types/dotenv

COPY package.json turbo.json tsconfig.json lerna.json renovate.json .npmrc ./
COPY scripts ./scripts
COPY packages ./packages

# Make scripts executable
RUN chmod +x ./scripts/test-build.sh ./scripts/fix-typescript-errors.sh ./scripts/verify-tsconfig.sh

# Fix permissions for shell scripts in packages
RUN find ./packages -name "*.sh" -exec chmod +x {} \;

# Run lightweight build testing
RUN ./scripts/test-build.sh

# Fix TypeScript errors automatically
RUN ./scripts/fix-typescript-errors.sh

# Verify tsconfig files are valid
RUN ./scripts/verify-tsconfig.sh

# Fix for Playwright installation issues by skipping browser installs
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=0

# Add local @types packages to fix TypeScript errors
RUN mkdir -p node_modules/@types/node node_modules/@types/dotenv
RUN echo '{ "name": "@types/node", "version": "20.10.0" }' > node_modules/@types/node/package.json
RUN echo '{ "name": "@types/dotenv", "version": "8.2.0" }' > node_modules/@types/dotenv/package.json

# Try installing with npm if bun fails with integrity check issues
RUN bun install --no-cache || npm install

RUN bun run build

FROM node:23.3.0-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    git \
    python3 \
    unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g bun@1.2.5 turbo@2.3.3

RUN apt-get update && apt-get install -y pciutils

COPY --from=builder /app/package.json ./
COPY --from=builder /app/turbo.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/lerna.json ./
COPY --from=builder /app/renovate.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts

ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "run", "start"]
