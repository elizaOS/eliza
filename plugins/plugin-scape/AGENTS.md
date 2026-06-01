# @elizaos/plugin-scape

First-class Eliza agent integration for xRSPS — an OSRS-alike TypeScript private server.

## Purpose / role

This plugin turns a running xRSPS instance into an autonomous-agent playground within the elizaOS runtime. It registers a `ScapeGameService` that connects to the xRSPS bot-SDK WebSocket endpoint, caches per-tick perception snapshots, and runs an autonomous LLM loop that picks and dispatches in-game actions. Operators can steer the agent in real time via directed prompts. The plugin is opt-in: it is loaded via the `elizaos.kind: "app"` manifest in `package.json` and only activates when `SCAPE_BOT_SDK_TOKEN` is configured.

## Plugin surface

### Actions
| Name | What it does |
|------|-------------|
| `SCAPE` | Single Pattern C parent action. Picks one op (`walk_to`, `attack`, `chat_public`, `eat`, `drop`, `set_goal`, `complete_goal`, `remember`) and dispatches it through `ScapeGameService.executeAction` or `JournalService`. Requires `minRole: ADMIN`. |

Legacy similes (all resolve to `SCAPE`): `SCAPE_WALK_TO`, `MOVE_TO`, `GO_TO`, `TRAVEL_TO`, `HEAD_TO`, `ATTACK_NPC`, `FIGHT_NPC`, `KILL_NPC`, `ENGAGE`, `CHAT_PUBLIC`, `SAY`, `SPEAK`, `TALK`, `BROADCAST`, `JOURNAL`, `INVENTORY`, `SET_GOAL`, `COMPLETE_GOAL`, `REMEMBER`, `EAT_FOOD`, `DROP_ITEM`.

### Providers
| Name | What it injects |
|------|----------------|
| `SCAPE_BOT_STATE` | Agent vitals, position, combat state from the latest perception snapshot |
| `SCAPE_INVENTORY` | Inventory + equipment (occupied slots only) |
| `SCAPE_NEARBY` | Nearby NPCs, players, and ground items sorted by Chebyshev distance |
| `SCAPE_JOURNAL` | Recent journal memories from `JournalService` |
| `SCAPE_GOALS` | Active and recent goals from `JournalService` |

All providers require `minRole: ADMIN` and are scoped to contexts `["game", "automation", "world", "state"]`.

### Services
| Class | serviceType | What it does |
|-------|------------|-------------|
| `ScapeGameService` | `"scape_game"` | Manages the bot-SDK WebSocket connection, caches perception snapshots, runs the autonomous LLM loop, exposes `executeAction` / `getJournalService` / `applyOperatorMessage` / `pause` / `resume` |
| `JournalService` | (internal, owned by `ScapeGameService`) | Reads/writes the Scape Journal file, manages goals and memories, calls `onSpawn` / `onPerception` hooks |

### HTTP routes (via `handleAppRoutes` in `routes.ts`)
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/apps/scape/viewer` | HTML iframe wrapper embedding the xRSPS React client |
| `POST` | `/api/apps/scape/prompt` | Legacy operator-steering endpoint |
| `GET` | `/api/apps/scape/journal` | Recent memories JSON |
| `GET` | `/api/apps/scape/goals` | Current goals JSON |
| `GET` | `/api/apps/scape/session/:id` | Session snapshot (telemetry + activity log) |
| `POST` | `/api/apps/scape/session/:id/message` | Operator directive (goal or pause/resume verbs) |
| `POST` | `/api/apps/scape/session/:id/control` | Explicit `pause` / `resume` control |

### Views (registered as elizaOS UI views)
- `ScapeOperatorSurface` — default desktop/XR tab at `/scape`
- `ScapeTuiView` — terminal surface at `/scape/tui`

### App lifecycle exports (consumed by elizaOS app-manager)
- `resolveLaunchSession` — builds initial session state
- `refreshRunSession` — refreshes session state on each poll cycle
- `stopRun` — tears down WebSocket and autonomous loop
- `collectLaunchDiagnostics` — returns diagnostics array (currently empty)

## Layout

```
src/
  index.ts                      Plugin entry; exports createAppScapePlugin(), appScapePlugin (gated)
  routes.ts                     All HTTP route handlers; app lifecycle exports
  shared-state.ts               Module-scope shared state (latest LLM response, action text resolver)
  actions/
    index.ts                    scapeActions array (single element: scapeAction)
    scape.ts                    SCAPE action — op dispatch, param parsing, timeout
    param-parser.ts             Shared coercion helpers (also used inline in scape.ts)
  providers/
    index.ts                    scapeProviders array (5 providers)
    bot-state.ts                SCAPE_BOT_STATE
    inventory.ts                SCAPE_INVENTORY
    nearby.ts                   SCAPE_NEARBY
    journal.ts                  SCAPE_JOURNAL
    goals.ts                    SCAPE_GOALS
  services/
    game-service.ts             ScapeGameService — connection, autonomous loop, public API
    journal-service.ts          JournalService — disk persistence, memory/goal management
    bot-manager.ts              BotManager — WebSocket lifecycle, reconnect, action queue
    agent-identity.ts           loadOrGenerateAgentIdentity — stable account credentials
    autonomous-loop-prompt.ts   formatScapeRouterPrompt / resolveScapeRouterAction helpers
  sdk/
    index.ts                    BotSdk class — framing, JSON send/receive, status tracking
    types.ts                    Wire-protocol types (ClientFrame, ServerFrame, PerceptionSnapshot, …)
    json.ts                     JSON frame codec helpers
  journal/
    journal-store.ts            JournalStore — low-level JSON read/write to disk
    types.ts                    JournalState, JournalMemory, JournalGoal, JournalProgressEntry
  ui/
    index.ts                    Re-exports ScapeOperatorSurface and ScapeTuiView
    ScapeOperatorSurface.tsx    React operator UI (embedded by elizaOS view system)
