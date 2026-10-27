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

Android surfaces may opt in to navigation interception with
`createSurface({ ..., interceptNavigation: true })`. The page then navigates within its
own origin by itself; a main-frame navigation to another origin, a cross-origin redirect
included, is cancelled before any request and reported as `navigationRequested`
(`{id, owner, session, epoch, url, redirect, userGesture}`). The host loads the address
with `navigate()` once its own check (for example `SubmittedNavigation`) allows it.
Non-web schemes and addresses with credentials are refused when WebView sends them to
this callback. A main-frame request that WebView sends without that callback (a POST
form submission, a page's own history move) gets a local empty 204 unless its origin is
the committed page's or one the host approved (`navigate`, `createSurface`, `goBack`,
`goForward`) for the length of that navigation, the https upgrade of either included.
It is reported with its `method` and never replayed, so a blocked host never receives it.
A server redirect of an address the host loaded goes on without asking again only while
it stays within the approved origin or its https upgrade. A tapped new window is
reported with `newWindow: true`. Subframes are not intercepted; this is not a
subresource filter.

When the host extends a running task to another website after its own check (for
example `https://www.ssa.gov` hands the person to `https://secure.login.gov`), it calls
`setTaskOrigins({ id, owner, session, epoch, origins })` with the task's exact HTTPS
origins. A page on one of them may then move to another, a POST included, without a
hold; every other origin is still held. `origins: []` ends the extension. Nothing is
added without this call, and the list ends with the surface.

A website never acts for the person through a surface. Android reports these as events
and does nothing by itself:

- `dialogRequested`: `alert`, `confirm`, `prompt` and leave-page dialogs wait for
  `answerDialog`. A dialog of a hidden, closing or navigating surface is cancelled,
  never accepted.
- `downloadRequested`: nothing is downloaded. The http(s) address can carry access
  tokens, so keep it out of models and logs.
- `externalLinkRequested`: a tapped `tel:`, `mailto:`, `market:` or `intent:` link.
  `openExternalLink` opens only that link with a fresh Intent; `tel:` opens the dialer
  and places no call. Script attempts are dropped.
- `identityProviderRequested`: Google and Facebook sign-in pages refuse embedded
  WebViews (`disallowed_useragent`). They are not loaded; open them in a full browser.
- `surfaceCrashed`: the page renderer crashed or was reclaimed. Only that surface
  closes; the host activity keeps running. Recreate the surface to continue.
- `keyboardChanged`: the on-screen keyboard opened or closed, with its height.

Isolated surfaces get a fresh storage profile that is cleared when the surface closes
and deleted once Android releases it. `createSurface({ ..., profileKey })` instead
selects one persistent profile per owner and key (for example a signed-in account), so
website sign-ins survive. `purgeProfiles({ profileKey })` removes it at once and closes
its surfaces (`surfaceClosed`); `purgeProfiles({ idleMs })` removes keyed profiles idle
for that long. `clearSurfaceStorage` signs one isolated surface out of every website.

`captureSurface` returns a JPEG of the visible page, about 1024 px on the long edge, for
a vision fallback. Before the copy it covers password, `cc-*`, `one-time-code` and other
sign-in fields, host-supplied selectors and every frame the page cannot read; it removes
the covers right after and paints over host chrome. It rejects rather than return an
image it could not mask.

Android `controlPage` also accepts `follow` for a current observed anchor with a
host-issued `follow` target permission. It loads the exact HTTPS address retained
in that snapshot without invoking the anchor's click handlers. Stale destinations,
other origins, URL credentials, downloads and other-window targets are refused.
The snapshot is consumed once. Navigation can interrupt its reply; read the page
without replaying after an uncertain outcome. This primitive does not grant task
authority or prove arrival. The embedded task adapter and guided workflow support `browser.follow`;
products still own planner policy and completion evidence.

Android `observeHistory` exposes adjacent same-origin destinations with opaque,
short-lived references. `navigateHistory` consumes a reference once and dispatches
through the native-owned isolated world: Android's ordinary Back/Forward API can
skip history entries. Hidden, paused, replaced or changed history refuses the
reference. Navigation can retire the reply; `UNCERTAIN_OUTCOME` requires page
readback, never replay. A dispatch receipt does not prove arrival or task success.
These are host primitives, not agent authorization: the caller must compose task
scope, origin approval, preview and durable effect recording. Cross-origin history
and iOS are not supported by these methods. Form POST resubmission is refused.

Script popups never open. `getSurfaceState` also returns `title`, `canGoBack`,
`canGoForward`, `progress`, `pageError` and `textZoom`; `setTextZoom` sets the page
text size from 50 to 300 percent.

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

Android `controlPage` uses the shared Chromium page commands in a named isolated
JavaScript world. It requires AndroidX WebKit 1.16 and a provider that supports
`JS_INJECTION_IN_FRAME_AND_WORLD`; unsupported providers reject control requests.
The host must supply an authorized task policy for input. Never use a policy
from model output or website content. Each effect requires a fresh snapshot and
its document ID. Closing, hiding, navigation, or owner reconciliation interrupts
pending work. Activity pause also fences control and keeps the page for Resume.
Hiding or pausing requires a fresh snapshot before the next input. A lost effect reply reports an uncertain outcome; observe before
continuing and never automatically replay the effect. This API currently covers
the main frame's DOM commands, not child frames or coordinate input.

