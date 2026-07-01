# LifeOps / Personal-Assistant QA checklist (#10721 / #10723 / #8795 / #9310)

Professional-QA enumeration of everything the LifeOps + personal-assistant surface must
do, with per-item automation status. Legend:

- `[auto: <path>]` — enforced by an automated test at that path (keyless PR lane unless noted).
- `[auto-live: <path>]` — automated but requires a live LLM / credentials lane.
- `[fixed+auto]` — bug found by this campaign, fixed, regression-tested.
- `[manual: <evidence>]` — verified by hand; evidence committed.
- `[GAP]` — no coverage; listed so it cannot be silently forgotten.
- `[N/A: reason]`.

Status column reflects the branch `fix/lifeops-pa-delarp-battletest`. All waves have landed; remaining `[GAP]` rows are the campaign's tracked residuals
(enumerated in the close-out comments on #10721/#10723).

## 1. Scheduler spine (the one scheduler)

| # | Behavior | Status |
|---|---|---|
| 1.1 | The 60s heartbeat actually runs more than once per boot (task tick re-arms) | [fixed+auto: packages/core/src/services/task.test.ts (1d7d008741) — 8 fail without fix] |
| 1.2 | A task created after boot is picked up without restart | [fixed+auto: task.test.ts — create/update/delete nudge markDirty] |
| 1.3 | 5 consecutive tick failures do NOT permanently pause the heartbeat; restarts self-heal a paused heartbeat | [fixed+auto: PA scheduler-task.test.ts (54f45b152e) — maxFailures:0 + boot self-heal] |
| 1.4 | One failing subsystem (legacy reminders/workflows) does not abort the rest of the tick | [fixed+auto: reminders-service.process-scheduled-work.test.ts — 5 isolation tests fail without fix] |
| 1.5 | Atomic fire claim: two concurrent ticks never double-fire one task | [auto: plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts] |
| 1.6 | Tick limit respected; low-priority tasks past the limit are deferred not lost | [auto: deterministic-lifeops-concurrent-day.scenario.ts (b1d02290f5) — 26 tasks, exact 25-budget ledger, overflow fires tick 2, keyless PR gate] |
| 1.7 | Runner clock follows the tick clock (not frozen at boot) — firedAt is the real fire time | [fixed+auto: plugin-scheduling runner-service.test.ts (15fe56184b) — fails against cache-by-closure] |
| 1.8 | State-log rows written for every transition; history endpoint shows the chain | [auto: packages/scenario-runner/test/scenarios/deterministic-lifeops-scheduled-tasks.scenario.ts] |
| 1.9 | State log does not grow unbounded — nightly rollup runs (90-day retention) | [fixed+auto: reminders-service.state-log-rollover.test.ts (94396230eb) — 2 fail without wiring] |

## 2. Recurrence & missed fires

| # | Behavior | Status |
|---|---|---|
| 2.1 | A completed daily task fires again the next day | [fixed+auto: recurrence-refire.test.ts + PA scheduler-recurrence.integration.test.ts (488814580d) — 14 fail without fix] |
| 2.2 | A fired-but-never-completed (zombie) recurring task fires at the next occurrence | [fixed+auto: same suites] |
| 2.3 | An acknowledged recurring task fires at the next occurrence | [fixed+auto: same suites] |
| 2.4 | An interval task fires N times across N intervals | [fixed+auto: same suites] |
| 2.5 | A completed `once` task never refires | [auto: recurrence-refire.test.ts] |
| 2.6 | A dismissed recurring task never refires | [auto: recurrence-refire.test.ts] |
| 2.7 | Missed-fire catch-up: offline 3 days → cron fires exactly once (no storm) | [fixed+auto: scheduler-recurrence.integration.test.ts] |
| 2.8 | during_window fires once per window per day, across consecutive days | [fixed+auto: same suites] |
| 2.9 | Property: no trigger/clock sequence double-fires one occurrence | [auto: due-property.test.ts (50b138bd67) — fast-check, seeds pinned; caught + fixed 3 real bugs] |

## 3. Snooze / defer / reopen

| # | Behavior | Status |
|---|---|---|
| 3.1 | Snoozed daily cron task fires at snooze time, not tomorrow's occurrence | [fixed+auto: plugins/plugin-scheduling/src/scheduled-task/next-fire-at.test.ts — 5 fail without fix] |
| 3.2 | Snoozed interval task fires at snooze time, not override+interval | [fixed+auto: same] |
| 3.3 | Snoozed once task stays indexed (not NULL-scan escape hatch) | [fixed+auto: same] |
| 3.4 | Gate-defer (e.g. quiet hours) on a recurring task re-fires at the defer time (no infinite re-defer) | [fixed+auto: next-fire-at.test.ts + due-property.test.ts scheduled-override properties] |
| 3.5 | Snooze resets the escalation ladder AND any dispatch-retry continuation | [fixed+auto: plugins/plugin-scheduling/src/scheduled-task/dispatch-policy-enforcement.test.ts] |
| 3.6 | Snooze duration honored — "snooze 45" ≠ hardcoded 30 | [fixed+auto: life-reminder-datetime.test.ts (a46f9eff13)] |
| 3.7 | Reopen within window → due immediately; outside window → typed error | [auto: plugins/plugin-scheduling/src/scheduled-task/runner.test.ts] |

## 4. Dispatch & escalation (message actually reaches the user)

| # | Behavior | Status |
|---|---|---|
| 4.1 | DispatchResult{ok:false} is never recorded as fired | [fixed+auto: dispatch-policy-enforcement.test.ts — 7/8 fail without fix] |
| 4.2 | rate_limited retries same step with backoff, bounded (3/step) | [fixed+auto: same] |
| 4.3 | Permanent failure advances the escalation ladder across channels at each step's delay | [fixed+auto: same] |
| 4.4 | auth_expired (user-actionable) records connectorDegradation for surfacing | [fixed+auto: same] |
| 4.5 | Ladder exhausted → terminal failed + pipeline.onFail child | [fixed+auto: same] |
| 4.6 | Parked retry row is indexed AND due at the retry time | [fixed+auto: same] |
| 4.7 | Scenario-level: dispatch retry visible in state-log via real tick | [auto: deterministic-lifeops-dispatch-retry.scenario.ts (24411f5ea1) — keyless PR gate; fails with the H2 bug reintroduced] |
| 4.8 | No-reply escalation (user ignores reminder → next channel, not skip) | [GAP — product decision pending; today completion-timeout skips. Tracked as residual] |
| 4.9 | in_app dispatch with no live surface returns ok:false (no fabricated success) | [fixed+auto: scheduled-task-in-app-dispatch.test.ts (66e5d9d2c9) — 2 fail without fix; notification write awaited] |

## 5. Reminders (NL creation → fire → resolution)

| # | Behavior | Status |
|---|---|---|
| 5.1 | "remind me Friday at 5pm" schedules Friday 17:00 owner-tz, never `now` | [fixed+auto: life-reminder-datetime.test.ts (a46f9eff13)] |
| 5.2 | "in 2 hours" → now+2h | [fixed+auto: same] |
| 5.3 | Unresolvable time expression → clarification question, nothing scheduled | [fixed+auto: same] |
| 5.4 | Reschedule actually moves the stored time (no silent no-op "Updated") | [fixed+auto: a46f9eff13 + date-level moves ac78e9875a — "move it to Friday 3pm" moves the DATE too; past dates reject] |
| 5.5 | Multilingual phrasing trusted from LLM classification (no English-keyword veto) | [fixed+auto: extract-task-plan.test.ts] |
| 5.6 | Reminder CRUD + snooze + complete + history via SCHEDULED_TASKS action | [auto: deterministic-lifeops-scheduled-tasks.scenario.ts] |
| 5.7 | Cross-platform reminder ladder delivers per-rung (process endpoint) | [auto: 4 reminder-ladder scenarios relabeled pr-deterministic + load-bearing per-title assertions (24411f5ea1); 31/31 in the CI corpus gate] |
| 5.8 | Quiet-hours + DST + timezone-mismatch + idempotent-retry reminder outcomes | [auto: 7 deterministic reminder outcome scenarios from #10192 — verify still green] |
| 5.9 | Persona inputs (elderly/ESL/typo/voice-transcription/run-on) produce correct schedules | [auto-live: 5 persona-*.scenario.ts + shared outcome helper (b1d02290f5)] |
| 5.10 | SCHEDULED_TASKS create tolerates natural LLM trigger shapes (type/cron/schedule/timezone/at/minutes aliases); incomplete triggers fail with a teaching message, never a bare success:false | [fixed+auto: scheduled-task-trigger-boundary.test.ts (7273e0d981) — 7 fail without fix] |
| 5.11 | Cross-turn re-ask does not create a duplicate reminder (content-level dedupe) | [fixed+auto: same — observed live before fix] |

## 6. Calendar

| # | Behavior | Status |
|---|---|---|
| 6.1 | No fabricated flight-conflict template — conflict answers derive from real data | [fixed+auto: 883068c93b — both interceptor copies deleted, regression tests] |
| 6.2 | CONFLICT_DETECT reads real events; reports real overlaps | [fixed+auto: 8446a9d797 — CalendarService feed loader wired at init] |
| 6.3 | 3-way overlap detected; back-to-back is NOT a conflict | [fixed+auto: same] |
| 6.4 | No calendar source → honest unavailable, not "No conflicts detected" | [fixed+auto: same — CALENDAR_UNAVAILABLE] |
| 6.5 | Triple-overlap + declined-attendee exclusion (LLM reasoning) | [auto-live: calendar-triple-overlap.scenario.ts (b1d02290f5)] |
| 6.6 | Conflict detect→reschedule→conflict gone (outcome round-trip) | [auto-live: plugins/plugin-personal-assistant/test/scenarios/calendar-conflict-resolve-outcome.scenario.ts] |
| 6.7 | DST reschedule keeps local wall-clock (fall-back day) | [auto-live: packages/test/scenarios/lifeops.calendar/calendar.reschedule.dst-fall-back.scenario.ts] |
| 6.8 | Multi-account prune doesn't cross-delete two "primary" calendars | [GAP — plugin-calendar CalendarRepository prune lacks grant_id clause; residual] |
| 6.9 | Fuzzy-title destructive ops (delete/update) require confirmation | [GAP — residual] |
| 6.10 | Recurring events (RRULE) honored end-to-end | [GAP — no recurrence handling in plugin-calendar; product feature; residual] |

## 7. Todos & goals

| # | Behavior | Status |
|---|---|---|
| 7.1 | Todo CRUD via real DB round-trips | [auto: plugins/plugin-todos/test/todos.real-db.test.ts] |
| 7.2 | Todo create/complete outcome via deterministic scenario | [auto: deterministic-todos-actions.scenario.ts] |
| 7.3 | Goal create with goalCountDelta outcome | [auto: packages/test/scenarios/goals/owner-goals-create.scenario.ts] |
| 7.4 | Goal state machine (pause/resume/complete) | [auto: plugins/plugin-goals/test/goals.real-db.test.ts] |
| 7.5 | Goal check-ins fire on schedule | [GAP — GoalsCheckinService is a stub; product feature; residual] |

## 8. Inbox / email

| # | Behavior | Status |
|---|---|---|
| 8.1 | Triage persistence/resolve/digest on real DB | [auto: plugins/plugin-inbox/test/inbox.real-db.test.ts] |
| 8.2 | Classifier contract: parse/validate/fail-closed on malformed model output; label whitelist | [fixed+auto: inbox classifier contract tests (deb025e2a9)] |
| 8.3 | 500-unread adversarial batch triage (no fabricated counts) | [auto-live: packages/test/scenarios/lifeops.inbox-triage/inbox-triage.500-unread.scenario.ts] |
| 8.4 | Gmail write-path effects via mock ledger (batch modify, draft, no-real-write) | [auto-live: lifeops.gmail/ + messaging.gmail/ scenarios] |
| 8.5 | Approved email send actually sends | wave-1 `fix:approvals` |
| 8.6 | Inbox connector failure surfaces as degraded, not "inbox is empty" | [GAP — actions/inbox.ts collapses failures to empty; residual] |

## 9. Approvals

| # | Behavior | Status |
|---|---|---|
| 9.1 | Approve → the approved action executes (send/workflow/sign) | [fixed+auto: owner-send-approval-worker.test.ts + resolve-request-executor.test.ts (87dccd1d71); executor-less actions fail loudly NO_EXECUTOR] |
| 9.2 | Reject → zero side effects | [fixed+auto: same] |
| 9.3 | Unknown/executor-less action → hard failure, never fake "Approved." | [fixed+auto: same] |
| 9.4 | Expired request cannot be resurrected (TOCTOU CAS) | [fixed+auto: PA approval-queue.toctou.integration.test.ts (79f673d4cd) AND the agent-side duplicate store (0fce62eb2e) — both CAS-guarded] |
| 9.5 | Approval queue state machine + validation | [auto: existing approval-queue tests + approval-queue-resolve-outcome.scenario.ts] |

## 10. Check-ins / follow-ups / proactive

| # | Behavior | Status |
|---|---|---|
| 10.1 | Morning/night check-ins fire once per local day | [auto: PA checkin tests; hasCheckinForLocalDay] |
| 10.2 | Follow-up fires PROACTIVELY from the tick (not user-prompted) | [auto: deterministic-lifeops-multiday-journey.scenario.ts (b1d02290f5) — 5-day injected-clock journey incl. snooze-across-days + day-4 recurrence refire] |
| 10.3 | Proactive GM/GN not double-scheduled (proactive-worker vs daily-rhythm packs) | [GAP — #10953 H1 second-scheduler unification; large refactor; residual] |
| 10.4 | Completion checks (user_replied_within) complete deterministically on inbound reply | [GAP — evaluateCompletion has one caller (LLM verb); no inbound hook; residual] |
| 10.5 | Pending prompts recorded and visible to the planner | [auto: scheduler.ts recordPendingPromptIfNeeded + scheduler.integration.test.ts] |

## 11. Timezones / DST / clocks

| # | Behavior | Status |
|---|---|---|
| 11.1 | Owner timezone drives windows/local-day math (not server tz) | [auto: PA timezone.test.ts (17 tests, #10953)] |
| 11.2 | Spring-forward: nonexistent local time (02:30) handled sanely | [auto: dst-boundaries.test.ts (50b138bd67) — NY + Berlin transitions pinned] |
| 11.3 | Fall-back: ambiguous local time handled; window fires once | [auto: dst-boundaries.test.ts; KNOWN core cron double-fire pinned + filed #11046] |
| 11.4 | Cron with explicit tz fires once/day across DST | [auto: dst-boundaries.test.ts (except the fall-back-hour core limit, #11046)] |
| 11.5 | Backwards clock jump does not double-fire or wedge | [auto: due-property.test.ts non-monotonic clock properties] |
| 11.6 | `tz:"owner_local"` resolves to the owner zone (not silent UTC) | [GAP — nothing translates it; residual] |

## 12. Adversarial & security

| # | Behavior | Status |
|---|---|---|
| 12.1 | Prompt injection via scheduled-task/user content does not trigger outbound actions | [auto-live: adversarial-injection-via-content.scenario.ts (b1d02290f5)] |
| 12.2 | Malformed LLM-supplied gates/pipeline degrade safely (not always-fire) | wave-2 property + [GAP: schedule() validation of LLM-supplied shouldFire; residual] |
| 12.3 | Route actor gate not spoofable via x-eliza-entity-id header | [GAP — security residual, routes/plugin.ts:96; file separately] |
| 12.4 | harsh_no_bypass blocking cannot be lifted via DELETE route | [GAP — website-blocker lifecycle residual] |
| 12.5 | Huge/empty payload fuzz on due-evaluation and verbs never crashes the tick | [fixed+auto: due-property.test.ts + runner-fuzz.test.ts — RangeError overflow + 26s Intl-scan bugs found and fixed] |

## 13. Optimization / trajectory / benchmarks

| # | Behavior | Status |
|---|---|---|
| 13.1 | LifeOps-tagged trajectories increment their own capability counters | [fixed+auto: training-trigger.test.ts (7cb9a1e46b)] |
| 13.2 | Failed-scenario trajectories excluded/down-weighted from training data | [fixed+auto: trajectory-task-datasets.quality.test.ts (3534324f1a)] |
| 13.3 | Judge scores serialized numerically in reports + native export | [fixed+auto: scenario-runner native-export.test.ts (66d6e5e0ad)] |
| 13.4 | Batch trajectory-quality review produces per-capability scoreboard | [fixed+auto: trajectories:review script (7ad4351c4d), keyless --dry-run tested] |
| 13.5 | Live scenario lane runnable on subscription-only host (no API key) | [fixed+auto+manual: cli provider (7d62df0a57); live run evidence 10757-cli-live-lane/ — hand review found + fixed 3 more bugs (7273e0d981)] |
| 13.6 | Manual trajectory review of real-LLM runs, by hand | [manual: 10757-cli-live-lane/report.json reviewed call-by-call — found trigger-alias rejection, unlabeled success:false, cross-turn duplicate; all three fixed in 7273e0d981] |
| 13.7 | lifeops-bench real-model cell enforced in CI (not skip-not-fail) | [GAP — needs stable secrets + score history; documented defer] |
| 13.8 | PR-lane orchestrator judge not a hardcoded 1.0 stub | [GAP — wave-3 candidate] |

## 14. UI surfaces (goals/todos/reminders/notifications)

| # | Behavior | Status |
|---|---|---|
| 14.1 | Create→persist→read-back through the UI (not fixture theater) | [GAP — ui-smoke stub is GET-only; needs mutating-stub or live lane; wave-3] |
| 14.2 | Notification rail shows scheduled-task completion with category "task" | [GAP — #10697 residual producer; wave-3] |
| 14.3 | Reminder fire → visible notification in UI (end-to-end) | [GAP — wave-3 evidence run] |
| 14.4 | Proactive suggestion appears, dismissible, rate-limited (#8792) | [GAP — wave-3 e2e + audit:app evidence] |

Gaps marked `residual` are enumerated in the campaign close-out comment on #10721/#10723 so
none silently disappears. This checklist is updated in-place as waves land.
