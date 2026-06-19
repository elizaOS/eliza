# @elizaos/plugin-minecraft

Minecraft automation plugin for elizaOS. Gives an Eliza agent the ability to connect to a Minecraft server and control a bot — moving, building, mining, chatting, navigating, and attacking — through natural language.

## How it works

The plugin manages a local WebSocket bridge process (`mineflayer-server`) that runs a [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot. The elizaOS agent communicates with the bridge over a local WebSocket and drives the bot via a single `MC` action.

## Capabilities

### Action: `MC`

One action with 13 operations, selected by an `action` parameter:

| Operation | Parameters | What it does |
|---|---|---|
| `connect` | `host?`, `port?`, `username?`, `auth?`, `version?` | Join a Minecraft server |
| `disconnect` | — | Leave the server |
| `goto` | `x`, `y`, `z` | Pathfind to coordinates |
| `stop` | — | Cancel movement |
| `look` | `yaw`, `pitch` | Point the bot's view |
| `control` | `control`, `state`, `durationMs?` | Press/release a movement key (`forward`, `back`, `left`, `right`, `jump`, `sprint`, `sneak`) |
| `waypoint_set` | `name` | Save current position as a named waypoint |
| `waypoint_goto` | `name` | Navigate to a saved waypoint |
| `waypoint_delete` | `name` | Delete a saved waypoint |
| `dig` | `x`, `y`, `z` | Mine a block at given coordinates |
| `place` | `x`, `y`, `z`, `face` | Place the held block against a reference block face (`up`/`down`/`north`/`south`/`east`/`west`) |
| `chat` | `message` | Send a chat message in-game |
| `attack` | `entityId` | Attack a nearby entity by ID |

Natural-language aliases work: "join", "move/walk", "mine/break", "say/tell", "hit", "navigate", etc.

### Providers

The plugin injects three context providers into the agent's state each turn:

- **MC_WORLD_STATE** — connection status, position, health, food, inventory contents, nearby entities.
- **MC_WAYPOINTS** — list of saved named waypoints and their coordinates.
- **MC_VISION** — biome, what the bot is looking at, nearby ores and logs (radius 16), nearby entities.

### Services

- **MinecraftService** — manages the bot lifecycle and bridge connection.
- **WaypointsService** — persists named waypoints via agent memory (durable when `plugin-sql` or another durable adapter is loaded).

## Requirements

- **Node.js only** — does not run in browser or mobile runtimes.
- A running Minecraft server (local or remote) for the bot to connect to. Offline-mode local servers work out of the box.

## Configuration

All settings are optional. Defaults work for a local offline server.

| Variable | Default | Description |
|---|---|---|
| `MC_HOST` | `127.0.0.1` | Minecraft server host |
| `MC_PORT` | `25565` | Minecraft server port |
| `MC_USERNAME` | `ElizaBot` | Bot login name |
| `MC_AUTH` | `offline` | Auth mode: `offline` or `microsoft` |
| `MC_VERSION` | `1.20.4` | Minecraft protocol version |
| `MC_SERVER_PORT` | `3457` | Local bridge WebSocket port (internal, rarely changed) |

Set these as environment variables or via `agentConfig.pluginParameters` in your character config.

## Enabling the plugin

Add `@elizaos/plugin-minecraft` to your agent's plugin list:

```json
{
  "plugins": ["@elizaos/plugin-minecraft"]
}
```

The bridge server starts automatically when the plugin initializes.

## Development

```bash
# Build the plugin
bun run --cwd plugins/plugin-minecraft build

# Build the bridge server (required first time)
bun run --cwd plugins/plugin-minecraft/mineflayer-server build

# Run tests
bun run --cwd plugins/plugin-minecraft test

# Watch mode
bun run --cwd plugins/plugin-minecraft dev
```

For agent-facing documentation (file layout, how to extend, gotchas), see `CLAUDE.md` in this directory.
