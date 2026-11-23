# Native reminders

The package exposes Apple Reminders, an Android [scheduling and alarm](../os/android/reminderAlarms.md) adapter, and a shared occurrence decision boundary. OS calendars and time zones are effect inputs to those decisions.

## Story: Complete or snooze the exact reminder occurrence I chose

> As the owner, I want repeats to advance to the next valid civil occurrence and an undated task to stay separate from the alarm schedule.

### Review binds the occurrence, and an unavailable next due time cannot silently schedule

A civil-time adapter reports an exact due time, the earlier instant in an overlap, or the first valid instant following a recurrence gap. A new repeat at a nonexistent civil time is refused. One-off completion ends the reminder; repeat completion keeps the next future occurrence and bounded history.

```quint
type ReminderKind = UndatedReminder | SingleReminder | RepeatingReminder
type ReviewedOccurrence = { reminderId: str, occurrenceId: str, revision: int }
type DueResolution = NativeDueAt({ dueAt: int }) | NonexistentCivilTime | NoNextDue
type ReminderDecision = ReminderComplete | ReminderNextAt({ nextAt: int }) | ReminderRefused
pure def completeNativeReminder(reviewed: ReviewedOccurrence, active: ReviewedOccurrence, kind: ReminderKind, nowMs: int, nextDue: DueResolution): ReminderDecision =
  if (reviewed != active or reviewed.reminderId == "" or reviewed.occurrenceId == "") ReminderRefused else
  if (kind != RepeatingReminder) ReminderComplete else match nextDue {
    | NativeDueAt(resolved) => if (resolved.dueAt > nowMs) ReminderNextAt({ nextAt: resolved.dueAt }) else ReminderRefused
    | _ => ReminderRefused
  }
pure def maySnoozeNativeReminder(reviewed: ReviewedOccurrence, active: ReviewedOccurrence, kind: ReminderKind, nowMs: int, requestedAt: int): bool =
  reviewed == active and reviewed.reminderId != "" and reviewed.occurrenceId != "" and
  kind != UndatedReminder and requestedAt > nowMs
pure def lawUnreviewedReminderCannotSnooze(reviewed: ReviewedOccurrence, active: ReviewedOccurrence, kind: ReminderKind, nowMs: int, requestedAt: int): bool =
  reviewed != active implies not(maySnoozeNativeReminder(reviewed, active, kind, nowMs, requestedAt))
pure val reviewedValues = Set({ reminderId: "weekly", occurrenceId: "monday", revision: 1 })
pure val activeValues = Set(
  { reminderId: "weekly", occurrenceId: "monday", revision: 1 },
  { reminderId: "weekly", occurrenceId: "monday", revision: 2 },
  { reminderId: "weekly", occurrenceId: "next-monday", revision: 3 })
pure val nowMsValues = Set(0, 1000)
pure val requestedAtValues = Set(0, 1000, 2000)
```
