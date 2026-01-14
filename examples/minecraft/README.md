# Minecraft Agent Example

This example shows how to run an Eliza agent that can **connect to a Minecraft server** and act using `@elizaos/plugin-minecraft`.

## Prereqs

- A Minecraft server you can connect to (local Docker is easiest)
- Node/Bun (for TypeScript)

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
bun run build:server
bun run build:ts
```

## 3) Run the TypeScript agent

```bash
cd examples/minecraft/typescript
cp env.example .env

# edit .env as needed
bun run agent.ts
```

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

## Rust demo (standalone)

```bash
cd examples/minecraft/rust
cargo run
```

## Notes

- The Mineflayer bridge server is a local WebSocket server (default `MC_SERVER_PORT=3457`).
- The TypeScript Eliza plugin starts the bridge server automatically.

