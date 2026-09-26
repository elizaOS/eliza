# Chromium browser bridge

Controls the actual Chromium profile, including background tabs, through native
messaging. The extension has no HTTP listener or cloud token. The native host owns
authenticated device registration and routes authorized commands to this profile.

Build with `bun run --cwd packages/browser-bridge-extension build`. Android builds
require `ELIZA_BROWSER_ANDROID_CERTIFICATE` containing the launcher's public signing
certificate SHA-256. The Android host is `ai.elizaos.app`; Linux uses
`ai.elizaos.browser`. Chromium must allow the extension to use that native host.

Commands address explicit tab IDs. Snapshots return complete per-frame text and
snapshot-bound element selectors. Any effect invalidates that frame's references.
A dispatch receipt requires fresh observation to establish the website result.
Large native messages use ordered lossless chunks below the Android Binder limit.
Incomplete or out-of-order messages never execute. Repeated
request IDs fail closed; interrupted effects are never replayed automatically.

Run `bun run --cwd packages/browser-bridge-extension test` for protocol tests.
Installed-browser and signed Android native-host verification are separate required
integration checks; a built extension alone does not prove those paths work.


Owned Chromium component builds can preserve the extension ID without the old
CRX private key. `scripts/chromium-component.mjs` supports only the revision and
source hashes in `scripts/chromium/upstream.json`. It emits a deterministic overlay,
a `git apply` patch, and an input/output hash report; it does not claim the browser
has compiled or passed release-device tests.

After building the extension, generate the overlay outside the checkout:

```sh
node packages/browser-bridge-extension/scripts/chromium-component.mjs \
  --source /absolute/chromium/src \
  --extension /absolute/eliza/packages/browser-bridge-extension/dist/android \
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
