# Manual review — Notification rail (fired-reminder render)

Verdict: **good**

- Screenshots: `04-notification-rail-desktop.png`, `05-notification-rail-mobile.png`.
- The fired reminder renders in the `NotificationCenter` rail as category
  **Reminder** with the correct title ("Reminder") and body ("Reminder
  (W8B11792-…): drink a glass of water — issue #11792 live proof"), timestamped
  "just now" — the correct task/reminder category and state.
- The category filter chips (All / Approvals / Reminders / General) render, and a
  concurrently-fired `high`-priority reminder correctly appears under **Approval
  needed** (category approval), confirming category routing by intensity.
- Desktop = right-side panel; mobile (390px) = full-width pull-down sheet + toast.
  Both render the reminder legibly.
- Minor: on desktop the open panel visually overlaps the feed's top-right "New"
  button (expected — it is an overlay panel), and on mobile the sheet overlays
  the feed beneath. Not a defect; the notification content is fully legible.
- No UI source changed by this lane; the rail is exercised live only.
