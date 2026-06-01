# @elizaos/plugin-2004scape

Autonomous 2004scape (RuneScape 2004 revival) game agent — WebSocket SDK layer, LLM-driven game loop, and operator dashboard.

## Purpose / role

Adds a self-playing RS2004 bot to an Eliza agent. The service connects to the 2004scape game via a local WebSocket gateway that bridges the in-browser game client to the elizaOS runtime. An autonomous LLM loop runs on a configurable timer; providers supply JSON game context to every prompt; `RS_2004` is the single planner-facing action that dispatches every in-game operation. The plugin is loaded as an opt-in package — add `@elizaos/plugin-2004scape` to the agent's plugin list.

Access is gated via `gatePluginSessionForHostedApp` (from `@elizaos/agent/services/app-session-gate`), so operator routes require an authenticated hosted-app session. All actions and providers carry `roleGate: { minRole: "ADMIN" }`.

## Plugin surface

### Actions

| Name | File | Description |
|---|---|---|
| `RS_2004` | `src/actions/rs2004.ts` | Single Pattern C parent action. Accepts an `action` enum (30 ops) plus an optional `params` object. Dispatches to `RsSdkGameService.executeAction`. Similes cover all legacy action names (`RS_2004_WALK_TO`, `CHOP_TREE`, `ATTACK_NPC`, etc.). |

Op set: `walk_to`, `chop`, `mine`, `fish`, `burn`, `cook`, `fletch`, `craft`, `smith`, `drop`, `pickup`, `equip`, `unequip`, `use`, `use_on_item`, `use_on_object`, `open`, `close`, `deposit`, `withdraw`, `buy`, `sell`, `attack`, `cast_spell`, `set_style`, `eat`, `talk`, `navigate_dialog`, `interact_object`, `open_door`, `pickpocket`.

### Providers

| Name | File | Description |
|---|---|---|
| `RS_SDK_MAP_AREA` | `src/providers/map-area.ts` | JSON current map area, features, notable NPCs, and travel coordinates. |
| `RS_SDK_WORLD_KNOWLEDGE` | `src/providers/world-knowledge.ts` | JSON nearest bank, skill training recommendations by level, and zone warnings. Cache scope: agent (stable). |
| `RS_SDK_GOALS` | `src/providers/goals.ts` | Computed goal list (IMMEDIATE / SHORT_TERM / MEDIUM_TERM / EXPLORE) from live bot state and action history. |
| `RS_SDK_BOT_STATE` | `src/providers/bot-state.ts` | Full JSON snapshot: player stats, skills, inventory, equipment, nearby NPCs/objects, ground items, game messages, combat events, dialog, shop, bank, combat style. |

### Services

| Class | Service type | File | Description |
|---|---|---|---|
| `RsSdkGameService` | `rs_2004scape` | `src/services/game-service.ts` | Starts the local WebSocket gateway, connects `BotSDK`, runs the autonomous LLM game loop, exposes `executeAction` for the `RS_2004` action handler. |

### Views (UI)

Three views registered in `src/index.ts`:

- `TwoThousandFourScapeOperatorSurface` — standard + XR, path `/2004scape`, bundle `dist/views/bundle.js`
- `TwoThousandFourScapeTuiView` — TUI, path `/2004scape/tui`

### Routes

`src/routes.ts` exports HTTP route handlers registered under `/api/apps/2004scape/`:

- `GET /api/apps/2004scape/viewer` — proxies and injects the 2004scape game client HTML
- `GET /api/apps/2004scape/viewer/proxy/*` — transparent proxy to `RS_SDK_SERVER_URL`
- App lifecycle routes (`/prepare`, `/run`, `/diagnostic`) — called by the elizaOS app session framework
- Session routes (`/api/apps/2004scape/session/:id`, `.../message`, `.../control`, `.../bridge/sync`) — operator dashboard ↔ embedded game client bridge

### Gateway

`src/gateway/index.ts` — `startGateway(options)` starts a Bun WebSocket server that routes messages between the in-browser game client (`/ws?username=`) and the SDK layer (`/sdk?username=`). HTTP endpoints: `/health`, `/status`, `/status/:username`.

## Layout

