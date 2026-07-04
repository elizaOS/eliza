# Evidence — #12283 LifeOps persona-journey scenarios (first B1 increment)

Issue #12283 asks for 72 persona-journey scenarios across 8 packs. This is the
first increment: the B1 (night-owl-anchored-day) pack, live-only surface, driven
against a **live** model and hand-reviewed.

## Scenario

`plugins/plugin-personal-assistant/test/scenarios/night-owl-flexible-habit-any-time-today.scenario.ts`
(`lane: "live-only"`, pack B1, tier T1). Persona-as-data (night-owl framing in
the turn text, never in `promptInstructions`). Premise from the issue's B1 table:
*"once today, any time", no fixed slot* — the assistant must create a flexible
habit and NOT default to a 9am/morning slot.

`finalChecks`: `definitionCountDelta` (effect-reading — a scheduled-task
definition was created) + `judgeRubric` (flexibility respected, no fixed slot).

## Verification — live run (Cerebras `gpt-oss-120b`), passed twice

```
eliza-scenarios run .../test/scenarios --scenario night-owl-flexible-habit-any-time-today
| night-owl-flexible-habit-any-time-today | passed | 6348ms |
Totals: 1 passed, 0 failed
```

**Trajectory, reviewed by hand** (report:
`.github/issue-evidence/12283-lifeops-personas/night-owl-flexible-habit-any-time-today.report.json`):

- `actionsCalled: ["OWNER_REMINDERS"]` — the model routed to reminder creation.
- Reply: *"Sure thing—I've set a reminder for you to drink a glass of water today
  around 1 pm. If you'd prefer a different time, just let me know!"* — chose 1pm
  (not a 9am/morning default) and offered flexibility.
- `definitionCountDelta` → passed: 1 matching definition for "drink water".
- `judgeRubric` → passed, score **1.00** ≥ 0.6.

Passed on two independent runs (6.3s / 6.8s) — reliable, not a fluke.

## Catalog + gates

- `_catalogs/night-owl-anchored-day.catalog.json` records the scenario as
  `verified`. `node packages/scripts/check-lifeops-persona-catalog-coverage.mjs`
  → B1 1/24 authored, 1/1 verified; the entry resolves to the real file.
- All four scenario-runner corpus ratchets stay green (14 tests): the live-only
  scenario does not touch the `pr-deterministic` id list, its `responseIncludes`
  are absent (no echo), and its `finalChecks` include an effect-reading check
  (`definitionCountDelta`) plus a non-skippable one.

## Scope note (honest)

This is 1 of 72. A second B1 premise (`night-owl-end-of-her-evening-nudge`,
recurring 2am wind-down) was authored and run live: the model behaved correctly
(scheduled the nudge toward her ~2am night window, judge 1.00) **but no
scheduled-task definition persisted** — a real recurring-reminder persistence
gap in the `OWNER_REMINDERS` path worth a separate investigation, so it is not
shipped here. The remaining packs/premises are enumerated in the issue's tables.

## Evidence rows

| Evidence | Status |
| --- | --- |
| Real-LLM trajectory | **Attached + reviewed** — live Cerebras `gpt-oss-120b`; `OWNER_REMINDERS` created the flexible habit, judge 1.00; report JSON in `.github/issue-evidence/12283-lifeops-personas/`. |
| Domain artifacts | `life_scheduled_definitions` row (the created habit) — asserted via `definitionCountDelta`. |
| Frontend / screenshots | N/A — no UI surface changed (scenario authoring). |
