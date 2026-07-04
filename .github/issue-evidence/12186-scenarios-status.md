# Issue #12186 — LifeOpsBench persona scenario corpus (PART A)

Branch: `feat/12186-lifeops-persona-scenarios`
Scope: Python LifeOpsBench only (`packages/benchmarks/lifeops-bench/`). TS plugin
work (extraction/learning writers, gate wiring, default packs, tick scenarios)
is a separate agent / separate deliverable and is **not** in this branch.

## What landed

- **5 new personas** in `eliza_lifeops_bench/scenarios/_personas.py`:
  `ari_adhd`, `noa_nightowl`, `tao_travel`, `cam_comms`, `del_low` — each with
  `communication_style` / `traits` / `patience_turns` grounded in the persona
  research (plan section C).
- **240 new base persona scenarios** under a new
  `eliza_lifeops_bench/scenarios/personas/` package, built programmatically
  (`PersonaAreaSpec` / `FamilySpec` × families × variants) mirroring the proven
  `scenarios/expanded/` builder. Spliced into `CORE_SCENARIOS` via
  `PERSONA_SCENARIOS`.
- **Schema-validity fix** (post-adversarial-review): all persona ground-truth
  scheduled-task shapes now match the real
  `plugins/plugin-scheduling/src/scheduled-task/schema.ts` zod contract, and a
  new corpus guard (`scenarios/personas/schema_check.py`) prevents regression.
  See the "Schema validity" section below.

### Counts (static / live per persona)

| Persona (id)                | STATIC | LIVE | Subtotal |
|-----------------------------|:------:|:----:|:--------:|
| ADHD (`ari_adhd`)           |   30   |  18  |    48    |
| Night-owl (`noa_nightowl`)  |   30   |  18  |    48    |
| High-travel (`tao_travel`)  |   30   |  18  |    48    |
| High-comms (`cam_comms`)    |   30   |  18  |    48    |
| Low-energy (`del_low`)      |   30   |  18  |    48    |
| **Total**                   | **150**| **90**| **240**  |

Base scenario count: **1020 → 1260** (+240). Edge-expanded total (10×):
11220 → **13860**. Clears the DoD "200+ higher-difficulty" bar.

`first_question_fallback` coverage: **50 / 150** persona static scenarios (33%);
global static ratio stays at **~40%** (well above the 30% corpus gate).

### Difficulty dimensions (all 5 from plan E.2 spanned)

1. **Flexible-scheduling correctness** — static ground truth encodes
   `during_window` / `relative_to_anchor` / `owner_local`-cron triggers, so a
   rigid fixed-time answer loses action-score (name matches, trigger kwargs
   mismatch → 0.5, not 1.0). Because every persona ground-truth action is now
   validated against the real plugin-scheduling zod schema (see the
   schema-validity section below), a **schema-correct** agent that emits the
   real shapes scores the full 1.0 — the benchmark rewards valid output, not the
   mock of it.
2. **Extraction-from-context** — LIVE `success_criteria` assert the agent pulled
   a fact (wake time, timezone, cross-channel contact) from context rather than
   asking or hallucinating.
3. **Proactive / no-reply** — LIVE families carry `disruptions`
   (`reminder_due` / `new_message`); correct behavior is a graded non-shaming
   follow-up or suppression.
4. **Adversarial / edge** — quiet-hours collisions, DST/timezone shifts,
   "don't nag me" boundaries, RSD-sensitive framing (LIVE judge rubric).
5. **Multi-domain / multi-turn** — static families chain
   calendar + reminders + messages + health; LIVE families raise `max_turns`.

Every STATIC `ground_truth_actions` uses only manifest action names
(`LIFE_CREATE`, `SCHEDULED_TASK_CREATE`, `CALENDAR`, `MESSAGE`, `ENTITY`,
`HEALTH`, `BOOK_TRAVEL`, `LIFE_SNOOZE`) and only `*_id`s that resolve in
`data/snapshots/medium_seed_2026.json` (`list_personal`, `cal_primary`,
`cal_work`, `contact_00003/07/09`, `reminder_00005`, `email_000002/000010`).
LIVE scenarios leave gt/required_outputs empty + fallback None, and carry
`success_criteria`/`world_assertions`/`disruptions`.

## Schema validity — ground truth matches the REAL plugin-scheduling contract

An adversarial review found that the first cut encoded scheduled-task shapes
that **did not match** the authoritative zod schema
(`plugins/plugin-scheduling/src/scheduled-task/schema.ts`), so a schema-correct
agent scored 0.5 instead of 1.0. The corpus tests missed it because the
`SCHEDULED_TASK_CREATE` manifest overlay declares nested objects as
`additionalProperties: true`. Fixed against the real schema + production
default-packs (`plugins/plugin-personal-assistant/src/default-packs/`):

