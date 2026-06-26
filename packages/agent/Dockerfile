# Use the official Bun image
FROM oven/bun:latest AS builder

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential

WORKDIR /app

COPY . .

RUN bun install
RUN bun run generate:action-search-keywords

# Final runtime stage
FROM oven/bun:latest AS runner
WORKDIR /app

COPY --from=builder /app /app

EXPOSE 3000

CMD ["sh","-c","echo Starting Eliza && bun run start"]
