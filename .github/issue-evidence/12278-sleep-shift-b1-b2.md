# Issue #12278 Evidence: Night-Owl + Shift-Rotation B1/B2

Branch: `codex/lifeops-bench-sleep-shift-b1-b2`

Stack base: `codex/lifeops-bench-comms-d1`

## Implemented

- Added `PERSONA_NOOR_NIGHT` and `PERSONA_MARCUS_SHIFT` to `_personas.py` and `ALL_PERSONAS`.
- Added 10 static night-owl anchored-day scenarios in `night_owl_anchored_day.py`.
- Added 6 live night-owl anchored-day scenarios in `live/night_owl_anchored_day.py`.
- Added 8 static shift-rotation scenarios in `shift_rotation.py`.
- Added 8 live shift-rotation scenarios in `live/shift_rotation.py`.
- Added `_catalogs/night-owl-anchored-day.catalog.json` and `_catalogs/shift-rotation.catalog.json` with all 32 entries.
- Registered the static and live scenario lists.
- Updated cumulative corpus accounting from 1314 base / 14454 runs to 1346 base / 14806 runs.

## Hand Review

- Confirmed `nightowl.anchored.wake_relative_morning_brief` preserves the issue exemplar's anchor-relative morning brief semantics and fallback.
- Confirmed `live.nightowl.wake_confirmation_fires_brief` preserves the issue exemplar's "just woke up" same-turn firing criteria.
- Confirmed `live.shiftrotation.sleep_protection_violation_requires_confirm` preserves the issue exemplar's calendar-domain protected-sleep conflict, fail-closed world assertions, and `expected_world_mutation="unchanged"`.
- Confirmed both new persona IDs are present exactly once.

## Validation

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 -m compileall -q \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/night_owl_anchored_day.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/shift_rotation.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/night_owl_anchored_day.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/shift_rotation.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_personas.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/__init__.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/__init__.py
```

Passed.

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 - <<'PY'
from eliza_lifeops_bench.scenarios import count_lifeops_scenarios, validate_lifeops_scenarios, SCENARIOS_BY_ID
from eliza_lifeops_bench.scenarios.night_owl_anchored_day import NIGHT_OWL_ANCHORED_DAY_SCENARIOS
from eliza_lifeops_bench.scenarios.shift_rotation import SHIFT_ROTATION_SCENARIOS
from eliza_lifeops_bench.scenarios.live.night_owl_anchored_day import LIVE_NIGHT_OWL_ANCHORED_DAY_SCENARIOS
from eliza_lifeops_bench.scenarios.live.shift_rotation import LIVE_SHIFT_ROTATION_SCENARIOS
from eliza_lifeops_bench.scenarios._personas import ALL_PERSONAS
ids = [s.id for s in NIGHT_OWL_ANCHORED_DAY_SCENARIOS + SHIFT_ROTATION_SCENARIOS + LIVE_NIGHT_OWL_ANCHORED_DAY_SCENARIOS + LIVE_SHIFT_ROTATION_SCENARIOS]
print(count_lifeops_scenarios())
print(validate_lifeops_scenarios())
print(len(NIGHT_OWL_ANCHORED_DAY_SCENARIOS), len(LIVE_NIGHT_OWL_ANCHORED_DAY_SCENARIOS), len(SHIFT_ROTATION_SCENARIOS), len(LIVE_SHIFT_ROTATION_SCENARIOS), len(ids))
print([i for i in ids if i not in SCENARIOS_BY_ID])
print([p.id for p in ALL_PERSONAS].count('noor_night'), [p.id for p in ALL_PERSONAS].count('marcus_shift'))
PY
```

Observed:

```text
{'suite': 'lifeops-bench', 'existing': 1346, 'added': 13460, 'total': 14806, 'multiplierAdded': 10.0, 'base': 1346, 'variantsPerBase': 10, 'totalRuns': 14806, 'summary': '1346 base scenarios; 10x prompt-prefix robustness variants = 14806 runs'}
{'valid': True, 'total': 14806, 'uniqueIds': 14806, 'duplicateIds': [], 'emptyInstructions': [], 'expansionMatches': True}
10 6 8 8 32
[]
1 1
```

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 -m pytest \
  packages/benchmarks/lifeops-bench/tests/test_scenarios_corpus.py::test_corpus_expands_current_core_by_exactly_10x -q
```

Passed.

```bash
python3 -m json.tool \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_catalogs/night-owl-anchored-day.catalog.json

python3 -m json.tool \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_catalogs/shift-rotation.catalog.json
```

Passed.

## Notes

Full `tests/test_scenarios_corpus.py` cannot be run in this worktree because
`packages/benchmarks/lifeops-bench/data/snapshots/` is absent. The focused checks
above cover compile/import, registry accounting, duplicate IDs, edge expansion,
persona uniqueness, scenario discoverability, and catalog JSON validity for this chunk.
