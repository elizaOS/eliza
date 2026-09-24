# @elizaos/plugin-scheduling

The scheduling spine for elizaOS agents — the storage-agnostic `ScheduledTask` state
machine **and** the always-loaded runtime primitive that HOSTS it.

Core TaskService drives the clock; this plugin owns ScheduledTask storage contracts,
state transitions, registries, and execution. Edge hosts inject the SQL executor through
the package root. Connector delivery uses typed DispatchResult and must not record failed
delivery as success.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-scheduling build  # build
bun run --cwd plugins/plugin-scheduling test   # tests
```
