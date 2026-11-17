# Reminder occurrence, completion, snooze and alarms

A consumer uses Eliza's browser-safe
`plugins/plugin-native-reminders/src/occurrence.ts`. Its Android
equivalent is the native reminder store. The agent's
[device action custody](../../agent/deviceActions/execution.md) owns
revision-bound writes and recovery.

## Story: Complete or snooze the current reminder occurrence

> As the person, I want Done to finish the reminder in front of me and
> Snooze to only move its alert, so that a repeating reminder never skips
> or loses an occurrence.

### Done owns recurrence advancement and snooze owns only the alert

Admit a safely represented clock and an active, dated row. Done requires
the current nonempty occurrence ID. It records the completed occurrence,
due instant, completion instant, and skipped count. Keep the newest 32.
A one-off row stays completed. A repeat advances only on Done and
replaces the occurrence identity, clearing its old completion, posting,
and snooze markers. Its new alert is strictly after now. A no-alert repeat
is pending. Other repeats retain the observed notification status.
Snooze rejects undated, inactive and no-alert rows and leaves an already
snoozed scheduled alert unchanged. A new snooze sets the alert ten minutes
after the supplied time, preserves the occurrence and due time, and uses
the observed notification permission. The current row and receipt are
validated against the owning storage revision before commit.

The port resolves the saved date, wall time and IANA zone. It uses the
earlier overlap, refuses an initial gap, and shifts a future gap to its
first valid local time. The first weekday repeat requires a weekday.
Lead is zero to 10,080 minutes. The first alert equals due minus lead.
For a next occurrence, select the first later eligible civil date whose
alert is strictly after now, counting skipped dates up to 40,000 steps.
The core workflow clock owns separate workflow recurrence semantics.

```quint
type ReminderDelivery = DeliveryScheduled | DeliveryDenied | NoReminderDelivery | ReminderCompleted
type ActiveOccurrence = { active: bool, repeated: bool, noAlert: bool, due: int, alert: int, occurrence: int, snoozed: bool, delivery: ReminderDelivery, historyCount: int }
pure val initial: ActiveOccurrence = { active: true, repeated: true, noAlert: false, due: 1000, alert: 900, occurrence: 1, snoozed: false, delivery: DeliveryScheduled, historyCount: 0 }
pure def canSetReminderKind(r: ActiveOccurrence): bool = r.active and r.occurrence == 1 and r.historyCount == 0 and not(r.snoozed)
pure def setReminderKind(r: ActiveOccurrence, repeated: bool, noAlert: bool): ActiveOccurrence =
  { ...r, repeated: repeated, noAlert: noAlert, delivery: if (noAlert) NoReminderDelivery else DeliveryScheduled }
pure def canCompleteOccurrence(r: ActiveOccurrence, now: int, nextDue: int, nextAlert: int, nextId: int): bool =
  r.active and r.occurrence > 0 and (not(r.repeated) or (nextId > r.occurrence and nextAlert > now and nextDue >= nextAlert))
pure def completeOccurrence(r: ActiveOccurrence, now: int, nextDue: int, nextAlert: int, nextId: int, alertsAllowed: bool): ActiveOccurrence = {
  val count = if (r.historyCount == 32) 32 else r.historyCount + 1
  if (r.repeated) { ...r, due: nextDue, alert: nextAlert, occurrence: nextId, snoozed: false, historyCount: count,
    delivery: if (r.noAlert) NoReminderDelivery else if (alertsAllowed) DeliveryScheduled else DeliveryDenied }
  else { ...r, active: false, delivery: ReminderCompleted, historyCount: count }
}
pure def canSnoozeOccurrence(r: ActiveOccurrence): bool =
  r.active and not(r.noAlert) and not(r.delivery == DeliveryScheduled and r.snoozed)
pure def snoozeOccurrence(r: ActiveOccurrence, now: int, alertsAllowed: bool): ActiveOccurrence =
  { ...r, alert: now + 600000, snoozed: true, delivery: if (alertsAllowed) DeliveryScheduled else DeliveryDenied }
pure val nowValues = Set(1, 1000)
pure val nextDueValues = Set(0, 2000)
pure val nextAlertValues = Set(0, 1900)
pure val nextIdValues = Set(1, 2, 3)
pure def alwaysOccurrenceHistoryBound(r: ActiveOccurrence): bool = r.historyCount >= 0 and r.historyCount <= 32
pure def alwaysInactiveReminderCompleted(r: ActiveOccurrence): bool = r.active == (r.delivery != ReminderCompleted)
pure def alwaysNoAlertHasNoDelivery(r: ActiveOccurrence): bool = r.active and r.noAlert implies r.delivery == NoReminderDelivery
pure def stepOnlyDoneCanAdvanceOccurrence(before: ActiveOccurrence, via: str, after: ActiveOccurrence): bool =
  after.occurrence != before.occurrence implies via == "completeOccurrence" and after.occurrence > before.occurrence
pure def stepSnoozeKeepsDueDate(before: ActiveOccurrence, via: str, after: ActiveOccurrence): bool =
  via == "snoozeOccurrence" implies after.due == before.due and after.historyCount == before.historyCount
pure def sometimesRepeatedReminderAdvances(r: ActiveOccurrence): bool = r.occurrence > 1
pure def sometimesCompletedOneOff(r: ActiveOccurrence): bool = r.delivery == ReminderCompleted
pure def sometimesSnoozed(r: ActiveOccurrence): bool = r.snoozed
```

## Story: Ring the reminder on time when the device allows exact alarms

> As the person, I want a reminder to ring at its exact time when the
> device lets the app schedule exact alarms, and close to it otherwise,
> without being asked for that permission by the reminder itself.

