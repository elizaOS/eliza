# @elizaos/plugin-device-filesystem

Mobile-safe filesystem bridge for the elizaOS runtime.

Adds a single `DeviceFilesystemBridge` service. Planner-visible read, write, and
directory list operations are routed through the canonical `FILE` action with
`target=device`:

- `FILE` with `action=read`, `target=device` — read a file from the user's
  device-files root.
- `FILE` with `action=write`, `target=device` — write a file to the user's
  device-files root.
- `FILE` with `action=ls`, `target=device` — list a directory inside the user's
  device-files root.

## Backends

The bridge picks one of two backends at startup:

- **Capacitor** — when `window.Capacitor.isNativePlatform()` is true (iOS,
  Android). Uses `@capacitor/filesystem` with `Directory.Documents` as the root.
  This is the path used when the agent is hosted in Eliza Cloud and a Capacitor
  shell on the user's device proxies storage calls.
- **Node** — when not on Capacitor. Uses `fs/promises` rooted at
  `resolveStateDir() + "/workspace"` (default `~/.eliza/workspace`).

Both backends reject absolute paths, `..` traversal, NUL bytes, and (on Node)
any resolution that escapes the workspace root.

## FILE integration

This package owns only the device filesystem bridge. It does not register
planner-facing file actions. The `@elizaos/plugin-coding-tools` `FILE` action
discovers the bridge by the `device_filesystem` service type and delegates
`target=device` operations to it.

## iOS Info.plist (apply in the eliza parent repo)

For iOS users to see files written into `Directory.Documents`, the host app's
`apps/app/ios/App/App/Info.plist` (in the parent `eliza` repo, outside this
worktree) needs the following keys added:

```xml
<key>UIFileSharingEnabled</key>
<true/>
<key>LSSupportsOpeningDocumentsInPlace</key>
<true/>
```

Without those keys, files still write — they just aren't browsable from the
Files.app side. Add them in the eliza repo's iOS shell before shipping.

## Android

No special manifest changes are required for Capacitor `Directory.Documents`
(the Capacitor Filesystem plugin handles scoped storage and MediaStore on
Android 10+). If a future feature needs cross-app sharing through
`MediaStore.Downloads`, that goes in the eliza parent repo's
`apps/app/android/...` AndroidManifest, not here.

## Service type

`DEVICE_FILESYSTEM_SERVICE_TYPE = "device_filesystem"`. Resolve programmatically
with `getDeviceFilesystemBridge(runtime)`.
