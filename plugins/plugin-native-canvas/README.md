# @elizaos/capacitor-canvas

Capacitor plugin that provides a multi-layer 2D canvas, drawing primitives, web view
embedding, and an A2UI bridge for elizaOS Eliza agents running on browser, node
(Electrobun), iOS, and Android.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-canvas build  # build
bun run --cwd plugins/plugin-native-canvas test   # tests
```
