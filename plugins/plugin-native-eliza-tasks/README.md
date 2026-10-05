# @elizaos/capacitor-eliza-tasks

Capacitor plugin that bridges iOS `BGTaskScheduler` background-wake events into the
elizaOS Capacitor runtime.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-eliza-tasks build  # build
bun run --cwd plugins/plugin-native-eliza-tasks test   # tests
```
