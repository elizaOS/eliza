# @elizaos/plugin-inbox

Unified cross-channel inbox triage with unresolved-item tracking, snooze, archive, and
follow-up watcher for Eliza agents.

Import the plugin, inbox services, connector fetchers, and shared types from
`@elizaos/plugin-inbox`. `InboxActionItem` is the action fan-out record;
`InboxItem` is the view record. Implementation modules are private.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-inbox build  # build
bun run --cwd plugins/plugin-inbox test   # tests
```
