# Issue #12279 Evidence: Traveler Timezone C1

Branch: `codex/lifeops-bench-traveler-c1`

## Implemented

- Added `PERSONA_ELENA_ROAD` (`elena_road`) for the issue-specific traveler persona.
- Added 8 static scenarios in `traveler_timezone.py`.
- Added 10 live scenarios in `live/traveler_timezone.py`.
- Added `_catalogs/traveler-timezone-truth.catalog.json` with 18 catalog entries.
- Registered static and live scenarios in the LifeOpsBench registries.
- Updated the pinned corpus accounting from 1260 base / 13860 runs to 1278 base / 14058 runs.

## Validation

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench \
  python3 -m compileall -q \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/traveler_timezone.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/traveler_timezone.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_personas.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/__init__.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/__init__.py
```

Passed.

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 - <<'PY'
from eliza_lifeops_bench.scenarios import count_lifeops_scenarios, validate_lifeops_scenarios, SCENARIOS_BY_ID
from eliza_lifeops_bench.scenarios.traveler_timezone import TRAVELER_TIMEZONE_SCENARIOS
from eliza_lifeops_bench.scenarios.live.traveler_timezone import LIVE_TRAVELER_TIMEZONE_SCENARIOS

ids = [s.id for s in TRAVELER_TIMEZONE_SCENARIOS] + [s.id for s in LIVE_TRAVELER_TIMEZONE_SCENARIOS]
print(count_lifeops_scenarios())
print(validate_lifeops_scenarios())
print(len(TRAVELER_TIMEZONE_SCENARIOS), len(LIVE_TRAVELER_TIMEZONE_SCENARIOS), len(ids))
print([i for i in ids if i not in SCENARIOS_BY_ID])
PY
```

Observed:

```text
{'suite': 'lifeops-bench', 'existing': 1278, 'added': 12780, 'total': 14058, 'multiplierAdded': 10.0, 'base': 1278, 'variantsPerBase': 10, 'totalRuns': 14058, 'summary': '1278 base scenarios; 10x prompt-prefix robustness variants = 14058 runs'}
{'valid': True, 'total': 14058, 'uniqueIds': 14058, 'duplicateIds': [], 'emptyInstructions': [], 'expansionMatches': True}
8 10 18
[]
```

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench \
  python3 -m pytest \
  packages/benchmarks/lifeops-bench/tests/test_scenarios_corpus.py::test_corpus_expands_current_core_by_exactly_10x -q
```

Passed.

```bash
python3 -m json.tool \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_catalogs/traveler-timezone-truth.catalog.json
```

Passed.

## Notes

Full `tests/test_scenarios_corpus.py` could not be run in this worktree because
`packages/benchmarks/lifeops-bench/data/snapshots/` is absent. The focused checks
above cover compile/import, registry accounting, duplicate IDs, edge expansion,
scenario discoverability, and catalog JSON validity for this chunk.
