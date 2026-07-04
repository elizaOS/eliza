# Issue #12282 Evidence: Neurotypical Control F1

Branch: `codex/lifeops-bench-control-f1`

Stack base: `codex/lifeops-bench-traveler-c1`

## Implemented

- Added 8 static control/adversarial scenarios in `neurotypical_control.py`.
- Added 10 live control/adversarial scenarios in `live/neurotypical_control.py`.
- Added `_catalogs/neurotypical-control-adversarial.catalog.json` with 18 catalog entries.
- Registered the static and live scenario lists.
- Updated cumulative corpus accounting from 1278 base / 14058 runs to 1296 base / 14256 runs.

## Validation

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 -m compileall -q \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/neurotypical_control.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/neurotypical_control.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/__init__.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/__init__.py
```

Passed.

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 - <<'PY'
from eliza_lifeops_bench.scenarios import count_lifeops_scenarios, validate_lifeops_scenarios, SCENARIOS_BY_ID
from eliza_lifeops_bench.scenarios.neurotypical_control import NEUROTYPICAL_CONTROL_SCENARIOS
from eliza_lifeops_bench.scenarios.live.neurotypical_control import LIVE_NEUROTYPICAL_CONTROL_SCENARIOS

ids = [s.id for s in NEUROTYPICAL_CONTROL_SCENARIOS] + [s.id for s in LIVE_NEUROTYPICAL_CONTROL_SCENARIOS]
print(count_lifeops_scenarios())
print(validate_lifeops_scenarios())
print(len(NEUROTYPICAL_CONTROL_SCENARIOS), len(LIVE_NEUROTYPICAL_CONTROL_SCENARIOS), len(ids))
print([i for i in ids if i not in SCENARIOS_BY_ID])
PY
```

Observed:

```text
{'suite': 'lifeops-bench', 'existing': 1296, 'added': 12960, 'total': 14256, 'multiplierAdded': 10.0, 'base': 1296, 'variantsPerBase': 10, 'totalRuns': 14256, 'summary': '1296 base scenarios; 10x prompt-prefix robustness variants = 14256 runs'}
{'valid': True, 'total': 14256, 'uniqueIds': 14256, 'duplicateIds': [], 'emptyInstructions': [], 'expansionMatches': True}
8 10 18
[]
```

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 -m pytest \
  packages/benchmarks/lifeops-bench/tests/test_scenarios_corpus.py::test_corpus_expands_current_core_by_exactly_10x -q
```

Passed.

```bash
python3 -m json.tool \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_catalogs/neurotypical-control-adversarial.catalog.json
```

Passed.

## Notes

Full `tests/test_scenarios_corpus.py` could not be run in this worktree because
`packages/benchmarks/lifeops-bench/data/snapshots/` is absent. The focused checks
above cover compile/import, registry accounting, duplicate IDs, edge expansion,
scenario discoverability, and catalog JSON validity for this chunk.
