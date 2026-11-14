# Alpha camera operation and saved photo receipt

Alpha's `apps/app/src/prototype/camera-adapter.ts` imports the exact
`camera-contract.ts` from the staged Eliza assistant package.
The consumer calls `captureAgentPhoto` for the
`camera_capture_photo` operation. Capability is
`camera.capture-photo.v1`. The staged
`client-coordinator.ts` rejects a successful camera result without
an exact saved photo receipt. Its durable [claim and receipt
owner](./mobileDeviceExecution.md) handles repeat admission.

## Story: Take the requested photo only from the current foreground Camera

### A ready viewfinder and current operation are checked again at shutter

The request can wait while preview starts. An already busy camera
or a recording that takes over before readiness refuses the
request. The actual shutter is inside the capture owner's exclusive
section and checks cancellation, current request and active Camera
again. Save uncertainty after dispatch cannot be converted into
failure-before-dispatch. The camera, preview, permissions and store
provide typed evidence to the port. The model is one request.

```quint
type CameraPhase = CameraUnasked | CameraWaiting | ShutterIssued | CaptureRefused | CaptureUncertain | CaptureSaved
type CameraRequest = { phase: CameraPhase, operationId: int, retired: bool, shutter: bool, mediaId: int }
pure val initial: CameraRequest = {phase: CameraUnasked, operationId: 0, retired: false, shutter: false, mediaId: 0}
pure def canAskCamera(s: CameraRequest, operationId: int, capability: bool, cameraVisible: bool, idle: bool): bool =
  s.phase == CameraUnasked and not(s.retired) and capability and operationId > 0 and cameraVisible and idle
pure def askCamera(s: CameraRequest, operationId: int, capability: bool, cameraVisible: bool, idle: bool): CameraRequest =
  {...s, phase: CameraWaiting, operationId: operationId}
pure val operationIdValues = Set(0, 1, 2)
pure def canIssueShutter(s: CameraRequest, currentRequest: bool, previewReady: bool, recording: bool): bool =
  s.phase == CameraWaiting and not(s.retired) and currentRequest and previewReady and not(recording)
pure def issueShutter(s: CameraRequest, currentRequest: bool, previewReady: bool, recording: bool): CameraRequest =
  {...s, phase: ShutterIssued, shutter: true}
pure def canRetireCamera(s: CameraRequest): bool = not(s.retired)
pure def retireCamera(s: CameraRequest): CameraRequest =
  {...s, retired: true, phase: if (s.phase == CameraWaiting) CaptureRefused else s.phase}
pure def canRefuseWaitingCamera(s: CameraRequest): bool = s.phase == CameraWaiting
pure def refuseWaitingCamera(s: CameraRequest): CameraRequest = {...s, phase: CaptureRefused}
pure def alwaysShutterPhaseMatches(s: CameraRequest): bool =
  s.shutter == (s.phase == ShutterIssued or s.phase == CaptureUncertain or s.phase == CaptureSaved)
pure def stepRetiredCannotOpenShutter(before: CameraRequest, after: CameraRequest): bool =
  before.retired implies after.retired and after.shutter == before.shutter
```

### The receipt identifies the saved image and excludes raw media

The strict v1 result carries kind `camera_capture_photo`, exact
operation ID, positive native media ID, width and height in
1–65,536 and `image/jpeg`. The wire boundary requires a media ID
string of one to 25 decimal digits without a leading zero and
validates the operation's 128-character token. The model uses
opaque numeric IDs after that decoding. Pixels, paths and
unexpected properties are excluded. A failed, missing or
malformed save receipt after shutter leaves an uncertain outcome.

```quint
type CaptureReceipt = { version: int, kindMatches: bool, operationId: int, mediaId: int, width: int, height: int, jpeg: bool, exactShape: bool }
pure def allowsSavedPhoto(receipt: CaptureReceipt, operationId: int): bool =
  receipt.exactShape and receipt.version == 1 and receipt.kindMatches and receipt.jpeg and
  receipt.operationId == operationId and receipt.operationId > 0 and receipt.mediaId > 0 and
  receipt.width > 0 and receipt.width <= 65536 and receipt.height > 0 and receipt.height <= 65536
pure def canAcceptSavedPhoto(s: CameraRequest): bool = s.phase == ShutterIssued
pure def acceptSavedPhoto(s: CameraRequest, receipt: CaptureReceipt): CameraRequest =
  if (allowsSavedPhoto(receipt, s.operationId)) {...s, phase: CaptureSaved, mediaId: receipt.mediaId}
  else {...s, phase: CaptureUncertain}
pure val receiptValues = Set(
  {version: 1, kindMatches: true, operationId: 1, mediaId: 3, width: 1200, height: 800, jpeg: true, exactShape: true},
  {version: 1, kindMatches: true, operationId: 2, mediaId: 3, width: 1200, height: 800, jpeg: true, exactShape: true},
  {version: 1, kindMatches: true, operationId: 1, mediaId: 0, width: 65537, height: 800, jpeg: true, exactShape: false}
)
pure def alwaysSavedHasMediaIdentity(s: CameraRequest): bool = (s.phase == CaptureSaved) == (s.mediaId > 0)
pure def sometimesSavedCameraImage(s: CameraRequest): bool = s.phase == CaptureSaved
pure def sometimesCameraSaveUncertain(s: CameraRequest): bool = s.phase == CaptureUncertain
```
