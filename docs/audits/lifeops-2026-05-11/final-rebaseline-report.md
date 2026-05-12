# Final cumulative re-baseline 2026-05-11

Run dir: `/Users/shawwalters/.milady/runs/lifeops/lifeops-multiagent-1778550918415`
Limit: 10 scenarios per agent on Cerebras gpt-oss-120b with Mockoon substrate.

## Headline pass rates

| Agent | Pass@1 | Mean score (calendar) | Cost | Wall time |
|---|---:|---:|---:|---:|
| eliza    | 0.100 | 0.570 | $0.0000 | 0ms (static) |
| hermes   | 0.000 | 0.495 | $0.0305 | 139,159 ms (2.32 min) |
| openclaw | 0.100 | 0.565 | $0.0466 | 74,911 ms (1.25 min) |

Notes:
- `eliza` ran in `--mode static` for this wave; agent cost / wall time reflect zero because the planner is replayed from cached trajectories rather than re-invoked against Cerebras. Per-scenario scores still reflect the live scorer against Mockoon state.
- `hermes` and `openclaw` ran live against Cerebras `gpt-oss-120b`.
- Only the `calendar` domain executed in this 10-scenario slice (the bench limit consumes the first N scenarios in canonical order, which are all calendar).

## Delta from W2-9 baseline (`~/.milady/runs/lifeops/lifeops-multiagent-best`)

| Agent | W2-9 mean | W4 mean | Delta |
|---|---:|---:|---:|
| eliza    | 0.000 | 0.570 | +0.570 |
| hermes   | 0.394 | 0.495 | +0.101 |
| openclaw | 0.259 | 0.565 | +0.306 |

Pass@1 deltas:

| Agent | W2-9 pass@1 | W4 pass@1 | Delta |
|---|---:|---:|---:|
| eliza    | 0.000 | 0.100 | +0.100 |
| hermes   | 0.000 | 0.000 |  0.000 |
| openclaw | 0.000 | 0.100 | +0.100 |

All three agents improved on mean score. Hermes still pass@1=0 — every calendar scenario failed at least one rubric, but partial credit improved.

## What landed since W2-9 (compressed)

- W4-A scorer: name-aliasing + soft intent + triviality refinement
- W4-B bench server: verified Cerebras chat-completions + scenario-runner embedding stub
- W4-C adapters: Cerebras 429 retry, concurrency 4→2
- W4-D planner: BLOCK scope sharpened, CALENDAR similes added, manifest arg shapes tightened
- W4-G personality judge: 6 new rubrics (87 calibration cases, 100%/0% FP)
- W4-H eliza-runtime profile: proves W3-1 spends 0 tokens on suppressed turns

## Saved-best symlink

`~/.milady/runs/lifeops/lifeops-multiagent-w4-final → /Users/shawwalters/.milady/runs/lifeops/lifeops-multiagent-1778550918415`

## Wave-5 followups

(operator-attention items from accumulated reports)

- Manifest auto-export overwrites W4-D's owner-surface descriptions; update `owner-surfaces.ts` as canonical source.
- `plugins/app-lifeops/package.json` missing typecheck script (turbo skips it).
- Real action gaps in the planner (`calendar_move_instance`, `calendar_move_event`, `calendar_update`, `create_reminder`, `broadcast_reminder`) consistently fail; need action-name simile coverage.
- `faultInjection` wiring in `start-mocks.ts` + scenario-runner seeds.
- 378 registry pins should be `workspace:*` (linter is reverting attempts).
- `@elizaos/agent` npm tarball needs republishing.
- Recurring runtime warnings in this run:
  - `CALENDAR_NEXT_EVENT/<missing> missing required field 'subaction'` (calendar.next_event_today)
  - `CALENDAR_UPDATE_PREFERENCES/<missing> missing required field 'subaction'` (calendar.update_preferences_blackout_evenings)
  - `CALENDAR_SEARCH_EVENTS/<missing> missing required field 'subaction'` (calendar.search_pitch_meetings_this_quarter, calendar.reschedule_dentist_to_friday)
  - `unsupported action in execute path: REPLY` across most calendar scenarios — planner emits REPLY but the runner has no executor entry for it. This is a real gap, not a scorer bug.
