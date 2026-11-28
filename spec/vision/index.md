# Vision

Device cameras and authorized screen sources supply observations for
scene description, camera stills, OCR, grounded controls and entity
tracking. [Description backpressure](./backpressure.md) governs
memory-pressure pauses, concurrency bounds, and failure circuit breaking.
The shell owns feature discovery, platform capture, OCR
workers and image decoding. The [device](../os/) owns protected surfaces.

## Story: Control which of my visual sources the assistant can use

> As the device owner, I want capture to follow my selected sources and
> for a disabled or protected source to stop contributing immediately.

### A capture uses one available and authorized source

The owner can select off, camera, screen, or both. A capture is authorized
for one mode, source, and request identity. A protected surface never
supplies a screen capture. When the owner changes mode, disconnects
a camera or screen, or the surface becomes protected, invalidate
the active request and discard any late frame. Retire each completed or
failed request before accepting its successor. The shell assigns unique
capture IDs.

```quint
type VisionMode = VisionOff | CameraOnly | ScreenOnly | CameraAndScreen
type CaptureSource = CameraSource | ScreenSource
type CapturePurpose = DescribeScene | CameraStill | ReadControls | ReadText | TrackScene
type VisionPhase = NoCapture | Capturing | FrameReady | CaptureFailed
type VisionState = { mode: VisionMode, cameraConnected: bool, screenConnected: bool, protectedScreen: bool, revision: int, phase: VisionPhase, captureId: str, source: CaptureSource, purpose: CapturePurpose, includeImage: bool, frameRef: str }
pure val initial: VisionState = { mode: VisionOff, cameraConnected: false, screenConnected: false, protectedScreen: false, revision: 0, phase: NoCapture, captureId: "", source: CameraSource, purpose: DescribeScene, includeImage: false, frameRef: "" }
pure def sourceAllowed(mode: VisionMode, source: CaptureSource, cameraConnected: bool, screenConnected: bool, protectedScreen: bool): bool =
  if (source == CameraSource) cameraConnected and (mode == CameraOnly or mode == CameraAndScreen)
  else screenConnected and not(protectedScreen) and (mode == ScreenOnly or mode == CameraAndScreen)
pure def suitableCaptureSource(source: CaptureSource, purpose: CapturePurpose): bool =
  (purpose == CameraStill implies source == CameraSource) and
    ((purpose == ReadControls or purpose == ReadText) implies source == ScreenSource)
pure def canConfigureVision(s: VisionState, revision: int): bool = revision > s.revision
pure def configureVision(s: VisionState, mode: VisionMode, cameraConnected: bool, screenConnected: bool, protectedScreen: bool, revision: int): VisionState =
  { ...initial, mode: mode, cameraConnected: cameraConnected, screenConnected: screenConnected, protectedScreen: protectedScreen, revision: revision }
pure def canRequestCapture(s: VisionState, captureId: str, source: CaptureSource, purpose: CapturePurpose): bool =
  s.phase == NoCapture and captureId != "" and suitableCaptureSource(source, purpose) and
    sourceAllowed(s.mode, source, s.cameraConnected, s.screenConnected, s.protectedScreen)
pure def requestCapture(s: VisionState, captureId: str, source: CaptureSource, purpose: CapturePurpose, includeImage: bool): VisionState =
  { ...s, phase: Capturing, captureId: captureId, source: source, purpose: purpose, includeImage: includeImage }
pure def canAcceptCameraOrScreen(s: VisionState, captureId: str, source: CaptureSource, revision: int, frameRef: str): bool =
  s.phase == Capturing and s.captureId == captureId and s.source == source and s.revision == revision and frameRef != "" and
    sourceAllowed(s.mode, source, s.cameraConnected, s.screenConnected, s.protectedScreen)
pure def acceptCameraOrScreen(s: VisionState, captureId: str, source: CaptureSource, revision: int, frameRef: str): VisionState =
  { ...s, phase: FrameReady, frameRef: frameRef }
pure def canFailCapture(s: VisionState, captureId: str, revision: int): bool =
  s.phase == Capturing and s.captureId == captureId and s.revision == revision
pure def failCapture(s: VisionState, captureId: str, revision: int): VisionState = { ...s, phase: CaptureFailed }
pure def canRetireCapture(s: VisionState, captureId: str, revision: int): bool =
  (s.phase == FrameReady or s.phase == CaptureFailed) and s.captureId == captureId and s.revision == revision
pure def retireCapture(s: VisionState, captureId: str, revision: int): VisionState =
  { ...s, phase: NoCapture, captureId: "", frameRef: "" }
pure def alwaysProtectedScreenHasNoCapture(s: VisionState): bool =
  s.protectedScreen and (s.phase == Capturing or s.phase == FrameReady) implies s.source != ScreenSource
pure def stepVisionRevisionNeverRewinds(before: VisionState, after: VisionState): bool = before.revision <= after.revision
pure val captureIdValues = Set("", "request", "other")
pure val frameRefValues = Set("", "frame")
pure def sometimesScreenReady(s: VisionState): bool = s.phase == FrameReady and s.source == ScreenSource
pure val eval_witness_sometimesScreenReady = (("configureVision", ScreenOnly, false, true, false, 1), ("requestCapture", "request", ScreenSource, ReadControls, false), ("acceptCameraOrScreen", "request", ScreenSource, 1, "frame"))
```