```
src/
  index.ts                    Plugin export; registers service, actions, providers, views
  routes.ts                   HTTP route handlers (viewer proxy + session bridge)
  shared-state.ts             Module-level LLM response slot (setCurrentLlmResponse / getCurrentLlmResponse)
  actions/
    index.ts                  Exports rsSdkActions = [rs2004Action]
    rs2004.ts                 RS_2004 action — op normalization, alias mapping, dispatch
    game-service.ts           Helper: getRsSdkGameService(runtime)
  providers/
    index.ts                  Exports rsSdkProviders array
    bot-state.ts              RS_SDK_BOT_STATE provider
    goals.ts                  RS_SDK_GOALS provider
    map-area.ts               RS_SDK_MAP_AREA provider (hardcoded KNOWN_AREAS for Lumbridge/Varrock/Draynor/Falador)
    world-knowledge.ts        RS_SDK_WORLD_KNOWLEDGE provider
    service-access.ts         Typed getters for the game service (getRs2004scapeStateService, getRs2004scapeEventLogService)
  services/
    game-service.ts           RsSdkGameService — gateway + BotManager + autonomous loop
    bot-manager.ts            BotManager — wraps BotSDK, computes BotState + alerts from BotWorldState
    autonomous-loop-prompt.ts formatRs2004RouterPrompt / resolveRs2004RouterAction helpers
  sdk/
    index.ts                  BotSDK class — WebSocket client to the gateway
    actions.ts                BotActions class — typed wrappers for every dispatchable game action
    actions-helpers.ts        Shared helpers for BotActions
    types.ts                  All shared types (BotState, BotWorldState, BotAction union, ActionResult, etc.)
  gateway/
    index.ts                  startGateway — Bun WS server bridging bot client ↔ SDK
  ui/
    index.ts                  Re-exports UI components
    TwoThousandFourScapeOperatorSurface.tsx  Operator dashboard React component
    TwoThousandFourScapeDetailExtension.tsx  Detail panel UI extension
```

## Commands

Scripts from `package.json` — run from repo root or with `--cwd`:

```bash
bun run --cwd plugins/plugin-2004scape build        # tsup JS + vite views + tsc types
bun run --cwd plugins/plugin-2004scape build:js     # tsup only
bun run --cwd plugins/plugin-2004scape build:views  # vite views bundle only
bun run --cwd plugins/plugin-2004scape build:types  # tsc type declarations only
bun run --cwd plugins/plugin-2004scape clean        # rm -rf dist
```

No test script is defined in this package.

## Config / env vars

All vars are read from agent settings (`runtime.getSetting`) falling back to `process.env`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `RS_SDK_BOT_NAME` | Yes (or `BOT_NAME`) | auto-generated | Bot account username |
| `RS_SDK_BOT_PASSWORD` | Yes (or `BOT_PASSWORD`) | auto-generated | Bot account password |
| `RS_SDK_GATEWAY_URL` | No | `ws://localhost:18791` | Gateway WebSocket URL the SDK connects to |
| `RS_SDK_SERVER_URL` | No | `https://rs-sdk-demo.fly.dev` | Remote 2004scape server for viewer proxy |
| `RS_2004SCAPE_GATEWAY_PORT` | No | `18791` | Port the embedded gateway listens on |
| `RS_2004SCAPE_LOOP_INTERVAL_MS` | No | `15000` | Autonomous game loop tick interval |
| `RS_2004SCAPE_MODEL_SIZE` | No | `TEXT_SMALL` | LLM size for the game loop: `TEXT_NANO` / `TEXT_SMALL` / `TEXT_MEDIUM` / `TEXT_LARGE` |

If `RS_SDK_BOT_NAME` is absent, the service starts but does not auto-connect.

## How to extend

**Add a new op to RS_2004:**
1. Add the string literal to the `Rs2004Op` union and `RS_2004_OPS` array in `src/actions/rs2004.ts`.
2. Add a `case` in `normalizeOp` (handle any aliases/legacy names).
3. Add a `case` in `resolveDispatch` mapping to the `BotActions` method name.
4. Implement the method in `src/sdk/actions.ts` (`BotActions` class).
5. Add the corresponding `case` in `dispatchAction` in `src/services/game-service.ts`.

**Add a provider:**
1. Create `src/providers/<name>.ts` exporting a `Provider` object with name, description, contexts, and `get()`.
2. Import and add it to the array in `src/providers/index.ts`.

**Add a service:**
1. Extend `Service` from `@elizaos/core`, set a static `serviceType`, implement `static start(runtime)` and `stop()`.
2. Register it in the `services` array in `src/index.ts`.

## Conventions / gotchas

- The gateway uses `Bun.serve` (Bun-native WebSocket API). It will not work in a plain Node.js environment without Bun.
- `shared-state.ts` holds a module-level mutable slot for the last LLM response. The autonomous loop writes it; the `RS_2004` action handler reads it as fallback when message text is empty. Keep this the only cross-module mutable singleton.
- Providers all carry `roleGate: { minRole: "ADMIN" }` and `contextGate` — they are intentionally suppressed outside game/automation contexts.
- `map-area.ts` has a hardcoded `KNOWN_AREAS` table for four zones (Lumbridge, Varrock, Draynor, Falador). Add new entries there to extend map knowledge.
- Autonomous loop step numbers are monotonically incrementing; they are used in trajectory metadata. Do not reset `stepNumber` at reconnect — it tracks total steps across the agent lifetime.
- The viewer proxy in `routes.ts` rewrites HTML `src`/`href`/`action` attributes and WebSocket URLs so the game client runs cross-origin inside the elizaOS dashboard iframe.
- The service `log()` method uses `console.log` with a `[2004scape]` prefix (not the structured logger). See root AGENTS.md rule #9 on logger-only — this is an existing deviation.
