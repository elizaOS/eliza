FROM node:23.3.0-slim

# Install essential dependencies for the build process
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



# Install bun globally with npm
RUN npm install -g bun

# Add bun global bin to PATH for root and node users
ENV PATH="/root/.bun/bin:/home/node/.bun/bin:$PATH"

# Create a wrapper script for elizaos that uses the local installation
RUN echo '#!/bin/bash\nexec /app/node_modules/.bin/elizaos "$@"' > /usr/local/bin/elizaos && \
    chmod +x /usr/local/bin/elizaos

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install

# Copy the rest of the application
COPY . .

# Build the application
RUN bun run build

# Change ownership of the app directory to node user
RUN chown -R node:node /app

# Create node user's bun directory
RUN mkdir -p /home/node/.bun && chown -R node:node /home/node/.bun

# Switch to non-root user
USER node


# Environment variables should be provided at runtime (e.g., via docker-compose.yaml)

# Expose port (adjust if needed based on your application)
EXPOSE 3000


# Start the application
CMD ["elizaos", "start"]