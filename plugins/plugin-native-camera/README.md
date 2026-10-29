# @elizaos/capacitor-camera

Capacitor plugin that gives Eliza agents camera preview, photo capture, and video
recording across web, iOS, and Android.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Host ports

[`host-ports`](src/host-ports.ts) holds the camera rules every host surface
shares: `cameraAccessDenied` classifies only explicit denials (the bridge's
denial codes, `NotAllowedError`/`PermissionDeniedError` or the bridge's denial
message), and `restartAfterResume` restarts a preview stopped on a denial only
after the camera was granted in system settings, so returning from Android's
own dialog never asks again. `CameraHostPorts` lets a host decide where an
explicit capture goes: a Keep storage port that receives one stable operation
identity per capture (`keepCapture` never reports an unconfirmed save), other
explicit hand-offs such as a scan review or a question, and a non-prompting
access read. The shared `CameraPageView` in `@elizaos/ui` accepts these ports;
without them a capture is only previewed. The lock-screen secure camera stays a
system surface.

## Camera session

[`session`](src/session.ts) is the one preview/capture/recording lifecycle every
camera surface drives (`CameraPageView` and other hosts' camera screens).
`createCameraSession` takes the bridge subset, an `active()` predicate and the
host's preview/recording options. Every start and stop bumps an epoch, so an
answer that arrives after the surface closed never moves it forward; stops are
chained so a new preview never races the previous release, and a preview that
comes up after its surface closed is released. One capture, control change or
recording start runs at a time (`exclusive`, `control`, `startRecording`).
Stopping the surface finishes an active recording first; finalization is single
flight and a recording is reported saved only for a complete receipt the host's
`recordingSaved` hook accepted (the host decides where it lives). Starts are
never retried automatically after an error; `rearm()` lets a resume grant (see
`restartAfterResume`) start it again.

## Document scans

[`scan-document`](src/scan-document.ts) is the presentation-free state of a
document scan. `createScanDocument` holds the ordered pages a person captured or
chose (JPEG, PNG or WebP; at most 20 pages, 16 MB per page, 64 MB per document
and 32 megapixels, via `admitScanImage`/`admitScanDimensions`), runs one page
operation, draft action or export at a time and reports the enabled state of
every control in `snapshot().controls`, so a host renders it without re-deriving
the rules. Exports read an immutable page snapshot; a final or unconfirmed export
ends editing, while a cancelled, failed, unavailable or too-large one leaves the
pages editable (`scanExportRetryable`). With `autosave` (for a native host the
platform may end while a system picker covers it) every page change is written to
the host's draft store one save at a time, compare-and-set on the draft revision,
and a confirmed export removes only the draft the document wrote itself.
`createScanCapture` reviews one scanned page: a scan-mode capture stays in memory
(`unsaved`) and reaches the host's library only through its explicit Keep port,
under one operation identity until a definite failure. Nothing is kept, uploaded
or handed off implicitly; any outbound use of a page stays an explicit host
action.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-camera build  # build
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

Android photo options validate before capture: supported formats, finite quality
from 0 to 100, positive integer dimensions, Boolean flags and known fields.
Either dimension can be supplied; the omitted dimension keeps the oriented
source size. Impossible bitmap byte counts reject explicitly. Requested EXIF
contains source-capture metadata, so its orientation/dimensions can precede
output transforms. Device tests decode JPEG, PNG and WebP, verify manual ISO and
shutter in source EXIF, and check dimensions and malformed-option rejection.

Gallery photos return the saved URI only after the encoded bytes are written.
Android 10+ keeps entries pending until publication and removes incomplete
entries on failure. Save failures reject with GALLERY_WRITE_FAILED; failed
cleanup retains the affected URI and diagnostic details. Older Android versions
request storage permission before capture and return a file URI. Device tests
read actual MediaStore images and compare exact bytes; a separate private provider
fixture checks write/publication/cleanup failures. Injected failures also run
through the real camera and WebView promise using the test activity's resolver;
these are not real MediaStore outages. Legacy storage behavior still needs
device qualification.
