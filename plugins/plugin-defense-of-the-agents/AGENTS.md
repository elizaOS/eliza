# @elizaos/plugin-defense-of-the-agents

elizaOS app plugin that connects an Eliza agent to the live Defense of the Agents MOBA game — spectator shell, auto-play game loop, and session command routing.

## Purpose / role

This plugin registers itself as an elizaOS **app** (kind: `"app"`, launchType: `"connect"`). When loaded, the agent joins the Defense of the Agents game API, auto-plays a heuristic strategy loop every 30 seconds, and exposes a spectator viewer shell inside the elizaOS dashboard. It is opt-in: enable it by adding `@elizaos/plugin-defense-of-the-agents` to your character's plugin list. No capabilities are added to the conversation model — this is a game-session manager, not an action/provider plugin.

## Plugin surface

No elizaOS actions, providers, evaluators, or model handlers are registered. The plugin object (`appDefenseOfTheAgentsPlugin`) registers:

| Field | Values |
|---|---|
| `app.launchType` | `"connect"` — opens `https://www.defenseoftheagents.com/` |
| `app.session.mode` | `"spectate-and-steer"` — agent plays autonomously; human can send commands |
| `app.session.features` | `["commands", "telemetry", "suggestions"]` |
| `views[0]` (id `defense-of-the-agents`) | `DefenseAgentsOperatorSurface` component — default desktop view |
| `views[1]` (id `defense-of-the-agents`, viewType `xr`) | `DefenseAgentsOperatorSurface` XR variant |
| `views[2]` (id `defense-of-the-agents`, viewType `tui`) | `DefenseAgentsTuiView` terminal view |

The UI components are registered via `@elizaos/app-core/ui-compat`:
- `DefenseAgentsOperatorSurface` — full operator panel (game telemetry, activity feed, strategy controls)
- `DefenseAgentsDetailExtension` — sidebar detail panel, registered as `"defense-agent-control"`

### Route handlers (exported from `src/routes.ts`, consumed by the host app router)

| Export | Role |
|---|---|
| `resolveLaunchSession(ctx)` | Called at app launch — auto-joins a game, starts the 30s auto-play loop |
| `refreshRunSession(ctx)` | Called on UI poll — returns cached or fresh session state |
| `stopRun(ctx)` | Called on stop — clears game loop, flushes per-agent caches |
| `collectLaunchDiagnostics(ctx)` | Returns `AppLaunchDiagnostic[]` when the remote API was unreachable at launch |
| `handleAppRoutes(ctx)` | HTTP multiplexer for `GET /api/apps/defense-of-the-agents/viewer`, session state, and session message/command POSTs |

## Layout

```
plugins/plugin-defense-of-the-agents/
  package.json               npm metadata, build scripts, elizaos app manifest
  src/
    index.ts                 Plugin object (createAppDefenseOfTheAgentsPlugin), re-exports routes + ui
    routes.ts                All game logic: session lifecycle, game loop, strategy, HTTP route handler
    ui/
      index.ts               registerOperatorSurface + registerDetailExtension calls
      DefenseAgentsOperatorSurface.tsx   Main dashboard React component
      DefenseAgentsDetailExtension.tsx   Sidebar detail panel React component
  vite.config.views.ts       Vite config for the dist/views/bundle.js UI bundle
  vitest.config.ts           Test config
```

Key constants in `src/routes.ts`:
- `DEFAULT_API_BASE_URL` — `https://wc2-agentic-dev-3o6un.ondigitalocean.app`
- `GAME_LOOP_INTERVAL_MS` — 30 000 ms between auto-play ticks
- `STRATEGY_REVIEW_INTERVAL_MS` — 30 minutes between strategy self-review cycles
- `STRATEGY_HISTORY_LIMIT` — keeps last 5 strategies

## Commands

```bash
bun run --cwd plugins/plugin-defense-of-the-agents test
bun run --cwd plugins/plugin-defense-of-the-agents build
bun run --cwd plugins/plugin-defense-of-the-agents build:js
bun run --cwd plugins/plugin-defense-of-the-agents build:views
bun run --cwd plugins/plugin-defense-of-the-agents build:types
bun run --cwd plugins/plugin-defense-of-the-agents clean
```

