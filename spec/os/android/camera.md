# Camera viewfinder and recording custody

A consumer's camera adapter composes Eliza
`plugins/plugin-native-camera/src/session.ts` and `host-ports.ts` with the
foreground Camera, native `ElizaCamera` or browser camera, and its media
library. Capture from the lock screen belongs to the system camera's
secure activity, staged into every image as the last story here says. The [assistant shutter and saved
photo receipt](../../agent/deviceActions/camera.md) uses this viewfinder and its exclusive
capture slot. The [scan document](../../files/scan/review.md) owns scan review.

## Story: Resume and operate the viewfinder I opened

> As the person, I want the viewfinder I opened to come back when I return
> to it, and never a stale one, so that what I see is what the camera
> captures.

### Only the current foreground start can publish ready

The viewfinder state is `off`, `starting`, `ready` or `error`. Starting
allocates a new epoch and waits for the queued preview releases. Stop
retires the epoch even when no hardware is available. A late native
start can require cleanup when there is no newer start or ready
preview. The bridge receives serialized release calls. A release failure
settles its slot and a subsequent start resets native camera state. The
model tracks whether that queue has drained. A consumer may also allow its
in-flight photo writer to settle for up to ten seconds before releasing
preview; storage read-back is handled inside its capture port.

```quint
type PreviewPhase = PreviewOff | PreviewStarting | PreviewReady | PreviewError
type AccessDenial = NoDenial | CameraDenied | MicrophoneDenied
type PreviewAnswer = PreviewStarted | ExplicitCameraDenial | PreviewFailed
type Work = CameraIdle | CameraControl | CameraCapture | RecordingStarting | RecordingActive | RecordingFinishing
type VideoAnswer = VideoStarted | ExplicitMicrophoneDenial | VideoStartFailed | StartLostPreview
type RecordingResult = RecordingUnobserved | RecordingConfirmed | RecordingFailed
type CameraView = { foreground: bool, epoch: int, phase: PreviewPhase, denied: AccessDenial, previewPending: bool, retiredPreviews: int -> bool, releases: bool, work: Work, workEpoch: int, finished: RecordingResult }
pure val initial: CameraView = { foreground: false, epoch: 0, phase: PreviewOff, denied: NoDenial, previewPending: false, retiredPreviews: Map(), releases: false, work: CameraIdle, workEpoch: 0, finished: RecordingUnobserved }
pure def ownsTicket(s: CameraView, ticket: int): bool = s.foreground and s.epoch == ticket
pure def ownsPreview(s: CameraView): bool = s.phase == PreviewStarting or s.phase == PreviewReady
pure def canEnterView(s: CameraView): bool = not(s.foreground)
pure def enterView(s: CameraView): CameraView = { ...s, foreground: true }
pure def canStartView(s: CameraView, retry: bool): bool =
  s.foreground and not(ownsPreview(s)) and (s.phase != PreviewError or retry) and s.work != RecordingStarting and s.work != RecordingFinishing
pure def startView(s: CameraView, retry: bool, bridge: bool): CameraView =
  if (bridge) { ...s, phase: PreviewStarting, epoch: s.epoch + 1 }
  else { ...s, phase: PreviewError }
pure def canDispatchPreview(s: CameraView): bool = s.foreground and s.phase == PreviewStarting and not(s.previewPending or s.releases)
pure def dispatchPreview(s: CameraView): CameraView = { ...s, previewPending: true }
pure def canObservePreview(s: CameraView, ticket: int): bool =
  (ticket == s.epoch and s.previewPending) or (ticket > 0 and ticket < s.epoch and s.retiredPreviews.getOr(ticket, false))
pure def observePreview(s: CameraView, ticket: int, answer: PreviewAnswer): CameraView =
  if (ticket != s.epoch) { ...s, retiredPreviews: s.retiredPreviews.put(ticket, false), releases: s.releases or (answer == PreviewStarted and not(ownsPreview(s))) }
  else if (answer == PreviewStarted) { ...s, previewPending: false, phase: PreviewReady, denied: if (s.denied == CameraDenied) NoDenial else s.denied }
  else { ...s, previewPending: false, phase: PreviewError, denied: if (answer == ExplicitCameraDenial) CameraDenied else NoDenial }
pure def canReleasePreview(s: CameraView): bool = s.releases and s.work != RecordingFinishing
pure def releasePreview(s: CameraView): CameraView = { ...s, releases: false }
pure def canStopView(s: CameraView): bool = s.foreground or ownsPreview(s)
pure def stopView(s: CameraView): CameraView =
  { ...s, foreground: false, epoch: s.epoch + 1, phase: PreviewOff, releases: true,
    retiredPreviews: if (s.previewPending) s.retiredPreviews.put(s.epoch, true) else s.retiredPreviews, previewPending: false,
    work: if (s.work == RecordingActive) RecordingFinishing else if (s.work == CameraControl) CameraIdle else s.work }
pure val ticketValues = Set(0, 1, 2, 3, 4, 5, 6)
pure val answerValues = Set(PreviewStarted, ExplicitCameraDenial, PreviewFailed)
pure def alwaysDispatchedHasStartingOwner(s: CameraView): bool = s.previewPending implies s.phase == PreviewStarting and s.foreground
pure def alwaysPreviewUsesPositiveEpoch(s: CameraView): bool = s.epoch >= 0 and (ownsPreview(s) implies s.epoch > 0)
pure def alwaysPreviewHasForegroundOwner(s: CameraView): bool = ownsPreview(s) implies s.foreground
pure def stepPreviewReadyMatchesInFlightEpoch(before: CameraView, via: str, after: CameraView): bool =
  (before.phase != PreviewReady and after.phase == PreviewReady) implies via == "observePreview" and before.previewPending and before.foreground and before.epoch == after.epoch
pure def sometimesPreviewReady(s: CameraView): bool = s.phase == PreviewReady
```

