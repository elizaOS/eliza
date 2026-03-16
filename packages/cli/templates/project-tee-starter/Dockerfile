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

COPY package.json tsconfig.json tsconfig.build.json tsup.config.ts ./
COPY src ./src
COPY assets ./assets
COPY elizadb ./elizadb
COPY knowledge ./knowledge

RUN bun install --no-cache

RUN bun run build

FROM node:23.3.0-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ffmpeg \
    git \
    make \
    python3 \
    unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g bun@1.2.5 turbo@2.3.3

COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/tsconfig.build.json ./
COPY --from=builder /app/tsup.config.ts ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/elizadb ./elizadb
COPY --from=builder /app/knowledge ./knowledge
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/src ./src

ENV NODE_ENV=production

EXPOSE 3000
EXPOSE 50000-50100/udp

CMD ["bun", "run", "start"]
