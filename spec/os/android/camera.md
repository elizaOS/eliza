# Camera viewfinder and recording custody

One camera session of a host surface: the live viewfinder, the one slot that
a capture, a viewfinder control or a recording holds, and when a recording
counts as saved. The `ElizaCamera` bridge client and the session shell
(`src/bridges/camera.vibe`) follow this machine; the host decides through
its ports where an explicit Keep of a capture goes, and nothing is kept,
uploaded or handed off implicitly. The lock-screen camera is the system's
secure camera, staged and checked by the image specs, never this session.
Calls to the bridge are admitted as [the bridge vocabulary](./bridge.md)
says.

## Story: See the live view I opened

> As the person, I want the viewfinder I opened to come back when I return
> to it, and never a stale one, so that what I see is what the camera
> captures.

### Only the answer to the current foreground start can make the viewfinder ready

Every start and every stop takes a new epoch. A start waits for the queued
preview releases before it asks the bridge for a preview, so a new preview
never races the release of the last one. An answer to an older epoch moves
nothing; if that late preview did come up and no newer start owns the
camera, it is queued for release. A failed release settles its place in the
queue, and the next start resets the native camera. A bridge that is not
registered puts the view in error without a call.

```quint
import bridge.* from "./bridge"
type PreviewPhase = PreviewOff | PreviewStarting | PreviewReady | PreviewError
type AccessDenial = NoDenial | CameraAccessDenied | MicrophoneAccessDenied
type CameraAnswer = AnswerStarted | AnswerDenied | AnswerFailed | AnswerPreviewLost
type Work = CameraIdle | CameraControl | CameraCapture | RecordingStarting | RecordingActive | RecordingFinishing
type RecordingResult = RecordingUnobserved | RecordingConfirmed | RecordingFailed
type CameraView = { foreground: bool, epoch: int, phase: PreviewPhase, denied: AccessDenial, inFlight: Set[int], releasePending: bool, work: Work, workEpoch: int, finished: RecordingResult }
pure val initial: CameraView = { foreground: false, epoch: 0, phase: PreviewOff, denied: NoDenial, inFlight: Set(), releasePending: false, work: CameraIdle, workEpoch: 0, finished: RecordingUnobserved }
pure def ownsPreview(s: CameraView): bool = s.phase == PreviewStarting or s.phase == PreviewReady
pure def canEnterView(s: CameraView): bool = not(s.foreground)
pure def enterView(s: CameraView): CameraView = { ...s, foreground: true }
pure def canStartView(s: CameraView, retry: bool): bool =
  s.foreground and not(ownsPreview(s)) and (s.phase != PreviewError or retry) and s.work != RecordingStarting and s.work != RecordingFinishing
pure def startView(s: CameraView, retry: bool, presence: PluginPresence): CameraView =
  if (presence == PluginRegistered) { ...s, phase: PreviewStarting, epoch: s.epoch + 1 } else { ...s, phase: PreviewError }
pure def canDispatchPreview(s: CameraView): bool =
  s.foreground and s.phase == PreviewStarting and not(s.inFlight.contains(s.epoch)) and not(s.releasePending)
pure def dispatchPreview(s: CameraView): CameraView = { ...s, inFlight: s.inFlight.union(Set(s.epoch)) }
pure def canObservePreview(s: CameraView, ticket: int): bool = s.inFlight.contains(ticket)
pure def observePreview(s: CameraView, ticket: int, previewAnswer: CameraAnswer): CameraView = {
  val rest = s.inFlight.exclude(Set(ticket))
  if (ticket != s.epoch) { ...s, inFlight: rest, releasePending: s.releasePending or (previewAnswer == AnswerStarted and not(ownsPreview(s))) }
  else if (previewAnswer == AnswerStarted) { ...s, inFlight: rest, phase: PreviewReady, denied: if (s.denied == CameraAccessDenied) NoDenial else s.denied }
  else { ...s, inFlight: rest, phase: PreviewError, denied: if (previewAnswer == AnswerDenied) CameraAccessDenied else NoDenial }
}
pure def canReleasePreview(s: CameraView): bool = s.releasePending and s.work != RecordingFinishing
pure def releasePreview(s: CameraView): CameraView = { ...s, releasePending: false }
pure def canStopView(s: CameraView): bool = s.foreground
pure def stopView(s: CameraView): CameraView =
  { ...s, foreground: false, epoch: s.epoch + 1, phase: PreviewOff, releasePending: true,
    work: if (s.work == RecordingActive) RecordingFinishing else if (s.work == CameraControl) CameraIdle else s.work }
pure val ticketValues = Set(1, 2, 3, 4)
pure val previewAnswerValues = Set(AnswerStarted, AnswerDenied, AnswerFailed)
pure val presenceValues = Set(PluginRegistered, PluginNotBuilt)
pure val weight_dispatchPreview = 3
pure val weight_observePreview = 3
pure def alwaysTicketsWereIssued(s: CameraView): bool = s.epoch >= 0 and s.inFlight.forall(t => t > 0 and t <= s.epoch)
pure def alwaysCurrentAnswerIsAwaitedOnlyWhileStarting(s: CameraView): bool =
  s.inFlight.contains(s.epoch) implies (s.phase == PreviewStarting and s.foreground)
pure def alwaysViewfinderHasForegroundOwner(s: CameraView): bool =
  (ownsPreview(s) implies (s.foreground and s.epoch > 0)) and (s.phase == PreviewError implies s.foreground)
pure def stepReadyOnlyFromTheCurrentAnswer(before: CameraView, via: str, after: CameraView): bool =
  (before.phase != PreviewReady and after.phase == PreviewReady) implies
    (via == "observePreview" and before.foreground and before.inFlight.contains(before.epoch) and after.epoch == before.epoch and not(after.inFlight.contains(after.epoch)))
pure def sometimesPreviewReady(s: CameraView): bool = s.phase == PreviewReady
```

