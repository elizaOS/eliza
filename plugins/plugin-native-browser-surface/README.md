# @elizaos/capacitor-browser-surface

Isolated native browser surfaces for mobile Browser tabs, exposed through the
ElizaSurfaceManager Capacitor bridge.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require
their SDKs, registered bridge, and OS permissions.

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
and does nothing by itself. Dialogs, file inputs and site permission requests wait only on
a surface whose own owner created it with `answersRequests: true`, while a listener for the
event exists; any other surface's are dismissed at once (a dialog cancelled, a file input
given nothing, a permission denied) and not reported, so no page freezes on a request
another owner's listener would never answer. `interceptNavigation` does not hold them: an
intercepting surface without `answersRequests` dismisses dialogs at once like any other.

- `dialogRequested`: `alert`, `confirm`, `prompt` and leave-page (`beforeunload`)
  dialogs wait for `answerDialog`; a dismissed one is cancelled, never accepted.
- `fileChooserRequested`: a file input waits for `answerFileChooser({ requestId, open })`.
  `open: true` shows the system document picker and gives the page the content URIs the
  person picks (at most 16, one unless the input takes several); `open: false` gives it
  nothing. A save-mode input always gets nothing.
- `sitePermissionRequested`: a camera, microphone or location request from the https
  page's own origin (`{ requestId, origin, kinds, topFrame, androidPermissions }`) waits
  for `answerSitePermission({ requestId, grant })` and is never remembered. A grant asks
  Android for `androidPermissions` (the runtime permissions the app still lacks) itself.
  It resolves `{ granted, outcome }`; `granted: false` means the page was denied, and
  `outcome` says why (see Site permissions below). Another origin's request is already
  denied and reported with `topFrame: false` and no `requestId`; an insecure page's own
  request is denied without a word. WebView names only the requesting origin, never the
  frame, so `topFrame` is an origin check: a same-origin embedded frame counts as the page.
- `sitePermissionWithdrawn` (`{ requestId }`): a held request ended without the host's
  answer; close its prompt. Either the page withdrew it (WebView's
  `onPermissionRequestCanceled` or `onGeolocationPermissionsHidePrompt`: WebView has
  already cancelled it and the plugin answers nothing), or the page navigated, or the
  surface was hidden, reconciled or closed, and the plugin denied it.
- `pageStarted` (`{ url }`): the surface's main frame started loading a new document
  (WebView's `onPageStarted`, which frames and same-document moves never send; an error
  page is a document too). Everything the previous page waited on has ended by then: each
  `sitePermissionWithdrawn` this start caused arrives before it. `navigationChanged`
  follows once the page settles.
- `downloadRequested`: nothing is downloaded until `saveDownload({ requestId })`, which
  saves the file to Downloads with the surface's own cookie for the requesting page's
  exact origin and reports `downloadFinished` (`saved` or `failed`). The http(s) address
  can carry access tokens, so keep it out of models and logs; native code never logs it.
- `fullscreenChanged`: a page's fullscreen view (usually video) is shown above the host;
  Back, the page, or hiding, pausing or navigating the surface ends it, and the host's
  system bars return as they were before.
- `externalLinkRequested`: a tapped `tel:`, `mailto:`, `sms:`, `geo:`, `market:` or `intent:` link,
  with `handoff` (`send-to`, `dial`, `view` or `refuse`).
  `openExternalLink` opens only that link with a fresh Intent; `tel:` opens the dialer
  and places no call. Script attempts are dropped without an event.
- `identityProviderRequested`: Google and Facebook sign-in pages refuse embedded
  WebViews (`disallowed_useragent`). They are not loaded; `openIdentityProvider({ requestId })`
  opens the page as a Custom Tab in the default browser, or another browser when the
  default is this app or Android would ask, sent by package so it never comes back into
  this app. The address never comes back from the host.
- `surfaceCrashed`: the page renderer crashed or was reclaimed. Only that surface
  closes; the host activity keeps running. Recreate the surface to continue.
