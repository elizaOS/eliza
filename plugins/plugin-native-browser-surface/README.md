# @elizaos/capacitor-browser-surface

Isolated native browser surfaces for mobile Browser tabs, exposed through the ElizaSurfaceManager Capacitor bridge.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

Android `openBrowser` opens a full Chromium Custom Tab using the installed
`org.chromium.chrome` browser. Chromium owns cookies, permissions, headers,
password autofill and passkeys; the return value confirms dispatch, not website
load or sign-in. The browser must provide a Custom Tabs service. Missing or
disabled Chromium is an explicit error, without a WebView fallback. Existing
`createSurface` views remain isolated WebViews and are not full-browser tabs.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-browser-surface build  # build
bun run --cwd plugins/plugin-native-browser-surface test   # tests
```
