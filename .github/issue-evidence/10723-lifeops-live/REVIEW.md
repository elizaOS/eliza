# #10723 — LifeOps / life-coach live-model trajectory evidence

**Model under test:** `gpt-oss-120b` via Cerebras (OpenAI-compatible,
`OPENAI_BASE_URL=https://api.cerebras.ai/v1`). `live-only` lane — replies and
`responseJudge` verdicts are all from the live model. No proxy, no mock judge.

**Runner:** `packages/scenario-runner/src/cli.ts run
plugins/plugin-personal-assistant/test/scenarios --lane live-only`.

**Scenarios run (goals / habits / recap / follow-up / recurrence):**

| scenario | domain | status | asserted outcome |
| --- | --- | --- | --- |
| reminder-daily-recurrence-outcome | reminders/recurrence | **passed** | scheduled task seeded, fired in day-1 window and *re-fired* in day-2 window (recurrence correct) |
| goal-sleep-basic | goals | failed | `responseJudge 0.00` — model flailed across REPLY / SCHEDULED_TASKS wrong `kind`s, hit repeated-failure limit, never cleanly saved the goal |
| brush-teeth-basic | habits/check-in | failed | `responseIncludesAny` — reply was a "something went wrong" error string |
| evening-recap-generation | recap | failed | `responseIncludesAll` — recap omitted a required entity (`brightline`) |
| gmail-retry-followup | follow-up | failed | `plannerIncludesAll` — planner never invoked `gmail_action` |

**What I verified by hand:** opened `005-reminder-daily-recurrence-outcome.json`
— the passing case shows a real `ScheduledTask` seeded then dispatched on two
consecutive daily windows (`now:2027-01-15…` then `now:2027-01-16…`), proving
the single scheduled-task runner + recurrence structurally fires. Opened the
`goal-sleep-basic` trajectory: the model repeatedly picked `SCHEDULED_TASKS`
with the wrong `kind` and tripped `TrajectoryLimitExceeded: Repeated tool
failure limit exceeded for SCHEDULED_TASKS:failed` — a real live-model
trajectory, not an infra crash (the harness ran end-to-end and the judge scored
every turn).

**Honest read:** 1 pass / 4 fail on `gpt-oss-120b`. The recurrence/scheduled-task
spine holds; the free-form goal/recap/follow-up flows expose real capability
gaps at this model tier plus mock-connector limits (mock Google token).
Captured as-is.

**Files:** `0NN-<scenario>.json`, `matrix.json`, `lifeops-native.jsonl.gz`,
`lifeops-native.manifest.json`, `run/viewer/index.html`.
