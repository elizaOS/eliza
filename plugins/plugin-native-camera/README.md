# @elizaos/capacitor-camera

Capacitor plugin that gives Eliza agents camera preview, photo capture, and video
recording across web, iOS, and Android.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-camera build  # build
bun run --cwd plugins/plugin-native-camera test   # tests
```

Android uses CameraX 1.5.3. Recording start waits for Start, and Stop waits for
Finalize with actual dimensions, duration, bytes and output URI. Automatic size
and duration stops remain retrievable. Concurrent finalization cannot start a
competing recording. Gallery output requires Android 10+; microphone denial is an
explicit failure. Quality, bitrate and frame rate are validated per recording;
actual device capabilities determine output. Stop recording before switching.

Preview cancellation owns pending provider/permission callbacks. Frame events
sample completed captures at approximately 2 Hz and stop with camera inactivity;
they are notifications, not image buffers or proof of display. Device acceptance
uses a fresh isolated ai.eliza.plugins.camera.test APK and actual CameraX,
MediaStore, readable video and the microphone-denial dialog.

Android direct zoom, focus and exposure controls require an active preview and
validate numeric inputs. Zoom uses device-supported ratios; metering runs on the
main thread and awaits CameraX completion. Cancellation rejects without changing
cached settings. Device tests inspect Camera2 zoom and metering regions, exercise cancellation,
and do not certify optical focus quality on a physical camera.

Android settings batches reject unknown keys, malformed values and numeric
overflow before changing cached or native state. This boundary validation does
not certify that all valid settings are applied; full batch completion and
manual-setting effects still require native verification.

White-balance presets require an active Android preview and device support.
Their promises settle from native Camera2 capture completion; confirmed presets
are restored across preview restart, camera switch and video rebind. Tests verify
completed AWB metadata and cancellation, not physical color accuracy. Queued
camera switches settle in order; stopping preview cancels remaining switches.