- **escalation steps** `afterMinutes` → `delayMinutes` (`escalationStepSchema`).
- **shouldFire** bare `{kind,…}` → `{gates:[{kind, params:{…}}]}`; gate params
  moved under `params` (`no_recent_user_message_in {minutes}`,
  `circadian_state_in {states}`, `quiet_hours`/`during_travel` no params — per
  the health packs).
- **completionCheck** top-level `lookbackMinutes` → `params.lookbackMinutes`
  (`daily-rhythm.ts`).
- **LIFE_CREATE** reminders: dropped the invalid `details.trigger` (the trigger
  union belongs to ScheduledTask); flexible/anchor/window recurrence is now a
  `SCHEDULED_TASK_CREATE(kind="reminder", trigger=…)`.
- **subject.kind** `"reminder"` (not in the enum) → `"self"` — this one was
  caught by the new guard itself.
- **LIVE mis-bucketing**: the 24 suppression/defer scenarios now set
  `expected_world_mutation="unchanged"` so a correctly-suppressing agent isn't
  score-inverted.
- **variant distinctness**: no family now emits byte-identical or duplicate
  variants (verified: 0 families with duplicate-variant ground truth).

**Systemic guard** (`scenarios/personas/schema_check.py`): a faithful Python
replica of the zod contract validates the nested trigger / shouldFire /
completionCheck / escalation / subject shapes of **every** persona ground-truth
action. Corpus tests assert zero drift on the persona packs AND prove the
checker has teeth (four negative tests catch each broken shape; one test
confirms it still flags the pre-existing non-persona pack drift, which is owned
elsewhere and out of scope for #12186).

## Task A3 — manifest regen: **skipped (correct)**

No LifeOps action metadata was changed (scenario data only references existing
actions), so `bun run lifeops-bench:manifest` was not run. `manifests/` is
untouched (`git status` clean for that path).

## Verification (all keyless / headless)

### 1. Corpus test — GREEN (20/20)

```
$ python -m pytest tests/test_scenarios_corpus.py -v
tests/test_scenarios_corpus.py::test_corpus_size_meets_minimum PASSED
tests/test_scenarios_corpus.py::test_corpus_expands_current_core_by_exactly_10x PASSED
tests/test_scenarios_corpus.py::test_unique_scenario_ids PASSED
tests/test_scenarios_corpus.py::test_every_action_name_exists_in_manifest PASSED
tests/test_scenarios_corpus.py::test_every_domain_has_minimum_coverage PASSED
tests/test_scenarios_corpus.py::test_referenced_world_ids_exist_in_snapshot PASSED
tests/test_scenarios_corpus.py::test_at_least_30_percent_have_first_question_fallback PASSED
tests/test_scenarios_corpus.py::test_live_scenarios_are_unscripted PASSED
tests/test_scenarios_corpus.py::test_persona_shape_sane PASSED
tests/test_scenarios_corpus.py::test_description_and_instruction_non_empty PASSED
tests/test_scenarios_corpus.py::test_authoring_validator_is_importable PASSED
tests/test_scenarios_corpus.py::test_authoring_validator_accepts_a_real_scenario PASSED
tests/test_scenarios_corpus.py::test_authoring_validator_rejects_fake_action_name PASSED
tests/test_scenarios_corpus.py::test_authoring_validator_rejects_fake_entity_id PASSED
tests/test_scenarios_corpus.py::test_persona_ground_truth_matches_real_zod_schema PASSED
tests/test_scenarios_corpus.py::test_schema_check_flags_preexisting_nonpersona_drift PASSED
tests/test_scenarios_corpus.py::test_schema_check_catches_afterMinutes_escalation PASSED
tests/test_scenarios_corpus.py::test_schema_check_catches_bare_should_fire_gate PASSED
tests/test_scenarios_corpus.py::test_schema_check_catches_top_level_completion_param PASSED
tests/test_scenarios_corpus.py::test_schema_check_catches_life_create_trigger PASSED
============================== 20 passed in 0.33s ==============================
```

This gate enforces: unique ids, all action names in the manifest, all entity ids
resolve in the snapshot, personas complete, ≥30% STATIC fallback ratio, LIVE
invariants (empty gt/outputs/null-fallback + non-empty
success_criteria/world_assertions), 10× edge-expansion integrity, **and — new —
that every persona ground-truth action matches the real plugin-scheduling zod
schema, with negative tests proving the checker catches each broken shape.**

### 2. Scenario count rose by ~240

```
$ python -m eliza_lifeops_bench --count-scenarios
{"base": 1260, "existing": 1260, "total": 13860, "variantsPerBase": 10,
 "summary": "1260 base scenarios; 10x prompt-prefix robustness variants = 13860 runs"}
# (was base=1020 / total=11220 before this branch)

$ python -m eliza_lifeops_bench --list-scenarios | grep -cE '^  (persona|live\.persona)\.'   # base persona lines
240
```

### 3. PerfectAgent ~1.0 / WrongAgent ~0.0 by construction (no model key)

Ran both oracles through the real runner over all 150 new persona STATIC
scenarios (proves each scenario is well-formed: real actions execute against the
real hashable world, real ids resolve, triviality guard defeats wrong agents).

```
=== PerfectAgent over 150 persona static scenarios ===
  adhd        n=30 mean=1.0000 min=1.0000 max=1.0000
  high_comms  n=30 mean=1.0000 min=1.0000 max=1.0000
  low_energy  n=30 mean=1.0000 min=1.0000 max=1.0000
  night_owl   n=30 mean=1.0000 min=1.0000 max=1.0000
  travel      n=30 mean=1.0000 min=1.0000 max=1.0000
  OVERALL mean=1.0000 min=1.0000 max=1.0000   pass@1 (>=0.99): 150/150 = 1.0000

=== WrongAgent over 150 persona static scenarios ===
  (every pack) mean=0.0000 min=0.0000 max=0.0000
  OVERALL mean=0.0000 min=0.0000 max=0.0000   pass@1 (>=0.99): 0/150 = 0.0000

=== VERDICT ===
PerfectAgent all >= 0.99: True
WrongAgent   all <= 0.01: True
```

And the smoke suite still passes with the perfect oracle:

```
$ python -m eliza_lifeops_bench --agent perfect --suite smoke
  Scenarios run: 5   pass@1: 1.000   (calendar/health/mail/messages/reminders all 1.000)
```

### 4. Difficulty is load-bearing AND the ground truth is schema-valid

The whole persona corpus is validated against the real plugin-scheduling zod
schema by `test_persona_ground_truth_matches_real_zod_schema` (runs over every
persona ground-truth action, not a cherry-picked sample) — so the difficulty
comes from correct-but-flexible shapes, not from invalid shapes that would
penalize a schema-correct agent.

Concrete polarity proof on a fixed scenario that carries escalation + a wrapped
gate + a nested completion param (`persona.low_energy.soft_escalation_only.v1`):

```
GT escalation.steps[0]:  {'delayMinutes': 0, 'channelKey': 'in_app', 'intensity': 'soft'}   # real schema (not afterMinutes)
GT shouldFire:           {'gates': [{'kind': 'no_recent_user_message_in', 'params': {'minutes': 45}}]}   # wrapped gates
GT completionCheck:      {'kind': 'user_replied_within', 'params': {'lookbackMinutes': 1440}}   # nested params

schema-correct answer (real shapes)     → action_score 1.0   # was 0.5 before the fix
old-broken-shape answer vs corrected GT → action_score 0.5   # invalid output now penalized
```

And the flexible-trigger requirement still bites — a rigid fixed-time answer
loses action score against the `during_window` / `relative_to_anchor` ground
truth (verified across the corpus by the schema-validated PerfectAgent=1.0 run:
a fixed `once` answer mismatches the trigger kwargs → 0.5, not 1.0).

## Env note

`data/snapshots/` is gitignored (generated). In a fresh worktree, rebuild before
running the corpus test / oracles:

```
cd packages/benchmarks/lifeops-bench && uv sync --extra test --extra anthropic
uv run python -m eliza_lifeops_bench.lifeworld.snapshots --rebuild
```

## LIVE-model-gated remainder — N/A (needs keys; not in scope for PART A)

Running the benchmark before/after for real pass@1 deltas (the DoD's optimized
before/after numbers) requires a live model and is the PART-B / evidence
closeout, gated purely on model access. Exact recipe (plan section G):

- **STATIC real-model run:**
  `CEREBRAS_API_KEY=... python -m eliza_lifeops_bench --agent cerebras-direct --mode static`
  (Cerebras: `OPENAI_BASE_URL=https://api.cerebras.ai/v1`, `gpt-oss-120b`.)
- **LIVE run** additionally needs `ANTHROPIC_API_KEY` (judge) +
  `CEREBRAS_API_KEY` (sim user):
  `CEREBRAS_API_KEY=... ANTHROPIC_API_KEY=... python -m eliza_lifeops_bench --agent cerebras-direct --mode live`
- **GEPA optimization loop:**
  `TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=... bun run --cwd plugins/plugin-training lifeops:gepa -- --trajectories <dir> --task <schedule_plan|calendar_extract|reminder_dispatch|...>`
  → promotion gate → `<stateDir>/optimized-prompts/<task>/`; re-run the benchmark
  to show uplift.
- **Live-LLM trajectories per PR_EVIDENCE:**
  `packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`
  against a live model, reviewed by hand.

Marked **N/A** here: no `CEREBRAS_API_KEY` / `ANTHROPIC_API_KEY` in this
environment. Frontend evidence is also N/A — this change adds no user-facing UI
surface (benchmark scenario data only).
