# @elizaos/plugin-native-wifi

Android-only overlay app that lets an Eliza agent scan, inspect, and connect to nearby
Wi-Fi networks.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-wifi build  # build
bun run --cwd plugins/plugin-native-wifi test   # tests
```
