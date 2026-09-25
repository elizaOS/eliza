# @elizaos/capacitor-browser-surface

Isolated native browser surfaces for mobile Browser tabs, exposed through the ElizaSurfaceManager Capacitor bridge.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

Android `openBrowser` opens a full Chromium Custom Tab using the installed
build-pinned browser (`org.chromium.chrome` by default, or `ai.elizaos.chromium`
for the owned build). Chromium owns cookies, permissions, headers,
password autofill and passkeys; the return value confirms dispatch, not website
load or sign-in. The browser must provide a Custom Tabs service. Missing or
disabled or incorrectly signed Chromium is an explicit error, without a WebView fallback. Existing
`createSurface` views remain isolated WebViews and are not full-browser tabs.

Set `ELIZA_CHROMIUM_PACKAGE_NAME` to one of those two package names and
`ELIZA_CHROMIUM_CERT_SHA256` to its signing-certificate SHA-256 when building the
Android host and plugin. Missing pins fail closed; package selection is never a
runtime setting. Changing packages uses a separate browser profile and does not
migrate existing browser grants or credentials. Native messaging retains its
upstream `org.chromium.chrome.browser` AIDL/action ABI.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-browser-surface build  # build
bun run --cwd plugins/plugin-native-browser-surface test   # tests
```
