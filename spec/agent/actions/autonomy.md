# Autonomy and the global pause

Autonomy lets the agent think and act between conversations, on a loop
with a positive interval. The loop runs only while autonomy is enabled;
disabling or stopping it removes the loop, and changing the interval
registers the loop again with the new one. The global pause is the owner's
vacation switch: one pause window at a time, ending strictly after it
starts or left open. While a window is active, scheduled work that respects
the pause is skipped and rescheduled for the window's end; work that does
not respect it, such as an emergency, runs anyway. The research baseline is
`plugins/plugin-assistant` `features/autonomy/service.ts` and
`services/global-pause/{service,store}.ts`. The scheduler that consults the
pause is in [scheduled tasks](../scheduledTasks.md).

## Story: Let the agent act on its own, within the owner's control

> As the owner, I turn my agent's own initiative on and off and set how
> often it thinks; when it is off, it does nothing on its own.

### The autonomy loop runs exactly while autonomy is enabled, with a positive interval

```quint
type FireOutcome = NotFired | Fired | SkippedForPause
type Autonomy = { autonomous: bool, loopRegistered: bool, interval: int, registrations: int, paused: bool, pauseStart: int, pauseEnd: int, now: int, lastFire: FireOutcome, lastRespectsPause: bool, rescheduledTo: int }
pure val initial: Autonomy = { autonomous: false, loopRegistered: false, interval: 30, registrations: 0, paused: false, pauseStart: 0, pauseEnd: -1, now: 0, lastFire: NotFired, lastRespectsPause: false, rescheduledTo: -1 }
pure val intervalValues = Set(-1, 0, 10, 60)
pure def canEnableAutonomy(a: Autonomy): bool = not(a.autonomous)
pure def enableAutonomy(a: Autonomy): Autonomy = { ...a, autonomous: true, loopRegistered: true, registrations: a.registrations + 1 }
pure def canDisableAutonomy(a: Autonomy): bool = a.autonomous
pure def disableAutonomy(a: Autonomy): Autonomy = { ...a, autonomous: false, loopRegistered: false }
pure def canSetInterval(a: Autonomy, interval: int): bool = interval > 0 and interval != a.interval
pure def setInterval(a: Autonomy, interval: int): Autonomy =
  { ...a, interval: interval, registrations: if (a.loopRegistered) a.registrations + 1 else a.registrations }
pure def alwaysLoopFollowsSwitch(a: Autonomy): bool = a.loopRegistered == a.autonomous and a.interval > 0
pure def sometimesLoopReRegistered(a: Autonomy): bool = a.loopRegistered and a.registrations >= 2
```

## Story: Pause scheduled work while the owner is away

> As the owner, I pause my agent's routines while I am on holiday; it stays
> quiet until I come back, except for what must not wait.

### One pause window at a time, ending strictly after it starts or left open

```quint
pure val opensAtValues = Set(0, 10)
pure val closesAtValues = Set(-1, 5, 20)
pure def canSetPause(a: Autonomy, opensAt: int, closesAt: int): bool = opensAt >= 0 and (closesAt == -1 or closesAt > opensAt)
pure def setPause(a: Autonomy, opensAt: int, closesAt: int): Autonomy = { ...a, paused: true, pauseStart: opensAt, pauseEnd: closesAt }
pure def canClearPause(a: Autonomy): bool = a.paused
pure def clearPause(a: Autonomy): Autonomy = { ...a, paused: false, pauseStart: 0, pauseEnd: -1 }
pure def alwaysPauseWindowWellFormed(a: Autonomy): bool = a.paused implies a.pauseStart >= 0 and (a.pauseEnd == -1 or a.pauseEnd > a.pauseStart)
```

### Work that respects the pause is skipped while a window is active and rescheduled for its end; other work runs

```quint
pure def pauseActive(a: Autonomy): bool = a.paused and a.now >= a.pauseStart and (a.pauseEnd == -1 or a.now < a.pauseEnd)
pure def passTime(a: Autonomy): Autonomy = { ...a, now: a.now + 10 }
pure def fireTask(a: Autonomy, respectsPause: bool): Autonomy = {
  val skip = respectsPause and pauseActive(a)
  { ...a, lastFire: if (skip) SkippedForPause else Fired, lastRespectsPause: respectsPause, rescheduledTo: if (skip) a.pauseEnd else -1 }
}
pure def stepPauseDecidesFiring(before: Autonomy, via: str, after: Autonomy): bool =
  via == "fireTask" implies
    (after.lastFire == (if (after.lastRespectsPause and pauseActive(before)) SkippedForPause else Fired)) and
    (after.lastFire == SkippedForPause implies after.rescheduledTo == before.pauseEnd)
pure def sometimesSkippedForPause(a: Autonomy): bool = a.lastFire == SkippedForPause and a.rescheduledTo > 0
pure def sometimesEmergencyRanDuringPause(a: Autonomy): bool = a.lastFire == Fired and not(a.lastRespectsPause) and pauseActive(a)
```
