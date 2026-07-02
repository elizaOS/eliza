# #10697 (slice) — calendar reminder priority tiering: on-device before/after

`ondevice-calendar-priority.png` — rendered on a connected Android instance
(emulator-5556, via the device's own Chrome + `adb reverse`):

- **BEFORE** — every calendar reminder was pushed at a single fixed
  `priority: "normal"`, so "Standup in 10 min" and "Dentist tomorrow 9am" were
  indistinguishable on the notification rail.
- **AFTER (#10697)** — tiered by the event's lead time: the imminent event
  (≤ 2h) is **high**, the far one (≥ 12h) is **low**, later-today stays normal.

Root logic is a pure, time-injected `resolveReminderNotificationPriority`
(6 unit tests: soon/overdue → high, ≥12h → low, later-today → normal,
non-calendar → normal, missing/unparseable dueAt → normal), wired into
`emitInAppReminderNudge`. The event start is the reminder's `dueAt`
(reminders-service.ts:923 sets `dueAt: event.startAt` for a `calendar_event`).
