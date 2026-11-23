# Native background tasks

iOS BGTaskScheduler owns actual firing time. The bridge supplies the owner-visible schedule, cancellation and wake outcomes. Its web fallback advertises unsupported.

## Story: Schedule a background wake without stacking duplicate requests

> As an iOS host, I want the pending refresh and optional processing work to be replaceable and cancellable, so retrying setup does not multiply wake requests.

### Refresh and processing have separate pending slots

The earliest threshold is a positive delay, not a promised wake time. Scheduling replaces the refresh slot and, when requested, replaces the processing slot. Cancellation retires both.

```quint
type WakeKind = RefreshWake | ProcessingWake | RemotePushWake
type TaskSchedule = { refreshAt: int, processingAt: int, lastFiredAt: int, hasFired: bool }
pure val initial: TaskSchedule = { refreshAt: 0, processingAt: 0, lastFiredAt: 0, hasFired: false }
pure def canScheduleNext(s: TaskSchedule, nowMs: int, delayMs: int, platformAccepted: bool): bool =
  nowMs >= 0 and delayMs >= 1000 and platformAccepted
pure def scheduleNext(s: TaskSchedule, nowMs: int, delayMs: int, platformAccepted: bool, alsoProcessing: bool): TaskSchedule =
  { ...s, refreshAt: nowMs + delayMs, processingAt: if (alsoProcessing) nowMs + delayMs else s.processingAt }
pure def canCancelWakes(s: TaskSchedule): bool = s.refreshAt != 0 or s.processingAt != 0
pure def cancelWakes(s: TaskSchedule): TaskSchedule = { ...s, refreshAt: 0, processingAt: 0 }
pure def alwaysTaskTimesAreNonnegative(s: TaskSchedule): bool =
  s.refreshAt >= 0 and s.processingAt >= 0 and s.lastFiredAt >= 0
pure val delayMsValues = Set(0, 1000, 30000)
```

### A platform wake consumes its slot and a remote push needs host opt-in

Wake delivery is a trusted OS observation. Refresh and processing need an outstanding slot. A remote push needs the host APNs capability. Older callbacks cannot replace a later last-wake result.

```quint
pure def canRecordWake(s: TaskSchedule, kind: WakeKind, nowMs: int, remotePushEnabled: bool): bool =
  nowMs >= s.lastFiredAt and (
    (kind == RefreshWake and s.refreshAt > 0 and nowMs >= s.refreshAt) or
    (kind == ProcessingWake and s.processingAt > 0 and nowMs >= s.processingAt) or
    (kind == RemotePushWake and remotePushEnabled))
pure def recordWake(s: TaskSchedule, kind: WakeKind, nowMs: int, remotePushEnabled: bool): TaskSchedule = {
  refreshAt: if (kind == RefreshWake) 0 else s.refreshAt,
  processingAt: if (kind == ProcessingWake) 0 else s.processingAt,
  lastFiredAt: nowMs, hasFired: true
}
pure def stepWakeTimestampNeverMovesBack(before: TaskSchedule, after: TaskSchedule): bool =
  before.lastFiredAt <= after.lastFiredAt
pure def sometimesWakeObserved(s: TaskSchedule): bool = s.hasFired
pure val nowMsValues = Set(0, 1000, 30000, 60000)
```
