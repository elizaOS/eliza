# Missed occurrence window

The window after which a scheduled occurrence is recorded as missed rather
than run, from `isMissedScheduledOccurrence` and
`SCHEDULED_OCCURRENCE_WINDOW_MS` in `packages/core/src/services/trigger-scheduling.vibe`. The
agent's prompt triggers and scheduled tasks, and every plugin schedule, use
this window; [scheduling](./scheduling.md) runs the occurrences.

## Story: Record a late occurrence as missed

> As a host, I want an occurrence that comes due far too late to be recorded
> as missed rather than run, so that a stopped agent or a stalled clock never
> runs a stale schedule.

### An occurrence more than thirty minutes past its scheduled instant is missed, and stays missed

```quint
pure val missedWindowMs: int = 1800000
pure def missedOccurrence(scheduledAt: int, now: int): bool = now - scheduledAt > missedWindowMs
pure def lawAMissedOccurrenceStaysMissed(scheduledAt: int, now: int, later: int): bool =
  missedOccurrence(scheduledAt, now) and later >= now implies missedOccurrence(scheduledAt, later)
```
