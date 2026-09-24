# @elizaos/capacitor-bun-runtime

Capacitor plugin that bridges the React UI to an embedded Bun-shape JS runtime on iOS
and Android, letting an Eliza agent run locally on a mobile device.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-bun-runtime build  # build
bun run --cwd plugins/plugin-native-bun-runtime test   # tests
```
