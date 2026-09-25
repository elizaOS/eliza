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

Android attachment owns the base, layers, and embedded WebView together. Detach
removes that group; reattach preserves its contents and layer order. Enabling
touch places the drawing surfaces above the host; disabling it returns input to
the host. Repeated attachment does not add duplicate views.
Touch settings require a boolean. Disabling, hiding, or removing an active surface emits
one cancellation with the last pointer coordinates; repeated enable/attach calls
preserve an unchanged gesture.

Android create and resize require positive integer dimensions whose RGBA byte count
fits a signed 32-bit integer. Invalid sizes reject with `INVALID_ARGUMENT` before
allocation or mutation. Resize preserves existing base and layer pixels, crops on
shrink, and leaves new pixels transparent on growth.

Android intercepts `eliza://` navigation from both API calls and embedded pages.
Deep-link events include the encoded path and decoded query parameters (last
repeated value wins). Navigation errors include the native code and message.
