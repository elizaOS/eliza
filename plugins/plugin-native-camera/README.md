# @elizaos/capacitor-camera

Capacitor plugin that gives Eliza agents camera preview, photo capture, and video
recording across web, iOS, and Android.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-camera build  # build
bun run --cwd plugins/plugin-native-camera test   # tests
```