```

## Commands

Only scripts present in `package.json`:

```bash
bun run --cwd plugins/plugin-scape build        # build:js + build:views + build:types
bun run --cwd plugins/plugin-scape build:js     # tsup (ESM bundle, main entry)
bun run --cwd plugins/plugin-scape build:views  # vite build (ScapeOperatorSurface + ScapeTuiView)
bun run --cwd plugins/plugin-scape build:types  # tsc --noCheck (type declarations)
bun run --cwd plugins/plugin-scape clean        # rm -rf dist
```

## Config / env vars

All resolved in priority order: `runtime.getSetting(key)` → `character.settings.secrets[key]` → `process.env[key]`.

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `SCAPE_BOT_SDK_TOKEN` | **Yes** | — | Shared secret matching xRSPS `BOT_SDK_TOKEN`. Without this the service skips connection entirely. |
| `SCAPE_BOT_SDK_URL` | No | `wss://scape-96cxt.sevalla.app/botsdk` | bot-SDK WebSocket URL. Use `ws://127.0.0.1:8080/botsdk` for local dev. |
| `SCAPE_CLIENT_URL` | No | `https://scape-client-2sqyc.kinsta.page` | xRSPS React client URL the viewer iframe loads. Use `http://localhost:3000` for local dev. |
| `SCAPE_AGENT_NAME` | No | `scape-agent` | In-game display name (normalized, max 12 chars). |
| `SCAPE_AGENT_PASSWORD` | No | auto-generated | Plaintext account password. Omit to auto-generate and persist to `~/.eliza/scape-agent-identity.json`. |
| `SCAPE_AGENT_ID` | No | `scape-{SCAPE_AGENT_NAME}` | Stable identifier; used as journal filename. |
| `SCAPE_AGENT_PERSONA` | No | — | Persona string injected into the system prompt. |
| `SCAPE_LOOP_INTERVAL_MS` | No | `15000` | Autonomous LLM step interval in ms (minimum 1000). |
| `SCAPE_MODEL_SIZE` | No | `TEXT_SMALL` | Model tier for the loop: `TEXT_NANO`, `TEXT_SMALL`, `TEXT_MEDIUM`, `TEXT_LARGE`. |

Agent identity (name, password, agentId) is persisted to `~/.eliza/scape-agent-identity.json` on first launch and reused on subsequent runs. The agent's xRSPS account (skills, inventory, position) accumulates across sessions as the same character.

## How to extend

### Add an action op

1. Add the new op string to the `ScapeOp` union and `SCAPE_OPS` array in `src/actions/scape.ts`.
2. Add a branch in `normalizeOp` for any aliases.
3. Add a branch in `dispatchOp` that calls `service.executeAction(...)` or `service.getJournalService()` as appropriate.
4. Mirror the same branch in `ScapeGameService.dispatchFromLoop` in `src/services/game-service.ts` (the autonomous loop uses this path, not the action handler).
5. Update the `SCAPE` action's `description` string so the LLM sees the new op in its prompt.

### Add a provider

1. Create `src/providers/<name>.ts` exporting a `Provider` with `name: "SCAPE_<NAME>"`.
2. Import and add it to the `scapeProviders` array in `src/providers/index.ts`.
3. Add it to the `orderedProviders` array in `ScapeGameService.gatherProviderContext` (order affects prompt readability).

### Add an HTTP route

1. Define the path constant at the top of `src/routes.ts`.
2. Add a branch in `handleAppRoutes` before the final `return false`.

## Conventions / gotchas

- **Wire-protocol compatibility.** `src/sdk/types.ts` must stay byte-compatible with xRSPS's `BotSdkProtocol.ts`. The JSON codec does structural matching — a field rename on either side silently breaks the wire format.
- **Identity file.** `~/.eliza/scape-agent-identity.json` is the source of truth for the agent's xRSPS account. Delete it to reset to a fresh character; hand-edit it to pin specific credentials.
- **Session ID.** The session ID is keyed on `runtime.agentId` (stable across the lifetime of the agent process). Stale session IDs from old refresh cycles return 404 with `expected` / `received` so the host can re-resolve.
- **Autonomous loop timing.** The first LLM step fires on the first perception frame (not at service start) to avoid prompting with an empty snapshot.
- **Operator pause.** `pause()` / `resume()` survive reconnects — the bot-SDK connection stays open during a pause so perception keeps updating.
- **Views are built separately.** `build:views` uses `vite.config.views.ts` and bundles `ScapeOperatorSurface` + `ScapeTuiView` into `dist/views/bundle.js`. This is separate from the main `tsup` JS build.
- **App gating.** The default export `appScapePlugin` is wrapped in `gatePluginSessionForHostedApp`. Use `createAppScapePlugin()` directly in tests to bypass the gate.
