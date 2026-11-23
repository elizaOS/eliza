# Native camera

The [Android camera session](../os/android/camera.md) owns Android camera resource exclusion. The cross-platform contract includes device selection, preview, photo capture, video recording, per-camera controls and document scan constraints.

On Android 10 and later, a gallery save can include `libraryId` in the photo
receipt. Its form is `m:<volume>:i:<id>`, using the saved image row's own
MediaStore volume and row ID. The save can succeed without an ID if that row
identity is unavailable. The [agent's receipt contract](../agent/deviceActions/operations.md)
governs when the ID reaches the agent.

## Story: Take a picture or record a clip through the current camera view

> As the person, I want a result only from my current preview and a separate reviewed save.

### The current epoch owns the camera result, and only zoom and torch may change during recording

Camera-only permission does not imply microphone or photo-library access. The host handles preview cleanup and keeps captured bytes only through the explicit approved save.

```quint
type CameraControl = SelectLens | CaptureStill | BeginVideo | FinishVideo | ChangeZoom | ChangeTorch | ChangeFocus | ChangeExposure
type CameraSessionView = { visible: bool, cameraGranted: bool, epoch: int, recording: bool, busy: bool }
pure def mayUseCameraControl(session: CameraSessionView, epoch: int, control: CameraControl): bool =
  session.visible and session.cameraGranted and epoch == session.epoch and not(session.busy) and
  (if (session.recording) (control == FinishVideo or control == ChangeZoom or control == ChangeTorch)
   else control != FinishVideo)
pure def lawRecordingRejectsLensChanges(session: CameraSessionView, epoch: int): bool =
  session.recording implies not(mayUseCameraControl(session, epoch, SelectLens))
```

### A document scan admits only supported pages inside the page and total bounds

```quint
type ScanFormat = ScanJpeg | ScanPng | ScanWebp | ScanUnsupported
type ScanPage = { format: ScanFormat, byteCount: int, widthPx: int, heightPx: int }
pure def mayAppendScanPage(existingPages: int, existingBytes: int, page: ScanPage): bool =
  existingPages >= 0 and existingPages < 20 and existingBytes >= 0 and
  page.format != ScanUnsupported and page.byteCount > 0 and page.byteCount <= 16777216 and
  existingBytes + page.byteCount <= 67108864 and
  page.widthPx > 0 and page.heightPx > 0 and page.widthPx * page.heightPx <= 32000000
pure def lawTwentyPagesIsFull(existingBytes: int, page: ScanPage): bool =
  not(mayAppendScanPage(20, existingBytes, page))
pure val sessionValues = Set(
  { visible: true, cameraGranted: true, epoch: 2, recording: true, busy: false },
  { visible: true, cameraGranted: true, epoch: 2, recording: false, busy: false },
  { visible: false, cameraGranted: true, epoch: 3, recording: false, busy: true })
pure val epochValues = Set(1, 2, 3)
pure val pageValues = Set(
  { format: ScanJpeg, byteCount: 1048576, widthPx: 1024, heightPx: 768 },
  { format: ScanPng, byteCount: 16777217, widthPx: 1024, heightPx: 768 },
  { format: ScanUnsupported, byteCount: 10, widthPx: 1024, heightPx: 768 })
pure val existingBytesValues = Set(-1, 0, 66060288, 67108864)
```