## Config / env vars

All settings are resolved via `getSetting(key)` → `process.env[key]` in that order. None are required; the plugin operates in read-only / degraded mode without them.

| Env var | Purpose | Default |
|---|---|---|
| `DEFENSE_OF_THE_AGENTS_API_KEY` | Bearer token for the game deployment API. Auto-registered and persisted on first launch if absent. | — |
| `DEFENSE_OF_THE_AGENTS_AGENT_NAME` | Name used to register / locate the agent's hero. Falls back to character name → `eliza-<agentId>`. | — |
| `DEFENSE_OF_THE_AGENTS_API_URL` | Override the game backend base URL. | `https://wc2-agentic-dev-3o6un.ondigitalocean.app` |
| `DEFENSE_OF_THE_AGENTS_VIEWER_URL` | Override the viewer page URL (fetched and proxied via the embedded viewer route). | `https://www.defenseoftheagents.com/` |
| `DEFENSE_OF_THE_AGENTS_GAME_ID` | Pin the agent to a specific game ID. Auto-set on first deploy. | scan games 1–5 |
| `DEFENSE_OF_THE_AGENTS_DEFAULT_HERO_CLASS` | `melee`, `ranged`, or `mage` | `mage` |
| `DEFENSE_OF_THE_AGENTS_DEFAULT_LANE` | `top`, `mid`, or `bot` | `mid` |
| `BOT_NAME` | Fallback agent name if `DEFENSE_OF_THE_AGENTS_AGENT_NAME` is unset. | — |
| `DEFENSE_STRATEGY_CURRENT` | JSON-serialised active `GameStrategy` (auto-managed). | default strategy |
| `DEFENSE_STRATEGY_BEST` | JSON-serialised best-scoring `GameStrategy` seen so far (auto-managed). | — |
| `DEFENSE_STRATEGY_HISTORY` | JSON array of last 5 strategies (auto-managed). | — |
| `DEFENSE_AUTO_PLAY` | `"1"` when auto-play is active (auto-managed; survives module re-import). | — |

## How to extend

**Add a new session command:** edit `handleAppRoutes` in `src/routes.ts`. Commands arrive as POST to `/api/apps/defense-of-the-agents/session/<sessionId>/message` with a `{ content: string }` body. Add a branch before `isDeploymentControlCommand` for text commands, or extend `parseDeploymentCommand` for new deployment vocabulary.

**Change the auto-play heuristic:** edit `executeStrategyTick` and `DEFAULT_STRATEGY` in `src/routes.ts`. The heuristic runs on a priority order: pick ability → recall if HP ≤ recallThreshold → reinforce weakest lane → hold.

**Add a UI panel:** create a React component under `src/ui/`, export it from `src/ui/index.ts`, and call `registerOperatorSurface` or `registerDetailExtension` from `@elizaos/app-core/ui-compat`.

**Add a new view tab:** add an entry to the `views` array in `createAppDefenseOfTheAgentsPlugin` in `src/index.ts` referencing a `componentExport` name from `dist/views/bundle.js`.

## Conventions / gotchas

- The plugin has **no elizaOS actions, providers, or evaluators** — it is purely an app session plugin. The host app-core calls `resolveLaunchSession`, `refreshRunSession`, `stopRun`, `collectLaunchDiagnostics`, and `handleAppRoutes` directly.
- The game loop is **per-agent** (keyed by `agentId`). Multiple agents with the same character name but different `agentId` values get isolated cache entries.
- `DEFENSE_OF_THE_AGENTS_API_KEY` is auto-registered if absent. On a 409 name conflict, registration retries with a random 4-char hex suffix appended to the agent name, then persists both the new name and key.
- The embedded viewer route (`GET /api/apps/defense-of-the-agents/viewer`) proxies the live game HTML and injects CSS/JS to suppress login/auth UI elements for clean embedding.
- Game state is cached for 5 s (`GAME_STATE_CACHE_TTL_MS`) to avoid rate limiting. Session state is cached for 15 s (`SESSION_STATE_CACHE_TTL_MS`).
- For architecture rules, logger conventions, ESM/module requirements, and git workflow, see the repo root `AGENTS.md`.
