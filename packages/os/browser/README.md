# Chromium browser bridge

Controls the actual Chromium profile, including background tabs, through native
messaging. The extension has no HTTP listener or cloud token. The native host owns
authenticated device registration and routes authorized commands to this profile.

Build with `bun run --cwd packages/os build:browser`. Android builds
require `ELIZA_BROWSER_ANDROID_CERTIFICATE` containing the launcher's public signing
certificate SHA-256. The Android host defaults to `ai.elizaos.app`; set
`ELIZA_BROWSER_ANDROID_APPLICATION` to a different host application ID and pass
the same `--application` to the component generator. Each host requires its own
matching certificate-pinned component build. Increment the extension version in
`scripts/build.mjs` when shipping changed component resources; Chromium may retain
the previous service worker across APK upgrades at the same extension version.
Qualify upgrades with the existing browser profile, without clearing its data. Linux uses
`ai.elizaos.browser`. Chromium must allow the extension to use that native host.

Commands address explicit tab IDs. Snapshots return complete per-frame text and
snapshot-bound element selectors. Any effect invalidates that frame's references.
A dispatch receipt requires fresh observation to establish the website result.
Snapshots include document identity, target bounds, viewport, DOM revision and
input revision. Effects reject changed URLs, page mutations, user input, field
values or target geometry; read again after manual progress. Form/editable values
are excluded from snapshot text and labels. The value comparison stays inside
the isolated page realm. These freshness checks do not classify a button as safe
for a particular task or replace the host's action policy.
Large native messages use ordered lossless chunks below the Android Binder limit.
Incomplete or out-of-order messages never execute. Repeated
request IDs fail closed; interrupted effects are never replayed automatically.
The native `cancel` capability fences a request by ID without waiting for the
command queue. Cancellation records survive worker restart. Context is checked
after browser lookups and before effect dispatch; a context change after dispatch
returns an uncertain outcome, not a claim that the effect was undone.

The optional `task-bind` native capability binds a tab to actor, account, agent,
task, epoch, expiry and an increasing per-tab binding revision. Only the trusted
host can issue `NativeSocketBrowserTarget.bindTask`; it is not a model-facing
browser subaction. Scoped `execute` calls pass that context explicitly. A bound
tab rejects raw commands, other origins/frames and stale contexts. After worker
restart it remains blocked until a higher binding is established. Revocation
fences pending lookups; a dispatched effect can still have an uncertain outcome.

The host supplies reviewed CSS target/action permissions. Main-frame execution
rechecks those permissions, excludes password/payment/OTP fields from ordinary
fills, and rejects submit controls and explicit sign-in/verification/payment
labels even if accidentally allowed. This is an additional guard, not semantic
proof about arbitrary JavaScript: a reviewed ordinary button or field can run
site code. Qualify each supported page and its consequences. Protected OTP fills,
complete sensitive-page policy, and installed Android task binding remain separate
work. Binding metadata and target rules must never come from model or page text.

Run `bun run --cwd packages/os test:browser` for protocol tests.
Installed-browser and signed Android native-host verification are separate required
integration checks; a built extension alone does not prove those paths work.

Run `ELIZA_BROWSER_EXECUTABLE=/absolute/test/chromium bun run --cwd packages/os
test:browser:page` for real isolated-world DOM freshness tests. This uses a fresh
test profile and local controlled page, not the installed native-message path.


Owned Chromium component builds can preserve the extension ID without the old
CRX private key. `scripts/chromium-component.mjs` supports only the revision and
source hashes in `scripts/chromium/upstream.json`. It emits a deterministic overlay,
a `git apply` patch, and an input/output hash report; it does not claim the browser
has compiled or passed release-device tests.

After building the extension, generate the overlay outside the checkout:

```sh
node packages/os/browser/scripts/chromium-component.mjs \
  --source /absolute/chromium/src \
  --extension /absolute/eliza/packages/os/browser/dist/android \
  --out /absolute/new-overlay-directory --platform android \
  --certificate APP_SIGNING_CERTIFICATE_SHA256
```

Linux uses `dist/chrome`, `--platform linux`, and no certificate argument. The OS
build must call exported `readReviewedChromiumSources(sourceRoot)` immediately
before applying `eliza-component.patch`, then verify every output hash in
`eliza-component-overlay.json`. This component patch includes the native-messaging
allowlist change; do not run the separate allowlist-only patch first.