### Returning a grounded screen description excludes unrequested images

Screen reads return OCR text and their grounded element coordinates by
default. Only an explicit image request can release that capture's image.
Scene description work pauses under critical memory pressure or when the
model arbiter denies capacity.

```quint
type VisionResources = { memoryCritical: bool, modelAvailable: bool, outstanding: int, concurrencyLimit: int }
pure val resourcesValues: Set[VisionResources] = Set(
  { memoryCritical: false, modelAvailable: true, outstanding: 0, concurrencyLimit: 2 },
  { memoryCritical: true, modelAvailable: true, outstanding: 0, concurrencyLimit: 2 },
  { memoryCritical: false, modelAvailable: true, outstanding: 2, concurrencyLimit: 2 })
pure def visionDescriptionAllowed(resources: VisionResources): bool =
  not(resources.memoryCritical) and resources.modelAvailable and
    resources.outstanding >= 0 and resources.outstanding < resources.concurrencyLimit
pure def releaseVisionImage(s: VisionState, revision: int): bool =
  s.phase == FrameReady and s.revision == revision and (s.purpose == CameraStill or s.includeImage) and
    sourceAllowed(s.mode, s.source, s.cameraConnected, s.screenConnected, s.protectedScreen)
pure def lawScreenImageIsOptIn(s: VisionState, revision: int): bool =
  s.purpose == ReadControls and not(s.includeImage) implies not(releaseVisionImage(s, revision))
```

## Story: Name and track an observed subject with current evidence

> As the owner, I want a name or ongoing tracking attached to a subject
> that is actually in the current scene.

### A subject matches the current observation and an explicit instruction

The tracking worker returns candidate observations scoped to the scene
and capture revision. A stale or empty subject cannot receive a name or
be selected for tracking. The user's instruction supplies the label.
The shell owns face detection, feature storage and retention.

```quint
type SubjectObservation = { subjectId: str, frameRef: str, revision: int, visible: bool }
pure def subjectIsCurrent(s: VisionState, subject: SubjectObservation): bool =
  s.phase == FrameReady and subject.visible and subject.subjectId != "" and
    subject.frameRef == s.frameRef and subject.revision == s.revision
pure def subjectNamingAllowed(s: VisionState, subject: SubjectObservation, ownerLabel: str, ownerRequested: bool): bool =
  subjectIsCurrent(s, subject) and ownerLabel != "" and ownerRequested
pure val subjectValues: Set[SubjectObservation] = Set(
  { subjectId: "subject", frameRef: "frame", revision: 1, visible: true },
  { subjectId: "subject", frameRef: "frame", revision: 2, visible: true },
  { subjectId: "", frameRef: "other", revision: 1, visible: false })
pure def lawStaleSubjectCannotBeNamed(s: VisionState, subject: SubjectObservation, ownerLabel: str, ownerRequested: bool): bool =
  subject.revision != s.revision implies not(subjectNamingAllowed(s, subject, ownerLabel, ownerRequested))
```
