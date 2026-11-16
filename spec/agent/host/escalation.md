# Escalation

When something needs the owner's attention, the host escalates: it sends a
notice, and if no one acknowledges it the escalation moves up a level on a
timer and sends again. One escalation runs per agent at a time, the levels
and resends are bounded, and the resolution is recorded before its timer is
cancelled, so a restart never re-escalates what was already resolved.
Shutting down cancels the timer but keeps an unresolved escalation for the
next run.

## Story: Get the owner's attention without nagging

> As the owner, when my agent needs me it tells me, then tells me more
> insistently up to a limit, and stops as soon as I answer.

### One escalation runs per agent at a time

```quint
type Escalation = { active: bool, timer: bool, level: int, delivered: int, stopped: bool, resolved: bool, started: int }
pure val maxLevel = 2
pure val maxDeliveries = 2
pure val initial: Escalation = { active: false, timer: false, level: 0, delivered: 0, stopped: false, resolved: false, started: 0 }
pure def canStartEscalation(e: Escalation): bool = not(e.stopped) and not(e.active)
pure def startEscalation(e: Escalation): Escalation = { ...e, active: true, timer: true, level: 0, delivered: 0, resolved: false, started: e.started + 1 }
pure def stepNoSecondEscalationWhileActive(before: Escalation, after: Escalation): bool = before.active implies after.started == before.started
```

### Levels and resends are bounded

```quint
pure def canSendNotice(e: Escalation): bool = e.active and not(e.stopped) and e.delivered < maxDeliveries
pure def sendNotice(e: Escalation): Escalation = { ...e, delivered: e.delivered + 1 }
pure def canRaiseLevel(e: Escalation): bool = e.active and e.timer and not(e.stopped) and e.level < maxLevel
pure def raiseLevel(e: Escalation): Escalation = { ...e, level: e.level + 1 }
pure def alwaysEscalationBounded(e: Escalation): bool = e.level >= 0 and e.level <= maxLevel and e.delivered >= 0 and e.delivered <= maxDeliveries
pure def sometimesTopLevelReached(e: Escalation): bool = e.level == maxLevel and e.delivered == maxDeliveries
```

### A resolution is recorded before its timer is cancelled

The two happen in one durable step, so no state has the timer cancelled
while the escalation is still unresolved and active.

```quint
pure def canResolve(e: Escalation): bool = e.active
pure def resolve(e: Escalation): Escalation = { ...e, resolved: true, active: false, timer: false }
pure def alwaysTimerOnlyForLiveEscalation(e: Escalation): bool =
  (e.timer implies e.active and not(e.stopped)) and (e.resolved implies not(e.active) and not(e.timer))
pure def sometimesResolved(e: Escalation): bool = e.resolved and e.delivered > 0
```

### Shutdown cancels the timer and keeps an unresolved escalation

```quint
pure def canShutDown(e: Escalation): bool = not(e.stopped)
pure def shutDown(e: Escalation): Escalation = { ...e, stopped: true, timer: false }
pure def sometimesUnresolvedKeptAtShutdown(e: Escalation): bool = e.stopped and e.active and not(e.resolved)
```
