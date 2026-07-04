# Issue #11792 — scheduled-task / reminder create → fire → notification-rail (live app)

Proves the scheduled-task + reminder **create / fire / notification** flow end to
end against the **real app runtime** (no mocks, no component-only fixture).

## What was driven

A new opt-in live-stack Playwright spec —
`packages/app/test/ui-smoke/scheduled-reminder-fire.spec.ts` — runs against the
real `@elizaos/plugin-scheduling` runner + `@elizaos/plugin-personal-assistant`
LifeOps scheduler hosted by the real app-core runtime (`ELIZA_UI_SMOKE_LIVE_STACK=1`
+ `ELIZA_UI_SMOKE_PLUGIN_ENTRIES=personal-assistant`). It:

1. **Creates** a `reminder` `ScheduledTask` ~30s out via the app's own authenticated
   API `POST /api/lifeops/scheduled-tasks` (the exact route the UI client uses).
2. **Reads it back** from `GET /api/lifeops/scheduled-tasks` (server persisted the
   row) **and** renders it in the Automations feed UI (`01`).
3. **Fires** it through the REAL runner — the core `TaskService` runs the LifeOps
   scheduler tick on its 60s cadence → `processDueScheduledTasks` → `runner.fire`
   → in_app dispatch → `NotificationService.notify`. The test polls the real API
   until the row transitions `scheduled → fired` **and** a `reminder` notification
   exists.
4. **Renders** the fired reminder in the real notification rail
   (`NotificationCenter` / `AgentNotification`) on desktop (`04`) and mobile (`05`).

## Result

Two green runs against the real runtime (`1 passed` each) — fire-loop logs:

```
reuse-stack run:  [w8b] fire loop: ticks=4  firedStatus=fired notif=f2c0d2f0-… cat=reminder
fresh-boot run:   [w8b] fire loop: ticks=14 firedStatus=fired notif=02619e94-… cat=reminder
```

The committed PNGs + `walkthrough.webm` are from the **fresh-boot** run (marker
`W8B11792-mr599qw1ipmw`); the `*.json` domain artifacts were captured from an
identical prior run against the same live runtime (marker `…-mr591jomemu`). Both
are real fired reminders.

## Artifacts (all manually reviewed)

| File | What it shows |
|---|---|
| `00-automations-feed-before.png` | Automations feed renders (pre-create baseline). |
| `01-automations-feed-scheduled.png` | The created reminder row (`W8B11792-… drink water · Once · Active`) reads back in the feed UI. |
| `03-automations-feed-after-fire.png` | The row persists after firing. |
| `04-notification-rail-desktop.png` | Notification rail open: the fired reminder as category **Reminder** — "Reminder (W8B11792-…): drink a glass of water — issue #11792 live proof · just now". |
| `05-notification-rail-mobile.png` | Same reminder in the mobile pull-down rail + toast (390px). |
| `scheduled-tasks-fired.json` | Domain artifact: the scheduled-task row, `state.status = "fired"`, `firedAt` stamped. |
| `notification-reminder.json` | Domain artifact: the emitted notification, `category = "reminder"`, `source = "lifeops"`. |
| `boot-log-excerpt.txt` | Backend `[ClassName]` logs: PA registered, 6 default packs seeded, live UI ready, fire-loop result. |

## Notes / findings

- **Notification category depends on intensity, not priority label.** A `high`
  reminder is escalated by the default ladder to intensity `urgent`, which the PA
  dispatcher surfaces as an **"Approval needed"** (`category: approval`)
  notification; a `medium` reminder surfaces as a plain **"Reminder"**
  (`category: reminder`). The spec uses `medium` so the rail shows the reminder
  category. Both categories were observed firing correctly (see `04` — the
  `high` probe shows as "Approval needed", the `medium` reminder as "Reminder").
- **The reminder fires via the autonomous core `TaskService` interval tick.**
  `POST /api/background/run-due-tasks` returns `503 runtime_unavailable` under the
  app-core live-stack server wiring, so the spec treats it as a best-effort
  accelerator and relies on the autonomous 60s tick (which fired every reminder
  in testing ~60-90s after due). This is a pre-existing app-core route/state gap,
  out of scope for this evidence lane, and does not affect the real fire path.

## Repro

```bash
ELIZA_UI_SMOKE_LIVE_STACK=1 \
ELIZA_UI_SMOKE_PLUGIN_ENTRIES=personal-assistant \
LOCAL_LLAMA_CPP_API_KEY=local \
ELIZA_LIVE_TEST_LOCAL_LLAMA_CPP_BASE_URL=http://127.0.0.1:<local-openai-compat-port>/v1 \
ELIZA_LIVE_TEST_SMALL_MODEL=<model> ELIZA_LIVE_TEST_LARGE_MODEL=<model> \
E2E_RECORD=1 \
node packages/app/scripts/run-ui-playwright.mjs \
  --config packages/app/playwright.ui-smoke.config.ts \
  packages/app/test/ui-smoke/scheduled-reminder-fire.spec.ts --project=chromium
```

(A provider key is required only to satisfy the live-stack's onboarding; the
fire → notification path itself is LLM-independent.)
