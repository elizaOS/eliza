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

Host-owned activity anchors may declare `consumption: "host_claim"`. Automatic admission, execution preparation and mutation hooks preserve owner control metadata, and atomic claim expectations reject stale writes as `raced`. Manual fire does not consume automatic admission. These hooks use the existing runner and store; they do not introduce another scheduler.
