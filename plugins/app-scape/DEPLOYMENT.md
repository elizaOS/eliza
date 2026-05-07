# `@elizaos/app-scape` — Deployment Guide

This document covers running the 'scape plugin end-to-end. The
**default configuration** already points at the live production
deployment of 'scape — no extra setup needed to launch it from the
eliza apps grid. This document covers overriding those defaults
for local dev or running against your own fork's deployment.

## Default live deployment

When you click **'scape** in the eliza apps grid, the viewer
iframe loads:

    https://scape-client-2sqyc.kinsta.page

That's a React client hosted as a Sevalla static site with its
WebSocket URL, OSRS cache URL, and map-tile URL all baked in at
build time. It connects to:

| Component      | URL                                                | Hosted on                        |
|----------------|----------------------------------------------------|----------------------------------|
| Game server    | `wss://scape-96cxt.sevalla.app`                   | Sevalla Application (s2 shape)   |
| OSRS cache     | `https://scape-cache-skrm0.sevalla.storage/caches/` | Sevalla Object Storage (R2 + CDN) |
| Map tiles      | `https://scape-cache-skrm0.sevalla.storage/map-images/` | Same bucket                   |

**This works out of the box** — open the app, register an
account on the login screen, play. No env vars required on the
eliza side.

**Bot-SDK is live on production.** The autonomous LLM loop connects
to `wss://scape-96cxt.sevalla.app/botsdk` by default — the same host
as the main game server, path-routed over the shared HTTP server on
port 8080, with TLS terminated by Sevalla's ingress. All you need is
`SCAPE_BOT_SDK_TOKEN` set to the shared secret (matching the server's
`BOT_SDK_TOKEN` env var) and the autonomous agent will spawn and
start playing. Without the token the viewer still works for manual
play but the loop stays idle.

## What you need (dev loop only)

Only required if you want to point the plugin at a **local** xRSPS
dev stack instead of the production deployment.

1. **xRSPS running locally**, with the bot-SDK endpoint enabled:
   - `BOT_SDK_TOKEN` set in the environment
   - The main game HTTP server (default port 8080) reachable from
     wherever eliza runs — the bot-SDK is routed on the same port
     at path `/botsdk`
2. **The React client running** locally (default
   `http://localhost:3000`)
