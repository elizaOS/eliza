# @elizaos/plugin-minecraft

Minecraft automation plugin — gives an Eliza agent the ability to connect to and control a Minecraft bot via a local Mineflayer bridge server.

## Purpose / role

This plugin adds Minecraft bot control to any Eliza agent. It manages a local WebSocket bridge process (the `mineflayer-server` sub-package) that runs a [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot, and exposes bot operations as a single agent action (`MC`). Load it by adding `@elizaos/plugin-minecraft` to the agent's plugin list. It is opt-in and Node.js only (`"platform": "node"`).

## Plugin surface

### Actions

| Name | similes | Purpose |
|---|---|---|
| `MC` | `MC_ATTACK`, `MC_BLOCK`, `MC_CHAT`, `MC_CONNECT`, `MC_DISCONNECT`, `MC_LOCOMOTE`, `MC_WAYPOINT`, and more | Single parent action exposing 13 ops: `connect`, `disconnect`, `goto`, `stop`, `look`, `control`, `waypoint_goto`, `dig`, `place`, `chat`, `attack`, `waypoint_set`, `waypoint_delete` |

The `action` parameter selects the op; `params` carries op-specific fields. Natural-language aliases for each op (e.g. "join", "move", "mine", "say") are normalized internally.

### Providers

| Name | Purpose |
|---|---|
| `MC_WORLD_STATE` | Live bot state: connection, position, health, food, inventory (up to 36 slots), nearby entities (up to 24). Per-turn, dynamic, not cached across turns. |
| `MC_WAYPOINTS` | List of named waypoints stored via `WaypointsService` (up to 50). Per-turn, dynamic. |
| `MC_VISION` | Semantic environment snapshot: biome, what the bot is looking at, nearby ore/log blocks (radius 16), nearby entities. Issues a `scan` request to the bridge. |

`MC_WORLD_STATE` is also exported as `minecraftStateProvider` for backward-compatible reference.

### Services

| Class | `serviceType` | Purpose |
|---|---|---|
| `MinecraftService` | `"minecraft"` | Owns the bot lifecycle: spawns/stops the bridge process, holds the WebSocket connection, provides `createBot`, `destroyBot`, `request`, `chat`, `getWorldState`. |
| `WaypointsService` | `"minecraft_waypoints"` | In-memory waypoint store backed by agent memory (`plugin-sql` or any durable adapter). Persists across restarts when a durable memory adapter is present. |

No evaluators, routes, events, or model handlers.

## Layout

```
plugins/plugin-minecraft/
  src/
    index.ts                   Plugin object export; wires all services/actions/providers
    protocol.ts                JsonValue, JsonObject, MinecraftBridgeRequest/Response types
    types.ts                   MinecraftSession, MinecraftWorldState (zod schema)
    actions/
      index.ts                 Re-exports minecraftAction
      mc.ts                    MC action — 13 ops, normalizeOp(), full handler switch
      helpers.ts               mergedInput, readString/Number/Boolean, parseVec3, emit, withMinecraftTimeout
      utils.ts                 extractVec3 (parses "x y z" from freetext)
    providers/
      index.ts                 Re-exports all three providers
      world-state.ts           MC_WORLD_STATE provider
      waypoints.ts             MC_WAYPOINTS provider
      vision.ts                MC_VISION provider (scan request + lookingAt)
    services/
      minecraft-service.ts     MinecraftService (bot lifecycle + request routing)
      process-manager.ts       MinecraftProcessManager — spawns mineflayer-server subprocess
      waypoints-service.ts     WaypointsService — CRUD waypoints via agent memory
      websocket-client.ts      MinecraftWebSocketClient — request/response over WebSocket
  mineflayer-server/           Standalone Node.js bridge (separate package)
    src/index.ts               WebSocket server; handles all bot commands via mineflayer + pathfinder
    package.json               @elizaos/plugin-minecraft-mineflayer-server
  __tests__/
    mc-action.test.ts          Unit tests for MC action
  protocol/schema.json         JSON schema for the bridge protocol
  prompts/evaluators.json      Prompt templates (evaluators)
  generated/specs/specs.ts     Generated API specs
  build.ts                     esbuild build script
```

## Commands

All scripts are in `plugins/plugin-minecraft/package.json`.

```bash
bun run --cwd plugins/plugin-minecraft build        # compile plugin (esbuild via build.ts)
bun run --cwd plugins/plugin-minecraft dev          # watch mode (bun --hot build.ts)
bun run --cwd plugins/plugin-minecraft test         # vitest run
bun run --cwd plugins/plugin-minecraft typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-minecraft lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-minecraft lint:check   # biome check (read-only)
bun run --cwd plugins/plugin-minecraft format       # biome format --write
bun run --cwd plugins/plugin-minecraft format:check # biome format (read-only)
bun run --cwd plugins/plugin-minecraft clean        # rm -rf dist .turbo
```

The `mineflayer-server` sub-package has its own build:

```bash
bun run --cwd plugins/plugin-minecraft/mineflayer-server build  # compile bridge server
bun run --cwd plugins/plugin-minecraft/mineflayer-server dev    # bun --hot src/index.ts
```

## Config / env vars

All variables are optional with defaults shown. Validated in `src/index.ts` via zod, then written to `process.env` on init.

| Var | Default | Description |
|---|---|---|
| `MC_SERVER_PORT` | `3457` | Port the local Mineflayer bridge WebSocket server listens on |
| `MC_HOST` | `127.0.0.1` | Minecraft game server host |
| `MC_PORT` | `25565` | Minecraft game server port |
| `MC_USERNAME` | `ElizaBot` (bridge default) | Bot username |
| `MC_AUTH` | `offline` | Auth mode: `offline` or `microsoft` |
| `MC_VERSION` | `1.20.4` (bridge default) | Minecraft protocol version |

These can also be set per-agent via `agentConfig.pluginParameters` in `package.json`.

## How to extend

### Add a new op to the MC action

1. Add the op string to the `McOp` union and `MC_OPS` array in `src/actions/mc.ts`.
2. Add alias normalization in `normalizeOp()` if needed.
3. Add a `case` block in the `handler` switch. Call `service.request(bridgeType, data)` for bridge-side ops.
4. Implement the corresponding `case` in `mineflayer-server/src/index.ts` WebSocket message handler.
5. Add the new bridge request type to `MinecraftBridgeRequestType` in `src/protocol.ts`.

### Add a new provider

1. Create `src/providers/<name>.ts` exporting a `Provider` object.
2. Export it from `src/providers/index.ts`.
3. Add it to the `providers` array in `src/index.ts`.

### Add a new service

1. Create `src/services/<name>-service.ts` extending `Service` from `@elizaos/core`.
2. Export a `SERVICE_TYPE` constant and the class.
3. Add it to the `services` array in `src/index.ts`.
4. Wire up `dispose()` in `src/index.ts` if the service needs teardown.

## Conventions / gotchas

- **Two-process architecture.** The plugin spawns `mineflayer-server` as a subprocess (`MinecraftProcessManager`). The bridge must be built separately (`bun run --cwd plugins/plugin-minecraft/mineflayer-server build`) before the dist entrypoint is available. In dev the process manager falls back to the `.ts` source via `tsx`.
- **Single action, many ops.** `MC` is a Pattern C action — one action name, op selected by the `action` parameter. Old leaf names (`MC_ATTACK`, etc.) are similes only; do not register them as separate actions.
- **Waypoints persist via agent memory.** `WaypointsService` uses `runtime.createMemory`/`updateMemory`/`deleteMemory` scoped to a fixed `waypointsRoomId`. Durability depends on the memory adapter in use (e.g. `plugin-sql`). Without a durable adapter, waypoints are lost on restart.
- **All ops time out at 15 s.** `withMinecraftTimeout` wraps every bridge request. Do not remove this — pathfinding blocks indefinitely if the server is unreachable.
- **`control` duration cap.** The `control` op enforces a 10,000 ms max duration to prevent runaway key-hold states.
- **Node.js only.** `"platform": "node"` in `package.json`. Do not use in browser or mobile runtimes.
- **Bridge server start is best-effort.** `MinecraftService.start()` catches subprocess start failures as warnings rather than fatal errors (the agent can still run without Minecraft). Watch logs for `[MinecraftServer Error]` if the bot won't connect.
