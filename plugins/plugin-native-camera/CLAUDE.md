# @elizaos/capacitor-camera

Capacitor plugin that gives Eliza agents camera preview, photo capture, and video recording across web, iOS, and Android.

Build, test, and setup: [README.md](README.md).

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
