# Boot and teardown

The host boots the agent runtime through a fixed pipeline of blocking
phases. Work that may finish after boot, such as connector warm-up or a
first index build, is deferred: each deferred task registers with the boot
owner, which waits for it before it disposes of the runtime. Restart and
replacement of a running runtime are in [start, restart, stop and
reset](./lifecycle.md); process signals are in [process
signals](./process.md).

## Story: Run an agent host for one owner

> As the owner, I start my agent host and it reports ready only when it has
> really finished booting; when it stops, everything it started is waited
> for and the runtime is disposed of exactly once.

### Boot advances through eight blocking phases until stopping begins

Phase 0 is not started and phase 8 is fully booted. A stop request ends
boot: no phase advances once teardown has begun.

```quint
type Boot = { phase: int, closing: bool, closed: bool, tasks: Set[int], disposed: int, failed: bool }
pure val bootPhases = 8
pure val initial: Boot = { phase: 0, closing: false, closed: false, tasks: Set(), disposed: 0, failed: false }
pure def canAdvance(b: Boot): bool = not(b.closing) and b.phase < bootPhases
pure def advance(b: Boot): Boot = { ...b, phase: b.phase + 1 }
pure def alwaysPhaseWithinPipeline(b: Boot): bool = b.phase >= 0 and b.phase <= bootPhases
```

### The host is ready only when every blocking phase is done

The host becomes ready only by finishing the last blocking phase.

```quint
pure def isReady(b: Boot): bool = b.phase == bootPhases and not(b.closing)
pure def stepReadyOnlyByTheLastPhase(before: Boot, via: str, after: Boot): bool =
  (isReady(after) and not(isReady(before))) implies (via == "advance" and before.phase == bootPhases - 1)
pure def sometimesReadyWithDeferredWork(b: Boot): bool = isReady(b) and b.tasks.size() > 0
```

### Every deferred task has the boot owner, and none registers after stopping begins

```quint
pure val idValues = Set(0, 1)
pure def canRegisterTask(b: Boot, id: int): bool = not(b.closing) and not(b.tasks.contains(id))
pure def registerTask(b: Boot, id: int): Boot = { ...b, tasks: b.tasks.union(Set(id)) }
pure def canSettleTask(b: Boot, id: int): bool = b.tasks.contains(id)
pure def settleTask(b: Boot, id: int): Boot = { ...b, tasks: b.tasks.exclude(Set(id)) }
pure def stepNoTaskRegisteredWhileClosing(before: Boot, after: Boot): bool =
  before.closing implies after.tasks.subseteq(before.tasks)
```

### The runtime is disposed of once, after its deferred tasks settle

A failed teardown step is recorded and does not stop disposal: the runtime
is still disposed of once its tasks settle.

```quint
pure def canBeginStop(b: Boot): bool = not(b.closing)
pure def beginStop(b: Boot): Boot = { ...b, closing: true }
pure def canDisposeRuntime(b: Boot): bool = b.closing and not(b.closed) and b.tasks.size() == 0
pure def disposeRuntime(b: Boot): Boot = { ...b, closed: true, disposed: b.disposed + 1 }
pure def canFailTeardown(b: Boot): bool = b.closing and not(b.closed)
pure def failTeardown(b: Boot): Boot = { ...b, failed: true }
pure def alwaysDisposedOnceWhenClosed(b: Boot): bool =
  b.disposed == (if (b.closed) 1 else 0) and (b.closed implies b.closing and b.tasks.size() == 0)
pure def sometimesDisposedAfterFailedTeardown(b: Boot): bool = b.closed and b.failed
```
