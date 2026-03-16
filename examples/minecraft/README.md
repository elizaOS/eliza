# Minecraft Agent Example

This example shows how to run an Eliza agent that can **connect to a Minecraft server** and act using `@elizaos/plugin-minecraft`.

## Feature Parity (TypeScript / Python / Rust)

All three language implementations now have full parity:

| Feature | TypeScript | Python | Rust |
|---------|------------|--------|------|
| **Actions** | | | |
| MC_CONNECT | ✅ | ✅ | ✅ |
| MC_DISCONNECT | ✅ | ✅ | ✅ |
| MC_CHAT | ✅ | ✅ | ✅ |
| MC_GOTO | ✅ | ✅ | ✅ |
| MC_STOP | ✅ | ✅ | ✅ |
| MC_DIG | ✅ | ✅ | ✅ |
| MC_PLACE | ✅ | ✅ | ✅ |
| MC_LOOK | ✅ | ✅ | ✅ |
| MC_CONTROL | ✅ | ✅ | ✅ |
| MC_ATTACK | ✅ | ✅ | ✅ |
| MC_SCAN | ✅ | ✅ | ✅ |
| MC_WAYPOINT_SET | ✅ | ✅ | ✅ |
| MC_WAYPOINT_DELETE | ✅ | ✅ | ✅ |
| MC_WAYPOINT_LIST | ✅ | ✅ | ✅ |
| MC_WAYPOINT_GOTO | ✅ | ✅ | ✅ |
| **Providers** | | | |
| MC_WORLD_STATE | ✅ | ✅ | ✅ |
| MC_VISION | ✅ | ✅ | ✅ |
| MC_WAYPOINTS | ✅ | ✅ | ✅ |

## Prereqs

- A Minecraft server you can connect to (local Docker is easiest)
- Node/Bun (for TypeScript)
- Python 3.10+ (for Python)
- Rust 1.70+ (for Rust)

## 1) Start a local server (offline)

```bash
docker run -it --rm \
  -p 25565:25565 \
  -e EULA=TRUE \
  -e ONLINE_MODE=FALSE \
  itzg/minecraft-server:java21
```

## 2) Build the Minecraft plugin + bridge server

```bash
cd plugins/plugin-minecraft
bun install
bun run build
```

## 3) Run the TypeScript agent

```bash
cd examples/minecraft/typescript
cp env.example .env

# edit .env as needed
bun run agent.ts
```

This TypeScript agent includes:

- `@elizaos/plugin-minecraft` (Minecraft actions + world state + vision + waypoints)
- `@elizaos/plugin-goals` (goal tracking)
- `@elizaos/plugin-todo` (task tracking)
- `@elizaos/plugin-sql` (storage; defaults to PGlite if `POSTGRES_URL` is not set)

## Python demo (standalone)

This uses the Python client package (it expects the Mineflayer bridge server to be running).

```bash
cd plugins/plugin-minecraft
export MC_SERVER_PORT=3457
cd mineflayer-server
bun run start
```

Then in another terminal:

```bash
cd plugins/plugin-minecraft/python
pip install -e ".[dev]"

cd ../../../examples/minecraft/python
pip install python-dotenv
python agent.py
```

The Python example demonstrates:
- World state, vision, and scan providers
- Setting and listing waypoints
- Autonomous walking loop with vision context

## Rust demo (standalone)

```bash
cd examples/minecraft/rust
cargo run
```

The Rust example demonstrates:
- World state, vision, and scan providers
- Setting and listing waypoints
- Autonomous walking loop with vision context

## Notes

- The Mineflayer bridge server is a local WebSocket server (default `MC_SERVER_PORT=3457`).
- The TypeScript Eliza plugin starts the bridge server automatically.
- Waypoints persist when a durable runtime adapter is used (the example includes `@elizaos/plugin-sql`, which uses PGlite by default).
- For Python/Rust standalone usage, waypoints are stored in-memory. For persistent waypoints in Python/Rust, integrate with your runtime's storage layer.