### An exact alarm needs the capability at check and at arm, and the store never asks for it

Arming happens
under the store lock. The store checks the exact-alarm capability, and
the capability can be withdrawn before the Android call; an exact alarm
is armed only when it was held at both points, otherwise the alarm is
inexact. The store never requests the capability. The notification uses
the host's icon, or the fixed fallback icon when the host supplies none,
and the installed alarm identity is fixed.

```quint
type AlarmKind = ExactAlarm | InexactAlarm
type AlarmArm = { kind: AlarmKind, permissionRequests: int, icon: int }
pure val fallbackReminderIcon = 2
pure def armReminderAlarm(heldAtCheck: bool, heldAtArm: bool, hostIcon: int): AlarmArm =
  { kind: if (heldAtCheck and heldAtArm) ExactAlarm else InexactAlarm, permissionRequests: 0,
    icon: if (hostIcon == 0) fallbackReminderIcon else hostIcon }
pure val hostIconValues = Set(0, 1)
pure def lawExactAlarmNeedsCapabilityThroughout(heldAtCheck: bool, heldAtArm: bool, hostIcon: int): bool =
  armReminderAlarm(heldAtCheck, heldAtArm, hostIcon).kind == ExactAlarm implies heldAtCheck and heldAtArm
pure def lawReminderNeverRequestsAlarmCapability(heldAtCheck: bool, heldAtArm: bool, hostIcon: int): bool =
  armReminderAlarm(heldAtCheck, heldAtArm, hostIcon).permissionRequests == 0
pure def lawReminderIconFallsBack(heldAtCheck: bool, heldAtArm: bool): bool =
  armReminderAlarm(heldAtCheck, heldAtArm, 0).icon == fallbackReminderIcon
```

## Story: Get my reminders back after the phone restarts or the app is stopped

> As the person, I want a reminder I scheduled to still ring, and a
> reminder notice I had not handled to come back, after the phone restarts
> or the app's process is stopped, without anything being skipped or
> repeated.

### Recovery re-arms scheduled reminders and re-posts unhandled notices once per boot without advancing any occurrence

Recovery runs when the device finishes booting, when the app is
replaced, when the time or time zone changes, and when the reminder
plugin loads. Android drops alarms and notifications at a reboot. Each
record is recovered on its own, so a damaged record or a failed alarm
does not stop the others. A scheduled record's alarm is armed again. A
posted record's notice is posted again, with the same occurrence, target
and tap route, only once per boot: a boot marker records the boot
recovered, and it advances only when every posted notice was re-posted,
so a notice that could not be posted is retried at the next recovery. A
record whose alarm permission was denied waits for an explicit
reschedule, and a record whose deletion is pending loses its alarm and
notice. Recovery never advances a recurrence or changes an occurrence.

```quint
type StoredStatus = StoredScheduled | StoredPosted | StoredPermissionDenied | StoredDeletionPending
type StoredReminder = { keptStatus: StoredStatus, armed: bool, noticeShown: bool, storedOccurrence: int }
pure def afterReboot(kept: StoredReminder): StoredReminder = { ...kept, armed: false, noticeShown: false }
pure def restoreReminder(kept: StoredReminder, newBoot: bool, notifyAllowed: bool): StoredReminder =
  if (kept.keptStatus == StoredDeletionPending) { ...kept, armed: false, noticeShown: false }
  else if (kept.keptStatus == StoredScheduled) { ...kept, armed: true }
  else if (kept.keptStatus == StoredPosted and newBoot and notifyAllowed) { ...kept, noticeShown: true }
  else kept
pure def bootMarkerAdvances(newBoot: bool, postedPending: bool, repostFailed: bool): bool =
  newBoot and (not(repostFailed) or not(postedPending))
pure val keptValues = Set(
  { keptStatus: StoredScheduled, armed: true, noticeShown: false, storedOccurrence: 1 },
  { keptStatus: StoredPosted, armed: false, noticeShown: true, storedOccurrence: 2 },
  { keptStatus: StoredPermissionDenied, armed: false, noticeShown: false, storedOccurrence: 1 },
  { keptStatus: StoredDeletionPending, armed: true, noticeShown: true, storedOccurrence: 3 }
)
pure def lawRecoveryNeverAdvancesOccurrence(kept: StoredReminder, newBoot: bool, notifyAllowed: bool): bool =
  restoreReminder(kept, newBoot, notifyAllowed).storedOccurrence == kept.storedOccurrence and
  restoreReminder(kept, newBoot, notifyAllowed).keptStatus == kept.keptStatus
pure def lawScheduledReminderRingsAfterReboot(kept: StoredReminder, notifyAllowed: bool): bool =
  kept.keptStatus == StoredScheduled implies restoreReminder(afterReboot(kept), true, notifyAllowed).armed
pure def lawPostedNoticeReturnsAfterReboot(kept: StoredReminder): bool =
  kept.keptStatus == StoredPosted implies restoreReminder(afterReboot(kept), true, true).noticeShown
pure def lawNoRepostWithinABoot(kept: StoredReminder, notifyAllowed: bool): bool =
  kept.keptStatus != StoredDeletionPending implies restoreReminder(kept, false, notifyAllowed).noticeShown == kept.noticeShown
pure def lawFailedRepostIsRetried(repostFailed: bool): bool =
  repostFailed implies not(bootMarkerAdvances(true, true, repostFailed))
pure def lawDeniedReminderWaitsForReschedule(kept: StoredReminder, newBoot: bool, notifyAllowed: bool): bool =
  kept.keptStatus == StoredPermissionDenied implies restoreReminder(kept, newBoot, notifyAllowed) == kept
```
