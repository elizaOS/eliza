# @elizaos/plugin-scape

First-class Eliza agent integration for **xRSPS** — a TypeScript OSRS private server.

## What this plugin does

`'scape` turns a running xRSPS instance into an autonomous-agent playground within the elizaOS runtime. When the `'scape` app is launched:

1. The viewer iframe loads the xRSPS React client. The default points at the live production deployment at [`https://scape-client-2sqyc.kinsta.page`](https://scape-client-2sqyc.kinsta.page). Override `SCAPE_CLIENT_URL` to point at a local dev server (`http://localhost:3000`) or your own fork's deployment.

2. The plugin's `ScapeGameService` connects to xRSPS's **bot-SDK** endpoint — a JSON-encoded WebSocket at `wss://scape-96cxt.sevalla.app/botsdk` by default (production deployment, shared HTTP server, path-routed, TLS terminated by Sevalla's ingress). Override `SCAPE_BOT_SDK_URL` to `ws://127.0.0.1:8080/botsdk` for a local dev stack.

3. The elizaOS LLM runtime drives the agent via the action list (`walk_to`, `attack`, `chat_public`, `eat`, `drop`, `set_goal`, `complete_goal`, `remember`) every N seconds, with optional directed prompts from the operator UI.

## Capabilities

- **Autonomous loop** — the agent picks actions via LLM inference on every tick. Configurable interval and model tier.
- **Perception providers** — bot vitals, inventory, nearby NPCs/players/items, and the Scape Journal are injected into each LLM prompt.
- **Scape Journal** — persistent cross-session memory. Memories, goals, and progress snapshots are written to `~/.eliza/scape-journals/<agentId>.json`.
- **Operator steering** — send a directive via the Apps UI or `POST /api/apps/scape/prompt` to override the agent's current goal. Supports `pause` / `resume` to halt and restart the autonomous loop.
- **In-game steering** — a human player can type `::steer <text>` in public game chat to set the agent's goal.
- **First-class account** — the agent logs in as a real xRSPS player account using the same scrypt auth and Postgres-backed persistence human players use. Skills, inventory, position, and journal accumulate across sessions.

## Actions

| Action | Operations |
|--------|-----------|
| `SCAPE` | `walk_to (x, z, run?)`, `attack (npcId)`, `chat_public (message)`, `eat (item?)`, `drop (item)`, `set_goal (title, notes?)`, `complete_goal (status?, goalId?, notes?)`, `remember (notes, kind?, weight?)` |

Requires `minRole: ADMIN`.

## Env vars / config

| Variable | Default | Purpose |
|----------|---------|---------|
| `SCAPE_BOT_SDK_TOKEN` | *(required)* | Shared secret matching xRSPS `BOT_SDK_TOKEN`. Without this the plugin will not connect. |
| `SCAPE_BOT_SDK_URL` | `wss://scape-96cxt.sevalla.app/botsdk` | bot-SDK WebSocket endpoint. Override to `ws://127.0.0.1:8080/botsdk` for local dev. |
| `SCAPE_CLIENT_URL` | `https://scape-client-2sqyc.kinsta.page` | xRSPS client URL the viewer iframe loads. Override to `http://localhost:3000` for local dev. |
| `SCAPE_AGENT_NAME` | `scape-agent` | In-game display name (max 12 chars). |
| `SCAPE_AGENT_PASSWORD` | *(auto-generated)* | Plaintext password for the agent's account. Leave unset to auto-generate and persist to `~/.eliza/scape-agent-identity.json`. |
| `SCAPE_AGENT_ID` | `scape-{SCAPE_AGENT_NAME}` | Stable ID across reconnects. Used as the journal filename. |
| `SCAPE_AGENT_PERSONA` | *(none)* | Persona string injected into the system prompt. |
| `SCAPE_LOOP_INTERVAL_MS` | `15000` | Autonomous LLM step interval in ms (minimum 1000). |
| `SCAPE_MODEL_SIZE` | `TEXT_SMALL` | Model tier: `TEXT_NANO`, `TEXT_SMALL`, `TEXT_MEDIUM`, `TEXT_LARGE`. |

Settings are resolved in priority order: elizaOS runtime settings (character secrets) → `process.env`.

## How to enable

Add `@elizaos/plugin-scape` to your character's plugin list and set `SCAPE_BOT_SDK_TOKEN`:

```json
{
  "plugins": ["@elizaos/plugin-scape"],
  "settings": {
    "secrets": {
      "SCAPE_BOT_SDK_TOKEN": "your-server-token"
    }
  }
}
```

The plugin auto-generates and persists an agent identity on first launch. No additional config is required for the default production xRSPS deployment.

## Protocol

Agents communicate with xRSPS over JSON frames at the `/botsdk` WebSocket path. The frame shapes in `src/sdk/types.ts` must stay compatible with xRSPS's `server/src/network/botsdk/BotSdkProtocol.ts` — the codec does structural matching, so renaming a field on either side silently breaks the wire format.

## Development

```bash
bun run --cwd plugins/plugin-scape build    # full build (JS + views + types)
bun run --cwd plugins/plugin-scape clean    # remove dist/
```

Point `SCAPE_BOT_SDK_URL` at a local xRSPS instance (`ws://127.0.0.1:8080/botsdk`) and `SCAPE_CLIENT_URL` at its React client (`http://localhost:3000`) for local development.
