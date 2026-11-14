# Reminder occurrence, completion, and snooze

AlphaPhone consumes the browser-safe
`plugins/plugin-native-reminders/src/occurrence.ts` at its Eliza pin
`c518127a025ab173874af9c7d304f26b25213b0d`. Its Android equivalent is the
native reminder store. [Request custody](./reminderCustody.md) owns
revision-bound writes and recovery.

## Story: Complete or snooze the current reminder occurrence

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
