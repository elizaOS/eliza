# Autonomous (TypeScript)

This example runs a **sandboxed autonomous loop** using:

- `@elizaos/plugin-local-ai` (local GGUF inference)
- `@elizaos/plugin-shell` (restricted shell)
- `@elizaos/plugin-inmemorydb` (ephemeral memory)

Entry point: `autonomous.ts`

## Run

```bash
cd examples/autonomous/typescript
bun install
bun run start
```

## Stop

- Create the stop file (default): `examples/autonomous/sandbox/STOP`

```bash
touch examples/autonomous/sandbox/STOP
```

## Config

See `env.example.txt` for the supported environment variables.
