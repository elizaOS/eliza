# Resident lifecycle

One device account has one resident agent, and each launch of it has an
epoch. Starting the resident adopts a proven survivor, launches the
[paired agent and gateway](./startup.md), or refuses an unproven one; the
resident serves once the launch it started reports authenticated health,
and a stop retires the launch and keeps custody of its processes until
their exit is confirmed. A request is answered only by the launch it
selected while that launch is still serving. The desktop native host's
[runtime supervisor](../nativeHost/runtimeSupervisor.md) is a different
supervisor: it runs one private runtime per signed-in account on a
computer.

## Story: Restore a resident agent without launching a duplicate

> As a device owner, when my app restarts it reuses the agent already
> running for it instead of launching a second one.

### Starting selects adoption, launch or refusal from current evidence

Starting waits for the previous resident to settle and for no update to
hold it. A listener of the same deployment is adopted, and so is a
journaled child that is still alive behind a recent launch stamp; without
either, the resident launches. A listener that is not provably this
deployment is preserved and never replaced. Every start begins a new
epoch.

```quint
import watchdog as W from "./watchdog"
type ResidentPhase = NoResident | StartingResident | ServingResident | PreservedResident | StoppingResident | StopUnconfirmed
type RequestPhase = NoSelection | Selected | InFlight | Returned | Unavailable | StaleReply | WorkFailed
type StartEvidence = {
  predecessorSettled: bool, updateAllowsStart: bool, listener: bool, deploymentMatches: bool,
  recentStamp: bool, journaledChildLive: bool
}
type ReadyEvidence = { epoch: int, authenticated: bool }
type AbsenceEvidence = { refusals: int, childJournaled: bool, childAlive: bool }
type ResidentHost = {
  phase: ResidentPhase, epoch: int, launchRequired: bool, credentialChange: bool,
  request: RequestPhase, selectedEpoch: int, returnedEpoch: int, absence: AbsenceEvidence
}
pure val noAbsence: AbsenceEvidence = { refusals: 0, childJournaled: false, childAlive: false }
pure val initial: ResidentHost = {
  phase: NoResident, epoch: 0, launchRequired: false, credentialChange: false,
  request: NoSelection, selectedEpoch: -1, returnedEpoch: -1, absence: noAbsence
}
pure def canBeginResident(s: ResidentHost, evidence: StartEvidence): bool =
  (s.phase == NoResident or s.phase == PreservedResident) and evidence.predecessorSettled and evidence.updateAllowsStart
pure def beginResident(s: ResidentHost, evidence: StartEvidence): ResidentHost = {
  val refused = evidence.listener and not(evidence.deploymentMatches)
  val detected = evidence.listener or (evidence.recentStamp and evidence.journaledChildLive)
  { ...s, phase: if (refused) PreservedResident else StartingResident, epoch: s.epoch + 1, launchRequired: not(detected) }
}
pure val evidenceValues = Set(
  { predecessorSettled: true, updateAllowsStart: true, listener: false, deploymentMatches: false, recentStamp: false, journaledChildLive: false },
  { predecessorSettled: true, updateAllowsStart: true, listener: true, deploymentMatches: true, recentStamp: false, journaledChildLive: false },
  { predecessorSettled: true, updateAllowsStart: true, listener: true, deploymentMatches: false, recentStamp: false, journaledChildLive: false },
  { predecessorSettled: true, updateAllowsStart: true, listener: false, deploymentMatches: false, recentStamp: true, journaledChildLive: true },
  { predecessorSettled: false, updateAllowsStart: false, listener: false, deploymentMatches: false, recentStamp: false, journaledChildLive: false }
)
pure def stepPreservedResidentNeverLaunches(before: ResidentHost, after: ResidentHost): bool =
  after.phase == PreservedResident implies not(after.launchRequired)
pure def sometimesUnprovenSurvivorPreserved(s: ResidentHost): bool = s.phase == PreservedResident
```

### The resident serves only after authenticated health of its current launch

A health observation counts only when it is authenticated and belongs to
the epoch of the launch being started; endpoint visibility alone is not
readiness.

```quint
pure def canObserveResidentReady(s: ResidentHost, observation: ReadyEvidence): bool =
  s.phase == StartingResident and observation.epoch == s.epoch and observation.authenticated
pure def observeResidentReady(s: ResidentHost, observation: ReadyEvidence): ResidentHost = { ...s, phase: ServingResident }
pure val observationValues = Set({ epoch: 1, authenticated: true }, { epoch: 2, authenticated: true }, { epoch: 1, authenticated: false })
pure def stepServingFollowsCurrentHealth(before: ResidentHost, via: str, after: ResidentHost): bool =
  (after.phase == ServingResident and before.phase != ServingResident) implies (via == "observeResidentReady" and after.epoch == before.epoch)
pure def sometimesAdoptedResidentServes(s: ResidentHost): bool = s.phase == ServingResident and not(s.launchRequired)
pure def sometimesLaunchedResidentServes(s: ResidentHost): bool = s.phase == ServingResident and s.launchRequired
```

## Story: Send a request through the running resident agent

> As a device owner, a reply reaches me only from the agent launch that
> took my request, and only while that launch is still serving.

### A request is admitted and its response published only while the launch it selected is still serving

