# @elizaos/app-scape

First-class agent integration for **xRSPS** — the TypeScript OSRS private
server at [xrsps-typescript](https://github.com/xrsps/xrsps-typescript).

## What this plugin does

`'scape` turns a running xRSPS instance into an autonomous-agent playground
for the eliza runtime. When you click **'scape** in the apps launcher:

1. The viewer iframe loads the xRSPS React client — by default the
   production 'scape deployment at
   [`https://scape-client-2sqyc.kinsta.page`](https://scape-client-2sqyc.kinsta.page),
   a React/WebGL build hosted as a Sevalla static site. It's wired at
   build time to a live game server at `wss://scape-96cxt.sevalla.app`
   and an OSRS cache + map-tile bucket at
   `https://scape-cache-skrm0.sevalla.storage`. Override
   `SCAPE_CLIENT_URL` to point at a local `http://localhost:3000` dev
   server or your own fork's deployment.
2. The plugin's `ScapeGameService` connects to xRSPS's **bot-SDK**
   endpoint — a JSON-encoded WebSocket at
   `wss://scape-96cxt.sevalla.app/botsdk` by default. That's the
   production deployment: the bot-SDK shares the main game server's
   HTTP port (8080) and is routed by URL path, so TLS is terminated by
   Sevalla's ingress and everything flows over a single public
   WebSocket endpoint. Spawning creates a first-class agent-player
   account using the same scrypt auth + Postgres-backed persistence
   human logins use. Override `SCAPE_BOT_SDK_URL` to
   `ws://127.0.0.1:8080/botsdk` for a local dev stack.
3. The eliza LLM runtime drives the agent via the action list (walk,
   fight, chat, skill, bank, ...) every N seconds, with optional
   directed prompts from the operator UI.

## Why "first-class citizen"?

The agent isn't a scripted bot glued on top of the client protocol. It's
a `PlayerState` in the xRSPS world with an optional `AgentComponent`
attached — same tick loop, same combat rules, same autosave, same
visibility to human players. Human and agent logins share the *exact*
same account store, save file, and code path. The only differences are:

- Agents talk over JSON frames at path `/botsdk` on the shared HTTP
  server (default port 8080) instead of the binary game protocol
  on `/`. Both endpoints share a single port so TLS is terminated
  once at the ingress.
- Agents carry an `AgentComponent` on their `PlayerState` that holds
  perception snapshots, action queues, journal refs, and goals.

This is the first step toward turning xRSPS into an ECS-for-agents.

## Protocol

Agents speak JSON — the same structured format used by the native tool-calling
runtime and trajectory viewer,
typically 40–60% cheaper than JSON for the kinds of state snapshots an
agent loop emits every few seconds. The full frame reference lives in
the xRSPS server at
[`server/src/network/botsdk/BotSdkProtocol.ts`](https://github.com/xrsps/xrsps-typescript/blob/main/server/src/network/botsdk/BotSdkProtocol.ts).

## Env vars

| Variable              | Default                                         | Purpose                                          |
|-----------------------|-------------------------------------------------|--------------------------------------------------|
| `SCAPE_CLIENT_URL`    | `https://scape-client-2sqyc.kinsta.page`        | xRSPS client URL the viewer iframe points at. Set to `http://localhost:3000` for local dev. |
| `SCAPE_BOT_SDK_URL`   | `wss://scape-96cxt.sevalla.app/botsdk`          | bot-SDK WebSocket endpoint on the xRSPS server. Defaults to the live Sevalla deployment (shared HTTP server, path-routed, TLS by ingress). Override to `ws://127.0.0.1:8080/botsdk` for local dev. |
| `SCAPE_BOT_SDK_TOKEN` | *(unset → autonomous loop disabled)*            | Shared secret matching xRSPS `BOT_SDK_TOKEN`.   |
| `SCAPE_AGENT_NAME`    | `scape-agent`                                   | In-game display name for the agent.              |
| `SCAPE_AGENT_PASSWORD`| *(unset → auto-generated + persisted to disk)*  | Plaintext password for the agent's account.    |
| `SCAPE_LOOP_INTERVAL_MS` | `15000`                                      | Autonomous LLM step interval.                    |
| `SCAPE_MODEL_SIZE`    | `TEXT_SMALL`                                    | eliza model tier for the loop.                  |

## Scope by PR

- **PR 2 (this):** Plugin skeleton, curated-registry entry, viewer route
  embedding the xRSPS client. No agent loop yet.
- **PR 3:** Bot-SDK client (`sdk/`) + connection manager + empty game
  service. Plugin connects to xRSPS and logs `agent spawned`, but
  doesn't do anything afterward.
- **PR 4:** First LLM loop + 5 actions + 3 providers. Watch the agent
  walk itself one tile at a time based on model output.
- **PR 5:** Full action toolbelt (~25 actions), world-knowledge
  provider, skill data.
- **PR 6:** Scape Journal — persistent memory/goals/progress.
- **PR 7:** Operator-directed prompts via `POST /api/apps/scape/prompt`.
- **PR 8:** Docs, deployment guide, end-to-end verification.