### Permission recovery uses a read of the current grant

An explicit camera denial receives camera recovery. An explicit
microphone denial receives microphone recovery only in video start.
Other bridge errors use the ordinary failure path. Generic errors need
an explicit retry. Closing Android's permissions dialog can cause a
resume event. A read without a prompt must say `granted` while the same
surface is still stopped with camera denial before recovery can rearm
the next start. Unreadable access leaves the error intact. The permission
port reads the stopped state on both sides of its await.

```quint
pure def canRearmView(s: CameraView, wasCameraError: bool, granted: bool): bool =
  wasCameraError and granted and s.phase == PreviewError and s.denied == CameraDenied
pure def rearmView(s: CameraView, wasCameraError: bool, granted: bool): CameraView = { ...s, phase: PreviewOff }
pure def sometimesDeniedCameraCanRecover(s: CameraView): bool = s.phase == PreviewOff and s.denied == CameraDenied
```

## Story: Control the live preview and finish one recording

> As the person, I want to control the live preview and finish one
> recording.

### A capture, viewfinder control and recording share one slot

Serialized controls and recording start require the ready preview. A capture can
reserve the slot before starting or waiting for its preview. Its caller
checks the epoch and readiness when using hardware or publishing the
result. A stop retires the visible preview and its controls. An already
active recording still enters finalization. If an in-flight recording
start later succeeds after retirement it enters that same finalization
path without publishing a recording indicator. A native `PREVIEW_STOPPED`
failure enters the preview error path. Concurrent finish requests share
the in-flight finalization. A repeated stop without an owned recording
does not issue a fresh native recording stop. A consumer's focus-point
hint can run alongside capture. Its marker does not confirm autofocus.