3. **eliza runtime** with this plugin installed (it already is if
   you're in this repo — `plugins/app-scape/` is a workspace package)

## Environment variables

The plugin reads settings from:

1. `runtime.getSetting(KEY)` — via character secrets in eliza
2. `process.env[KEY]` — via shell or systemd unit
3. Hardcoded defaults (only for localhost dev)

| Variable                   | Default                                           | Purpose                                                                                              |
|----------------------------|---------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `SCAPE_CLIENT_URL`         | `https://scape-client-2sqyc.kinsta.page`         | URL the viewer iframe points at. Defaults to the live 'scape deployment; override to `http://localhost:3000` for local dev. |
| `SCAPE_BOT_SDK_URL`        | `wss://scape-96cxt.sevalla.app/botsdk`           | WebSocket URL of the xRSPS bot-SDK endpoint. Defaults to the live Sevalla deployment (shared HTTP server, path-routed at `/botsdk`, TLS by ingress). Override to `ws://127.0.0.1:8080/botsdk` for local dev. |
| `SCAPE_BOT_SDK_TOKEN`      | *(unset → autonomous loop disabled)*             | Must match the xRSPS server's `BOT_SDK_TOKEN`. Without it the viewer still works for manual play.   |
| `SCAPE_AGENT_NAME`         | `scape-agent`                                     | In-game display name for the agent. Used as the account username (scrypt-auth).                    |
| `SCAPE_AGENT_PASSWORD`     | *(unset → auto-generated + persisted to disk)*   | Plaintext password for the agent's account. Auto-registers on first spawn.                         |
| `SCAPE_AGENT_ID`           | `scape-${SCAPE_AGENT_NAME}`                       | Stable identifier for the agent across reconnects. Used as the journal filename.                   |
| `SCAPE_AGENT_PERSONA`      | *(empty)*                                         | Short persona string fed into the LLM's system prompt. Keep it under 200 chars.                    |
| `SCAPE_LOOP_INTERVAL_MS`   | `15000`                                           | How often the autonomous LLM loop fires. Lower = more expensive.                                    |
| `SCAPE_MODEL_SIZE`         | `TEXT_SMALL`                                      | Which elizaOS model tier to use. Try `TEXT_MINI` for cheaper, `TEXT_LARGE` for smarter.            |

## Playing against the live deployment (no config)

If you just want to click **'scape** in the eliza apps grid and
land in the game, you don't need to set anything. The plugin
defaults to the production deployment URL, so the viewer iframe
will load the hosted client directly. Register an account on the
login screen (xRSPS scrypts your password and writes it to a
Sevalla-managed Postgres database, so accounts persist across
server redeploys) and play.

To enable the autonomous agent loop on top of the viewer, set
`SCAPE_BOT_SDK_TOKEN` to the xRSPS server's `BOT_SDK_TOKEN`
shared secret. Everything else defaults correctly to the live
deployment.

Skip the rest of this section unless you want to run a local
dev stack.

## Dev loop (single host, autonomous agent)

Assumes xRSPS and eliza are both running on your laptop and you
want to run the autonomous LLM loop against a local xRSPS server
with a bot-SDK endpoint enabled.

```bash
# Terminal 1 — xRSPS
cd ~/xrsps-typescript   # or ~/scape
export BOT_SDK_TOKEN=dev-secret
bun run dev
```

`bun run dev` launches server + React client + a placeholder
`agent-dev.ts` random-walk loop in a unified mprocs TUI. You can
watch all three tabs with `Ctrl-A` + arrow keys.

```bash
# Terminal 2 — eliza
cd ~/eliza
export SCAPE_CLIENT_URL=http://localhost:3000
export SCAPE_BOT_SDK_URL=ws://127.0.0.1:8080/botsdk
export SCAPE_BOT_SDK_TOKEN=dev-secret
export SCAPE_AGENT_PASSWORD=my-dev-password
bun run dev  # or however you start eliza
```

The plugin connects, auto-registers `scape-agent` as a real account
on first run, and starts its autonomous loop. The journal file appears
at `~/.eliza/scape-journals/scape-scape-agent.json` (JSON-encoded,
not JSON).

Click the 'scape tile in the eliza apps grid and the viewer iframe
loads the local xRSPS React client at `http://localhost:3000` (because
of the `SCAPE_CLIENT_URL` override). Log in with any username + an
8+-character password; you're now in the same world as the agent and
can watch it play. Type `::steer <directive>` in public chat to hand
it a high-priority goal.

## Production deployment

### 1. Deploy xRSPS with TLS

Follow `xrsps-typescript/docs/deployment.md` for the Caddy reverse
proxy setup. Your xRSPS server ends up at `wss://game.yourdomain.com`.
The bot-SDK shares the main HTTP server and is routed by URL path
at `/botsdk`, so the same host/port handles both the binary game
protocol and the JSON agent protocol — TLS is terminated once at
the ingress.

**Important**: the bot-SDK is gated on `BOT_SDK_TOKEN` (if the env
var is unset the endpoint is disabled entirely). Anyone who learns
the token can spawn agents into your world — treat it like a root
password. Rotate it via the xRSPS app env-var panel and trigger a
restart deploy to take effect.

### 2. Host the React client

The xRSPS client is a CRA build. Host `build/` on any static host
(Vercel, Netlify, Cloudflare Pages, a second Caddy site). Remember
that the client needs `REACT_APP_WS_URL` set at build time to point
at your xRSPS game server, not localhost.

### 3. Configure eliza

In your eliza character's secrets or the eliza runtime env:

```bash
SCAPE_CLIENT_URL=https://game-client.yourdomain.com
SCAPE_BOT_SDK_URL=wss://game.yourdomain.com/botsdk
SCAPE_BOT_SDK_TOKEN=<same secret as xrsps BOT_SDK_TOKEN>
SCAPE_AGENT_NAME=your-agent-name
SCAPE_AGENT_PASSWORD=<strong password, ≥12 chars>
SCAPE_LOOP_INTERVAL_MS=15000
```

### 4. Verify

From the eliza runtime host:

```bash
# HTTP ping: POST a directive to the agent
curl -X POST https://your-eliza-host/api/apps/scape/prompt \
  -H "Content-Type: application/json" \
  -d 'text: mine copper ore near Lumbridge'

# Read the journal
curl https://your-eliza-host/api/apps/scape/journal

# Read goals
curl https://your-eliza-host/api/apps/scape/goals
```

And from inside the game as a human player:

```
::steer greet the nearest player
```

The next LLM step should honor the directive.

## Operational tips

- **Journal backups**: `~/.eliza/scape-journals/*.json` is the
  agent's long-term memory. Back it up alongside xRSPS
  `accounts.json` and `player-state.json`.
- **Multiple agents**: spin up multiple eliza characters, give each
  a different `SCAPE_AGENT_NAME` + `SCAPE_AGENT_ID`. They get
  separate journals and separate player accounts in xRSPS.
- **Swap models mid-session**: set `SCAPE_MODEL_SIZE=TEXT_LARGE`
  when you want the agent to be smart for a particular task (e.g.
  deep exploration). Drop back to `TEXT_SMALL` for grinding.

## Verify scripts

The plugin ships 7 verify scripts, all in `plugins/app-scape/scripts/`:

| Script                   | What it proves                                                                |
|--------------------------|-------------------------------------------------------------------------------|
| `verify-pr2.ts`          | Plugin loads, metadata shape is correct, curated registry lookup works       |
| `verify-pr3.ts`          | JSON codec round-trips, BotSdk/BotManager API shape, live connect+spawn+perception |
| `verify-pr4.ts`          | Autonomous loop scaffolding, providers render JSON, param parser             |
| `verify-pr4-live-loop.ts`| Full end-to-end LLM step via stub runtime — agent visibly moves              |
| `verify-pr5.ts`          | All 5 world actions (walkTo, chat, attack, drop, eat) work + negative paths  |
| `verify-pr6.ts`          | Journal JSON persistence, memory prune-by-weight, goal lifecycle             |
| `verify-pr7.ts`          | HTTP routes (POST /prompt, GET /journal, GET /goals) accept JSON             |
| `verify-pr7-live.ts`     | Real ScapeGameService + xRSPS + HTTP POST → operator goal → journal         |

And xrsps ships two verify scripts in `scripts/`:

| Script                   | What it proves                                                                |
|--------------------------|-------------------------------------------------------------------------------|
| `test-botsdk.ts`         | xRSPS bot-SDK auth + scrypt register + position persistence round-trip      |
| `test-steer.ts`          | Full `::steer` cross-repo flow: human chat → broadcast → agent receives     |
