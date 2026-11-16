# Proactive messages

The agent may start a conversation on its own: a check-in, a reminder of
something it noticed. A gate decides. It admits a message only while
proactive messages are on, after the owner's active surface has settled,
outside the cool-down after the last one, below the daily cap and when the
message is not a repeat of the last one on that surface.

## Story: Speak up without becoming a nuisance

> As the owner, my agent reaches out on the device I am using, at most
> twice a day, never repeating itself before the cool-down is over.

### A message is admitted only on the settled active surface, outside the cool-down and below the daily cap

Asking whether a message would be admitted is the same check and records
nothing; only sending it is recorded.

```quint
type Proactive = { on: bool, surface: int, surfaceSettled: bool, coolingDown: bool, sentToday: int, lastText: int, lastSurface: int }
pure val dailyCap = 2
pure val initial: Proactive = { on: false, surface: 0, surfaceSettled: true, coolingDown: false, sentToday: 0, lastText: 0, lastSurface: 0 }
pure val surfaceValues = Set(1, 2)
pure val textValues = Set(1, 2)
pure def canEmit(p: Proactive, surface: int, text: int): bool =
  p.on and p.surfaceSettled and not(p.coolingDown) and p.sentToday < dailyCap and surface == p.surface and surface > 0 and text > 0 and
  not(p.lastText == text and p.lastSurface == surface)
pure def wouldAdmit(p: Proactive, surface: int, text: int): bool = canEmit(p, surface, text)
pure def emit(p: Proactive, surface: int, text: int): Proactive = { ...p, sentToday: p.sentToday + 1, coolingDown: true, lastText: text, lastSurface: surface }
pure def alwaysWithinDailyCap(p: Proactive): bool = p.sentToday >= 0 and p.sentToday <= dailyCap
pure def sometimesCapReached(p: Proactive): bool = p.sentToday == dailyCap
```

### Switching surface waits for the new surface to settle

```quint
pure def canSetOn(p: Proactive, active: bool): bool = p.on != active
pure def setOn(p: Proactive, active: bool): Proactive = { ...p, on: active }
pure def canSwitchSurface(p: Proactive, surface: int): bool = surface > 0 and surface != p.surface
pure def switchSurface(p: Proactive, surface: int): Proactive = { ...p, surface: surface, surfaceSettled: false }
pure def canSettleSurface(p: Proactive): bool = not(p.surfaceSettled)
pure def settleSurface(p: Proactive): Proactive = { ...p, surfaceSettled: true }
pure def stepNoMessageWhileSurfaceSettles(before: Proactive, after: Proactive): bool =
  after.sentToday > before.sentToday implies before.surfaceSettled
pure def sometimesSentOnSecondSurface(p: Proactive): bool = p.sentToday > 0 and p.lastSurface == 2
```

### The cool-down and the daily count reset only with time

The end of the cool-down also forgets the last message, so it may be sent
again later.

```quint
pure def canCoolDownEnds(p: Proactive): bool = p.coolingDown
pure def coolDownEnds(p: Proactive): Proactive = { ...p, coolingDown: false, lastText: 0 }
pure def canNewDay(p: Proactive): bool = p.sentToday > 0
pure def newDay(p: Proactive): Proactive = { ...p, sentToday: 0 }
pure def stepCountResetsOnlyOnNewDay(before: Proactive, via: str, after: Proactive): bool =
  after.sentToday < before.sentToday implies via == "newDay"
```