The generated component checks exact identity, installation location, resource
root, manifest, and compiled resource hashes. It serves verified copies and denies
filesystem fallback for unknown resources. Other extensions' verification and the
native host's release checks remain intact. The build must use
`is_desktop_android=true` for Android, preserve browser/app certificate pins, and
pass release tests without unpacked installation or allowlist-bypass flags.

The package test command includes pinned-source patch application and compiled C++
integrity tests. Those tests require a C++20 compiler and OpenSSL development
headers/library; they are not a substitute for a full Chromium build. Chromium
fixtures retain their upstream license in `scripts/chromium/LICENSE.chromium`.

This is an internal OS component, not a standalone workspace or installable
product. The OS package builds it against the locked
`@elizaos/plugin-browser/native-wire` dependency. Linux assembly and signed AOSP
provisioning live in `../scripts/linux/assemble-browser-payload.py` and
`../scripts/distro-android/prepare-chromium-browser.ts`. Preserve those existing
signed-artifact and certificate checks when changing the component.

For installed Linux acceptance, set `ELIZA_BROWSER_EXECUTABLE` to the OS-built
Chromium executable and run `node --conditions=eliza-source
packages/os/browser/scripts/test-native-browser.mjs`. The test uses the embedded
component and installed `/usr/libexec/elizaos-browser-native-host` relay without
unpacked-extension or allowlist-bypass flags.


The `pageGuidance` isolated-world renderer uses existing snapshot target identity
for a single ring and dismissible label without changing provider element styles.
Scroll/viewport movement hides the annotation until stable geometry returns;
DOM changes and manual input require a fresh host observation. Same-step dismissal
survives repeated offers; restore must be explicit. Labels are excluded from the
page snapshot by a closed shadow tree. The trusted `task-guide` native capability admits ordered, task-bound annotations
through `NativeSocketBrowserTarget.guideTask`, never a model browser action.
Cancellation, rebinding and detected transport disconnect remove the annotation.
Before native registration, worker recovery clears guides listed in a durable
tab-ID-only index and revokes old bindings. Removal requires a page receipt;
failure prevents registration until recovery succeeds. Closed tabs are retired.
Owner-bound removal remains available after lease expiry or origin navigation;
it does not grant page-read or action authority. Closed-tab receipts require a
successful live-tab inventory, including a second read after an injection race.
Inventory or injection errors on a live tab retain the cleanup record for retry.
The observation monitor excludes only mount/removal records for its private
guide host nodes. Provider insertions and edits still invalidate observations;
showing a guide does not itself make the guarded action stale.
Bound click/fill/scroll commands validate before showing an action pointer and
short instruction. After 800 ms of stable visibility, the effect rechecks page,
input, target, binding and per-command expiry. Cancel/dismissal or stale context
prevents dispatch. The brief tap marker represents dispatch, not verified success;
normal readback still determines the outcome. Raw task-guide calls cannot request
an action pointer. Cleanup uses the same acknowledged removal/recovery path.
Product Pause/Close integration remains required before enabling it in a product.
Run `ELIZA_BROWSER_EXECUTABLE=/absolute/test/chromium bun run --cwd packages/os
test:browser:guidance` for actual Chromium renderer tests. These do not establish
native-host, Android or pre-action pointer integration.

Run `ELIZA_BROWSER_EXECUTABLE=/absolute/test/chromium bun run --cwd packages/os
test:browser:task-guidance` for actual Chromium binding/removal checks. Socket
framing is covered by the browser plugin tests; installed native transport and
Android are separate acceptance gates.

Task snapshots now attach `manualActivity` from a value-free extension journal.
The isolated main-frame listener records a form-submit attempt following recent
trusted click/keyboard activity; it never captures form values or treats the
attempt as provider success. The receiver checks extension identity, frame,
origin and current binding revision. Acknowledged records survive worker restart
and task epoch changes for the same owner/task. Repeated IDs are deduplicated;
capacity overflow and in-page transport failures are explicit flags. The listener
is installed during an authorized snapshot, so activity before that snapshot or
lost before storage acknowledgment is not covered. Product consumers must treat
attempts as uncertain and reconcile observed provider status. They must not infer
payment success or human intent solely from a form event. Run
`node packages/os/browser/scripts/test-manual-activity.mjs` for Chromium event
semantics using a simulated message transport; installed transport/device
qualification and product consumption remain separate gates.