`bun run --cwd plugins/plugin-native-browser-surface test:control` uses
`ELIZA_BROWSER_EXECUTABLE` to test the generated channel in a real Chromium
isolated world. This checks DOM effects and document/reference isolation, not
Android installation or the native reply proxy. The generated native asset shares
the existing browser command implementation; `build` regenerates it and
`node plugins/plugin-native-browser-surface/scripts/build-control-channel.mjs --check`
checks that it is current.
The same test routes commands through the authenticated native-host HTTP gateway
and surface client. It checks complete observations, real click/fill readback,
and an effect whose reply is lost without delivering that command again. The
native host transport still needs product task and page ownership composition.
Run the native bridge flow with `--surface-control` on the Android test command
above. It uses a local synthetic document, checks real click/fill readback, stale
references and document IDs, and hides/restores the same page. This lane requires
a provider with isolated-world support and fails if it is unavailable.

The `select` command chooses one exact visible option label from a native select.
Its `text` is the label, not the internal option value. Snapshot options expose
labels, disabled state and selection. Ambiguous labels, disabled options and
multi-select controls are refused. Selection uses the same document, task policy,
preview and fresh-readback requirements as other effects.

A `validateOnly: true` input command checks the observed target and host policy
without consuming its native snapshot or running input. The shared task adapter
uses this before the visible preview, then sends the actual action with its
preview identity. Validation still requires the current document and snapshot.

The isolated channel also accepts `guide` commands for the shared page guidance
renderer: show an observed target, check action-preview readiness, pause or hide.
Show and readiness requests require the current document and snapshot. Annotations
do not consume input references. Hide and pause remain available after the surface
is hidden, but cannot read or change website controls. Native answer offers are
not supported; product approval stays in its trusted host. Hosts must still bind
task authority and wait for a valid action preview before dispatching input.

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

`./browsing-session` is the renderer half of `BrowserSessionPolicy`: it normalizes saved
tabs and history (private tabs never enter a snapshot), and restores saved tabs only into an
untouched browser. Hosts own tab views, storage and the bounds (`BrowsingLimits`).

`SubmittedNavigation` from `./submitted-navigation` owns submitted-address history, stale-check fencing and revision-bound explicit one-time overrides. Hosts validate/resolve addresses and supply a verdict check. Failed checks stay unavailable. The default `check-first` policy waits for a clean verdict. A host can select `policy: "blacklist"` to permit unavailable and lookalike results; a confirmed blocked result still stops navigation. Navigation waits for the host check, which should use a local cache rather than await feed downloads. Request-time enforcement must also cover redirects and subsequent navigation. It does not grant task actions. Hosts retain warning/confirmation UI, sandbox configuration and all navigation authorization. This controller cannot observe internal iframe navigation or certify loaded content.

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
- `BrowserFieldOrigin` binds a website login field only to the origin WebView reports for
  its frame (`WebMessageListener` `sourceOrigin`), and only when it equals the committed
  top-level HTTPS origin of an eligible tab. Cross-origin, sandboxed and cleartext frames are
  refused with a stated reason; a binding ends with its navigation.
- `BrowserHttpAuthOrigin` admits an HTTP sign-in prompt for fill only from an engine-reported
  challenge. Standard WebView reports none (`STANDARD_WEBVIEW`), so its prompts stay manual.

Android helpers for the same hosts (they need AndroidX WebKit with
`JS_INJECTION_IN_FRAME_AND_WORLD` and `WEB_MESSAGE_LISTENER`; without them the feature stays off):

- `BrowserLoginFields.install(webView, host, extras)` runs its reporter (`SCRIPT`) in an
  isolated world of every frame before the first load. Bound fields reach Android Autofill as
  virtual children of `anchor`, a transparent view the host lays over the tab, with the
  per-field and top-level origin extras the host's password provider reads
  (`BrowserAutofillExtras`; for `plugin-native-passwords` pass
  `PasswordAutofillPolicy.FIELD_ORIGIN` and `PasswordFormPolicy.TOP_ORIGIN_EXTRA`). Fill
  values go only to the frame that reported the field. While it exists, exclude the tab
  WebView's own autofill structure.
- `BrowserHttpAuthAutofill.field(...)` builds the prompt's two fields; they report the bound
  origin only while the host's binding admits the tab.
- `BrowserDownloads` reviews every download natively, keeps a private tab's entries in memory
  only, fetches a signed-in file itself so the tab's cookie reaches only its exact page origin
  on each redirect hop, and stops that fetch when its entry, tab or site data is cleared.
  `BrowserBlobCapture` copies a page-created `blob:` file through an isolated world. The host
  passes its preference name, its "is this review still current" check and its cookie reader.

Hosts retain site-permission prompts, OS permissions, sealed storage and navigation.
Hosts that do their own downloads recheck cookie policy at every redirect and never hand
authenticated headers to DownloadManager, which stores and replays them. The pure policies
perform no network requests; none of this qualifies a browser, provider or device integration.
