# elizaOS Cloudflare Worker (Rust)

A serverless AI agent running on Cloudflare Workers using Rust compiled to WebAssembly.

## Prerequisites

- Rust 1.70+
- [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- [worker-build](https://github.com/cloudflare/workers-rs)

## Setup

```bash
# Install worker-build
cargo install worker-build

# Set your API key
wrangler secret put OPENAI_API_KEY
```

## Development

```bash
# Build and run locally
wrangler dev
```

The worker will start at `http://localhost:8788`.

## Deploy

```bash
wrangler deploy
```

## API

Same as the TypeScript worker - see the parent [README](../README.md).

## Benefits of Rust Worker

- **Performance**: Near-native speed with WASM
- **Memory safety**: Rust's guarantees at runtime
- **Smaller bundle**: Optimized WASM binary
- **Type safety**: Compile-time error checking



