# Personal-assistant scenario corpus

Every scenario in THIS directory is `lane: "live-only"` (197 files as of
2026-07): they drive message turns whose behavior (chief-of-staff judgment,
persona tone, natural-language dismissal) only a real model can produce, so
none of them can pass under the strict deterministic LLM proxy.

The keyless, merge-blocking coverage for PA/LifeOps behavior therefore lives
outside this directory and is what `bun run test:scenarios` actually runs:

- `packages/test/scenarios/reminders/` — the 4 `pr-deterministic` reminder
  ladder scenarios (`reminder.cross-platform.fires-on-mac-and-phone`,
  `reminder.cross-platform.acknowledged-syncs`,
  `reminder.escalation.intensity-up`, `reminder.escalation.silent-dismiss`)
  driving the REAL `/api/lifeops/reminders/process` endpoint with injected
  `now` values.
- `packages/scenario-runner/test/scenarios/deterministic-lifeops-*.scenario.ts`
  — the ScheduledTask spine (`scheduled-tasks`, `dispatch-retry`,
  `recurrence`, `concurrent-day`, `multiday-journey`) through the REAL
  scheduler tick (`executeLifeOpsSchedulerTask`).

Both run under `SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1` — zero
LLM calls, zero cost, fail-closed on any unfixtured model call.

`bun run test:scenarios:list` prints this live-only corpus (the old
`test:scenarios` behavior). When a scenario here becomes deterministically
satisfiable, relabel it `lane: "pr-deterministic"`, add its id to
`packages/scenario-runner/src/corpus-assertion-guard.test.ts`, and it will be
picked up by lane filtering automatically.