### Only Android's explicit permission refusal counts as a denial

The shell turns each bridge answer into a `CameraAnswer` with `answerOf`.
When Android's prompt grants access, the shell calls again and that call's
admission counts. A missing bridge, an unsupported device, a view that is not
ready or any other native failure is an ordinary failure that needs an
explicit retry; nothing is inferred from timing or wording.

```quint
pure def answerOf(admission: Admission, started: bool): CameraAnswer =
  if (admission == PermissionRequired) AnswerDenied
  else if (admission == CallAdmitted and started) AnswerStarted
  else AnswerFailed
pure def lawDenialIsOnlyAPermissionRefusal(presence: PluginPresence, call: BridgeCall, facts: HostFacts, started: bool): bool = {
  val answer = answerOf(admitCall(presence, call, facts), started)
  (answer == AnswerDenied implies (presence == PluginRegistered and call.needsGrant and not(facts.granted))) and
  (answer == AnswerStarted implies admitCall(presence, call, facts) == CallAdmitted)
}
```

### Permission recovery rearms the view only on a read of the current grant

Closing Android's permission dialog also resumes the app, so a resume never
restarts a view stopped on a camera denial by itself. The shell reads the
camera grant without prompting, and reads the view on both sides of that
read; only `AccessGranted` while the view is still stopped on the camera
denial lets the next start run. An unreadable grant leaves the error. An
explicit retry and a stop also leave it.

```quint
type GrantRead = AccessGranted | AccessNotGranted | AccessUnreadable
pure def rearmedPhase(phase: PreviewPhase, denied: AccessDenial, grant: GrantRead): PreviewPhase =
  if (phase == PreviewError and denied == CameraAccessDenied and grant == AccessGranted) PreviewOff else phase
pure def canRearmView(s: CameraView): bool = s.phase == PreviewError and s.denied == CameraAccessDenied
pure def rearmView(s: CameraView, grant: GrantRead): CameraView = { ...s, phase: rearmedPhase(s.phase, s.denied, grant) }
pure def canDismissDenial(s: CameraView): bool = s.denied != NoDenial
pure def dismissDenial(s: CameraView): CameraView = { ...s, denied: NoDenial }
pure def lawOnlyAGrantRearms(phase: PreviewPhase, denied: AccessDenial, grant: GrantRead): bool =
  rearmedPhase(phase, denied, grant) != phase implies (grant == AccessGranted and denied == CameraAccessDenied)
pure def stepCameraDenialEndsOnlyByGrantRetryOrStop(before: CameraView, via: str, after: CameraView): bool =
  (before.phase == PreviewError and before.denied == CameraAccessDenied and after.phase != PreviewError) implies
    (via == "rearmView" or via == "startView" or via == "stopView")
pure def sometimesStoppedOnCameraDenial(s: CameraView): bool = s.phase == PreviewError and s.denied == CameraAccessDenied
```

## Story: Capture with the camera only from the live view

> As the person, I want one capture, control change or recording at a time
> on the view I see, and a recording called saved only when it really is,
> so that the camera never acts on a view I left.

### A capture, a viewfinder control and a recording share one slot

A control and a recording start need the ready preview; a capture may
reserve the slot before its preview is up and checks the epoch itself
before it uses the hardware or shows its result. A stop frees a control at
once and sends an active recording to finalization. A focus-point hint is
not work: it may run beside a capture, and its marker does not confirm
focus.

