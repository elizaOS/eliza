# Issue #14351 Shift-Rotation Evidence

Two scenario-runner live-only B2 rows were repaired and verified on 2026-07-06
with `ELIZA_CHAT_VIA_CLI=claude`, `TZ=UTC`, and
`SCENARIO_TURN_TIMEOUT_MS=240000`. The judge was self-graded by the model under
test because no independent `CEREBRAS_API_KEY` was configured in this
environment.

## `shift-rotation-capture-new-shift-pattern`

Command:

```bash
ELIZA_CHAT_VIA_CLI=claude ELIZA_CLI_TIMEOUT_MS=240000 SCENARIO_TURN_TIMEOUT_MS=240000 TZ=UTC \
bun --conditions eliza-source --tsconfig-override ../../tsconfig.json src/cli.ts run \
  ../../plugins/plugin-personal-assistant/test/scenarios \
  --scenario shift-rotation-capture-new-shift-pattern \
  --lane live-only \
  --report /tmp/eliza-14351-shift-rotation-live8-capture/report.json \
  --run-dir /tmp/eliza-14351-shift-rotation-live8-capture/run \
  --export-native /tmp/eliza-14351-shift-rotation-live8-capture/native.jsonl
```

Evidence:

- `capture-new-shift-pattern.report.json`
- `capture-new-shift-pattern.native.jsonl`

Manual readout:

- Scenario status: `passed`
- Structured action: `SCHEDULED_TASKS`
- Created task kind: `reminder`
- Trigger: cron `33 8 * * *` UTC, about one hour after the 07:30 night-shift
  clock-out and outside the protected daytime sleep block.
- Final checks: `daily-handoff-record-exists-outside-protected-sleep`,
  `memoryWriteOccurred`, and `shift-capture-anchoring` all passed; judge score
  `0.90`.

## `shift-rotation-sleep-window-conflict-requires-confirm`

Command:

```bash
ELIZA_CHAT_VIA_CLI=claude ELIZA_CLI_TIMEOUT_MS=240000 SCENARIO_TURN_TIMEOUT_MS=240000 TZ=UTC \
bun --conditions eliza-source --tsconfig-override ../../tsconfig.json src/cli.ts run \
  ../../plugins/plugin-personal-assistant/test/scenarios \
  --scenario shift-rotation-sleep-window-conflict-requires-confirm \
  --lane live-only \
  --report /tmp/eliza-14351-shift-rotation-live10-conflict/report.json \
  --run-dir /tmp/eliza-14351-shift-rotation-live10-conflict/run \
  --export-native /tmp/eliza-14351-shift-rotation-live10-conflict/native.jsonl
```

Evidence:

- `sleep-window-conflict.report.json`
- `sleep-window-conflict.native.jsonl`

Manual readout:

- Scenario status: `passed`
- Structured action: `CALENDAR`
- Calendar result: `success:false`, `error:"PROTECTED_SLEEP_CONFLICT"`,
  `noop:true`
- Requested local time: `10:00`
- Protected quiet/sleep window: `05:00-13:00 UTC`
- Final checks: no calendar event, no definition, no external dispatch,
  message write, and `sleep-conflict-fail-closed` all passed; judge score
  `1.00`.

## Remaining #14351 Scope

This evidence proves the two repaired scenario-runner rows now pass live. The
catalog now has all 22 B2 entries authored, with 6 verified and the remaining
16 LifeOpsBench entries explicitly re-statused in-place with written reasons.
The eight static LifeOpsBench rows have keyless oracle proof only; the eight
live LifeOpsBench rows still require provider credentials for real live runs.

Coverage gate:

```bash
node packages/scripts/check-lifeops-persona-catalog-coverage.mjs --json
```

Current B2 result: `22/22 authored`, `6/22 verified`, `errors: []`.

## LifeOpsBench Static Harness Check

The eight static LifeOpsBench B2 rows were also run with the keyless
`PerfectAgent` oracle. This validates the corpus definitions, expected tool
calls, LifeWorld executor path, and scoring, but it is not a real-LLM run and
therefore does not flip those catalog rows to `verified`.

Evidence:

- `lifeops-bench-static/shiftrotation.capture_nights_starting_monday.json`
- `lifeops-bench-static/shiftrotation.protect_post_shift_sleep_window.json`
- `lifeops-bench-static/shiftrotation.normalize_d_e_n_week_pattern.json`
- `lifeops-bench-static/shiftrotation.reanchor_recurring_reminders_new_shift.json`
- `lifeops-bench-static/shiftrotation.tomorrow_resolves_against_shift_boundary.json`
- `lifeops-bench-static/shiftrotation.quiet_hours_move_with_rotation.json`
- `lifeops-bench-static/shiftrotation.forward_rotation_transition_leniency.json`
- `lifeops-bench-static/shiftrotation.dedup_habit_survives_shift_change.json`

All eight reported `pass_at_1: 1.0`, `pass_at_k: 1.0`, and `total_cost_usd: 0`.
The environment had no `CEREBRAS_API_KEY`, `ANTHROPIC_API_KEY`, or
`OPENAI_API_KEY`, so the eight live LifeOpsBench B2 rows could not be executed.

## LifeOpsBench Eliza Adapter Smoke

One static B2 row was also run through the real LifeOpsBench `eliza` adapter
after starting the TypeScript benchmark server in source mode with the minimal
smoke plugin set:

```bash
ELIZA_BENCH_SERVER_CMD='node --conditions=eliza-source --conditions=development --import tsx' \
ELIZA_BENCH_SKIP_CORE_PLUGINS=true \
ELIZA_BENCH_SKIP_ELIZA_PLUGIN=true \
python3 -m eliza_lifeops_bench \
  --agent eliza \
  --mode static \
  --scenario shiftrotation.capture_nights_starting_monday \
  --output-dir /tmp/lifeops-bench-shift-eliza-smoke-one \
  --per-scenario-timeout-s 120 \
  --verbose
```

Evidence:

- `lifeops-bench-eliza-smoke/shiftrotation.capture_nights_starting_monday.no-provider.json`
- `lifeops-bench-eliza-smoke/shiftrotation.capture_nights_starting_monday.no-provider.txt`

Manual readout:

- The bench server reached `ELIZA_BENCH_READY`.
- The runtime initialized with the SQL plugin and benchmark plugin.
- The run failed the scenario with `pass_at_1: 0.0` because no LLM provider was
  configured: the agent response was `This agent has no LLM provider configured.
  Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in your
  environment, or sign in to Eliza Cloud (ELIZAOS_CLOUD_API_KEY).`
- This is negative evidence only: it proves the real adapter can start and reach
  the expected provider boundary in this environment, not that the scenario is
  verified.

The LifeOpsBench corpus pytest check passed after adding the canonical generated
snapshot files back under `packages/benchmarks/lifeops-bench/data/snapshots/`
and un-ignoring that benchmark fixture directory:

```bash
python3 -m pytest tests/test_scenarios_corpus.py -q
```

Result: `21 passed`.