```quint
pure def canReserveWork(s: CameraView, work: Work): bool =
  s.work == CameraIdle and s.foreground and
  (work == CameraCapture or (s.phase == PreviewReady and (work == CameraControl or work == RecordingStarting)))
pure def reserveWork(s: CameraView, work: Work): CameraView =
  { ...s, work: work, workEpoch: s.epoch, finished: if (work == RecordingStarting) RecordingUnobserved else s.finished }
pure def canClearWork(s: CameraView, ticket: int): bool = (s.work == CameraControl or s.work == CameraCapture) and s.workEpoch == ticket
pure def clearWork(s: CameraView, ticket: int): CameraView = { ...s, work: CameraIdle }
pure def canReadVideoStart(s: CameraView): bool = s.work == RecordingStarting
pure def readVideoStart(s: CameraView, videoAnswer: VideoAnswer): CameraView =
  if (videoAnswer == VideoStarted) { ...s, work: if (ownsTicket(s, s.workEpoch)) RecordingActive else RecordingFinishing }
  else if (not(ownsTicket(s, s.workEpoch))) { ...s, work: CameraIdle }
  else { ...s, work: CameraIdle,
    denied: if (videoAnswer == ExplicitMicrophoneDenial) MicrophoneDenied else s.denied,
    phase: if (videoAnswer == StartLostPreview) PreviewError else s.phase }
pure def canFinishVideo(s: CameraView): bool = s.work == RecordingActive
pure def finishVideo(s: CameraView): CameraView = { ...s, work: RecordingFinishing }
pure val workValues = Set(CameraControl, CameraCapture, RecordingStarting, RecordingActive)
pure val videoAnswerValues = Set(VideoStarted, ExplicitMicrophoneDenial, VideoStartFailed, StartLostPreview)
pure def alwaysRecordingIndicatorHasCurrentReadyPreview(s: CameraView): bool =
  s.work == RecordingActive implies s.phase == PreviewReady and ownsTicket(s, s.workEpoch)
pure def alwaysWorkDoesNotComeFromFuture(s: CameraView): bool = s.workEpoch <= s.epoch
pure def stepStopCarriesOwnedVideoToFinishing(before: CameraView, via: str, after: CameraView): bool =
  (via == "stopView" and before.work == RecordingActive) implies after.work == RecordingFinishing
pure def sometimesRetiredVideoFinalizes(s: CameraView): bool = not(s.foreground) and s.work == RecordingFinishing
```

### A pending recording start that still owns the view came from a ready preview

A recording start still pending under the view's current epoch belongs to
a foreground view whose preview is ready: a stop retires the epoch before a
closed view can reopen, so a recording never starts on a preview that was
never ready.

```quint
pure def alwaysCurrentVideoStartHasReadyPreview(s: CameraView): bool =
  (s.work == RecordingStarting and s.epoch == s.workEpoch) implies s.foreground and s.phase == PreviewReady
```

### Video confirmation requires a complete bridge receipt and host read-back

`completeRecording` requires a nonempty path, finite positive duration
and finite positive file size. A consumer sets audio on, gallery save,
medium quality, a five-minute duration limit and a 100 MiB file limit.
The consumer's hook accepts a `content://media/` or `browser-video:///` path
ending in a decimal identity, then reads the corresponding `v:` item
from the library. Only a live, undisposed adapter publishes that item.
Generic `CameraVideoPort` hosts may instead hold a reviewed temporary
video until explicit Keep or discard. A host may fail adoption even
after the bridge stopped recording. The failed outcome leaves the save
unconfirmed. The positive finite checks and URI decoding are port facts.

