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
   rigid fixed-time answer loses action-score. **Verified empirically:** a fixed
   `once`/`due` answer scores **0.5** action-credit vs **1.0** for the correct
   flexible-window answer (name matches, trigger kwargs mismatch).
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
`data/snapshots/medium_seed_2026.json` (`list_personal`, `list_work`,
`cal_primary`, `cal_work`, `contact_00003/07/09`, `event_00040`,
`reminder_00000/05`, `sub_003`, `conv_0006`). LIVE scenarios leave
gt/required_outputs empty + fallback None, and carry
`success_criteria`/`world_assertions`/`disruptions`.

## Task A3 — manifest regen: **skipped (correct)**

No LifeOps action metadata was changed (scenario data only references existing
actions), so `bun run lifeops-bench:manifest` was not run. `manifests/` is
untouched (`git status` clean for that path).

## Verification (all keyless / headless)

### 1. Corpus test — GREEN (14/14)

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
============================== 14 passed in 0.32s ==============================
```

This gate enforces: unique ids, all action names in the manifest, all entity ids
resolve in the snapshot, personas complete, ≥30% STATIC fallback ratio, LIVE
invariants (empty gt/outputs/null-fallback + non-empty
success_criteria/world_assertions), and 10× edge-expansion integrity.

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

### 4. Flexible-trigger difficulty is load-bearing (verified)

```
persona.adhd.flexible_daily_habit.v1  (GT: LIFE_CREATE, trigger during_window=evening)
  flexible-GT vs rigid fixed-time answer  → action_score 0.5
  flexible-GT vs correct replay           → action_score 1.0
persona.adhd.object_permanence_resurface.v1 (GT trigger during_window=morning)
  during_window-GT vs rigid `once` answer → action_score 0.5
```

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
