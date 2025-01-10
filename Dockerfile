# Use a specific Node.js version for better reproducibility
FROM node:23.3.0-slim AS builder

# Install pnpm globally and install necessary build tools
RUN npm install -g pnpm@9.4.0 && \
    apt-get update && \
    apt-get install -y git python3 make g++ tini && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set Python 3 as the default python
RUN ln -s /usr/bin/python3 /usr/bin/python

# Set the working directory
WORKDIR /app

# Copy package.json and other configuration files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./

# Copy the rest of the application code
COPY agent ./agent
COPY packages ./packages
COPY scripts ./scripts
COPY characters ./characters

# Install dependencies and build the project
RUN pnpm install \
    && pnpm build-docker

# Prune dev dependencies
RUN pnpm prune --prod

# Create a non-root user
RUN adduser --disabled-password --gecos "" appuser

# Set environment variables for Node.js
ENV NODE_OPTIONS="--unhandled-rejections=strict --no-warnings --enable-source-maps"
ENV NODE_NO_WARNINGS=1

# Switch to non-root user
USER appuser

# Use tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the application with the new loader syntax
CMD ["node", \
     "--import", "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('ts-node/esm', pathToFileURL('./'))", \
     "/app/agent/src/index.ts", \
     "--isRoot"]