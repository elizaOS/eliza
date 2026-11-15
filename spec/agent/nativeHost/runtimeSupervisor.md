# Native runtime supervisor

The native host supervises one private runtime child for the account it is
currently asked to run (`packages/agent/native-host/runtime-supervisor.mjs`
and `private-runtime-launch.mjs`). The desired identity can change at any
time; the supervisor starts, reaps and stops only the child it launched.
[Account migration](./accountMigration.md) prepares an account's files
before its child starts.

## Story: Run the agent for the account I am signed in to, and only that one

> As a device owner, the runtime that serves me was launched for my account
> and confirmed its launch; a runtime for an account I left never keeps
> running in my place.

### A child runs only with a launch receipt for the identity still desired

The supervisor launches a child for the desired identity it captured. The
child counts as running only after its launch receipt, and only if the
desired identity is unchanged and no close was requested; otherwise the
supervisor reaps the child it just launched.

```quint
type Supervisor = { desired: int, captured: int, running: int, busy: bool, closeRequested: bool, closed: bool, spawned: bool, receipt: bool, failed: bool, backoff: bool }
pure val initial: Supervisor = { desired: 0, captured: 0, running: 0, busy: false, closeRequested: false, closed: false, spawned: false, receipt: false, failed: false, backoff: false }
pure def setIdentity(s: Supervisor, identity: int): Supervisor = { ...s, desired: identity }
pure def canReconcile(s: Supervisor): bool = not(s.busy) and not(s.closeRequested) and s.running == 0 and s.desired != 0 and not(s.backoff) and not(s.spawned)
pure def reconcile(s: Supervisor): Supervisor = { ...s, busy: true, captured: s.desired, receipt: false }
pure def canSpawnChild(s: Supervisor): bool = s.busy and not(s.spawned)
pure def spawnChild(s: Supervisor): Supervisor = { ...s, spawned: true }
pure def canReceiveReceipt(s: Supervisor): bool = s.busy and s.spawned and not(s.receipt)
pure def receiveReceipt(s: Supervisor): Supervisor = { ...s, receipt: true }
pure def canStartComplete(s: Supervisor): bool = s.busy and s.spawned and s.receipt
pure def startComplete(s: Supervisor): Supervisor = {
  val keep = not(s.closeRequested) and s.desired == s.captured
  { ...s, busy: false, running: if (keep) s.captured else 0, spawned: keep, receipt: keep }
}
pure val identityValues = Set(0, 1, 2)
pure def alwaysRunningChildHasReceipt(s: Supervisor): bool =
  (s.running != 0 implies (s.spawned and s.receipt and not(s.busy))) and (s.spawned and not(s.busy) implies s.running != 0) and
  (s.busy implies s.captured != 0)
pure def stepRunningOnlyForDesiredIdentity(before: Supervisor, via: str, after: Supervisor): bool =
  (via == "startComplete" and after.running != 0) implies (before.desired == before.captured and not(before.closeRequested))
pure def sometimesChildRunning(s: Supervisor): bool = s.running != 0
pure def sometimesChangedIdentityReapsChild(s: Supervisor): bool = s.running == 0 and not(s.busy) and s.captured != 0 and s.captured != s.desired and not(s.spawned) and not(s.failed)
```

### A failed launch reaps its child and backs off before retrying

If the launch or its receipt fails, the supervisor reaps the child, records
the failure and waits out a backoff before it may launch again. A running
child can be stopped at any time, which reaps it.

```quint
pure def canLaunchFailure(s: Supervisor): bool = s.busy
pure def launchFailure(s: Supervisor): Supervisor = { ...s, busy: false, failed: true, spawned: false, running: 0, backoff: true, receipt: false }
pure def canRetryLaunch(s: Supervisor): bool = s.backoff
pure def retryLaunch(s: Supervisor): Supervisor = { ...s, backoff: false, failed: false }
pure def canStopChild(s: Supervisor): bool = s.running != 0
pure def stopChild(s: Supervisor): Supervisor = { ...s, running: 0, spawned: false, receipt: false }
pure def alwaysFailureLeavesNoChild(s: Supervisor): bool = (s.failed implies not(s.spawned)) and (s.backoff implies not(s.busy))
pure def sometimesBackingOff(s: Supervisor): bool = s.backoff and s.captured != 0
```

### Close completes only after the owned child has stopped

A close request stops new launches. The supervisor closes only when no
launch is in progress and its child has stopped. Assuming launches settle
and the supervisor keeps stopping its child, every close request completes.

```quint
pure def requestClose(s: Supervisor): Supervisor = { ...s, closeRequested: true }
pure def canFinishClose(s: Supervisor): bool = s.closeRequested and not(s.closed) and not(s.busy) and s.running == 0 and not(s.spawned)
pure def finishClose(s: Supervisor): Supervisor = { ...s, closed: true }
pure def alwaysClosedOwnsNoChild(s: Supervisor): bool = s.closed implies (s.closeRequested and not(s.busy) and s.running == 0 and not(s.spawned))
pure def sometimesClosedAfterRunning(s: Supervisor): bool = s.closed and s.captured != 0
pure def leadsToCloseCompletes(s: Supervisor, later: Supervisor): bool = s.closeRequested implies later.closed
pure val fair_spawnChild = "weak"
pure val fair_receiveReceipt = "weak"
pure val fair_startComplete = "weak"
pure val fair_stopChild = "weak"
pure val fair_finishClose = "weak"
```
