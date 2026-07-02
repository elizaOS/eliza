# #8795 — LifeOps live legs on gemma-4-31b (Cerebras)

Four live legs proving the LifeOps train/eval/bench surfaces work end-to-end on
the new default eval model `gemma-4-31b` (Cerebras, paid tier, 131k context,
reasoning off). All commands run from the `feat/cerebras-gemma-4-31b-cutover`
worktree with `CEREBRAS_API_KEY=$CEREBRAS_API_KEY` (key redacted everywhere).
Legs 1–3 ran 2026-07-01; leg 4 ran 2026-07-02.

## Leg 1 — Cerebras wiring smoke (`leg1-verify-cerebras.log`)

```
CEREBRAS_API_KEY=$CEREBRAS_API_KEY bun run lifeops:verify-cerebras
```

- Defaults resolve with no overrides: `CEREBRAS_MODEL: (default gemma-4-31b)`,
  base URL `(default https://api.cerebras.ai/v1)`.
- Real API round-trips with token usage: eval 26→6 tokens (`{"ok": true}`),
  train 44→12 tokens, judge returned `5`.
- Verdict: **OK — eval, train, and judge paths all reachable on gemma-4-31b.**

## Leg 2 — GEPA seed runs, 3 wired tasks (`leg2-gepa-*.log`)

```
TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  bun run --cwd plugins/plugin-training lifeops:gepa-seed -- \
  --task <task> --generations 2 --population 4 \
  --state-dir /tmp/claude-1000/gepa-gemma4-<task> --apply
```

All three ran real GEPA loops against `gemma-4-31b (cerebras)`:

| task | dataset | baseline | optimized | delta | artifact persisted |
|---|---|---|---|---|---|
| calendar_extract | 11 | 0.856 | 0.856 | 0.000 | no — guard refused (must beat baseline by ≥0.0001); exit 1 is the guard, not a crash |
| schedule_plan | 11 | 1.000 | 1.000 | 0.000 | no — baseline already perfect; same guard, exit 1 |
| inbox_triage | 8 | 0.688 | 0.875 | **+0.188** | yes — `v1.json` persisted (copy: `leg2-inbox_triage-artifact-v1.json`) |

The inbox_triage artifact carries full GEPA lineage (baseline 0.6875 →
seed-feedback variant 0.8125 → final 0.875) and was persisted by
`[SERVICE:OPTIMIZED_PROMPT]` with version=1.

## Leg 3 — Live prompt benchmark (`leg3-prompt-benchmark.log`)

```
RUN_LIFEOPS_PROMPT_BENCHMARK=1 CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  bun run --cwd plugins/plugin-personal-assistant test -- \
  test/lifeops-prompt-benchmark.activation.test.ts
```

- `lint-default-packs`: clean, 0 findings.
- Vitest: **5/5 tests passed** in 74.71s (48.23s spent in live tests).
- Caveat (honest gap): vitest did not surface per-scenario score lines to the
  captured output — the log proves the live benchmark gate passed on
  gemma-4-31b but does not include the individual score printout.

## Leg 4 — Python lifeops-bench smoke on the new default large tier

```
cd packages/benchmarks/lifeops-bench && uv sync
CEREBRAS_API_KEY=$CEREBRAS_API_KEY uv run python -m eliza_lifeops_bench \
  --agent cerebras-direct --seeds 3 --model-tier large --suite smoke
```

- Tier resolution confirmed: `Model tier: large (cerebras → gemma-4-31b)`,
  evaluator model `gemma-4-31b` (cut over in `eliza_lifeops_bench/model_tiers.py`).
- `ANTHROPIC_API_KEY` was absent, so the harness auto-restricted to **STATIC
  scenarios** (its documented judge-less mode; the claude-opus-4-7 satisfaction
  judge is only used by LIVE scenarios). Recorded, not faked.

### Found + fixed: silently missing action manifest scored everything 0

The first run (`leg4-lifeops-bench-broken-manifest-20260702.log`) returned
**pass@1 0.000 / pass@k 0.000** while the `perfect` reference agent scored
1.000 on the same suite. Root cause: `manifests/actions.manifest.json` and
`data/snapshots/*.json` are gitignored generated artifacts (they were
de-tracked when the `lifeops-bench-manifest.yml` regeneration workflow was
removed), so a fresh checkout has neither — and
`runner._field_registry_tools_by_name()` silently returned `{}` on the
missing file. Every tool then degraded to a discriminator-only schema, so the
schema-obedient gemma-4-31b emitted calls like
`CALENDAR{"subaction":"check_availability"}` with no `startAt`/`eventId`/
`message` fields and every action failed executor validation.

Fixes applied:
- restored `manifests/actions.manifest.json` (170 actions) from git history
  (`67217005f5^`), re-applied `python -m eliza_lifeops_bench.manifest_export`
  (idempotent, +0 entries); the file stays gitignored — regenerate it before
  running the bench on a fresh checkout;
- regenerated `data/snapshots/{tiny_seed_42,medium_seed_2026}.json` via
  `python -m eliza_lifeops_bench.lifeworld.snapshots --rebuild`;
- `runner.py` (committed): the missing-manifest fallback now logs a loud
  warning instead of degrading silently.
- `tests/test_scenarios_corpus.py` (the manifest/world gate) passes again.

### Result with restored manifest (`leg4-lifeops-bench-smoke-20260702.log`)

