# Reminder delivery records

## Story: Preserve a reminder and its escalation policy

> As an owner, I can keep an assistant reminder's schedule and escalation data across upgrades and deliveries.

### A legacy reminder is imported only into the matching owner without replacing a current row

Reminder creation and scheduling belong to the existing assistant and task runner. This plugin owns the import policy and reminder delivery metadata. A transaction reads the legacy and current rows and inserts the eligible record at its existing identifier.

```quint
type ReminderStatus = ReminderPending | ReminderDelivered | ReminderSnoozed | ReminderDismissed
type ReminderDelivery = { ownerId: str, reminderId: str, scheduledAt: int, escalationAt: int, deliveryStatus: ReminderStatus, attempt: int }
pure def validReminderDelivery(row: ReminderDelivery): bool =
  row.ownerId != "" and row.reminderId != "" and row.scheduledAt >= 0 and row.escalationAt >= row.scheduledAt and row.attempt >= 0
pure def mayImportReminder(row: ReminderDelivery, ownerId: str, existingIds: Set[str]): bool =
  validReminderDelivery(row) and row.ownerId == ownerId and not(existingIds.contains(row.reminderId))
pure def lawExistingReminderIsNeverReplaced(row: ReminderDelivery, ownerId: str, existingIds: Set[str]): bool =
  existingIds.contains(row.reminderId) implies not(mayImportReminder(row, ownerId, existingIds))
pure def lawReminderImportStaysWithOwner(row: ReminderDelivery, ownerId: str, existingIds: Set[str]): bool =
  mayImportReminder(row, ownerId, existingIds) implies row.ownerId == ownerId
```

### A pending reminder escalates when its escalation deadline has arrived

The scheduler supplies an observed clock value and drives delivery. A dismiss action closes escalation. Snoozing changes the deadline explicitly on the stored reminder.

```quint
pure def escalationDue(row: ReminderDelivery, at: int): bool =
  validReminderDelivery(row) and (row.deliveryStatus == ReminderPending or row.deliveryStatus == ReminderSnoozed) and at >= row.escalationAt
pure def lawDismissedReminderCannotEscalate(row: ReminderDelivery, at: int): bool =
  row.deliveryStatus == ReminderDismissed implies not(escalationDue(row, at))
pure def lawReminderDoesNotEscalateEarly(row: ReminderDelivery, at: int): bool =
  at < row.escalationAt implies not(escalationDue(row, at))
pure val rowValues = Set({ ownerId: "owner", reminderId: "follow-up", scheduledAt: 10, escalationAt: 20, deliveryStatus: ReminderPending, attempt: 0 }, { ownerId: "other", reminderId: "follow-up", scheduledAt: 10, escalationAt: 20, deliveryStatus: ReminderDismissed, attempt: 1 })
```
