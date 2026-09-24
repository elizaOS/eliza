# @elizaos/agent

Standalone agent host and HTTP/WebSocket backend around the elizaOS runtime.

Hosts explicitly compose core, assistant, storage, and model plugins. Start from the
repository root with `bun run start`; use `bun run dev` for the app and API together.
Configure providers and connectors through the host configuration; never expose host
secrets to ungranted agents.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/agent build  # build
bun run --cwd packages/agent test   # tests
```

Retain real end-to-end scenarios exercising host, transport, and persistence.
The package test, test:e2e, and test:integration commands share that suite;
do not reintroduce removed unit, mock, smoke, or source-inspection tests.
