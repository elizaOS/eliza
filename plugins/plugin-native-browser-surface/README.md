# @elizaos/capacitor-browser-surface

Isolated native browser surfaces for mobile Browser tabs, exposed through the ElizaSurfaceManager Capacitor bridge.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-browser-surface build  # build
bun run --cwd plugins/plugin-native-browser-surface test   # tests
```