A request selects the current launch. Dispatch is refused unless that
launch is serving; a response that completes after its launch retired is
a stale reply, never published. A failed request publishes nothing.

```quint
pure def selectedLaunchServing(s: ResidentHost): bool = s.phase == ServingResident and s.epoch == s.selectedEpoch
pure def canSelectLaunch(s: ResidentHost): bool = s.request != Selected and s.request != InFlight
pure def selectLaunch(s: ResidentHost): ResidentHost = { ...s, selectedEpoch: s.epoch, request: Selected, returnedEpoch: -1 }
pure def canDispatchRequest(s: ResidentHost): bool = s.request == Selected
pure def dispatchRequest(s: ResidentHost): ResidentHost = { ...s, request: if (selectedLaunchServing(s)) InFlight else Unavailable }
pure def canFinishRequest(s: ResidentHost): bool = s.request == InFlight
pure def finishRequest(s: ResidentHost, workSucceeded: bool): ResidentHost =
  if (not(workSucceeded)) { ...s, request: WorkFailed }
  else if (selectedLaunchServing(s)) { ...s, request: Returned, returnedEpoch: s.epoch }
  else { ...s, request: StaleReply }
pure def alwaysEpochCoordinates(s: ResidentHost): bool =
  s.epoch >= 0 and s.selectedEpoch <= s.epoch and s.returnedEpoch <= s.epoch and
  (s.request == Returned implies s.returnedEpoch == s.selectedEpoch and s.returnedEpoch >= 0)
pure def stepRequestFencedByServingLaunch(before: ResidentHost, via: str, after: ResidentHost): bool =
  ((via == "dispatchRequest" and after.request == InFlight) or (via == "finishRequest" and after.request == Returned)) implies selectedLaunchServing(before)
pure def stepEpochNeverGoesBackward(before: ResidentHost, after: ResidentHost): bool = after.epoch >= before.epoch
pure def sometimesResponseReturned(s: ResidentHost): bool = s.request == Returned
pure def sometimesRetiredResponseRejected(s: ResidentHost): bool = s.request == StaleReply
pure def sometimesSelectionRejected(s: ResidentHost): bool = s.request == Unavailable
```

## Story: Retire the resident for a restart or credential change

> As a device owner, when I restart the agent or change account, the old
> agent is stopped before a new one serves me.

### A stop retires the launch at once and keeps custody until exit is confirmed

A stop, whether asked for or caused by a crash, begins a new epoch, so no
request of the old launch can be admitted or answered. A termination
request or a closed socket does not prove the processes gone: the stop
completes only when the direct child has exited, the absence evidence
gathered since the stop proves the detached process absent by the
[watchdog's test](./watchdog.md), and, for a credential change, no other
process of the account remains. Otherwise the stop stays unconfirmed, keeps custody and
can be retried. A retired launch never serves again: a later start is a
new launch with a new epoch.

```quint
pure def canRequestStop(s: ResidentHost): bool =
  s.phase == StartingResident or s.phase == ServingResident or s.phase == PreservedResident
pure def requestStop(s: ResidentHost, credentialChange: bool): ResidentHost =
  { ...s, phase: StoppingResident, epoch: s.epoch + 1, credentialChange: credentialChange, absence: noAbsence }
pure def canObserveAbsence(s: ResidentHost, absence: AbsenceEvidence): bool =
  (s.phase == StoppingResident or s.phase == StopUnconfirmed) and absence.refusals >= 0
pure def observeAbsence(s: ResidentHost, absence: AbsenceEvidence): ResidentHost = { ...s, absence: absence }
pure val absenceValues = Set(
  { refusals: 2, childJournaled: true, childAlive: false },
  { refusals: 1, childJournaled: true, childAlive: false },
  { refusals: 3, childJournaled: true, childAlive: true },
  { refusals: 2, childJournaled: false, childAlive: false }
)
pure def canFinishStop(s: ResidentHost): bool = s.phase == StoppingResident or s.phase == StopUnconfirmed
pure def finishStop(s: ResidentHost, launcherGone: bool, soleUid: bool): ResidentHost =
  if (launcherGone and W::confirmsDetachedAbsence(s.absence.refusals, s.absence.childJournaled, s.absence.childAlive) and (not(s.credentialChange) or soleUid))
    { ...s, phase: NoResident, launchRequired: false, credentialChange: false }
  else { ...s, phase: StopUnconfirmed }
pure def stepStopConfirmedOnlyOnProvenAbsence(before: ResidentHost, via: str, after: ResidentHost): bool =
  (via == "finishStop" and after.phase == NoResident) implies
    W::confirmsDetachedAbsence(before.absence.refusals, before.absence.childJournaled, before.absence.childAlive)
pure def stepRetirementAdvancesEpoch(before: ResidentHost, via: str, after: ResidentHost): bool =
  via == "requestStop" implies after.epoch > before.epoch
pure def alwaysCredentialStopKeepsCustody(s: ResidentHost): bool =
  s.credentialChange implies (s.phase == StoppingResident or s.phase == StopUnconfirmed)
pure def sometimesShutdownUnconfirmed(s: ResidentHost): bool = s.phase == StopUnconfirmed
pure def sometimesShutdownConfirmed(s: ResidentHost): bool = s.phase == NoResident and s.epoch >= 2
```
