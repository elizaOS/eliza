# @elizaos/plugin-roblox

Roblox Open Cloud integration: lets an Eliza agent send messages, trigger game-side actions, and look up players in a Roblox experience.

## Purpose / role

Adds outbound Roblox game communication to any Eliza agent. The plugin publishes messages and action payloads to a Roblox experience via the Open Cloud Messaging Service API, and can query player and experience metadata. It is opt-in: set `ROBLOX_API_KEY` + `ROBLOX_UNIVERSE_ID` in the agent's settings; the service skips initialization if either is missing.

## Plugin surface

| Kind | Name | What it does |
|---|---|---|
| Action | `ROBLOX` | Unified router for three subactions: `message`, `execute`, `get_player` |
| Provider | `roblox-game-state` | Injects Roblox connection state and experience metadata into agent context each turn |
| Service | `RobloxService` | Singleton that holds one `RobloxAgentManager` (and `RobloxClient`) per agent UUID; manages lifecycle |

### Action subactions

- `message` — publish a text payload to the configured Roblox messaging topic, optionally targeting specific player IDs (max 25)
- `execute` — publish a named game-side action (e.g. `give_coins`, `teleport`, `spawn_entity`, `move_npc`, `start_event`) with freeform parameters and optional target player IDs; built-in regex patterns infer common actions from natural language
- `get_player` — look up a Roblox user by numeric ID or username; fetches display name, ban status, account age, and avatar headshot URL

### Provider output

`roblox-game-state` runs in `automation` and `agent_internal` contexts (cache scope: per-turn). Produces a text block with: configured, service/client availability, universeId, placeId, experience name, active player count, total visits, creator, messagingTopic, dryRun flag.

## Layout

```
plugins/plugin-roblox/
  index.ts                    Plugin export (robloxPlugin, RobloxService, RobloxApiError, RobloxClient)
  actions/
    index.ts                  Re-exports robloxAction as robloxActions array
    robloxAction.ts           ROBLOX action implementation; subaction routing, regex NLP, timeout wrapper
  providers/
    index.ts                  Re-exports gameStateProvider as robloxProviders array
    gameStateProvider.ts      roblox-game-state provider
  services/
    RobloxService.ts          Singleton service; RobloxAgentManager inner class
  client/
    RobloxClient.ts           HTTP wrapper for Open Cloud + users.roblox.com APIs
  types/
    index.ts                  RobloxConfig, RobloxUser, RobloxGameAction, RobloxExperienceInfo,
                              MessagingServiceMessage, DataStoreEntry, ManagerHealthStatus
  utils/
    config.ts                 hasRobloxEnabled(), validateRobloxConfig() — reads all env vars
  prompts/
    evaluators.json           Prompt fragments (evaluators)
    providers.json            Prompt fragments (providers)
  __tests__/
    suite.ts                  RobloxTestSuite (registered in plugin.tests)
```

## Commands

Scripts defined in `package.json` for this plugin only:

```bash
bun run --cwd plugins/plugin-roblox build          # compile (build.ts)
bun run --cwd plugins/plugin-roblox dev            # build --watch
bun run --cwd plugins/plugin-roblox test           # vitest run __tests__/
bun run --cwd plugins/plugin-roblox test:unit      # same as test
bun run --cwd plugins/plugin-roblox typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-roblox lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-roblox format         # biome format --write
bun run --cwd plugins/plugin-roblox clean          # rm dist .turbo artifacts
```

## Config / env vars

All read via `runtime.getSetting(...)` in `utils/config.ts`:

| Var | Required | Default | Notes |
|---|---|---|---|
| `ROBLOX_API_KEY` | Yes | — | Roblox Open Cloud API key; sensitive |
| `ROBLOX_UNIVERSE_ID` | Yes | — | Target universe ID |
| `ROBLOX_PLACE_ID` | No | — | Narrows scope to a specific place |
| `ROBLOX_WEBHOOK_SECRET` | No | — | For future inbound webhook validation; stored in config but not consumed yet |
| `ROBLOX_MESSAGING_TOPIC` | No | `"eliza-agent"` | Open Cloud Messaging Service topic |
| `ROBLOX_DRY_RUN` | No | `false` | String `"true"` suppresses actual publish calls |

## How to extend

**Add an action**: create `actions/myAction.ts` exporting an `Action` from `@elizaos/core`. Add it to the array in `actions/index.ts`. The plugin auto-registers everything in `robloxActions`.

**Add a provider**: create `providers/myProvider.ts` exporting a `Provider`. Add to `providers/index.ts` → `robloxProviders`.

**Add a service method**: add to `RobloxService` in `services/RobloxService.ts`. Delegate to `RobloxAgentManager` (which holds the `RobloxClient`). Keep service methods agent-scoped by `UUID`.

**Extend the API client**: add methods to `RobloxClient` in `client/RobloxClient.ts`. Use the private `request<T>()` helper; pass a custom `baseUrl` for non-Open-Cloud endpoints (e.g. `users.roblox.com`, `games.roblox.com`, `thumbnails.roblox.com`). Throw `RobloxApiError` on non-OK responses.

**Add a known game action pattern**: extend the `KNOWN_GAME_ACTIONS` array in `actions/robloxAction.ts` with a `name`, one or more `patterns: RegExp[]`, and an `extractParams` function.

## Conventions / gotchas

- **Outbound only**: Open Cloud has no external subscribe endpoint. This plugin publishes to Roblox; it cannot poll incoming player chat. For inbound messages, build an HTTP bridge in Roblox Studio using `HttpService:RequestAsync`.
- **DryRun**: `ROBLOX_DRY_RUN=true` skips `publishMessage` and `setDataStoreEntry`/`deleteDataStoreEntry` calls silently. DataStore dry-run uses `console.log` (acceptable only in development; do not ship).
- **Action timeout**: all Roblox service calls are wrapped in a 15-second `Promise.race` timeout (`ROBLOX_ACTION_TIMEOUT_MS`).
- **Player ID caps**: `targetPlayerIds` is capped at 25 entries (`MAX_ROBLOX_TARGET_IDS`); messages are capped at 1000 characters.
- **Service singleton**: `RobloxService` is a singleton instance across the process. Each agent UUID gets its own `RobloxAgentManager`. Do not hold state on the service instance directly.
- **Validation guard**: `validate()` in `robloxAction.ts` returns `false` unless both `ROBLOX_API_KEY` and `ROBLOX_UNIVERSE_ID` are set (`Boolean(apiKey && universeId)`), so the action never fires for unconfigured agents.
- ESM only (`"type": "module"`). Node runtime required (`eliza.platforms: ["node"]`).
- See the root `AGENTS.md` for repo-wide conventions (logger, architecture rules, naming).