- `keyboardChanged`: the on-screen keyboard opened or closed, with its height.

### Request lifecycle (Android)

What the code does, one surface at a time:

- **Who may wait.** A dialog or site permission request waits only when the surface was
  created with `answersRequests: true`, a listener for its event exists, the owner's session
  is live, the surface is foregrounded (presented) and not paused, and fewer than 4 of that
  kind are already waiting. A file input waits under the same conditions (one at a time, see
  below). Anything else is dismissed at once and not reported: so a request from a surface
  that is not foregrounded is dismissed at once. Downloads, external links and sign-in pages
  are not gated on `answersRequests` or on being foregrounded: any live surface reports them.
- **Presenting ends the hidden siblings' requests.** `presentSurface({ id })` hides every
  other surface of the same owner, and `presentSurface()` with no id hides them all; for
  each hidden one, held dialogs are cancelled (a leave-page dialog cancelled means the page
  stays), fullscreen ends, the file input gets no files, held site permissions are denied
  and each sends `sitePermissionWithdrawn`, and the held download is dropped. The surface
  being presented keeps its own. `reconcileOwner` does the same to every surface of the
  owner. The held external link and sign-in page are not ended by hiding.
- **Navigating and closing** (the page starts loading a new document, `destroySurface`,
  a purged profile, a renderer crash, a stale surface `reconcileOwner` removes, the
  plugin's teardown when the host activity is destroyed) end the
  same things as hiding, and also drop the held external link and sign-in page.
  `sitePermissionWithdrawn` is sent only while the owner's session is live.
- **Pausing** (`pauseSurface`) cancels held dialogs and ends fullscreen only; a held
  file input and held site permissions stay, since a system picker or Android's
  runtime permission dialog for a grant may be what covers the page.
- **One of each per surface; the later replaces the earlier.** File input: the earlier
  one gets no files at once; the host hears nothing for it, and `answerFileChooser` with its
  id rejects `FILE_CHOOSER_CLOSED`. Download: the earlier one is dropped silently;
  `saveDownload` with its id rejects `DOWNLOAD_NOT_PENDING`. External link: the later
  link replaces the earlier silently, and `openExternalLink` with the earlier address
  rejects `EXTERNAL_LINK_NOT_PENDING`; a refused or scripted link also clears the earlier
  one. Sign-in page: the later `requestId` replaces the earlier silently, and
  `openIdentityProvider` with the earlier one rejects `IDENTITY_PROVIDER_NOT_PENDING`.
  None of the four sends an event for the replaced request.
- **Site permissions.** A request carries `kinds[]` (`camera`, `microphone`, `location`;
  kinds the host app declares no Android permission for are left out, and a request left
  with none is denied at once). One `answerSitePermission` answers the whole request:
  `grant: true` first shows Android's runtime permission dialog for any permission the app
  lacks (one dialog at a time; later grants wait their turn), then grants every listed kind
  if Android allowed them all and the page is still at the requesting origin, and otherwise
  denies them all; `grant: false` denies them all. It resolves `{ granted, outcome }`:
  `granted` (the page has every kind), `denied` (`grant: false`), `android-refused`
  (Android's dialog was shown and a permission is still missing) or `ended` (the page
  withdrew the request, navigating, hiding or closing ended it while Android asked, the
  page left the requesting origin, or Android could not ask: no dialog could open, or
  Android returned no answer, e.g. another request was showing). Only
  `granted` gives the page anything. It is answered once: a second answer, even while
  Android's dialog is up, rejects `SITE_PERMISSION_CLOSED`.
- **Autoplay while capturing.** As Chrome lets a page that captures play media, a granted
  camera or microphone request lets that surface's current page play audio and video
  without a gesture (`mediaPlaybackRequiresUserGesture` off); the next page start
  (WebView's `onPageStarted`) turns the gesture requirement back on. A location grant
  changes nothing. WebView's Blink fixes the requirement into each `<video>` and `<audio>`
  element when it is created, so only elements the page creates after the grant play on
  their own: a preview element already in the page (for example a static
  `<video autoplay>`) stays paused until a tap plays it. The setting is changed before the
  grant is answered, but WebView sends settings to the page by an asynchronous sync that
  does not wait for the permission answer, so an element made in the page's
  `getUserMedia` handler plays on its own only as best effort (observed to on WebView 124).
- **External links.** `openExternalLink` takes the pending link first, so it is used once
  whatever happens. When no app other than this one resolves the Intent, or the app is gone
  by launch, it rejects `EXTERNAL_APP_UNAVAILABLE` (Android refusing the launch rejects
  `EXTERNAL_LINK_DENIED`; an unparsable link `EXTERNAL_LINK_INVALID`). It resolves
  `{ status: "dispatched" }` once Android started the other app.
- **The host's own navigation.** `navigate`, `reloadSurface`, `goBack` and `goForward`
  first end what the page holds, as navigating does (dialogs cancelled, fullscreen,
  file input, site permissions with `sitePermissionWithdrawn`, held download), then load:
  a held dialog blocks the page, so WebView could not start the load and no `pageStarted`
  would follow. A held leave-page dialog is cancelled too; the load then runs the page's
  `beforeunload` again, which may hold a new leave-page dialog, as Chrome asks before a
  browser navigation.
- **Leaving the page (`beforeunload`).** A page's leave-page check reaches the plugin as
  `onJsBeforeUnload` and is a dialog like the others, `kind: "beforeunload"`.
  `answerDialog({ accept: true })` leaves the page; `accept: false` keeps the page and
  drops the navigation. A leave-page dialog that is dismissed — on a surface without
  `answersRequests`, with no listener, not foregrounded, paused, or when the surface is
  hidden — is cancelled, so the page stays and the navigation does not happen.

A certificate error is never passed. When it is the page's own, `navigationChanged`
follows with `securityBlocked: true` and the certificate `pageError`, which a later
generic load error of the same address does not replace, so the host can cover the error
page with a security block.

Android `pauseSurface` calls `WebView.onPause()` on one surface and `resumeSurface`
undoes it. The page stops drawing and its timers slow to about once a second, even while
it is shown; its state and history stay. A hidden surface is already treated this way, so
use it for a page that stays shown under host screens. It frees no memory. A paused
page gets no touches, focus or keyboard, its held dialogs are cancelled (held file inputs
and permission requests stay, as a picker or permission prompt may cover it), and capture,
page control, `observeHistory` and `navigateHistory` reject until `resumeSurface`;
`goBack`, `goForward`, `navigate` and `reloadSurface` still run. `presentSurface` never
resumes it. iOS rejects both methods with `UNSUPPORTED`.

Isolated surfaces get a fresh storage profile that is cleared when the surface closes
and deleted once Android releases it. `createSurface({ ..., profileKey })` instead
selects one persistent profile per owner and key (for example a signed-in account), so
website sign-ins survive. `purgeProfiles({ profileKey })` removes it and closes
its surfaces (`surfaceClosed`); `purgeProfiles({ idleMs })` removes keyed profiles idle
for that long. `purgeProfiles({ all: true })` removes every surface profile of any owner
and closes their surfaces. `profileKey` and `all` resolve only once WebView reports the
cookies removed, after storage deletion was issued, with `clean` true when no purged
profile still holds a cookie; `idleMs` resolves at once, without `clean`.
A keyed profile accepts third-party cookies, so embedded sign-ins work as in a browser.
`clearSurfaceStorage` signs one isolated surface out of every website.

Android `createSurface({ ..., layer: "below-host" })` draws the page under the host
WebView instead of over it, so the host draws its own chrome, rounded corners and
shadows over the page and nothing is cut out of the website. It improves edges and
shadows; it saves no memory or CPU, and the transparent host is blended over the page
each frame, so measure frame time on the device before adopting it. The host makes its
WebView background, every view between that WebView and its nearest `FrameLayout`
ancestor, and its page CSS over the page rect transparent. The page is clipped only to
its outer clip's rectangle. `setOcclusionRects` then lists the host-owned rects: a
gesture, hover, mouse or drag event that starts on the page outside them goes to the
website until it ends; any other stays with the host. A finger added during a gesture
follows the first finger, and a gesture on a page hidden mid-gesture is cancelled. The
page takes no input until the first `setOcclusionRects` call, and the host awaits that
call before it shows new interactive chrome over the page. The website gets the whole
gesture, so its own long-press, text selection and focus (and so the keyboard) work as
in the default layer. TalkBack reads host chrome first, then the website; host nodes
over the page must be `aria-hidden`. Captures draw the page alone, so no host pixel is
in them, and mask the host-owned rects and the area outside the outer clip. iOS rejects
this layer with `UNSUPPORTED`.

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
reference. While the page holds a dialog it rejects `DIALOG_OPEN` at once, without
dispatching or consuming the reference: a dialog freezes the page, so the traversal could
run only once the dialog is answered. Unlike `goBack` and `goForward` it ends nothing the
page holds. Navigation can retire the reply, and a page that does not answer within 5
seconds rejects it; `UNCERTAIN_OUTCOME` requires page readback, never replay. A dispatch receipt does not prove arrival or task success.
These are host primitives, not agent authorization: the caller must compose task
scope, origin approval, preview and durable effect recording. Cross-origin history
and iOS are not supported by these methods. Form POST resubmission is refused.

Android `stopLoading` stops the current page load where it is (a no-op when nothing is
loading) and then sends `navigationChanged`, so the host re-reads `progress`. It ends
nothing the page holds: a held dialog, file input or site permission request still waits
for its answer.

Script popups never open. Pages pinch-zoom, and a page without a mobile viewport is shown
whole. `getSurfaceState` also returns `title`, `canGoBack`, `canGoForward`, `progress`,
`pageError`, `securityBlocked`, `textZoom` and `pageScale` (density-independent pixels per CSS pixel: 1 is
the page's own mobile size); `navigationChanged` follows a pinch once it settles. `setTextZoom` sets the page
text size from 50 to 300 percent. On Android every `navigationChanged` event also
carries these fields as they were when it was sent. Listeners receive every surface's
events, so a host uses them only when `exists` is true and `owner`, `session` and
`epoch` match its own identity, which `getSurfaceState` checks itself. They are a
snapshot: one sent before a host command settled can predate it, and a later title or
progress change sends no event. iOS sends only the identity, so a host falls back to
`getSurfaceState` when the fields are absent. The bundled `packages/ui` shell still
re-reads `getSurfaceState` after its queued commands settle.

`parseBrowserAddressInput` (also exported as `./address-input` without bridge
registration) classifies address-bar text as an HTTP(S) URL, search text, or a
rejection reason. Hosts supply the inferred protocol and own aliases, search
providers, upgrades and error copy. Parsing performs no network request and is
not an SSRF, reputation, browser ownership or navigation-authorization check.

## Android browser tab host

`BrowserTabHostPlugin` is the native tab model of a full mobile browser: child
WebViews drawn above the Capacitor host and presented one at a time at the
geometry the renderer sends with `present`. A product subclasses it, adds its
Capacitor name and registers it:

```java
@CapacitorPlugin(name = "ProductBrowser")
public class ProductBrowserPlugin extends BrowserTabHostPlugin {
  @Override protected BrowserTabHostConfig tabHostConfig() {
    return BrowserTabHostConfig.builder("product_browser_v1", "product_private_", "product-browser")
        .names("Product Phone", "Product", "Product Browser")
        .hostScheme("productphone")
        .autofillExtras(new BrowserAutofillExtras(PasswordAutofillPolicy.FIELD_ORIGIN, PasswordFormPolicy.TOP_ORIGIN_EXTRA))
        .allowLoopback(BuildConfig.DEVELOPMENT_ONLY_FLAG)
        .build();
  }
  @Override protected BrowserBookmarkStore openBookmarkStore(Context context) { /* sealed store */ }
  @Override protected BrowserSessionStore openSessionStore(Context context) { /* sealed store */ }
}
```

Profile, preference and Keystore names are compatibility identifiers. A host that
already shipped keeps the names its earlier builds wrote, so website sign-ins,
bookmarks, saved tabs, history, site permissions and downloads stay readable;
nothing is migrated when a name changes. `BrowserTabHostConfig` refuses Android's
`Default` profile, a persistent profile under an ephemeral prefix, and any prefix
that overlaps the isolated or keyed surface profiles above.

- Normal tabs share one persistent profile (sign-ins survive close and restart)
  and are the only tabs that accept third-party cookies. Private tabs get
  ephemeral profiles that are purged once no tab, including their pop-up, uses
  them, and again at the next start; a replaced host document gets a new private
  namespace.
- A tapped `target=_blank` link or `window.open` from the selected, committed tab
  opens a tab in the opener's profile (`tabOpened`); untapped pop-ups are refused.
  A pop-up may close itself.
- `tel:`, `mailto:`, `sms:`/`smsto:`, `geo:`, `intent:` and `market:` links are handed to
  Android once per tap. `tel:` opens the dial pad and `sms:` opens a compose screen; no call is
  placed and nothing is sent. These mail, phone, text and map links also open when the host is
  the handler. `intent:` and `market:` links never open the host's own schemes or package.
- `clearBrowsingData` closes normal tabs and clears the persistent profile,
  saved tabs, history, permissions and download history (bookmarks remain);
  `clearSiteData` clears one site of the selected tab. The product confirms first.
- `find`, `findNext` and `clearFind` search the selected tab; navigation, tab
  changes and close clear the highlights (`findResult` with `cleared`).
- `reviewReading` and `reviewQuestion` read the selected HTTPS page in its
  isolated world (`BrowserReadingWorld`) and show the whole excerpt before the
  person releases it (`BrowserReviewedReading`). A reading is bound to one speech
  route, owner and session and consumed once through `consumeReading`; a product
  overrides `cancelReadingSpeech` to stop its speech request.
- Site permissions, HTTP sign-in, engine-attested login fields, downloads,
  fullscreen video, sharing and another-browser handoff use the policies in this
  package.

Passkeys stay disabled; the host says so once per install. The renderer half is
`./tab-host`: the `BrowserTabHostPlugin` bridge type and `BrowserTabSession`, a
session model that accepts only this document's events in native order, moves a
document revision on every load or address change, and binds page actions to a
committed, settled document.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-browser-surface build  # build
bun run --cwd plugins/plugin-native-browser-surface test   # tests
```

Android device tests exercise ownership, storage isolation, real WebView page
reads, navigation/back/reload, and visibility after rejected presentation:

```bash
bun packages/app/scripts/android-native-plugins.ts --serial emulator-5554 --plugin plugin-native-browser-surface
```

The bridge fixture exports native screenshots and complete page-read results.

Android `controlPage` uses the shared Chromium page commands in a named isolated
JavaScript world. It requires AndroidX WebKit 1.16 and a provider that supports
`JS_INJECTION_IN_FRAME_AND_WORLD`; unsupported providers reject control requests.
The host must supply an authorized task policy for input. Never use a policy
from model output or website content. Each effect requires a fresh snapshot and
its document ID. Closing, hiding, navigation, or owner reconciliation interrupts
pending work. Activity pause also fences control and keeps the page for Resume.
Hiding or pausing requires a fresh snapshot before the next input. A lost effect
reply reports an uncertain outcome; observe before continuing and never
automatically replay the effect. This API currently covers the main frame's DOM
commands, not child frames or coordinate input. After a task effect,
`BrowserEffectWatch` applies the Chromium network watch's rule to every request
`shouldInterceptRequest` sees, from any frame; task snapshots report it as
`effectViolation` and `effectWatch`. WebView names no request type, so only an
image or stylesheet load (by its `Accept` header) is a passive cross-site read;
beacons and other cross-site reads count within the 30-second window. WebView
never shows it WebSocket, service-worker or WebRTC traffic, so `unseen` names
those.

`bun run --cwd plugins/plugin-native-browser-surface test:control` uses
`ELIZA_BROWSER_EXECUTABLE` to test the generated channel in a real Chromium
isolated world. This checks DOM effects and document/reference isolation, not
Android installation or the native reply proxy. The generated native asset shares
the existing browser command implementation; `build` regenerates it and
`bun plugins/plugin-native-browser-surface/scripts/build-control-channel.mjs --check`
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
`close()` when the service stops. Its state lives on the main thread: a call
from another thread is posted there in call order, so call `close()` on the main
thread (for example in `onDestroy`) when the unbind must happen before it returns.
It verifies the module's build-pinned package and signing certificate before
binding and after connection. The priority-preserving Custom Tabs binding keeps
the browser reachable without opening an activity, tab, URL or debugging port.
It does not grant task/action authority or claim that a renderer is observable.
A host that needs the browser only for some work calls `acquire()` instead of
`start()` and closes the returned lease when that work ends; `stop()` ends a
`start()`. With no `start()` or open lease, the binding is released after the
idle delay (the constructor's second argument, 60 s by default), so Android can
freeze or reclaim the browser. That trades resident memory for latency: the next
`acquire()` after a release may cold-start Chromium. The memory saving has not
been measured on a device yet (compare `dumpsys meminfo` and `oom_adj` of the
browser with the host idle).
`lease.whenReady(callback)` is posted to the main thread once the browser
service is connected, has passed its package and certificate check and was asked
to warm up; it runs once and is dropped when the lease closes. Warmup is only
requested (`CustomTabsClient.warmup` is asynchronous), so the first page or
native-messaging call after a cold start may still wait for Chromium to
initialise; time that, not only `whenReady`. It never runs when the
browser refuses the binding or fails its package or certificate check, so a
host puts its own deadline around it and closes the lease at that deadline.
A browser that fails verification after connecting closes the connection for
good: `isClosed()` turns true and `acquire()` returns a lease that is already
closed (`isOpen()` is false) and binds nothing. The hold, retry, release and
ready rules live in the plain-JVM `ChromiumBindingDemand`. A host that stages
`ChromiumBrowserConnection` as a resident helper must also list
`ChromiumBindingDemand` and `ChromiumBrowserIdentity` in its `helpers`;
`stageResidentHostSources` refuses the list otherwise.

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

Page reading (read aloud, ask about a page) has a native and a renderer half. Android
`BrowserPageReading` refuses sensitive addresses (`sensitiveUrl`) and holds `EXTRACT`, the
fixed script a host runs only in an isolated world of the selected tab's main frame
(`BrowserReadingWorld`, below); it scans
the whole document and returns `{blocked:true}` for credential prose, login fields or
unlabelled codes, otherwise at most 5,000 characters of visible article text. `./page-reading`
applies the same text and address rules in the renderer, probes provider support
(`createReadingSupport`), and `pageQuestionReading` returns the excerpt a native question
review released with whether the page was cut to fit it (`pageQuestionExcerpt` returns only
the text), or `""` when the provider has no isolated world so the host's review opens
for pasted text. A sensitive page never opens a review. Hosts own the review UI, consent,
speech and what is sent; this heuristic is not a credential detector.

When the live page cannot be read in an isolated world (a sandboxed web-build iframe, or
a WebView without document-start scripts), `readPublicPageSource` from `./page-source`
fetches the address again without credentials, cookies, referrer or redirects, bounded to
5 seconds and 256 KiB, drops chrome, forms and hidden nodes, and offers at most 5,000
characters of the main region for review. Sign-in pages, sensitive addresses and
credential prose return `{blocked:true}`; any other failure offers nothing so the review
opens for pasted text. Hosts inject `fetch` and the HTML parser; the live frame keeps its
opaque origin.

`SubmittedNavigation` from `./submitted-navigation` owns submitted-address history,
stale-check fencing and revision-bound explicit one-time overrides. Hosts
validate/resolve addresses and supply a verdict check. Failed checks stay unavailable.
The default `check-first` policy waits for a clean verdict. A host can select
`policy: "blacklist"` to permit unavailable and lookalike results; a confirmed blocked
result still stops navigation. Navigation waits for the host check, which should use a local
cache rather than await feed downloads. Request-time enforcement must also cover
redirects and subsequent navigation. It does not grant task actions. Hosts retain
warning/confirmation UI, sandbox configuration and all navigation authorization. This
controller cannot observe internal iframe navigation or certify loaded content.

## Android host web policy

The pure-JVM policy classes in `ai.eliza.plugins.browsersurface` are shared by hosts
with persistent and private WebView profiles. Run `bun run test:native-policy`
from this package with a JDK on PATH or JAVA_HOME.

- `BrowserWebOrigin` validates HTTP(S) origins, blob owners and site matching.
- `BrowserDownloadPolicy` limits cookies to the open source tab's exact origin,
  decodes data URLs within 64 MB on Android 26+, and excludes private downloads from saved history.
  A transfer the host runs itself is listed as running until it ends with its saved file or as
  failed; running entries are never saved or restored, and `removeWhere` returns what it removed
  so the host can stop those transfers. Saved entries survive restoration even above the limit
  for adding new entries.
- `BrowserSitePermissions` stores revocable camera, microphone and location choices
  per origin. Private tabs neither read nor store these choices.
- `BrowserSessionPolicy` restores valid persistent tabs, history and complete titles.
  It excludes private tabs and validates bookmarks. Hosts own tab and storage limits.
- `BrowserExternalLinkPolicy` requires a user gesture and selects a safe handoff kind.
  The host constructs a fresh intent and refuses a resolved target in its own package.
- `BrowserExternalPage` admits an explicit "open in another browser" handoff of the visible
  HTTPS page (no credentials, not the host's own origin) to another package's enabled,
  exported activity that handles every HTTPS link.
- `BrowserSitePrompt` decides the site permission prompt: only a secure top-level page asks,
  for its own origin; only the selected, shown page of a foreground host may prompt or use a
  stored Allow; private tabs never read or store a decision; a kind the app cannot hold is
  refused with a notice. It also gives the prompt text and the OS permissions behind each kind.
- `BrowserSitePermissionRecord` reads and writes the sealed JSON form of
  `BrowserSitePermissions`, oldest origin first; a damaged record grants nothing (org.json).
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
- `BrowserExternalHandoff.intentFor(raw, ownPackage, hostSchemes)` builds the implicit intent
  for a `mailto:`, `tel:` (dial only), `sms:`/`smsto:` (compose only), `geo:`, `market:` or
  `intent:` link with no component, selector, clip data, extras or grant flags; `fallback` reads
  a safe HTTPS `browser_fallback_url`, and `browserProbe`/`genericHttps` find general browsers
  for an external page handoff.
- `BrowserBookmarkStore` and `BrowserSessionStore` keep bookmarks, normal-tab history and tabs,
  and site-permission decisions, sealed by the host's `BrowserSealedText` (for example a
  Keystore AES-GCM frame). The host passes its own preferences file and key, so installed data
  keeps its names. Private tabs never reach them.
- `BrowserReadingWorld` is the isolated world for page reading. The host calls `prepare(url)`
  (or `prepareHistory`) before each load and `pageStarted(url)` from its client; only the
  prepared main-frame document, announcing a one-time nonce from the committed HTTPS origin,
  becomes `ready()`, and `evaluate` returns a result only while that document is current. A
  redirect or unprepared navigation invalidates it. Without the capability `available()` is
  false and nothing is injected.

Hosts retain the prompt dialog, OS permission requests, the sealing key and navigation.
Hosts that do their own downloads recheck cookie policy at every redirect and never hand
authenticated headers to DownloadManager, which stores and replays them. The pure policies
perform no network requests; none of this qualifies a browser, provider or device integration.
