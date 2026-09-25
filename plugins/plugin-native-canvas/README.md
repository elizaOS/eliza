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

Android drawing and clearing reject unknown or deleted layer IDs with
`LAYER_NOT_FOUND`. Batch errors include `commandIndex`; earlier commands remain
applied and later commands do not run. Device contracts verify layer isolation,
encoded pixels, and failure recovery through the real WebView bridge:

```bash
bun packages/app/scripts/android-native-plugins.ts --serial emulator-5580 --plugin plugin-native-canvas
```

Android's public WebView methods own a standalone view: `navigate` selects inline,
fullscreen, or popup placement; `eval`, `snapshot`, and A2UI calls use that view.
Existing explicit `canvasId` calls remain isolated. Inline content sits behind the
host WebView; fullscreen sits above it; popup uses a native dialog. Wait for
`webViewReady` before using page content. Snapshot supports PNG/JPEG/WebP and
rejects invalid options or an unlaid view. A2UI requires the page's runtime host.
