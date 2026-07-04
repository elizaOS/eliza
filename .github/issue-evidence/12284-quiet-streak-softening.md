# #12284 items 6+8 — quiet-streak softening of the no-reply ladder (evidence)

Branch `feat/12284-intensity-quiet-watcher`, based on `develop` @ b24dec831.
Companion to `12284-reminder-intensity-noreply.md` (#12952, item 6's lookup):
this change gives the quiet-user-watcher signal its structural consumer (item
8) through the SAME intensity lookup, and gives the recent-task-states log its
production writer so a real quiet streak can actually form.

## Targeted suites (local, real repository-backed runtime — no scheduler mocks)

`bunx vitest run --config vitest.config.ts src/lifeops/scheduled-task/no-reply-intensity.test.ts src/lifeops/scheduled-task/scheduler.no-reply-policy.test.ts src/lifeops/scheduled-task/scheduler.quiet-streak.test.ts`

```
 Test Files  3 passed (3)
      Tests  23 passed (23)
```

Per file: `no-reply-intensity.test.ts` 8 (6 existing + 2 softener unit cases) ·
`scheduler.no-reply-policy.test.ts` 9 (8 existing + 1 new auditability case) ·
`scheduler.quiet-streak.test.ts` 6 (new).

The quiet-streak suite drives REAL scheduler ticks end to end: three
consecutive ignored check-ins flow through fire → completion-timeout →
terminal `expired`, each transition appended to the recent-task-states log by
the production writer (`recordTaskStateEntry`), and the day-4 reminder's
resolved ladder is asserted from the persisted task record:

- softened: `metadata.noReplyPolicy { maxRetries: 0, retryCadenceMinutes: [] }`,
  `metadata.noReplyState { quietStreakSoftened: true, quietStreakDays: 3, appliedReminderIntensity: "minimal" }`
- contrast persona (no history): `{ maxRetries: 1, retryCadenceMinutes: [60] }`, no softening flags
- streak broken by a reply (`completed` entry): no softening
- explicit `persistent` owner + streak: one notch to `normal` (1 retry, not 2)
- approvals: full 2-retry 30/120 cadence preserved (never softened)
- owner reply through the real `MESSAGE_RECEIVED` seam appends the
  streak-breaking `completed` log entry

## Adjacent suites

- `inbound-reply-completion.integration.test.ts` — 5 passed (its completion
  path now appends the streak-breaking entry)
- `test/recent-task-states.integration.test.ts` — 2 passed
- `test/default-pack-spine-seeding.test.ts` + `test/default-packs.smoke.test.ts` — 9 passed
- `bun run --cwd plugins/plugin-scheduling test` — 19 files, 238 passed
  (package untouched; PA-side seam chosen, same rationale as #12952)
- `bun run --cwd plugins/plugin-personal-assistant typecheck` — exit 0

## Full package suite + pre-existing develop failures

`bun run --cwd plugins/plugin-personal-assistant test`:

```
 Test Files  4 failed | 139 passed (143)
      Tests  9 failed | 1144 passed | 7 skipped (1160)
```

All 9 failures reproduce verbatim (same tests, same files) on a detached
clean checkout of `origin/develop` @ b24dec831 — none of the 4 files is
touched by this branch:

```
 Test Files  4 failed (4)
      Tests  9 failed | 29 passed (38)
```

- `src/actions/life-reminder-datetime.test.ts` (1) — #12998's rage-quit
  delete-trap regression, merged as a known safety gap
- `src/lifeops/domains/reminders-service.process-scheduled-work.test.ts` (5) —
  `travel_reconcile` subsystem (#13211) calls `cache.getCache` against that
  test's mock runtime
- `test/signature-deadline-scheduler.test.ts` (1)
- `src/components/BlockerSettingsCards.test.tsx` (2)
