# Computer use session lifecycle

## Story: Manage leased computer-use sessions with fresh observations

> As the owner, I can open, pause, resume, renew leases on, observe, execute actions in, and close computer-use sessions across host, browser, sandbox, and remote guest targets. Stale epochs, expired leases, or missing observations never execute consequential actions.

### A session tracks status, target kind, monotonic epoch and sequence, lease validity, and observation freshness

A session starts closed at epoch zero. Reopening advances the epoch so commands captured for an older generation can never apply to the reopened session.

```quint
type SessionStatus = Idle | Running | Paused | Stopping | Closed
type SessionTargetKind = HostTarget | BrowserTarget | SandboxTarget | RemoteGuestTarget
type SessionMachine = {
  status: SessionStatus,
  targetKind: SessionTargetKind,
  epoch: int,
  sequence: int,
  leaseActive: bool,
  observationSeq: int,
  activeActionSeq: int,
  closedCount: int
}

pure val initial: SessionMachine = {
  status: Closed,
  targetKind: HostTarget,
  epoch: 0,
  sequence: 0,
  leaseActive: false,
  observationSeq: 0,
  activeActionSeq: 0,
  closedCount: 0
}
```

### Opening a closed session advances its epoch and grants an active lease

A closed session opens into `Idle` with a higher epoch, a fresh sequence counter, an active lease, and no active action or stale observation.

```quint
pure def canOpenSession(s: SessionMachine, target: SessionTargetKind): bool =
  s.status == Closed

pure def openSession(s: SessionMachine, target: SessionTargetKind): SessionMachine = {
  ...s,
  status: Idle,
  targetKind: target,
  epoch: s.epoch + 1,
  sequence: s.sequence + 1,
  leaseActive: true,
  observationSeq: 0,
  activeActionSeq: 0
}
```

### Recording an observation advances sequence while the session is leased and not stopping or closed

Fresh observations record the sequence number at which they were captured so consequential actions can verify that an observation exists for the current generation.

```quint
pure def canRecordObservation(s: SessionMachine): bool =
  s.status != Closed and s.status != Stopping and s.leaseActive

pure def recordObservation(s: SessionMachine): SessionMachine = {
  ...s,
  sequence: s.sequence + 1,
  observationSeq: s.sequence + 1
}
```

### Starting an action requires an idle leased session matching epoch and sequence, plus an observation when required

Consequential actions require a fresh observation in the current generation; non-consequential actions may start without one.

```quint
pure def canBeginAction(
  s: SessionMachine,
  expectedEpoch: int,
  expectedSeq: int,
  requiresObservation: bool
): bool =
  s.status == Idle and s.leaseActive and
  expectedEpoch == s.epoch and expectedSeq == s.sequence and
  (not(requiresObservation) or s.observationSeq > 0)

pure def beginAction(
  s: SessionMachine,
  expectedEpoch: int,
  expectedSeq: int,
  requiresObservation: bool
): SessionMachine = {
  ...s,
  status: Running,
  sequence: s.sequence + 1,
  activeActionSeq: s.sequence + 1
}

pure def canCompleteAction(s: SessionMachine, forEpoch: int, forActionSeq: int): bool =
  s.status == Running and forEpoch == s.epoch and forActionSeq == s.activeActionSeq

pure def completeAction(s: SessionMachine, forEpoch: int, forActionSeq: int): SessionMachine = {
  ...s,
  status: Idle,
  sequence: s.sequence + 1,
  activeActionSeq: 0
}
```

### Pausing, resuming, lease expiration, lease renewal, stopping, and closing maintain strict lifecycle boundaries

Pausing suspends an idle or running session; resuming returns a paused leased session to idle; lease expiry revokes execution until renewed; stopping drains any active action; closing terminates the session and clears leases and active actions.

