# Deployment Guide (elizaOS)

## Overview

elizaOS agents can be deployed to a variety of platforms. This repository includes **production-ready examples** in the `examples/` directory, with implementations in **TypeScript, Python, and Rust** for each deployment target.

The TypeScript runtime (`AgentRuntime`) is designed to run in both long-lived and serverless contexts.

| Platform              | Directory              | Languages                    | Runtime Type       |
| --------------------- | ---------------------- | ---------------------------- | ------------------ |
| **Cloudflare Workers** | `examples/cloudflare/` | TypeScript, Rust (WASM), Python | Edge/Serverless    |
| **AWS Lambda**        | `examples/aws/`        | TypeScript, Python, Rust     | Serverless         |
| **GCP Cloud Run**     | `examples/gcp/`        | TypeScript, Python, Rust     | Container          |
| **Vercel**            | `examples/vercel/`     | TypeScript, Python, Rust (WASM) | Edge/Serverless |
| **Supabase**          | `examples/supabase/`   | TypeScript, Rust (WASM)      | Edge (Deno)        |
| **Local/CLI**         | `examples/chat/`       | TypeScript, Rust             | Long-running       |

## Core deployment pattern

Regardless of target, the pattern is:

1. **Create a character** — Provide at least `name` and optionally `bio`, `system`, settings, secrets.
2. **Instantiate runtime** — `new AgentRuntime({ character, plugins: [...] })`
3. **Initialize** — `await runtime.initialize({ skipMigrations?: boolean })`
4. **Ensure a connection** — Use `runtime.ensureConnection(...)` so entities/rooms/worlds exist.
5. **Process messages** — Create `Memory` (often with `createMessageMemory(...)`) and call `runtime.messageService.handleMessage(runtime, message, callback)`

## Cloudflare Workers

**Location:** `examples/cloudflare/`

Cloudflare Workers provide globally distributed edge compute with sub-millisecond cold starts.

### Quick start (TypeScript)

```bash
cd examples/cloudflare
bun install

# Set API key for local dev
export OPENAI_API_KEY=your_key_here

# Start local dev server
bun run dev
```

### Deploy to production

```bash
# Set secret (first time only)
wrangler secret put OPENAI_API_KEY

# Deploy
wrangler deploy
```

### Multi-language support

| Language   | Directory              | Port | Notes                        |
| ---------- | ---------------------- | ---- | ---------------------------- |
| TypeScript | `./` (root)            | 8787 | Primary, with streaming      |
| Rust       | `./rust-worker/`       | 8788 | High-performance WASM        |
| Python     | `./python-worker/`     | 8789 | Beta support                 |

### Features

- REST API for chat (`POST /chat`, `POST /chat/stream`)
- Streaming responses (TypeScript)
- Conversation memory
- Customizable character via `wrangler.toml`
- Compatible with any OpenAI-compatible API

### Production considerations

- Use **Cloudflare KV** or **Durable Objects** for persistent conversation storage
- Configure rate limiting in `wrangler.toml`
- Set up custom domains

See `examples/cloudflare/README.md` for complete documentation.

---

## AWS Lambda

**Location:** `examples/aws/`

Deploy agents as serverless functions with AWS Lambda and API Gateway.

### Quick start

```bash
cd examples/aws
bun install

# Deploy using AWS SAM
sam build
sam deploy --guided
```

### Multi-language support

| Language   | Directory       | Runtime              |
| ---------- | --------------- | -------------------- |
| TypeScript | `typescript/`   | Node.js 20           |
| Python     | `python/`       | Python 3.11          |
| Rust       | `rust/`         | provided.al2 (cargo-lambda) |

### Project structure

```
examples/aws/
├── template.yaml       # SAM template
├── samconfig.toml      # SAM configuration
├── scripts/deploy.sh   # Deployment script
├── typescript/handler.ts
├── python/handler.py
├── rust/src/lib.rs
└── test-client.ts      # Test client
```

### Singleton runtime pattern

The examples use a **singleton runtime** reused across invocations to reduce cold-start overhead:

```typescript
let runtime: AgentRuntime | null = null;

async function initializeRuntime() {
  if (!runtime) {
    runtime = new AgentRuntime({ character, plugins });
    await runtime.initialize();
  }
  return runtime;
}
```

See `examples/aws/README.md` for complete documentation.

---

## GCP Cloud Run

**Location:** `examples/gcp/`

Deploy containerized agents to Google Cloud Run with automatic scaling.

### Quick start

```bash
cd examples/gcp

# Build and deploy TypeScript version
./deploy.sh typescript

# Or use Cloud Build
gcloud builds submit --config cloudbuild.yaml
```

### Multi-language support

| Language   | Directory       | Dockerfile                    |
| ---------- | --------------- | ----------------------------- |
| TypeScript | `typescript/`   | `typescript/Dockerfile`       |
| Python     | `python/`       | `python/Dockerfile`           |
| Rust       | `rust/`         | `rust/Dockerfile`             |

### Infrastructure as Code

