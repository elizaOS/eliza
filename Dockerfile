FROM node:23.3.0-slim AS builder

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ffmpeg \
    g++ \
    git \
    make \
    python3 \
    unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g bun@1.2.5 turbo@2.3.3
RUN ln -s /usr/bin/python3 /usr/bin/python
COPY bun.lock drizzle.config.ts package.json tsconfig.build.json tsconfig.json tsup.config.ts vitest.config.ts ./
# COPY patches ./patches
RUN bun install --no-cache

COPY drizzle ./drizzle
COPY src ./src
RUN bun run build

FROM node:23.3.0-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    ffmpeg \
    git \
    python3 \
    unzip \
    libnss3 \                         
    libnspr4 \                                    
    libatk1.0-0 \                                 
    libatk-bridge2.0-0 \                          
    libcups2 \                                    
    libatspi2.0-0 \                               
    libxcomposite1 \                              
    libxdamage1 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
    
RUN npm install -g bun@1.2.5 turbo@2.3.3

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/bun.lock ./bun.lock
COPY --from=builder /app/drizzle ./drizzle
# now trying to rebuild at start, so include sources, todo need to disable build
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/tsconfig.build.json ./tsconfig.build.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/tsup.config.ts ./tsup.config.ts
COPY --from=builder /app/vitest.config.ts ./vitest.config.ts
COPY --from=builder /app/src ./src

RUN npx patchright install chromium

ENV NODE_ENV=production

EXPOSE 3000
CMD ["bun", "run", "start"]
