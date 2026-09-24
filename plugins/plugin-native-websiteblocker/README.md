# @elizaos/capacitor-websiteblocker

Capacitor plugin that enforces website blocking across browser, Android (split-tunnel
VPN DNS), and iOS (native Safari content blocker) from a single TypeScript API surface.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-websiteblocker build  # build
bun run --cwd plugins/plugin-native-websiteblocker test   # tests
```
