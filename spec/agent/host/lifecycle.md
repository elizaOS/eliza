# Start, restart, stop and reset

The host's lifecycle routes start, restart, pause, resume, stop and reset
the one live runtime. A restart keeps serving the old runtime while the
replacement builds; only when the replacement is ready does the host close
admission, wait for the turns already admitted and publish the replacement.
A stop is refused while a boot is in progress. Booting one runtime is in
[boot and teardown](./boot.md).

## Story: Restart without dropping the conversation

> As the owner, I restart my agent and keep talking to it: the old runtime
> answers until the new one is ready, and no turn is cut off by the swap.

### The host runs at most one runtime, and each runtime it built is closed once

```quint
type Phase = NotStarted | Starting | Live | Paused | Restarting | Stopped | Failed
type Lifecycle = { phase: Phase, runtime: bool, boot: bool, stopping: bool, active: int, cordoned: bool, built: int, closed: int, vaultKeys: bool, configSaved: bool, reloadPublished: bool, pendingReload: bool }
pure val initial: Lifecycle = { phase: NotStarted, runtime: false, boot: false, stopping: false, active: 0, cordoned: false, built: 0, closed: 0, vaultKeys: false, configSaved: false, reloadPublished: false, pendingReload: false }
pure def alwaysOneRuntimeClosedOnce(l: Lifecycle): bool =
  l.closed >= 0 and l.built - l.closed == (if (l.runtime) 1 else 0)
pure def alwaysLiveOrRestartingHasRuntime(l: Lifecycle): bool =
  ((l.phase == Live or l.phase == Restarting or l.phase == Paused) implies l.runtime) and
  (l.boot implies (l.phase == Starting or l.phase == Restarting)) and
  (l.stopping implies l.runtime and not(l.boot))
```

### Start begins one boot when no runtime exists

A repeated start during a boot or restart reports the pending phase and
starts nothing. A first boot runs only while no runtime exists, and a failed
first boot leaves no runtime.

```quint
pure def canStart(l: Lifecycle): bool = not(l.runtime) and not(l.boot) and not(l.stopping)
pure def start(l: Lifecycle): Lifecycle = { ...l, phase: Starting, boot: true }
pure def canBootSucceeded(l: Lifecycle): bool = l.phase == Starting and l.boot
pure def bootSucceeded(l: Lifecycle): Lifecycle = { ...l, runtime: true, boot: false, phase: Live, built: l.built + 1 }
pure def canBootFailed(l: Lifecycle): bool = l.phase == Starting and l.boot
pure def bootFailed(l: Lifecycle): Lifecycle = { ...l, boot: false, phase: Failed }
pure def alwaysFirstBootHasNoRuntime(l: Lifecycle): bool = l.phase == Starting implies not(l.runtime)
pure def sometimesFailedFirstBoot(l: Lifecycle): bool = l.phase == Failed and not(l.runtime)
```

### Restart keeps serving the old runtime until the replacement is ready

A replacement that fails to build before admission closes leaves the old
runtime running. While a restart is in progress the old runtime is never
closed except by publishing the replacement.

```quint
pure def canRestart(l: Lifecycle): bool = l.runtime and l.phase == Live and not(l.boot) and not(l.stopping)
pure def restart(l: Lifecycle): Lifecycle = { ...l, phase: Restarting, boot: true }
pure def canRestartFailed(l: Lifecycle): bool = l.phase == Restarting and not(l.cordoned)
pure def restartFailed(l: Lifecycle): Lifecycle = { ...l, phase: Live, boot: false }
pure def canEnterTurn(l: Lifecycle): bool = l.runtime and (l.phase == Live or l.phase == Restarting) and not(l.cordoned) and not(l.stopping)
pure def enterTurn(l: Lifecycle): Lifecycle = { ...l, active: l.active + 1 }
pure def canExitTurn(l: Lifecycle): bool = l.active > 0
pure def exitTurn(l: Lifecycle): Lifecycle = { ...l, active: l.active - 1 }
pure def stepOldRuntimeServesUntilReplaced(before: Lifecycle, via: str, after: Lifecycle): bool =
  before.phase == Restarting implies (after.closed == before.closed or via == "replace") and (via == "restartFailed" implies after.runtime and after.built == before.built)
pure def sometimesOldRuntimeServesDuringRestart(l: Lifecycle): bool = l.phase == Restarting and l.active > 0
```

### A restart in progress is a boot in progress

A restart holds the boot until it publishes the replacement or fails, so a
stop or reset, which a boot refuses, never closes the old runtime before the
replacement is published.

```quint
pure def alwaysRestartIsABoot(l: Lifecycle): bool = l.phase == Restarting implies l.boot
```

### The replacement is published only after admission closed and admitted turns drained

