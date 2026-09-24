# @elizaos/capacitor-calendar

A Capacitor plugin that reads and writes Apple Calendar events through EventKit, for use
in elizaOS iOS apps and macOS desktop runtimes.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-calendar build  # build
bun run --cwd plugins/plugin-native-calendar test   # tests
```
