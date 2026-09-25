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
concurrent batch effects still require native verification.

White-balance presets require an active Android preview and device support.
Their promises settle from native Camera2 capture completion; confirmed presets
are restored across preview restart, camera switch and video rebind. Tests verify
completed AWB metadata and cancellation, not physical color accuracy. Queued
camera switches settle in order; stopping preview cancels remaining switches.

Exposure compensation requires an active, ready preview and device support.
EV is rounded to the nearest native step; getSettings reports the applied EV.
Out-of-range requests reject before batch mutation. The original confirmed
request is retained for rebinds, avoiding drift across cameras with different
steps. Device tests check completed AE indices, mixed-batch rejection and cancellation.

Android settings-batch zoom uses the same supported ratio range as setZoom and
waits for native completion before reporting success or caching the ratio.
Unsupported mixed batches reject before mutation. Confirmed zoom is restored
before preview restart, camera switch and recording rebind complete. Device tests
check completed crop/zoom metadata, cancellation and retained white balance/EV.

Android flash settings require an active preview. Cameras without a flash unit
reject non-off modes before mixed-batch mutation. Torch completion and a native
capture-options receipt precede confirmation; rebinds restore confirmed flash
policy. Device tests inspect flash/AE metadata, torch state and cancellation.
Physical flash output and automatic scene decisions need hardware qualification.

Android focus modes apply supported Camera2 AF policies and wait for completed
capture options. Manual mode retains the observed lens distance; auto selects
and triggers single-shot AF at the center, and continuous selects continuous
picture AF. Mode changes cancel previous metering, releasing single-shot locks.
Point focus exits manual lock and reports auto. Confirmed policies
survive rebinds; manual distances belong to each camera and fixed-focus defaults
adapt to device support. Native metadata tests do not certify physical sharpness
or lens calibration.

Android exposure mode, ISO and shutter speed require a ready preview. Manual
mode uses the current observed sensor values for omitted fields; specifying ISO
or shutter speed selects manual mode. Device ranges and incompatible automatic
flash/nonzero EV combinations reject before batch mutation. Continuous mode
releases manual control; auto waits for convergence and locks exposure. Settings
report completed sensor values, including hardware quantization. Focus changes
retain sensor options, and rebinds restore confirmed exposure. Exposure-point
metering returns to continuous exposure. Device tests check sensor metadata,
lifecycle retention and cancellation; physical exposure quality remains unqualified.