```quint
pure def canCordon(l: Lifecycle): bool = l.runtime and l.phase == Restarting and l.boot and not(l.stopping) and not(l.cordoned)
pure def cordon(l: Lifecycle): Lifecycle = { ...l, cordoned: true }
pure def canReplace(l: Lifecycle): bool = l.cordoned and l.phase == Restarting and l.boot and not(l.stopping) and l.active == 0
pure def replace(l: Lifecycle): Lifecycle =
  { ...l, cordoned: false, phase: Live, boot: false, built: l.built + 1, closed: l.closed + 1, reloadPublished: l.configSaved, pendingReload: false }
pure def alwaysCordonOnlyDuringRestart(l: Lifecycle): bool = l.cordoned implies (l.phase == Restarting or l.stopping)
pure def stepReplacementAfterDrain(before: Lifecycle, via: str, after: Lifecycle): bool =
  via == "replace" implies before.cordoned and before.active == 0
pure def sometimesReplaced(l: Lifecycle): bool = l.built >= 2 and l.phase == Live
```

### A configuration change during the first boot is applied by the next restart

The change is saved at once; the boot in progress keeps its owner, and the
restart that follows publishes it.

```quint
pure def canSaveConfigDuringBoot(l: Lifecycle): bool = l.phase == Starting and l.boot and not(l.configSaved)
pure def saveConfigDuringBoot(l: Lifecycle): Lifecycle = { ...l, configSaved: true, reloadPublished: false, pendingReload: true }
pure def alwaysSavedConfigIsPendingOrPublished(l: Lifecycle): bool = (l.configSaved and not(l.reloadPublished)) implies l.pendingReload
pure def sometimesDeferredConfigPublished(l: Lifecycle): bool = l.configSaved and l.reloadPublished
```

## Story: Pause, stop and reset

> As the owner, I pause and resume my agent, stop it without cutting off a
> reply, and reset it so that nothing of the old runtime's secrets remains.

### Pause and resume need a live runtime that is not booting or stopping

Only a pause enters the paused phase, from a live runtime, and only a resume
returns from it to live.

```quint
pure def canPause(l: Lifecycle): bool = l.runtime and l.phase == Live and not(l.boot) and not(l.stopping)
pure def pause(l: Lifecycle): Lifecycle = { ...l, phase: Paused }
pure def canResume(l: Lifecycle): bool = l.runtime and l.phase == Paused and not(l.boot) and not(l.stopping) and not(l.cordoned)
pure def resume(l: Lifecycle): Lifecycle = { ...l, phase: Live }
pure def stepPauseOnlyFromLiveAndResumeOnlyFromPaused(before: Lifecycle, via: str, after: Lifecycle): bool =
  ((after.phase == Paused and before.phase != Paused) implies (via == "pause" and before.phase == Live and before.runtime)) and
    ((before.phase == Paused and after.phase == Live) implies via == "resume")
pure def sometimesPaused(l: Lifecycle): bool = l.phase == Paused
```

### Stop is refused during a boot, closes admission and waits for admitted turns

A stop of a running runtime closes admission at once; while it stops no turn
is admitted, and it settles only when no admitted turn is left.

```quint
pure def canStop(l: Lifecycle): bool = l.phase != Starting and l.phase != Restarting and not(l.stopping)
pure def stop(l: Lifecycle): Lifecycle = if (l.runtime) { ...l, stopping: true, cordoned: true } else { ...l, phase: Stopped }
pure def canStopSettled(l: Lifecycle): bool = l.stopping and l.active == 0
pure def stopSettled(l: Lifecycle): Lifecycle = { ...l, stopping: false, runtime: false, phase: Stopped, cordoned: false, closed: l.closed + 1 }
pure def stepStopClosesAdmissionAndWaitsForTurns(before: Lifecycle, via: str, after: Lifecycle): bool =
  (via == "stop" implies (before.phase != Starting and before.phase != Restarting and (before.runtime implies after.cordoned))) and
    (via == "stopSettled" implies before.active == 0) and
    (before.stopping implies after.active <= before.active)
pure def sometimesStoppedThenStartedAgain(l: Lifecycle): bool = l.phase == Live and l.closed >= 1 and l.built >= 2
```

### The live runtime keeps vault keys, and a reset clears them

```quint
pure def canStoreVaultKey(l: Lifecycle): bool = l.runtime and not(l.stopping)
pure def storeVaultKey(l: Lifecycle): Lifecycle = { ...l, vaultKeys: true }
pure def canReset(l: Lifecycle): bool = not(l.boot) and not(l.stopping) and l.active == 0
pure def reset(l: Lifecycle): Lifecycle =
  { ...l, phase: NotStarted, runtime: false, cordoned: false, vaultKeys: false, closed: if (l.runtime) l.closed + 1 else l.closed }
pure def stepResetClearsVaultKeys(before: Lifecycle, via: str, after: Lifecycle): bool = via == "reset" implies not(after.vaultKeys)
pure def sometimesResetAfterARuntime(l: Lifecycle): bool = l.phase == NotStarted and l.built > 0 and not(l.vaultKeys)
```
