# Resident runtime request authority

Grace extends `EmbeddedRuntimeService` in
`apps/app/native/java/technology/graceful/grace/LocalRuntimeService.java`.
Its `RuntimeCredentialBroker.java` constructs the upstream
`LocalCredentialBroker`. Grace consumes the pinned
`plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/runtime`
session and supervisor. `NativeRuntimeSession.request` selects an exact
lifecycle snapshot, checks host activity and running status before calling
its request, and checks activity, running status, and epoch again before
returning. `NativeProcessSupervisor` increments the epoch before
retirement on invalidation, restart and close. The transaction below
covers one captured request interleaved with arbitrary runtime replacements.

## Story: Send a request through the running resident agent

As a phone app, I can open a request against one selected resident launch
and publish its response only while the same host and launch remain live.

### Selection, dispatch and response publication share the running epoch

The session represents selection separately from request admission.
`Unavailable` corresponds to the pre-dispatch lifecycle refusal. The Alpha pin exposes
its specialized `NotReadyException` and `RUNTIME_NOT_READY` code. The
Grace pin uses the general lifecycle exception here. AlphaPhone
uses its separately modeled resident-host implementation.
A successful I/O completion from a retired launch becomes
`StaleReply` (the source raises a lifecycle error). A thrown I/O error
is returned as an error and does not attempt response publication. A
close retires the host permanently. A later service object is another
host instance. `markRunning` receives the authenticated readiness
observation from the startup owner.

```quint
type HostPhase = Stopped | Starting | Running | LaunchFailed | Closed
type RequestPhase = NoSelection | Selected | InFlight | Returned | Unavailable | StaleReply | WorkFailed
type ReadyEvidence = { epoch: int, authenticated: bool }
type PhoneHost = { epoch: int, lifecycle: HostPhase, selectedEpoch: int, request: RequestPhase, returnedEpoch: int }
pure val initial: PhoneHost = { epoch: 0, lifecycle: Stopped, selectedEpoch: -1, request: NoSelection, returnedEpoch: -1 }
pure def canStartHost(h: PhoneHost): bool = h.lifecycle == Stopped or h.lifecycle == LaunchFailed
pure def startHost(h: PhoneHost): PhoneHost = { ...h, epoch: h.epoch + 1, lifecycle: Starting }
pure def canRestartHost(h: PhoneHost): bool = h.lifecycle != Closed
pure def restartHost(h: PhoneHost): PhoneHost = { ...h, epoch: h.epoch + 1, lifecycle: Starting }
pure def canMarkRunning(h: PhoneHost, observation: ReadyEvidence): bool = h.lifecycle == Starting and observation.epoch == h.epoch and observation.authenticated
pure def markRunning(h: PhoneHost, observation: ReadyEvidence): PhoneHost = { ...h, lifecycle: Running }
pure val observationValues = Set({ epoch: 1, authenticated: true }, { epoch: 2, authenticated: true }, { epoch: 1, authenticated: false })
pure def canFailLaunch(h: PhoneHost): bool = h.lifecycle == Starting or h.lifecycle == Running
pure def failLaunch(h: PhoneHost): PhoneHost = { ...h, lifecycle: LaunchFailed }
pure def canCloseHost(h: PhoneHost): bool = h.lifecycle != Closed
pure def closeHost(h: PhoneHost): PhoneHost = { ...h, epoch: h.epoch + 1, lifecycle: Closed }
pure def canSelectLaunch(h: PhoneHost): bool = h.request != Selected and h.request != InFlight
pure def selectLaunch(h: PhoneHost): PhoneHost = { ...h, selectedEpoch: h.epoch, request: Selected, returnedEpoch: -1 }
pure def sameRunningLaunch(h: PhoneHost): bool = h.lifecycle == Running and h.epoch == h.selectedEpoch
pure def canDispatchRequest(h: PhoneHost): bool = h.request == Selected
pure def dispatchRequest(h: PhoneHost): PhoneHost = { ...h, request: if (sameRunningLaunch(h)) InFlight else Unavailable }
pure def canFinishRequest(h: PhoneHost): bool = h.request == InFlight
pure def finishRequest(h: PhoneHost, workSucceeded: bool): PhoneHost =
  if (not(workSucceeded)) { ...h, request: WorkFailed }
  else if (sameRunningLaunch(h)) { ...h, request: Returned, returnedEpoch: h.epoch }
  else { ...h, request: StaleReply }
pure def alwaysEpochCoordinates(h: PhoneHost): bool =
  h.epoch >= 0 and h.selectedEpoch <= h.epoch and h.returnedEpoch <= h.epoch
pure def alwaysReturnedOwnsSelection(h: PhoneHost): bool =
  h.request == Returned implies h.returnedEpoch == h.selectedEpoch and h.returnedEpoch >= 0
pure def stepReturnedOnlyFromLiveLaunch(before: PhoneHost, via: str, after: PhoneHost): bool =
  via == "finishRequest" and after.request == Returned implies sameRunningLaunch(before)
pure def stepAdmissionOnlyFromLiveLaunch(before: PhoneHost, via: str, after: PhoneHost): bool =
  via == "dispatchRequest" and after.request == InFlight implies sameRunningLaunch(before)
pure def stepRetiredHostCannotRestart(before: PhoneHost, after: PhoneHost): bool =
  before.lifecycle == Closed implies after.lifecycle == Closed
pure def sometimesResponseReturned(h: PhoneHost): bool = h.request == Returned
pure def sometimesRetiredResponseRejected(h: PhoneHost): bool = h.request == StaleReply
pure def sometimesSelectionRejected(h: PhoneHost): bool = h.request == Unavailable
```
