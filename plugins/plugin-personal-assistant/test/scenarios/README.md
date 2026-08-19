# Personal-assistant scenario corpus

This directory contains both `live-only` model-behavior scenarios and
`pr-deterministic` domain contracts. Live-only cases cover chief-of-staff
judgment, persona tone, and other semantics that require a supported model;
deterministic cases exercise registered actions, services, and durable state.
Use scenario metadata and evidence scope—not the directory—to select a lane.

Additional keyless, merge-blocking PA/LifeOps coverage lives in shared roots
and is also exercised by `bun run test:scenarios`:

- `packages/test/scenarios/reminders/` — the `pr-deterministic` reminder
  ladder scenarios (`reminder.ladder.delivers-three-rungs`,
  `reminder.ladder.acknowledged-suppresses-later`,
  `reminder.escalation.intensity-up`,
  `reminder.escalation.unacknowledged-ladder`)
  driving the REAL `/api/lifeops/reminders/process` endpoint with injected
  `now` values.
- `packages/scenario-runner/test/scenarios/deterministic-lifeops-*.scenario.ts`
  — the ScheduledTask spine (`scheduled-tasks`, `dispatch-retry`,
  `recurrence`, `concurrent-day`, `multiday-journey`) through the REAL
  scheduler tick (`executeLifeOpsSchedulerTask`).

Both run under `SCENARIO_USE_DETERMINISTIC_MODEL=1` — zero
LLM calls, zero cost, fail-closed on any unfixtured model call.

`bun run test:scenarios:list` prints this mixed corpus; use `--lane live-only`
or `--lane pr-deterministic` when selecting one evidence lane. When a scenario
becomes deterministically satisfiable, relabel it `lane: "pr-deterministic"`, add its id to
`packages/scenario-runner/src/corpus-assertion-guard.test.ts`, and it will be
picked up by lane filtering automatically.
