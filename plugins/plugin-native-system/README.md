# @elizaos/capacitor-system

A Capacitor plugin that bridges Android system-role status and device-settings control
into the elizaOS mobile runtime.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-system build  # build
bun run --cwd plugins/plugin-native-system test   # tests
```
