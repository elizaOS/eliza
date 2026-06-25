# Use the official Bun image
FROM oven/bun:1.1.26-slim AS builder
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential

WORKDIR /app

# Copy EVERYTHING from the root context
# Because Railway's Root Directory is now set to /, 
# Bun can see the root package.json and pnpm-workspace.yaml
COPY . .

# Install dependencies using Bun
RUN bun install --ignore-scripts

# Final runtime stage
FROM oven/bun:1.1.26-slim AS runner
WORKDIR /app

# Copy the built files from the builder stage
COPY --from=builder /app /app

EXPOSE 3000

# Run the agent specifically from the monorepo
CMD ["sh","-c","echo START && bun run start"]
