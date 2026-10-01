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

Android hosts may opt in to the shared `BrowserNativeMessagingService` by
registering it as an exported service with the action
`org.chromium.chrome.browser.extensions.messaging.action.NATIVE_MESSAGING`.
The plugin does not register an exported service automatically. The relay accepts
only the build-pinned Chromium package/certificate and a verified extension;
debug builds do not bypass verification. It exposes the private abstract socket
`<applicationId>.browser.native` only to the same UID. Each host must build its
owned Chromium component with that host's application ID and signing certificate.
This is transport infrastructure, not proof of an installed browser connection.
The plugin owns the Chromium native-messaging AIDL definitions. Host apps use
the library classes and must not compile duplicate copies of those definitions.
Eliza retains its existing service component as a thin subclass of this relay.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-browser-surface build  # build
bun run --cwd plugins/plugin-native-browser-surface test   # tests
```

Android device tests exercise ownership, storage isolation, real WebView page
reads, navigation/back/reload, and visibility after rejected presentation:

```bash
node packages/app/scripts/android-native-plugins.ts --serial emulator-5554 --plugin plugin-native-browser-surface
```

The bridge fixture exports native screenshots and complete page-read results.