`task-protected-fill` is a separate native capability. A protected verification
value requires the host's marker plus a dedicated `fill-code` target permission
and a matching OTP input. It does not allow password fields or Verify/submit
activation. Run `node --conditions=eliza-source
packages/os/browser/scripts/test-protected-fill.mjs` for controlled Chromium
field-policy and snapshot-redaction checks; native transport and provider
qualification remain separate.


Android component generation accepts `--embed-host` only as an explicit build
option. It adds `knownActivityEmbeddingCerts` to the intent dispatcher target, standard Custom Tab and main
tabbed activities, plus the dispatcher alias (Android 15 does not inherit its
certificate set). It uses the provisioned host certificate from native messaging.
It does not enable untrusted embedding or change activity exports/launch modes.
Android enforces this opt-in by signer, not package name: every app sharing that
signer is trusted for embedding. Use a dedicated host signer for a production
distribution. Native messaging still checks its separate host application ID.
The default remains disabled. Host WindowManager support, actual split bounds,
existing-tab continuity, input and lifecycle must be qualified on the installed
browser; a generated manifest is only one prerequisite for a native dock.

The Android overlay includes full-origin Autofill transport (including ports and
per-field origins). The original patch provenance is in `scripts/chromium/autofill`.
The Java regression requires JDK 21. Consumers must not apply a second Autofill patch.

Products may add the complete reviewed protection resource set exposed by
`protectionAssetNames`. This opts the component into `declarativeNetRequest` and
exposes only `warning.html`; partial inventories, extra permissions and other
web-accessible resources reject. Products retain their policy and warning UI.
Unprotected builds retain their existing permissions and resource inventory.

Eliza OS owns Android Chromium compilation as well as source preparation. On a
provisioned Linux Chromium/depot_tools host, run:

```sh
node packages/os/scripts/distro-android/build-chromium-browser.ts \
  --source /absolute/chromium/src --extension /absolute/product/extension \
  --out /absolute/new-overlay --build /absolute/chromium/src/out/Owned \
  --args-file /absolute/reviewed-args.gn --jobs 8 \
  --application PRODUCT_APP_ID --certificate APP_CERTIFICATE_SHA256 \
  --embed-host true
```

The build requires the pinned pristine sources and a new output directory. GN args
must explicitly select Android, arm64 or x64, Desktop Android, and package
`ai.elizaos.chromium`. The command applies the verified overlay, runs GN and bounded
Ninja, and records APK and GN-input hashes. It does not sign a release, install an
APK, provision AOSP or qualify a device. Preserve `chromium-build.json` alongside
the overlay and use the existing signed-artifact admission flow for release.

## Shared host protection

`protection/` provides an opt-in rule compiler, extension-worker engine and Node
reputation cache. The host owns warning HTML/CSS/copy, reviewed feed selection,
cache location, user-agent attribution and alarm names. `installBrowserProtection`
is installed once per extension worker; its warning page must be a local HTML
filename. The DNR engine reserves IDs 10000–11999 and one session exception at ID
1; compose other rules outside those ranges. A temporary exception requires a
message from the host warning page in its top-level tab and permits only the exact
main-frame GET; navigation failure, commit, expiry or tab removal revokes it.

`createWebsiteReputation` requires explicit feeds and accepts an optional private
cache directory. It downloads the configured lists, never visited URLs, and never
reports missing/expired feed data as clean. Feed configuration is trusted host
policy, not model input. The Phishing.Database mirror adapter pins fallback bytes
to an official commit. Hosts must ship the selected feeds' required attribution.

These modules are not enabled automatically in Eliza's browser build. Consumers
bundle the extension engine into their admitted worker resource and include the
Node module in the verified native gateway dependency closure. Run the protection
regressions with `node --test browser/src/protection-*.test.mjs` from `packages/os`.

`buildBrowserProtection(output, {warningDirectory, feeds, refreshAlarm, exceptionAlarm})`
builds the optional unpacked worker using the shared engine. HTML/CSS overrides
preserve shared messaging and enforcement. The optional builder defaults to the
reviewed Phishing.Database and HaGeZi lists and ships their license notices.
`composeProtectionAssets` adds the complete admitted resource inventory to an
existing component without changing its other capabilities. Keep existing alarm
names when upgrading an installed consumer. Run `test:browser:protection:network`
for real Chromium blocking, exception, offline-restart and capacity checks.
