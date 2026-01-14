# Mineflayer Bridge Server

This is a small **local WebSocket server** that owns the Mineflayer bot process and exposes a stable JSON protocol for:

- connecting/disconnecting a bot
- sending chat and movement/interaction commands
- retrieving world state / inventory / nearby entities

It’s started automatically by the TypeScript Eliza plugin (`plugins/plugin-minecraft/typescript`), but you can also run it standalone for debugging.

## Run

```bash
cd plugins/plugin-minecraft/mineflayer-server
bun install

export MC_SERVER_PORT=3457
export MC_HOST=127.0.0.1
export MC_PORT=25565
export MC_AUTH=offline
export MC_USERNAME=ElizaBot

bun run build
bun run start
```

