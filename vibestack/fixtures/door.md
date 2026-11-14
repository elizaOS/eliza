# Door

## Domain

### Door

```quint
type Mode = Open | Closed | Locked
type Door = { mode: Mode, opened: int, alarm: bool }
pure val initial: Door = { mode: Closed, opened: 0, alarm: false }
```

## Story: Use the door

### Anyone can switch the alarm at any time

```quint
pure def setAlarm(d: Door, on: bool): Door = { ...d, alarm: on }
```

### A locked door must be unlocked before it opens

```quint
pure def canMove(d: Door, target: Mode): bool = d.mode != target and not(d.mode == Locked and target == Open)
pure def move(d: Door, target: Mode): Door =
  { ...d, mode: target, opened: if (target == Open) d.opened + 1 else d.opened }
pure def alwaysCountsOpenings(d: Door): bool = d.opened - (0 - 1) > 0 and (d.mode == Open implies d.opened > 0)
pure def sometimesLocked(d: Door): bool = d.mode == Locked and d.alarm
```
