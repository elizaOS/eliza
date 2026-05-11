# @elizaos/plugin-device-filesystem

Mobile-safe filesystem actions for the elizaOS runtime.

Adds three planner-visible actions backed by a single `DeviceFilesystemBridge`
service:

- `DEVICE_FILE_READ` — read a file from the user's device-files root.
- `DEVICE_FILE_WRITE` — write a file to the user's device-files root.
- `DEVICE_LIST_DIR` — list a directory inside the user's device-files root.

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

## Why not just use `plugin-coding-tools`?

`plugin-coding-tools` is a developer-only Read/Write/Bash surface for Bun on
desktop and the privileged AOSP build. It binds to Node `fs` against arbitrary
absolute paths, and it's intentionally absent from Mobile and Store builds. This
plugin is the user-facing equivalent that ships everywhere the agent runs.

## iOS Info.plist (apply in the milady parent repo)

For iOS users to see files written into `Directory.Documents`, the host app's
`apps/app/ios/App/App/Info.plist` (in the parent `milady` repo, outside this
worktree) needs the following keys added:

```xml
<key>UIFileSharingEnabled</key>
<true/>
<key>LSSupportsOpeningDocumentsInPlace</key>
<true/>
```

Without those keys, files still write — they just aren't browsable from the
Files.app side. Add them in the milady repo's iOS shell before shipping.

## Android

No special manifest changes are required for Capacitor `Directory.Documents`
(the Capacitor Filesystem plugin handles scoped storage and MediaStore on
Android 10+). If a future feature needs cross-app sharing through
`MediaStore.Downloads`, that goes in the milady parent repo's
`apps/app/android/...` AndroidManifest, not here.

## Service type

`DEVICE_FILESYSTEM_SERVICE_TYPE = "device_filesystem"`. Resolve programmatically
with `getDeviceFilesystemBridge(runtime)`.
