# Autonomy

Autonomy lets the agent think and act between conversations, on a loop
with a positive interval. The loop runs only while autonomy is enabled;
disabling or stopping it removes the loop, and changing the interval
registers the loop again with the new one. The owner's global pause of
scheduled work is in [scheduled tasks](../scheduledTasks.md).

## Story: Let the agent act on its own, within the owner's control

> As the owner, I turn my agent's own initiative on and off and set how
> often it thinks; when it is off, it does nothing on its own.

### The autonomy loop runs exactly while autonomy is enabled, with a positive interval

```quint
type Autonomy = { autonomous: bool, loopRegistered: bool, interval: int, registrations: int }
pure val initial: Autonomy = { autonomous: false, loopRegistered: false, interval: 30, registrations: 0 }
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