```quint
type VideoReceipt = { pathPresent: bool, durationPositiveFinite: bool, sizePositiveFinite: bool, ownedReadback: bool }
pure def completeVideoReceipt(r: VideoReceipt): bool =
  r.pathPresent and r.durationPositiveFinite and r.sizePositiveFinite and r.ownedReadback
pure def canObserveVideoFinish(s: CameraView): bool = s.work == RecordingFinishing
pure def observeVideoFinish(s: CameraView, receipt: VideoReceipt): CameraView =
  { ...s, work: CameraIdle, finished: if (completeVideoReceipt(receipt)) RecordingConfirmed else RecordingFailed }
pure val receiptValues = Set(
  { pathPresent: true, durationPositiveFinite: true, sizePositiveFinite: true, ownedReadback: true },
  { pathPresent: true, durationPositiveFinite: true, sizePositiveFinite: true, ownedReadback: false },
  { pathPresent: false, durationPositiveFinite: false, sizePositiveFinite: false, ownedReadback: false }
)
pure def lawMissingReadbackIsUnconfirmed(receipt: VideoReceipt): bool = not(receipt.ownedReadback) implies not(completeVideoReceipt(receipt))
pure def stepRecordingConfirmationFollowsFinalization(before: CameraView, via: str, after: CameraView): bool =
  (before.finished != RecordingConfirmed and after.finished == RecordingConfirmed) implies via == "observeVideoFinish" and before.work == RecordingFinishing
pure def sometimesVideoConfirmed(s: CameraView): bool = s.finished == RecordingConfirmed
pure def sometimesVideoFailed(s: CameraView): bool = s.finished == RecordingFailed
```

## Story: Take a photo from the lock screen with the system's secure camera

> As the person, I want the camera I open from the lock screen to be the
> system's own secure camera, so that a locked phone never shows the app's
> surface or hands it my capture.

### Lock-screen capture is the system secure camera's, staged from reviewed source and checked on the booted image

Every image stages the system camera's secure capture activity from
reviewed source: each module's checkout is at its reviewed commit, its
index hides no change, it has no ignored input files, its changes are
exactly the reviewed overrides with their reviewed sizes and digests, and
each reviewed file has its reviewed digest. When the product refuses
lock-screen surfaces, a launcher that declares an activity shown over the
lock screen, or that handles either secure capture action, is refused
([product composition](../image/product.md)). On a
booted image, for an explicit user and the exact expected image
fingerprint, the system camera must be enabled and both the secure still
and secure capture actions must resolve to its secure activity, and the
launcher must handle neither. None of these checks is evidence that a
locked capture is isolated, that unlocking returns correctly, or that a
device was accepted.

```quint
type SecureCameraEvidence = { sourceVerified: bool, imageVerified: bool, lockedCaptureVerified: bool }
pure def secureCameraSourceVerified(atReviewedCommit: bool, indexHidesNothing: bool, noIgnoredInputs: bool, changesAreReviewed: bool, filesMatch: bool): bool =
  atReviewedCommit and indexHidesNothing and noIgnoredInputs and changesAreReviewed and filesMatch
pure def secureCameraImageEvidence(sourceVerified: bool, fingerprintMatches: bool, cameraEnabled: bool, systemHandlesBoth: bool, launcherHandlesEither: bool): SecureCameraEvidence =
  { sourceVerified: sourceVerified,
    imageVerified: sourceVerified and fingerprintMatches and cameraEnabled and systemHandlesBoth and not(launcherHandlesEither),
    lockedCaptureVerified: false }
pure def lawLauncherHandlerFailsTheImageCheck(sourceVerified: bool, fingerprintMatches: bool, cameraEnabled: bool, systemHandlesBoth: bool): bool =
  not(secureCameraImageEvidence(sourceVerified, fingerprintMatches, cameraEnabled, systemHandlesBoth, true).imageVerified)
pure def lawHiddenSourceChangeIsNotVerified(atReviewedCommit: bool, noIgnoredInputs: bool, changesAreReviewed: bool, filesMatch: bool): bool =
  not(secureCameraSourceVerified(atReviewedCommit, false, noIgnoredInputs, changesAreReviewed, filesMatch))
pure def lawChecksNeverClaimLockedCapture(sourceVerified: bool, fingerprintMatches: bool, cameraEnabled: bool, systemHandlesBoth: bool, launcherHandlesEither: bool): bool =
  not(secureCameraImageEvidence(sourceVerified, fingerprintMatches, cameraEnabled, systemHandlesBoth, launcherHandlesEither).lockedCaptureVerified)
```