```
Model: gemma-4-31b   Judge: claude-opus-4-7 (unused in STATIC mode)
Scenarios run: 15 (5 smoke scenarios x 3 seeds)
pass@1: 0.133   pass@k: 0.400   Total latency: 389.63s
Mean score per domain:
  calendar 0.933   mail 0.533   messages 0.300   health 0.000   reminders 0.000
```

Full per-turn transcripts: `leg4-results-20260702.json`. Remaining failures
are genuine model/scoring mismatches, not harness errors — e.g.
`health.step_count_today` answers with a wrong step total, and
`reminders.create_pickup_reminder_tomorrow_9am` resolves "tomorrow 9am" to a
past date (`2026-05-11T09:00:00Z`) because the benchmark-clock anchor is only
injected into CALENDAR tool descriptions, not `SCHEDULED_TASK_CREATE`.

Known accounting gap (pre-existing): `Total cost: $0.0000` — the ledger has
no gemma-4-31b price entry, so per-turn `cost_usd` is null.

## Leg 5 — 4th structured capability seeded + run: `health_checkin` (2026-07-02)

The prior legs seeded only the 3 tasks that shipped in `SEED_TASKS`
(`calendar_extract`, `schedule_plan`, `inbox_triage`). Auditing the other 5
LifeOps tasks against the seed harness's scorer showed exactly one more is a
clean structured JSON planner and therefore runnable via `lifeops:gepa-seed`
with a discriminative exact-match scorer: **`health_checkin`** (its live
consumer `resolveHealthPlanWithLlm` emits `{subaction,metric,days,shouldAct}`,
the same shape as `schedule_plan`). Added a 10-row seed dataset for it
(`plugins/plugin-training/scripts/lifeops-gepa-seed.ts`, covering every
subaction `today/trend/by_metric/status`, the `by_metric` metric enum, day-window
inference, the vague-guard `shouldAct=false`, and multilingual ES/FR phrasing)
and ran GEPA on gemma-4-31b:

```
TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  bun --conditions=eliza-source \
  plugins/plugin-training/scripts/lifeops-gepa-seed.ts \
  --task health_checkin --generations 3 --population 4 --apply \
  --state-dir /tmp/claude-1000/gepa8-health_checkin
```

| task | dataset | baseline | optimized | delta | artifact persisted |
|---|---|---|---|---|---|
| health_checkin | 10 | 0.925 | **0.975** | **+0.050** | yes — `v1.json` (copy: `leg5-health_checkin-artifact-v1.json`) |

The optimized prompt tightened output formatting ("Return raw JSON only ...
Omit any fields with null values"), lifting field-match on the multilingual /
metric rows. Persist passed both gates: delta ≥ 0.0001 and the
`validateOptimizedPromptForTask` fragment check for `health_checkin`. Unit
coverage updated: `src/scripts/lifeops-gepa-seed.test.ts` now asserts the 4-task
key set + a health-planner shape test — **9/9 pass**.

### Per-capability runnability audit (which of the 8 are seed-runnable)

| task | live consumer output | seed-runnable? | why |
|---|---|---|---|
| calendar_extract | structured JSON plan | ✅ ran (leg 2) | exact-field scorer discriminative |
| schedule_plan | structured JSON plan | ✅ ran (leg 2) | exact-field scorer discriminative |
| inbox_triage | structured JSON class | ✅ ran (leg 2) | exact-field scorer discriminative |
| health_checkin | structured JSON plan | ✅ ran (leg 5) | exact-field scorer discriminative |
| reminder_dispatch | free-text nudge | ❌ | scored as structured, but expected is prose → `parseStructuredFieldsLoose` fails → always 0; needs a judge scorer |
| meeting_prep | free-text narrative | ❌ | same: prose output, exact-match not meaningful |
| morning_brief | free-text narrative | ❌ | token-overlap scorer, but "expected narrative" is arbitrary → no crisp target |
| screentime_recap | JSON `{recap,topApps,suggestion}` | ❌ | recap/suggestion are prose → exact-match ~0; only `topApps` structured |

**Conclusion:** all 4 structured-planner LifeOps tasks now have real
gemma-4-31b before/after GEPA runs (3 in leg 2, `health_checkin` here). The
remaining 4 emit natural language, so the seed harness's structured/exact-match
scorer cannot optimize them — they are *not* mechanically runnable now and need
either (a) a judge-based scorer wired into the seed loop or (b) captured live
per-task trajectories fed through `lifeops:gepa` (the trajectory loop). That is
successor #11384's scope, not a gap in the closed parent.

## File index

| file | leg |
|---|---|
| `leg1-verify-cerebras.log` | 1 — wiring smoke |
| `leg2-gepa-{calendar_extract,schedule_plan,inbox_triage}.log` | 2 — GEPA seeds |
| `leg2-inbox_triage-artifact-v1.json` | 2 — persisted artifact |
| `leg3-prompt-benchmark.log` | 3 — live prompt benchmark |
| `leg4-lifeops-bench-broken-manifest-20260702.log` | 4 — pre-fix 0.000 run |
| `leg4-lifeops-bench-smoke-20260702.log` | 4 — post-fix smoke run |
| `leg4-results-20260702.json` | 4 — full result JSON |
| `leg5-gepa8-health_checkin-20260702.log` | 5 — health_checkin dry run |
| `leg5-gepa8-health_checkin-apply-20260702.log` | 5 — health_checkin --apply |
| `leg5-health_checkin-artifact-v1.json` | 5 — persisted artifact |
