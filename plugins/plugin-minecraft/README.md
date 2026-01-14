# Minecraft Plugin for ElizaOS (Mineflayer Bridge)

This plugin lets Eliza agents **connect to a Minecraft server, perceive world state, and perform in-game actions** via a local WebSocket bridge powered by [Mineflayer](https://github.com/PrismarineJS/mineflayer).

It’s implemented in **TypeScript, Python, and Rust**:

- **TypeScript**: the Eliza plugin and the process manager that starts the Mineflayer bridge server.
- **Python / Rust**: thin client SDKs/plugins that connect to the same bridge server (useful if your agent runtime is not Node).

## Quickstart (local, offline mode)

### 1) Start a local Minecraft server

The simplest path is an offline local server (no Microsoft login).

If you don’t already have a server, you can use Docker:

```bash
docker run -it --rm \
  -p 25565:25565 \
  -e EULA=TRUE \
  -e ONLINE_MODE=FALSE \
  -e DIFFICULTY=easy \
  -e MOTD="Eliza Minecraft" \
  itzg/minecraft-server:java21
```

### 2) Start the Mineflayer bridge server

```bash
cd plugins/plugin-minecraft
bun install
bun run build:server

export MC_SERVER_PORT=3457
export MC_HOST=127.0.0.1
export MC_PORT=25565
export MC_AUTH=offline
export MC_USERNAME=ElizaBot

cd mineflayer-server
bun run start
```

### 3) Use the TypeScript plugin in an Eliza runtime

See the example agent in `examples/minecraft/typescript` (added by this change).

## Microsoft authentication (optional)

Mineflayer supports Microsoft auth, but it requires an interactive device-code login flow on first run.

Set:

```bash
export MC_AUTH=microsoft
export MC_USERNAME="your_email@example.com"
```

Then start the bridge server and follow the printed login instructions.

## Development

```bash
cd plugins/plugin-minecraft

# build everything
bun run build

# run TS plugin build in watch mode
bun run dev

# run the Mineflayer bridge server directly (watch)
bun run dev:server
```

## Testing

- **Unit tests**: live under each language package.
- **Integration tests**: require a running Minecraft server and are opt-in via env flags (see the package READMEs).

## Protocol

The bridge uses a small JSON-over-WebSocket protocol defined in:

- `protocol/schema.json`

It’s intentionally stable so Python and Rust can interoperate with the TypeScript runtime.

## Actions (current)

- **`MC_CONNECT`**: create/connect a bot (optional JSON overrides: `{"host","port","username","auth","version"}`)
- **`MC_DISCONNECT`**: destroy/disconnect current bot
- **`MC_CHAT`**: send chat text
- **`MC_GOTO`**: pathfind to `x y z` (or JSON `{x,y,z}`)
- **`MC_STOP`**: stop current pathfinding goal
- **`MC_LOOK`**: set yaw/pitch (radians)
- **`MC_CONTROL`**: set movement controls (forward/back/left/right/jump/sprint/sneak)
- **`MC_DIG`**: dig block at `x y z`
- **`MC_PLACE`**: place onto a reference block face: `x y z face` (face: up/down/north/south/east/west)
- **`MC_ATTACK`**: attack entity by `entityId` (from `MC_WORLD_STATE`)
- **`MC_SCAN`**: scan nearby blocks (optional JSON: `{"blocks":["oak_log"],"radius":16,"maxResults":32}`)
- **`MC_WAYPOINT_SET`**: save current position as a named waypoint (message text = name)
- **`MC_WAYPOINT_LIST`**: list waypoints
- **`MC_WAYPOINT_GOTO`**: pathfind to a named waypoint (message text = name)
- **`MC_WAYPOINT_DELETE`**: delete waypoint (message text = name)

## Providers (current)

- **`MC_WORLD_STATE`**: bot vitals + position + inventory + nearby entities
- **`MC_VISION`**: semantic environment snapshot (biome, lookingAt, key blocks, nearby entities)
- **`MC_WAYPOINTS`**: saved waypoints (names and coordinates)

## Waypoint persistence

Waypoints are stored in a dedicated internal room as **memories**. This means they persist **whenever your runtime uses a durable adapter**.

- The TypeScript example includes `@elizaos/plugin-sql`, which defaults to **PGlite** if `POSTGRES_URL` is not set, so waypoints persist out of the box.
- If you run without a durable adapter, waypoints will exist only in-memory for that process.

