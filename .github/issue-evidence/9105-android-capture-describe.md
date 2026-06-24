# #9105 — Android on-device screen capture → describe (verified on Pixel 9a)

## Capture (MediaProjection, FGS fix)
`Capacitor.Plugins.ScreenCapture.captureScreenshot({format:"jpeg",scale:0.5,quality:75})`
→ `{"ok":true,"w":540,"h":1212,"len":15280}` — a 540×1212 JPEG of the live Eliza
home screen (see `9105-android-screen-capture.jpg`; note the system
MediaProjection cast indicator in the status bar).

Root cause that was blocking capture: Android 14 (API 34) throws
`SecurityException: Media projections require a foreground service of type
FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION` from `getMediaProjection()`. Fixed by
starting a `mediaProjection` foreground service before `getMediaProjection()`
(commit f140453cb7). After the fix the VirtualDisplay
`ScreenCapture(virtual:ai.elizaos.app)` is created with no SecurityException.

## Describe (on-device GPU vision)
The captured JPEG → bionic inference host `op:"image"` (eliza-1-2b text model +
`vision/mmproj-2b.gguf`, `nativeDescribeImage` on the Mali GPU):

> "The screen shows an orange background with a text input field at the bottom.
>  The text input field has a plus icon on the left and a microphone icon on the
>  right."

Accurate: the Eliza home screen is an orange background with the "Ask Eliza"
composer (a `+` on the left, a mic on the right) at the bottom.

## Pipeline
- plugin-vision loads on-device — `GET /api/vision/capture-requests` → 200.
- The renderer screen-capture bridge actively polls `/api/vision/capture-requests`
  every ~1.5s through the JNI loopback (logcat-confirmed).
- IMAGE_DESCRIPTION model handler routes to the bionic host `op:"image"`.
- Degenerate-repetition collapse bounds the small vision model's output
  (457 → 220 chars) for low-token screen understanding.
