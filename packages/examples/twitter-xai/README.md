# X (Twitter) Agent Example (Grok + X API)

A full-featured elizaOS agent that runs on **X (formerly Twitter)** using two
plugins:

- **Grok (xAI)** for text generation + embeddings — `@elizaos/plugin-xai`
- **X API v2** for mentions, posts, and timeline interactions —
  `@elizaos/plugin-x`

## What this example does

- **Replies to @mentions** by routing each mention through the elizaOS message
  pipeline (`runtime.messageService.handleMessage(...)`).
- **Optional automated posting** via `plugin-x`'s built-in post loop.
- **Dry run mode** via `TWITTER_DRY_RUN=true` (no writes to X).

## Prerequisites

- An **xAI API key** for Grok (`XAI_API_KEY`).
- An **X developer app** with **user-context write access**.
  - Default: **OAuth 1.0a user-context** credentials (`TWITTER_API_KEY`,
    `TWITTER_API_SECRET_KEY`, `TWITTER_ACCESS_TOKEN`,
    `TWITTER_ACCESS_TOKEN_SECRET`).
  - Alternative: **OAuth 2.0 PKCE** (interactive login) with
    `TWITTER_AUTH_MODE=oauth`.
  - Alternative: **Eliza Cloud broker** with `TWITTER_AUTH_MODE=broker` —
    delegates OAuth to a managed service.

## Quick start

### 1) Configure environment

```bash
cd packages/examples/twitter-xai
cp env.example .env
# edit .env
```

Start with `TWITTER_DRY_RUN=true` until you've verified everything.

### 2) Run

```bash
# from repo root (build workspace deps)
bun install
bun run build

cd packages/examples/twitter-xai
bun run start
```

## Configuration

### Grok (xAI) — `@elizaos/plugin-xai`

- `XAI_API_KEY` (required)
- `XAI_BASE_URL` (default `https://api.x.ai/v1`)
- `XAI_SMALL_MODEL` (default `grok-3-mini`)
- `XAI_MODEL` (default `grok-3`)
- `XAI_EMBEDDING_MODEL` (default `grok-embedding`)

### X API v2 auth — `@elizaos/plugin-x`

- `TWITTER_AUTH_MODE` — `env` (default), `oauth`, or `broker`.

OAuth 1.0a user context (`TWITTER_AUTH_MODE=env`):

- `TWITTER_API_KEY`
- `TWITTER_API_SECRET_KEY`
- `TWITTER_ACCESS_TOKEN`
- `TWITTER_ACCESS_TOKEN_SECRET`

OAuth 2.0 PKCE (`TWITTER_AUTH_MODE=oauth`):

- `TWITTER_CLIENT_ID`
- `TWITTER_REDIRECT_URI`
- `TWITTER_SCOPES` (default `tweet.read tweet.write users.read offline.access`)

Eliza Cloud broker (`TWITTER_AUTH_MODE=broker`):

- `TWITTER_BROKER_URL`

### Agent behavior toggles

- `TWITTER_DRY_RUN` (default `true`)
- `TWITTER_ENABLE_REPLIES` (default `true`)
- `TWITTER_ENABLE_POST` (default `false`)
- `TWITTER_ENABLE_ACTIONS` (default `false`)
- `TWITTER_TARGET_USERS` (optional comma list or `*` for broad engagement)

## How it works

`plugin-x`'s `XService` runs background clients for posting,
interactions, timeline, and discovery. Incoming mentions are routed into the
runtime via `runtime.messageService.handleMessage(...)` so you get the standard
state-composition → model → action pipeline.