```quint
pure def canReserveWork(s: CameraView, work: Work): bool =
  s.work == CameraIdle and s.foreground and
  (work == CameraCapture or (s.phase == PreviewReady and (work == CameraControl or work == RecordingStarting)))
pure def reserveWork(s: CameraView, work: Work): CameraView =
  { ...s, work: work, workEpoch: s.epoch, finished: if (work == RecordingStarting) RecordingUnobserved else s.finished }
pure def canFinishWork(s: CameraView): bool = s.work == CameraControl or s.work == CameraCapture
pure def finishWork(s: CameraView): CameraView = { ...s, work: CameraIdle }
pure val workValues = Set(CameraControl, CameraCapture, RecordingStarting)
pure def alwaysWorkDoesNotComeFromTheFuture(s: CameraView): bool = s.workEpoch >= 0 and s.workEpoch <= s.epoch
pure def alwaysPreviewWorkHasTheCurrentReadyPreview(s: CameraView): bool =
  (s.work == CameraControl or s.work == RecordingActive) implies (s.phase == PreviewReady and s.foreground and s.workEpoch == s.epoch)
pure def sometimesRecording(s: CameraView): bool = s.work == RecordingActive
```

### A recording start that still owns the view came from its ready preview

The view cannot restart while a recording start is pending, so only a stop
moves the epoch past it. A start that succeeds after that stop goes straight
to finalization and never shows a recording indicator; a refusal after it
changes nothing. A current microphone refusal is the microphone denial, and
`PREVIEW_STOPPED` (`AnswerPreviewLost`) puts the view in error so the host
offers a retry, not a dead shutter.

```quint
pure def ownsTicket(s: CameraView, ticket: int): bool = s.foreground and s.epoch == ticket
pure def canReadVideoStart(s: CameraView): bool = s.work == RecordingStarting
pure def readVideoStart(s: CameraView, videoAnswer: CameraAnswer): CameraView =
  if (videoAnswer == AnswerStarted) { ...s, work: if (ownsTicket(s, s.workEpoch)) RecordingActive else RecordingFinishing }
  else if (not(ownsTicket(s, s.workEpoch))) { ...s, work: CameraIdle }
  else { ...s, work: CameraIdle,
    denied: if (videoAnswer == AnswerDenied) MicrophoneAccessDenied else s.denied,
    phase: if (videoAnswer == AnswerPreviewLost) PreviewError else s.phase }
pure val videoAnswerValues = Set(AnswerStarted, AnswerDenied, AnswerFailed, AnswerPreviewLost)
pure val weight_readVideoStart = 2
pure def alwaysCurrentVideoStartHasReadyPreview(s: CameraView): bool =
  (s.work == RecordingStarting and s.workEpoch == s.epoch) implies (s.foreground and s.phase == PreviewReady)
pure def sometimesClosedViewFinalizesRecording(s: CameraView): bool = not(s.foreground) and s.work == RecordingFinishing
pure def sometimesMicrophoneDenied(s: CameraView): bool = s.denied == MicrophoneAccessDenied
```

### A recording is confirmed only by a complete bridge receipt that the host read back

The bridge's stop answer must carry a path, a finite positive duration and
a finite positive size, and the host must then read the item back from its
own media store (or hold it for review until an explicit Keep). Concurrent
finish requests share the one finalization, and a finish with no active
recording asks the bridge for nothing. A host that fails to adopt the file
after the bridge stopped leaves the recording unconfirmed.

```quint
type VideoReceipt = { pathPresent: bool, durationPositive: bool, sizePositive: bool, hostReadBack: bool }
pure def completeVideoReceipt(r: VideoReceipt): bool = r.pathPresent and r.durationPositive and r.sizePositive and r.hostReadBack
pure def canFinishVideo(s: CameraView): bool = s.work == RecordingActive
pure def finishVideo(s: CameraView): CameraView = { ...s, work: RecordingFinishing }
pure def canObserveVideoFinish(s: CameraView): bool = s.work == RecordingFinishing
pure def observeVideoFinish(s: CameraView, receipt: VideoReceipt): CameraView =
  { ...s, work: CameraIdle, finished: if (completeVideoReceipt(receipt)) RecordingConfirmed else RecordingFailed }
pure val receiptValues = Set(
  { pathPresent: true, durationPositive: true, sizePositive: true, hostReadBack: true },
  { pathPresent: true, durationPositive: true, sizePositive: true, hostReadBack: false },
  { pathPresent: false, durationPositive: false, sizePositive: false, hostReadBack: false }
)
pure def stepConfirmationFollowsFinalization(before: CameraView, via: str, after: CameraView): bool =
  (before.finished != RecordingConfirmed and after.finished == RecordingConfirmed) implies (via == "observeVideoFinish" and before.work == RecordingFinishing)
pure def sometimesVideoConfirmed(s: CameraView): bool = s.finished == RecordingConfirmed
pure def sometimesVideoFailed(s: CameraView): bool = s.finished == RecordingFailed
```
