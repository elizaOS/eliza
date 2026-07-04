# Manual review — Automations feed (scheduled-task read-back)

Verdict: **good**

- Screenshots: `01-automations-feed-scheduled.png` (created row present),
  `03-automations-feed-after-fire.png` (row persists after fire),
  `00-automations-feed-before.png` (baseline).
- The reminder created via `POST /api/lifeops/scheduled-tasks` renders in the
  feed as `W8B11792-… drink water · Once · Active` — proving the UI reads the
  persisted row back from the real API (`client.listScheduledTasks`).
- No UI source was changed by this lane; the feed is exercised live only.
- Colors/layout consistent with the design system (orange accent on the "New"
  button + schedule labels; neutral rows). No blue. No layout break.
- e2e gap closed: scheduled-task create → persisted read-back now has a live
  browser assertion (`scheduled-reminder-fire.spec.ts`).
