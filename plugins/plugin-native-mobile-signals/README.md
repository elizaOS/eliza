# @elizaos/capacitor-mobile-signals

Capacitor plugin that bridges mobile wake, lock, battery, and protected-data state into
Eliza agents via the `MobileSignals` Capacitor plugin interface.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-mobile-signals build  # build
bun run --cwd plugins/plugin-native-mobile-signals test   # tests
```
