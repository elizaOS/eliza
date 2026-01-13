# X (Twitter) Agent Example (Grok + X API)

A full-featured elizaOS agent that runs on **X (formerly Twitter)** and uses:

- **Grok (xAI)** for text generation + embeddings (via `@elizaos/plugin-xai` / `elizaos-plugin-xai` / `elizaos-plugin-xai` Rust crate)
- **X API v2** for reading mentions and creating posts/replies

This example is implemented in **TypeScript**, **Python**, and **Rust**.

## What this example does

- **Replies to @mentions** by polling X search results and routing each mention through the **full elizaOS pipeline** (`messageService.handleMessage()` / `message_service.handle_message()`).
- **Optional automated posting** (TypeScript version uses the plugin’s built-in post loop; Python/Rust versions include an explicit loop).
- **Dry run mode** supported via `X_DRY_RUN=true` (no writes to X).

## Prerequisites

- An **xAI API key** for Grok (`XAI_API_KEY`).
- An **X developer app** with **user-context write access**.
  - This example defaults to **OAuth 1.0a user-context** credentials:
    - `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`

## Quick start

### 1) Configure environment

```bash
cd examples/xai
cp env.example .env
# edit .env
```

Start with `X_DRY_RUN=true` until you’ve verified everything.

### 2) Run (choose language)

#### TypeScript

```bash
# from repo root (build workspace deps)
bun install
bun run build

cd examples/xai/typescript
bun install
bun run start
```

#### Python

```bash
cd examples/xai/python
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python agent.py
```

#### Rust

```bash
cd examples/xai/rust/xai-agent
cargo run --release
```

## Configuration

### Grok (xAI)

- `XAI_API_KEY` (required)
- `XAI_BASE_URL` (optional, default `https://api.x.ai/v1`)
- `XAI_SMALL_MODEL` (optional, default `grok-3-mini`)
- `XAI_MODEL` / `XAI_LARGE_MODEL` (optional, default `grok-3`)
- `XAI_EMBEDDING_MODEL` (optional, default `grok-embedding`)

### X API v2 auth (recommended: OAuth 1.0a env credentials)

- `X_AUTH_MODE=env`
- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_TOKEN_SECRET`

### Agent behavior toggles

- `X_DRY_RUN` (default: `true`)
- `X_ENABLE_REPLIES` (default: `true`)
- `X_ENABLE_POST` (default: `false`)
- `X_POST_INTERVAL_MIN`, `X_POST_INTERVAL_MAX` (minutes; used when posting is enabled)
- `X_ENGAGEMENT_INTERVAL_MIN`, `X_ENGAGEMENT_INTERVAL_MAX` (minutes; polling cadence)
- `X_MAX_ENGAGEMENTS_PER_RUN` (default: `5`)
- `X_TARGET_USERS` (optional comma list or `*` for broad engagement)

## How it works (canonical pipeline)

For each incoming mention:

1. **Create a `Memory`** for the X post (stable IDs per post/conversation).\n
2. **Ensure connection/room** exists in elizaOS (world + room + entity).\n
3. Call **`messageService.handleMessage()`** which:\n
   - composes state (providers)\n
   - evaluates `shouldRespond`\n
   - plans actions (if enabled)\n
   - generates a response\n
   - runs evaluators\n
4. The **callback posts a reply** to X (unless `X_DRY_RUN=true`).\n

TypeScript relies on the `plugin-xai` X service background clients for polling and posting; Python/Rust run explicit polling loops in the example.\n

