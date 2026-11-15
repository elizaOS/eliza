# Trajectory capture

The agent captures each run's trajectory through the trajectories service and
its row store (`features/trajectories/store/trajectory-{storage,internals}.ts`,
folded in from the assistant plugin), the single owner of trajectory
persistence, and the host recovers the trajectory of a process that died
(`dev-trajectory-recovery.ts`). [Core trajectories](../core/trajectories.md)
own what a trajectory records. This spec owns one execution's capture: the
queue of accepted steps, graceful draining, the persistence setting, and
recovery after a crash by the exact owner. Exporting trajectories for
training is not part of the agent.

## Story: Keep what was captured when the agent stops, and let only its owner recover it

> As a user, steps the agent captured are saved before it stops gracefully,
> nothing is saved when I turned persistence off, and after a crash only the
> execution that owned the trajectory can close it, without pretending that
> lost steps were saved.

### Captured steps are saved before a graceful end

An execution starts its capture under its own owner identity, with the
persistence setting in force. While active and not stopping it accepts steps;
a failed write keeps the step queued for another attempt. Finishing, or
terminating after a stop, waits until every accepted step is saved.

```quint
type CaptureStatus = CaptureAbsent | CaptureActive | CaptureCompleted | CaptureTerminated
type TrajectoryCapture = { status: CaptureStatus, owner: int, persistence: bool, accepted: int, persisted: int, stopping: bool, dead: bool, writeFailed: bool, crashed: bool }
pure val initial: TrajectoryCapture = { status: CaptureAbsent, owner: 0, persistence: false, accepted: 0, persisted: 0, stopping: false, dead: false, writeFailed: false, crashed: false }
pure val ownerValues = Set(0, 1, 2)
pure def canStart(t: TrajectoryCapture, owner: int, persistence: bool): bool = t.status == CaptureAbsent and not(t.stopping) and owner > 0
pure def start(t: TrajectoryCapture, owner: int, persistence: bool): TrajectoryCapture = { ...t, status: CaptureActive, owner: owner, persistence: persistence }
pure def canCapture(t: TrajectoryCapture): bool = t.status == CaptureActive and not(t.stopping) and t.persistence
pure def capture(t: TrajectoryCapture): TrajectoryCapture = { ...t, accepted: t.accepted + 1 }
pure def canPersistStep(t: TrajectoryCapture): bool = t.persisted < t.accepted and not(t.crashed)
pure def persistStep(t: TrajectoryCapture): TrajectoryCapture = { ...t, persisted: t.persisted + 1, writeFailed: false }
pure def canFailWrite(t: TrajectoryCapture): bool = t.persisted < t.accepted and not(t.crashed)
pure def failWrite(t: TrajectoryCapture): TrajectoryCapture = { ...t, writeFailed: true }
pure def canFinish(t: TrajectoryCapture): bool = t.status == CaptureActive and not(t.crashed) and t.persisted == t.accepted
pure def finish(t: TrajectoryCapture): TrajectoryCapture = { ...t, status: CaptureCompleted }
pure def canStop(t: TrajectoryCapture): bool = not(t.stopping)
pure def stop(t: TrajectoryCapture): TrajectoryCapture = { ...t, stopping: true }
pure def canTerminate(t: TrajectoryCapture): bool = t.stopping and not(t.crashed) and t.status == CaptureActive and t.persisted == t.accepted
pure def terminate(t: TrajectoryCapture): TrajectoryCapture = { ...t, status: CaptureTerminated }
pure def alwaysSavedNeverExceedsAccepted(t: TrajectoryCapture): bool = t.persisted >= 0 and t.persisted <= t.accepted
pure def alwaysGracefulEndIsDrained(t: TrajectoryCapture): bool =
  ((t.status == CaptureCompleted or t.status == CaptureTerminated) and not(t.crashed)) implies t.persisted == t.accepted
pure def sometimesFailedWriteRetriedBeforeStop(t: TrajectoryCapture): bool = t.status == CaptureTerminated and t.persisted > 0 and not(t.crashed)
```

### Nothing is captured when persistence is off

An execution started with persistence off accepts and saves no steps.

```quint
pure def alwaysPersistenceOffSavesNothing(t: TrajectoryCapture): bool = (t.status != CaptureAbsent and not(t.persistence)) implies (t.accepted == 0 and t.persisted == 0)
pure def sometimesRunWithPersistenceOff(t: TrajectoryCapture): bool = t.status == CaptureCompleted and not(t.persistence)
```

### Only the exact owner recovers a dead execution's trajectory

A crash marks the execution dead and may lose steps that were accepted but not
saved. The supervisor may also confirm that a drained execution exited. Only
the owner the capture started under can then close the trajectory; recovery
never claims that a lost step was saved, and leaves the saved count as it was.

```quint
pure def canConfirmExit(t: TrajectoryCapture): bool = t.status == CaptureActive and t.persisted == t.accepted and not(t.dead)
pure def confirmExit(t: TrajectoryCapture): TrajectoryCapture = { ...t, dead: true, stopping: true }
pure def canCrash(t: TrajectoryCapture): bool = t.status == CaptureActive and not(t.dead)
pure def crash(t: TrajectoryCapture): TrajectoryCapture = { ...t, crashed: true, dead: true, stopping: true }
pure def canRecover(t: TrajectoryCapture, owner: int): bool = t.dead and t.status == CaptureActive and owner == t.owner
pure def recover(t: TrajectoryCapture, owner: int): TrajectoryCapture = { ...t, status: CaptureTerminated }
pure val tValues = Set(initial, { ...initial, status: CaptureActive, owner: 1, persistence: true, accepted: 1, dead: true, crashed: true, stopping: true })
pure def lawForeignOwnerCannotRecover(t: TrajectoryCapture, owner: int): bool = owner != t.owner implies not(canRecover(t, owner))
pure def stepRecoveryNeedsADeadExecution(before: TrajectoryCapture, via: str, after: TrajectoryCapture): bool =
  via == "recover" implies (before.dead and after.persisted == before.persisted and after.accepted == before.accepted)
pure def sometimesCrashLostAStep(t: TrajectoryCapture): bool = t.status == CaptureTerminated and t.crashed and t.persisted < t.accepted
```