```quint
pure def canPauseSession(s: SessionMachine): bool =
  s.status == Idle or s.status == Running

pure def pauseSession(s: SessionMachine): SessionMachine = {
  ...s,
  status: Paused,
  sequence: s.sequence + 1,
  activeActionSeq: 0
}

pure def canResumeSession(s: SessionMachine): bool =
  s.status == Paused and s.leaseActive

pure def resumeSession(s: SessionMachine): SessionMachine = {
  ...s,
  status: Idle,
  sequence: s.sequence + 1
}

pure def canExpireLease(s: SessionMachine): bool =
  s.leaseActive and s.status != Closed

pure def expireLease(s: SessionMachine): SessionMachine = {
  ...s,
  status: if (s.status == Running) Idle else s.status,
  leaseActive: false,
  sequence: s.sequence + 1,
  activeActionSeq: 0
}

pure def canRenewLease(s: SessionMachine): bool =
  s.status != Closed and s.status != Stopping and not(s.leaseActive)

pure def renewLease(s: SessionMachine): SessionMachine = {
  ...s,
  leaseActive: true,
  sequence: s.sequence + 1
}

pure def canBeginStop(s: SessionMachine): bool =
  s.status == Idle or s.status == Running or s.status == Paused

pure def beginStop(s: SessionMachine): SessionMachine = {
  ...s,
  status: Stopping,
  sequence: s.sequence + 1,
  activeActionSeq: 0
}

pure def canCloseSession(s: SessionMachine): bool =
  s.status != Closed

pure def closeSession(s: SessionMachine): SessionMachine = {
  ...s,
  status: Closed,
  leaseActive: false,
  sequence: s.sequence + 1,
  observationSeq: 0,
  activeActionSeq: 0,
  closedCount: s.closedCount + 1
}
```

### Session invariants hold in every reachable state and across every transition

Epochs and sequences never decrease, closed sessions hold no active lease or action, running sessions always hold a lease and a positive active action sequence, and reopening always advances the epoch.

```quint
pure def alwaysCountersValid(s: SessionMachine): bool =
  s.epoch >= 0 and s.sequence >= 0 and s.observationSeq >= 0 and
  s.observationSeq <= s.sequence and s.activeActionSeq >= 0 and
  s.activeActionSeq <= s.sequence and s.closedCount >= 0

pure def alwaysClosedIsClean(s: SessionMachine): bool =
  s.status == Closed implies (not(s.leaseActive) and s.activeActionSeq == 0 and s.observationSeq == 0)

pure def alwaysRunningRequiresLeaseAndAction(s: SessionMachine): bool =
  s.status == Running implies (s.leaseActive and s.activeActionSeq > 0)

pure def alwaysNonRunningHasNoActiveAction(s: SessionMachine): bool =
  s.status != Running implies s.activeActionSeq == 0

pure def stepMonotonicProgress(before: SessionMachine, after: SessionMachine): bool =
  after.epoch >= before.epoch and after.sequence >= before.sequence and after.closedCount >= before.closedCount

pure def stepReopenAdvancesEpoch(before: SessionMachine, after: SessionMachine): bool =
  (before.status == Closed and after.status != Closed) implies after.epoch > before.epoch

pure def sometimesRunningObservedAction(s: SessionMachine): bool =
  s.status == Running and s.observationSeq > 0

pure def sometimesReopenedAfterClose(s: SessionMachine): bool =
  s.status == Idle and s.epoch >= 2 and s.closedCount >= 1

pure def sometimesLeaseRenewedAfterExpiry(s: SessionMachine): bool =
  s.status == Paused and not(s.leaseActive)

pure val expectedEpochValues = Set(0, 1, 2, 3)
pure val expectedSeqValues = Set(0, 1, 2, 3, 4, 5, 6)
pure val forEpochValues = Set(0, 1, 2, 3)
pure val forActionSeqValues = Set(0, 1, 2, 3, 4, 5, 6)
pure val eval_witness_sometimesRunningObservedAction = (("openSession", HostTarget), "recordObservation", ("beginAction", 1, 2, true))
pure val eval_witness_canCompleteAction = (("openSession", HostTarget), "recordObservation", ("beginAction", 1, 2, true), ("completeAction", 1, 3))
pure val eval_witness_sometimesReopenedAfterClose = (("openSession", HostTarget), "closeSession", ("openSession", BrowserTarget))
pure val eval_witness_sometimesLeaseRenewedAfterExpiry = (("openSession", HostTarget), "pauseSession", "expireLease")
```
