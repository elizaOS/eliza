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
