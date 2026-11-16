# Retention sweeps

The host deletes memories and logs past their retention period with a
worker that the kernel's task service runs on a schedule. The worker is
published once when the service starts and its task is installed
asynchronously. Stopping waits for an installation still in flight and for
a sweep in progress, and leaves no worker or task behind.

## Story: Sweep expired memories and logs on a schedule

> As the owner, my agent forgets what it should no longer keep, and when it
> stops no sweep is left running or scheduled.

### The worker is published once, when the service starts

```quint
type RetentionPhase = NotStarted | Starting | Running | Stopping | Stopped
type Retention = { phase: RetentionPhase, installing: bool, worker: bool, task: bool, sweeping: bool, installFailed: bool, sweeps: int }
pure val initial: Retention = { phase: NotStarted, installing: false, worker: false, task: false, sweeping: false, installFailed: false, sweeps: 0 }
pure def canStart(r: Retention): bool = r.phase == NotStarted
pure def start(r: Retention): Retention = { ...r, phase: Starting, installing: true, worker: true }
pure def canInstall(r: Retention): bool = r.installing and r.phase == Starting
pure def install(r: Retention): Retention = { ...r, phase: Running, installing: false, task: true }
pure def canInstallFailed(r: Retention): bool = r.installing
pure def installFailed(r: Retention): Retention = { ...r, installing: false, installFailed: true, worker: false }
pure def alwaysTaskHasWorker(r: Retention): bool = (r.task implies r.worker) and (r.installing implies r.worker)
pure def stepWorkerPublishedOnlyAtStart(before: Retention, via: str, after: Retention): bool =
  (not(before.worker) and after.worker) implies (via == "start" and before.phase == NotStarted)
```

### Only a running service sweeps, one sweep at a time

```quint
pure def canRunSweep(r: Retention): bool = r.phase == Running and not(r.sweeping)
pure def runSweep(r: Retention): Retention = { ...r, sweeping: true }
pure def canSweepDone(r: Retention): bool = r.sweeping
pure def sweepDone(r: Retention): Retention = { ...r, sweeping: false, sweeps: r.sweeps + 1 }
pure def alwaysSweepOnlyWhileRunningOrDraining(r: Retention): bool = r.sweeping implies (r.phase == Running or r.phase == Stopping)
pure def sometimesSwept(r: Retention): bool = r.sweeps > 0
```

### Stopping waits for an installation in flight and a sweep in progress, and leaves nothing behind

```quint
pure def canStop(r: Retention): bool = r.phase != Stopped and r.phase != Stopping
pure def stop(r: Retention): Retention = { ...r, phase: Stopping }
pure def canInstallDuringStop(r: Retention): bool = r.installing and r.phase == Stopping
pure def installDuringStop(r: Retention): Retention = { ...r, installing: false, task: true }
pure def canFinishStop(r: Retention): bool = r.phase == Stopping and not(r.installing) and not(r.sweeping)
pure def finishStop(r: Retention): Retention = { ...r, phase: Stopped, worker: false, task: false }
pure def alwaysStoppedLeavesNothing(r: Retention): bool =
  r.phase == Stopped implies not(r.task) and not(r.worker) and not(r.installing) and not(r.sweeping)
pure def sometimesStoppedDuringStart(r: Retention): bool = r.phase == Stopped and r.sweeps == 0 and not(r.installFailed)
```
