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

`parseBrowserAddressInput` (also exported as `./address-input` without bridge
registration) classifies address-bar text as an HTTP(S) URL, search text, or a
rejection reason. Hosts supply the inferred protocol and own aliases, search
providers, upgrades and error copy. Parsing performs no network request and is
not an SSRF, reputation, browser ownership or navigation-authorization check.

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

Android foreground-service hosts can share `ChromiumBrowserConnection`: construct
it with the service context, call `start()` after entering foreground, and
`close()` when the service stops. Call its lifecycle methods on the main thread.
It verifies the module's build-pinned package and signing certificate before
binding and after connection. The priority-preserving Custom Tabs binding keeps
the browser reachable without opening an activity, tab, URL or debugging port.
It does not grant task/action authority or claim that a renderer is observable.

Android `presentBrowser()` foregrounds the certificate-pinned browser without a
URL or new website tab. Invoke it from an explicit user interaction before a
workflow that needs visible native guidance. Its receipt is dispatch only: the
caller must freshly observe and retain normal task/target/visibility guards. It
does not select a task tab, grant action authority or navigate. Other platforms
reject this Android-only operation.

Android `openDockedBrowser({url, panelWidthDp})` requests a right-side host pane
beside the build-pinned Chromium browser. The host application must declare
`android.window.PROPERTY_ACTIVITY_EMBEDDING_SPLITS_ENABLED=true` and the browser
must opt in to the host signer (including its intent dispatcher target). Android
13+, WindowManager embedding support and sufficient window width are required.
The helper width defaults to 400 dp, accepts 320–640 dp, and reserves at least
480 dp for the website. Package-scoped Custom Tabs VIEW intents match a rule for
the exact pinned package; Android independently enforces each activity's trust.

The launch receipt reports dispatch only. `getBrowserDockState()` returns actual
host embedding state and bounds in native display pixels. Neither method selects
a task tab, authorizes an action or proves the website has loaded. The caller
must observe and validate the relevant browser target before any workflow effect.
Other platforms reject these operations. Installed pane/input qualification,
rotation, existing-tab continuity, Close/return and persistent entry are separate
integration requirements; these APIs alone do not provide a complete helper UI.
The dock state has no page address or title, because the website runs in
Chromium, not in this plugin. A host reads the current page through the browser
extension connection instead (`NativeSocketBrowserTarget.currentPage()` in
`@elizaos/plugin-browser`).

When the host is already embedded, `presentBrowser()` revalidates the installed
browser and host embedding trust and preserves the existing pane without sending
a launcher intent. It still does not identify or authorize a task tab: callers
must freshly observe before acting. Outside an existing split, presentation keeps
the normal browser-launcher behavior; restoring a closed split is separate work.

`setBrowserDockVisible({visible})` requests collapse or restoration of the existing
host-owned split using Window SDK extension 3+. It never launches or reloads a URL.
The current host session must have opened the split, and the topmost current split
(in AndroidX z-order) must have this host as primary. Missing/foreign/recreated sessions reject
instead of replaying navigation. A request receipt is not proof of resulting bounds.
The product must pause its work before hiding help and provide a return control;
this low-level API does not itself provide persistent entry or task resumption.

Hosts can explicitly declare `SYSTEM_ALERT_WINDOW` and request Android's revocable
overlay permission using `requestBrowserHelperEntryPermission()`. The library does
not add that permission automatically. `hideBrowserDockWithEntry` requires the
grant and installs a bounded, non-focusable return control before requesting
collapse. Tapping it moves the existing host WebView into a full-screen native
window and emits `browserHelperReturned`; no Activity, URL or browser tab is
launched. `restoreBrowserDockFromEntry` returns the same view to the existing
split. The host owns pause, microphone shutdown, saved context and explicit Resume.
These windows are removed when this plugin instance is destroyed; process-death
recovery and device lifecycle qualification remain host integration requirements.

A successful explicit `openDockedBrowser` releases an existing return badge or
full-screen helper window and emits `browserHelperWindowClosed`. The consumer
updates its presentation state without resuming a task. Failed navigation
preflight leaves the existing helper window intact.

While the host process remains alive, overlay permission revocation restores the
WebView to its original parent, removes return windows and requests the existing
browser split. The same permission check runs on host resume. A closed-window
event carries `permission-revoked`; task and microphone state remain host-owned.
Android may kill the process when permission changes, so this recovery does not
establish process-death persistence. The permission watcher is removed on destroy.

`SubmittedNavigation` from `./submitted-navigation` owns submitted-address history, stale-check fencing and revision-bound explicit one-time overrides. Hosts validate/resolve addresses and supply a verdict check. Failed checks stay unavailable. Hosts retain warning/confirmation UI, sandbox configuration and all navigation authorization. This controller cannot observe internal iframe navigation or certify loaded content.

## Android host web policy

The pure-JVM policy classes in `ai.eliza.plugins.browsersurface` are shared by hosts
with persistent and private WebView profiles. Run `bun run test:native-policy`
from this package with a JDK on PATH or JAVA_HOME.

- `BrowserWebOrigin` validates HTTP(S) origins, blob owners and site matching.
- `BrowserDownloadPolicy` limits cookies to the open source tab's exact origin,
  decodes data URLs within 64 MB on Android 26+, and excludes private downloads from saved history.
  Saved entries survive restoration even above the limit for adding new entries.
- `BrowserSitePermissions` stores revocable camera, microphone and location choices
  per origin. Private tabs neither read nor store these choices.
- `BrowserSessionPolicy` restores valid persistent tabs, history and complete titles.
  It excludes private tabs and validates bookmarks. Hosts own tab and storage limits.
- `BrowserExternalLinkPolicy` requires a user gesture and selects a safe handoff kind.
  The host constructs a fresh intent and refuses a resolved target in its own package.
- `BrowserAutofillEligibility` requires the selected, visible, committed HTTPS document
  to match the engine address. The host owns framework commit/cancel and excludes
  ineligible views from autofill.

Hosts retain consent UI, OS permissions, sealed storage, navigation and downloads.
Recheck cookie policy at every redirect; do not hand authenticated headers to
DownloadManager, which stores and replays them. These policies do not themselves
perform network requests or qualify a browser/device integration.
