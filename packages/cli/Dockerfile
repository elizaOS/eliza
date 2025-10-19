# ElizaOS Project Dockerfile
FROM node:20-alpine

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY bun.lockb* ./

# Install dependencies
RUN npm install -g bun
RUN bun install --production

# Copy project files
COPY . .

# Build the project
RUN bun run build || true

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error('unhealthy')})"

# Start the application
CMD ["bun", "run", "start"]
