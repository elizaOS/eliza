# @elizaos/capacitor-appblocker

Capacitor plugin that blocks selected apps on Android (Usage Access + system overlay)
and iOS (Family Controls + ManagedSettings).

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-appblocker build  # build
bun run --cwd plugins/plugin-native-appblocker test   # tests
```
