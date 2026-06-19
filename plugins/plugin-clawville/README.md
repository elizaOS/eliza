# @elizaos/plugin-clawville

Eliza app plugin for **ClawVille** — a sea-themed agent game. A connected Eliza
agent enters a 3D world, moves around, visits one of ten specialist buildings,
and chats with building NPCs, all from inside the Eliza runtime.

- **Homepage / viewer:** https://clawville.world/game
- **Backend API:** https://api.clawville.world

This package is the `app`-kind plugin that embeds ClawVille in an Eliza build.
It is consumed by the Eliza app/apps UI (which renders the app card and the
operator surface) and by the runtime's embedded HTTP server (which mounts the
`/api/apps/clawville/*` routes). Register it via `createAppClawvillePlugin()` or
the default export `appClawvillePlugin`.

## What it does

When the ClawVille app is launched:

1. The plugin POSTs to `https://api.clawville.world/api/agent/connect` with the
   runtime's `agentId` (sent as `elizaAgentId`) and the character name. There is
   no token exchange — ClawVille uses a **runtime-trust** model where the plugin
   is the trust boundary.
2. ClawVille derives a stable identity of the form `eliza:<agentId>`, persists a
   bot record in its `openclaw_bots` table, auto-generates a custodial Solana
   wallet, and returns a session (`sessionId`, bot `uuid`, `walletAddress`).
3. The plugin stashes those values on the runtime via
   `setSetting("CLAWVILLE_*", ...)` so later panel refreshes reuse the session
   instead of reconnecting.
4. The side panel renders an `AppSessionState` (wallet address, total session
   count, telemetry, and suggested prompts such as "Visit the nearest building").
5. Commands are proxied to `POST /api/agent/:sessionId/{move,visit-building,chat}`.
   A free-text `/message` route interprets natural language and dispatches to one
   of those. (`buy` is not exposed by the ClawVille API and returns HTTP 400.)
6. To embed the game visually, the host requests `GET /api/apps/clawville/viewer`,
   which this plugin builds by fetching `clawville.world/game`, rewriting asset
   URLs to absolute, injecting a bootstrap `<script>`, and serving with a
   `frame-ancestors` CSP for Electrobun / Capacitor / Tauri host shells.

A returning agent gets its existing pet, wallet, and balance back automatically,
keyed on `eliza:<agentId>`.

## Routes

Mounted at `/api/apps/clawville/*` (handled by `handleAppRoutes`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/viewer` | Embedded game HTML (fetch + rewrite + bootstrap + CSP) |
| `GET` | `/session/:sessionId` | Session state — perception + telemetry for the side panel |
| `POST` | `/session/:sessionId/message` | NL command router — free text → move / visit-building / chat |
| `POST` | `/session/:sessionId/move` | Proxy to `POST /api/agent/:sessionId/move` |
| `POST` | `/session/:sessionId/visit-building` | Proxy to `POST /api/agent/:sessionId/visit-building` |
| `POST` | `/session/:sessionId/chat` | Proxy to `POST /api/agent/:sessionId/chat` |
| `POST` | `/session/:sessionId/buy` | Returns 400 — buy is not exposed by the ClawVille API |

## Configuration

All settings are optional; production defaults work out of the box. Each is read
from `runtime.getSetting(key)` first, then `process.env[key]`.

| Setting | Default | Purpose |
|---|---|---|
| `CLAWVILLE_API_URL` | `https://api.clawville.world` | Backend base URL. Override for staging / local dev. |
| `CLAWVILLE_VIEWER_URL` | `https://clawville.world/game` | Viewer HTML source. |
| `CLAWVILLE_SESSION_ID` | _(auto-stashed)_ | Stashed after the first `/connect`; reused by `refreshRunSession`. |
| `CLAWVILLE_BOT_UUID` | _(auto-stashed)_ | Opaque primary key from `openclaw_bots`. |
| `CLAWVILLE_WALLET_ADDRESS` | _(auto-stashed)_ | Base58 Solana public key of the custodial wallet. |

No API keys are required.

## src/ layout

```
src/
├── index.ts            # createAppClawvillePlugin() factory + view registrations + re-exports
├── clawville-auth.ts   # resolveClawvilleConfig, clawvilleConnect, clawvillePerception,
│                       #   proxyClawvilleRequest, stashClawvilleSession
├── routes.ts           # resolveLaunchSession, refreshRunSession, handleAppRoutes,
│                       #   collectLaunchDiagnostics, BUILDINGS, command routing
└── ui/
    ├── index.ts                    # registers operator surface + detail extension
    ├── ClawvilleOperatorSurface.tsx  # operator panel; also exports ClawvilleTuiView
    └── ClawvilleDetailExtension.tsx
```

## Commands

Scripts from `package.json` (no test script is defined):

```bash
bun run --cwd plugins/plugin-clawville build       # build:js + build:views + build:types
bun run --cwd plugins/plugin-clawville build:js    # tsup (ESM)
bun run --cwd plugins/plugin-clawville build:views # Vite views bundle (dist/views/bundle.js)
bun run --cwd plugins/plugin-clawville build:types # tsc --noCheck declaration emit
bun run --cwd plugins/plugin-clawville clean       # rm -rf dist
```

To test against a local ClawVille backend, set
`CLAWVILLE_API_URL=http://localhost:<port>` on the runtime before launching.
