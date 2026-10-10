# @elizaos/capacitor-owned-media

Android owned-media primitives for Eliza hosts. Everything operates only on MediaStore items
the host package itself published (`OWNER_PACKAGE_NAME`), never on arbitrary URIs, and never
uploads or rewrites originals.

- `OwnedMediaConfig` – host configuration: a storage namespace for SharedPreferences and the
  MediaStore `RELATIVE_PATH` and display-name prefix for edit copies and kept captures (under
  `Pictures/` or `DCIM/`). Shared code never chooses product names or folders.
- `OwnedPhotoEdits` – serial edit sessions over one owned still photo: quarter-turn rotation,
  centered crop and filters, previewed at most 1024 px, saved as a new owned PNG copy. Each save
  has a UUID operation identity, a receipt journal and a deterministic display name, so a crash
  between publish and receipt resolves to `saved` or `failed`, never a duplicate. The session
  aborts if the source changes (MediaStore generation and SHA-256 of the snapshot).
- `PhotoFilter` / `PhotoFilterMath` – CSS reference filters (`vivid`, `warm`, `cool`, `mono`,
  `fade`, `noir`) in encoded sRGB with per-primitive clipping. The math is pure Java.
- `OwnedCaptures` – explicit capture publication with one durable operation identity.
- `OwnedMediaSelection` – owned, published media queries with album and trash selection.
- `MediaBytes` – exact provider readback after a write.

The Android library has no components and declares no permissions.

```bash
bun run --cwd plugins/plugin-native-media test   # JVM checks and real Android consumer compilation
```

## Host integration (Android)

Include the Gradle module (for example `:eliza-owned-media`) and build one configuration:

```java
OwnedMediaConfig config = OwnedMediaConfig.builder("myapp")
    .edits("Pictures/My App/Edits/", "MyApp-edit-")
    .captures("Pictures/", "SCAN_")
    .build();
OwnedPhotoEdits edits = new OwnedPhotoEdits(context, config);
```

Call `OwnedPhotoEdits` from one serial worker thread. Preference names are
`<namespace>-photo-edit-results`, so a host that already stored receipts under that name keeps
them.

## Validation

Tests require JDK 21, an Android SDK through `ANDROID_HOME`, and Gradle 8.13
through `GRADLE_BIN` (or `gradle` on PATH). The consumer uses the installed
Capacitor Android dependency; `CAPACITOR_ANDROID_DIR` can select a host module.
Compiling the APKs is not a device execution result. To run the consumer on an
isolated Android test device, install its host and test APKs, then run
`adb shell am instrument -w example.ownedmedia.host.test/androidx.test.runner.AndroidJUnitRunner`.
The test creates and removes synthetic MediaStore items owned by its fixture app.

Capture operations reserve their identity and image hash before insertion. A
retry resolves a published item instead of inserting another. An incomplete
pending item is removed and is not silently retried. Unknown provider outcomes
remain unconfirmed. Capture and edit receipts are retained; saving a new edit
does not evict older receipts.
