# Alpha resident adoption, request epoch and retirement

Alpha consumes `stageResidentHostSources` through its
`scripts/stage-local-agent-sources.ts`. Eliza's producer
`packages/app/scripts/mobile/android/resident-host-sources.mjs` selects
`ElizaAgentService` and its helpers from the pinned revision. Alpha
provides installed package and socket identities through
`android/consumer-host.json`. The included
`packages/app/platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java`
serializes cross-instance lifecycle, adopts proven detached agents and
preserves unresolved process custody. This model owns one app UID's
admission, boot and shutdown. Workflow survivors remain separately
owned except when a credential change requires sole-UID evidence.

## Story: Restore a resident agent without launching a duplicate

### The service selects boot, adoption or refusal from current evidence

A listener with a matching deployment can be adopted and probed. An
unproven listening survivor blocks a replacement. Without a listener, a
recent launch stamp holds startup only when its journaled child is
still identifiable and live. An expired or unproven stamp alone does
not confer custody. A worker must hold the lifecycle lock, have a settled
predecessor and have passed the update-pause gate before it makes this
decision. The source exposes independent process and service observations.
The evidence arguments summarize those platform checks.

```quint
type ResidentPhase = NoResident | StartingResident | ReadyResident | PreservedResident | StoppingResident | StopUnconfirmed
type StartEvidence = {
  predecessorSettled: bool, updateAllowsStart: bool, listener: bool, deploymentMatches: bool,
  recentStamp: bool, journaledChildLive: bool
}
type Resident = { phase: ResidentPhase, requestEpoch: int, requestsOpen: bool, launchRequired: bool, credentialChange: bool }
pure val initial: Resident = { phase: NoResident, requestEpoch: 0, requestsOpen: true, launchRequired: false, credentialChange: false }
pure def canBeginResident(s: Resident, evidence: StartEvidence): bool =
  (s.phase == NoResident or s.phase == PreservedResident) and evidence.predecessorSettled and evidence.updateAllowsStart
pure def beginResident(s: Resident, evidence: StartEvidence): Resident = {
  val refused = evidence.listener and not(evidence.deploymentMatches)
  val detected = evidence.listener or (evidence.recentStamp and evidence.journaledChildLive)
  { ...s, phase: if (refused) PreservedResident else StartingResident,
    requestEpoch: s.requestEpoch + 1, requestsOpen: not(refused), launchRequired: not(detected) }
}
pure val evidenceValues = Set(
  {predecessorSettled: true, updateAllowsStart: true, listener: false, deploymentMatches: false, recentStamp: false, journaledChildLive: false},
  {predecessorSettled: true, updateAllowsStart: true, listener: true, deploymentMatches: true, recentStamp: false, journaledChildLive: false},
  {predecessorSettled: true, updateAllowsStart: true, listener: true, deploymentMatches: false, recentStamp: false, journaledChildLive: false},
  {predecessorSettled: true, updateAllowsStart: true, listener: false, deploymentMatches: false, recentStamp: true, journaledChildLive: true},
  {predecessorSettled: false, updateAllowsStart: false, listener: false, deploymentMatches: false, recentStamp: false, journaledChildLive: false}
)
pure def canObserveResidentReady(s: Resident, selectedEpoch: int, authenticatedHealth: bool): bool =
  s.phase == StartingResident and selectedEpoch == s.requestEpoch and authenticatedHealth
pure def observeResidentReady(s: Resident, selectedEpoch: int, authenticatedHealth: bool): Resident =
  { ...s, phase: ReadyResident }
pure val selectedEpochValues = Set(0, 1, 2, 3)
pure def permitsRequestEpoch(s: Resident, selectedEpoch: int): bool =
  s.requestsOpen and selectedEpoch >= 0 and selectedEpoch == s.requestEpoch
pure def lawRetiredRequestIsRefused(epoch: int, selectedEpoch: int): bool =
  epoch != selectedEpoch implies not(permitsRequestEpoch({ ...initial, requestEpoch: epoch }, selectedEpoch))
pure def stepPreservedResidentNeverLaunches(before: Resident, after: Resident): bool =
  after.phase == PreservedResident implies not(after.launchRequired)
pure def sometimesAdoptionProbed(s: Resident): bool = s.phase == ReadyResident and not(s.launchRequired)
pure def sometimesUnprovenSurvivorPreserved(s: Resident): bool = s.phase == PreservedResident
```

## Story: Retire the resident for a restart or credential change

### Shutdown failure preserves custody and retired request observations cannot act

Shutdown fences request admission before settling process ownership.
The `withCurrent` method checks the exact request epoch under the
native lifecycle lock. A termination request or closed socket alone
does not prove absence. The ordinary stop requires direct-child exit
and eventual detached-process absence. The credential-stop path also
requires sole-UID inventory evidence, including workflow siblings.
Unconfirmed shutdown retains prior ownership and can be retried.
`requestsOpen` models admission to the synchronized
`RequestObservation` fence. Authenticated endpoint readiness is a
separate condition because the source can reopen the fence while the
detached probe is still running.

```quint
pure def canRequestStop(s: Resident): bool =
  s.phase == StartingResident or s.phase == ReadyResident or s.phase == PreservedResident
pure def requestStop(s: Resident, credentialChange: bool): Resident =
  { ...s, phase: StoppingResident, requestEpoch: s.requestEpoch + 1, requestsOpen: false, credentialChange: credentialChange }
pure def canFinishStop(s: Resident): bool = s.phase == StoppingResident or s.phase == StopUnconfirmed
pure def finishStop(s: Resident, launcherGone: bool, detachedGone: bool, soleUid: bool): Resident =
  if (launcherGone and detachedGone and (not(s.credentialChange) or soleUid)) {
    ...s, phase: NoResident, launchRequired: false, credentialChange: false
  } else { ...s, phase: StopUnconfirmed }
pure def alwaysRetirementFencesRequests(s: Resident): bool =
  s.phase == StoppingResident or s.phase == StopUnconfirmed or s.phase == PreservedResident implies not(s.requestsOpen)
pure def alwaysEpochNonnegative(s: Resident): bool = s.requestEpoch >= 0
pure def stepRetirementAdvancesEpoch(before: Resident, via: str, after: Resident): bool =
  via == "requestStop" implies after.requestEpoch > before.requestEpoch and not(after.requestsOpen)
pure def stepEpochNeverGoesBackward(before: Resident, after: Resident): bool = after.requestEpoch >= before.requestEpoch
pure def sometimesShutdownUnconfirmed(s: Resident): bool = s.phase == StopUnconfirmed
pure def sometimesShutdownConfirmed(s: Resident): bool = s.phase == NoResident and not(s.requestsOpen)
```
