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

Build the package before running engine check, build, verify, or smoke commands; these commands use the bundled tools shipped to consumers.

Android lifecycle, streamed Agent requests, and BunRuntime RPCs are exercised against
the real bundled backend by `node packages/app/scripts/android-native-agent.ts
--serial <fresh-x86_64-emulator>`. See the [app setup guide](../../packages/app/README.md).