Terraform configuration is provided:

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values
terraform init
terraform apply
```

### Dockerfile pattern (TypeScript)

```dockerfile
# Build stage
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/handler.js"]
```

See `examples/gcp/README.md` for complete documentation.

---

## Vercel Edge Functions

**Location:** `examples/vercel/`

Deploy to Vercel's global edge network with automatic deployments from Git.

### Quick start

```bash
cd examples/vercel
bun install

# Deploy
vercel deploy
```

### Multi-language support

| Language   | Directory       | Runtime              |
| ---------- | --------------- | -------------------- |
| TypeScript | `typescript/`   | Edge Runtime         |
| Python     | `python/`       | Serverless Function  |
| Rust       | `rust/`         | Edge Runtime (WASM)  |

### Edge vs Serverless

- **Edge Functions** (TypeScript, Rust WASM): Run at the edge, fastest cold starts
- **Serverless Functions** (Python): Run in a single region, full Python support

See `examples/vercel/README.md` for complete documentation.

---

## Supabase Edge Functions

**Location:** `examples/supabase/`

Deploy to Supabase's Deno-based edge runtime.

### Quick start

```bash
cd examples/supabase

# Deploy
supabase functions deploy elizaos-agent
```

### Multi-language support

| Language   | Directory       | Notes                        |
| ---------- | --------------- | ---------------------------- |
| TypeScript | `typescript/`   | Native Deno support          |
| Rust       | `rust/`         | WASM compiled                |

**Note:** Python is not supported (Supabase uses Deno runtime).

See `examples/supabase/README.md` for complete documentation.

---

## Local development / CLI

**Location:** `examples/chat/`

Run agents locally for development and testing.

### TypeScript

```bash
cd examples/chat/typescript
bun install
bun run chat.ts
```

### Rust (WASM)

```bash
cd examples/chat/rust-wasm
bun install
bun run chat.ts  # Uses WASM-compiled Rust
```

---

## Environment variables and secrets

Secrets/config are accessed through `runtime.getSetting(...)` and/or character settings/secrets. In the TypeScript runtime initialization, persisted settings from the database are merged back into the runtime's character (see `AgentRuntime.initialize()` in `packages/typescript/src/runtime.ts`).

### Best practices

- **Never commit secrets to git**
- Use platform-specific secret management:
  - Cloudflare: `wrangler secret put`
  - AWS: Lambda environment variables or Secrets Manager
  - GCP: Secret Manager
  - Vercel: Environment variables in dashboard
  - Supabase: Edge Function secrets

### Common environment variables

| Variable           | Description                |
| ------------------ | -------------------------- |
| `OPENAI_API_KEY`   | OpenAI API key             |
| `OPENAI_BASE_URL`  | Custom OpenAI-compatible endpoint |
| `OPENAI_MODEL`     | Model to use (e.g., `gpt-5`) |
| `CHARACTER_NAME`   | Agent character name       |
| `CHARACTER_BIO`    | Agent biography            |
| `CHARACTER_SYSTEM` | System prompt              |

---

## Database and migrations

The TypeScript runtime requires a database adapter at initialization. For serverless deployments:

```typescript
// Skip migrations for faster cold starts
await runtime.initialize({ skipMigrations: true });
```

### Database options by platform

| Platform    | Recommended Database                    |
| ----------- | --------------------------------------- |
| Cloudflare  | Cloudflare D1, KV, or Durable Objects   |
| AWS Lambda  | DynamoDB, Aurora Serverless, or RDS     |
| GCP         | Cloud SQL, Firestore, or Spanner        |
| Vercel      | Vercel Postgres, Planetscale, or Neon   |
| Supabase    | Supabase Postgres (built-in)            |

---

## Docker deployments

For containerized deployments (Kubernetes, ECS, Cloud Run, etc.), use the Dockerfiles in `examples/gcp/` as templates.

### Multi-stage build pattern

```dockerfile
# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

# Stage 2: Production
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "dist/handler.js"]
```

---

## Additional deployment examples

The `examples/` directory contains many more deployment scenarios:

| Example                 | Description                              |
| ----------------------- | ---------------------------------------- |
| `examples/discord/`     | Discord bot deployment                   |
| `examples/telegram/`    | Telegram bot deployment                  |
| `examples/twitter-xai/` | Twitter/X integration                    |
| `examples/next/`        | Next.js web application                  |
| `examples/react/`       | React frontend integration               |
| `examples/rest-api/`    | REST API servers (Express, Hono, etc.)   |
| `examples/app/`         | Desktop apps (Electron, Tauri)           |

---

## Getting started via templates

The `elizaos` package in this repo is an **example scaffolder** (commands: `create`, `info`, `version`) located at `packages/elizaos/`.

Use it to copy an example project into a new directory, then follow that example's `package.json` scripts (for instance, the chat example uses `bun run chat.ts`).

## Getting help

- Each example directory contains a detailed `README.md`
- Check `examples/` for the most up-to-date deployment patterns
- See `ARCHITECTURE.md` for runtime internals
- See `CORE_CONCEPTS.md` for conceptual overview
