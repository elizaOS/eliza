# Process signals and server resources

The host process owns the interrupt and terminate signals while its shared
cleanup runs. The cleanup callbacks run one at a time in their declared
order, and the process exits only after all of them settled: with code 0
when all succeeded, with code 1 after reporting a failure. Only an explicit
external kill ends the process with a partial cleanup. The HTTP server's
resources follow the same discipline: closing is established before any
disposer runs, and a resource offered after close is refused.

## Story: Stop the host cleanly

> As the owner, when I stop my agent host it finishes its cleanup once,
> even if I press interrupt again, and it tells me whether cleanup failed.

### The first interrupt or terminate signal starts the drain

```quint
type Signal = NoSignal | Interrupt | Terminate
type Outcome = Running | Draining | ExitedClean | ExitedFailed | Killed
type Process = { phase: Outcome, first: Signal, repeated: Signal, cleanupsBegun: int, callbackPending: bool, cleanupFailed: bool, failureReported: bool, closing: bool, resources: Set[int], disposals: int }
pure val cleanupSteps = 4
pure val initial: Process = { phase: Running, first: NoSignal, repeated: NoSignal, cleanupsBegun: 0, callbackPending: false, cleanupFailed: false, failureReported: false, closing: false, resources: Set(), disposals: 0 }
pure val signalValues = Set(Interrupt, Terminate)
pure def canReceiveSignal(p: Process, signal: Signal): bool = p.phase == Running and signal != NoSignal
pure def receiveSignal(p: Process, signal: Signal): Process = { ...p, phase: Draining, first: signal }
pure def alwaysRunningUntilSignalled(p: Process): bool = (p.phase == Running) == (p.first == NoSignal)
```

### A repeated signal during the drain starts no second cleanup and does not exit

```quint
pure def canRepeatSignal(p: Process, signal: Signal): bool = p.phase == Draining and p.repeated == NoSignal and signal != NoSignal
pure def repeatSignal(p: Process, signal: Signal): Process = { ...p, repeated: signal }
pure def stepRepeatedSignalChangesNothingElse(before: Process, via: str, after: Process): bool =
  via == "repeatSignal" implies
    after.phase == before.phase and after.cleanupsBegun == before.cleanupsBegun and
    after.callbackPending == before.callbackPending and after.cleanupFailed == before.cleanupFailed
```

### Cleanup callbacks run one at a time, in order, and each settles

```quint
pure def canBeginCleanup(p: Process): bool = p.phase == Draining and not(p.callbackPending) and p.cleanupsBegun < cleanupSteps
pure def beginCleanup(p: Process): Process = { ...p, cleanupsBegun: p.cleanupsBegun + 1, callbackPending: true }
pure def canFinishCleanup(p: Process, ok: bool): bool = p.phase == Draining and p.callbackPending
pure def finishCleanup(p: Process, ok: bool): Process = { ...p, callbackPending: false, cleanupFailed: p.cleanupFailed or not(ok) }
pure def alwaysCleanupWithinSteps(p: Process): bool =
  p.cleanupsBegun >= 0 and p.cleanupsBegun <= cleanupSteps and (p.callbackPending implies p.cleanupsBegun > 0)
```

### The process exits only after every cleanup settled, with code 1 after a failure

The failure is reported before exit; a reporter that itself throws does not
change the exit code.

```quint
pure def cleanupDone(p: Process): bool = p.cleanupsBegun == cleanupSteps and not(p.callbackPending)
pure def canExitClean(p: Process): bool = p.phase == Draining and cleanupDone(p) and not(p.cleanupFailed)
pure def exitClean(p: Process): Process = { ...p, phase: ExitedClean }
pure def canExitFailed(p: Process): bool = p.phase == Draining and cleanupDone(p) and p.cleanupFailed
pure def exitFailed(p: Process): Process = { ...p, phase: ExitedFailed, failureReported: true }
pure def alwaysExitFollowsCleanup(p: Process): bool =
  (p.phase == ExitedClean or p.phase == ExitedFailed) implies cleanupDone(p) and
  (p.phase == ExitedClean implies not(p.cleanupFailed)) and
  (p.phase == ExitedFailed implies p.cleanupFailed and p.failureReported)
pure def sometimesRepeatedDuringCleanup(p: Process): bool = p.phase == Draining and p.repeated != NoSignal and p.callbackPending
pure def sometimesExitedWithFailure(p: Process): bool = p.phase == ExitedFailed
```

### Only an explicit external kill ends the process during the drain

```quint
pure def canKill(p: Process): bool = p.phase == Draining
pure def kill(p: Process): Process = { ...p, phase: Killed }
pure def sometimesKilledMidCleanup(p: Process): bool = p.phase == Killed and not(cleanupDone(p))
```

### Once draining, the process eventually exits unless it is killed

```quint
pure val fair_beginCleanup = "weak"
pure val fair_finishCleanup = "weak"
pure val fair_exitClean = "weak"
pure val fair_exitFailed = "weak"
pure def leadsToProcessExits(p: Process, later: Process): bool =
  p.phase == Draining implies (later.phase == ExitedClean or later.phase == ExitedFailed or later.phase == Killed)
```

## Story: Close the server's resources once

> As the owner, stopping the host closes its server resources once, and
> nothing registered late escapes cleanup.

### Closing is established before any disposer runs, and a disposer runs once

```quint
pure def canCloseResources(p: Process): bool = not(p.closing)
pure def closeResources(p: Process): Process = { ...p, closing: true }
pure def canDisposeResources(p: Process): bool = p.closing and p.disposals == 0
pure def disposeResources(p: Process): Process = { ...p, disposals: p.disposals + 1, resources: Set() }
pure def alwaysDisposedOnceAfterClosing(p: Process): bool = p.disposals <= 1 and (p.disposals > 0 implies p.closing)
pure def sometimesResourcesDisposed(p: Process): bool = p.disposals == 1
```

### A resource offered after close is refused

```quint
pure val resourceValues = Set(1, 2)
pure def canRegisterResource(p: Process, resource: int): bool = not(p.closing) and not(p.resources.contains(resource))
pure def registerResource(p: Process, resource: int): Process = { ...p, resources: p.resources.union(Set(resource)) }
pure def stepNoResourceAfterClose(before: Process, after: Process): bool =
  before.closing implies after.resources.subseteq(before.resources)
pure def alwaysNoResourceAfterDisposal(p: Process): bool = p.disposals > 0 implies p.resources.size() == 0
pure def sometimesResourceRegisteredBeforeClose(p: Process): bool = p.closing and p.disposals == 0 and p.resources.size() > 0
```
