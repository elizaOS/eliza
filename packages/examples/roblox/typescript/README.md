## Roblox agent bridge (TypeScript)

This example runs an **elizaOS AgentRuntime** that Roblox can call via HTTP for inbound chat, while the agent can publish outbound messages/actions to Roblox via `@elizaos/plugin-roblox`.

### Setup

- **Roblox Open Cloud**:
  - Create an Open Cloud API key with permissions for:
    - MessagingService Publish
    - (optional) DataStore access
  - Note your **Universe ID**
- **Roblox Studio**:
  - Copy `examples/roblox/roblox-studio/ServerScriptService/ElizaBridge.server.lua` into `ServerScriptService`
  - Enable **HttpService** and set `AGENT_URL` to your public URL

### Environment variables

- **Required for outbound agent → Roblox**:
  - `ROBLOX_API_KEY`
  - `ROBLOX_UNIVERSE_ID`
- **Optional “echo replies into Roblox”**:
  - `ROBLOX_ECHO_TO_GAME=true` (publishes the agent reply back to the MessagingService topic)
- **Inbound auth (recommended)**:
  - `ELIZA_ROBLOX_SHARED_SECRET` (must match `SHARED_SECRET` in the Luau script)
- **Database (required for AgentRuntime)**:
  - `POSTGRES_URL` (recommended; production-grade)
    - If you don’t set `POSTGRES_URL`, `@elizaos/plugin-sql` falls back to PGlite, which can be less reliable depending on platform/runtime.
- **LLM model**:
  - If you set `OPENAI_API_KEY`, the bridge uses `@elizaos/plugin-openai`.
  - If `OPENAI_API_KEY` is not set, it falls back to **classic ELIZA** (no OpenAI required).

### Run

```bash
cd examples/roblox/typescript
bun install

# Start Postgres locally (recommended)
docker compose up -d
export POSTGRES_URL="postgresql://eliza:eliza@localhost:55432/eliza"

# Optional: enable OpenAI (recommended)
export OPENAI_API_KEY="..."

bun run start
```

The server exposes:
- `POST /roblox/chat` (Roblox → agent)
- `GET /health`

