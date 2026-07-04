# Issue #12281 Evidence: Comms Flood D1

Branch: `codex/lifeops-bench-comms-d1`

Stack base: `codex/lifeops-bench-control-f1`

## Implemented

- Added 10 static comms-flood scenarios in `comms_flood_triage.py`.
- Added 8 live comms-flood scenarios in `live/comms_flood_triage.py`.
- Added `_catalogs/comms-flood-triage.catalog.json` with 18 catalog entries.
- Added the `dre_flood` persona when absent from the current stack.
- Registered the static and live scenario lists.
- Updated cumulative corpus accounting from 1296 base / 14256 runs to 1314 base / 14454 runs.

## Hand Review

- Confirmed the static VIP allow-list scenario lands the issue's exemplar text and two required `priorityFlag: "vip_breakthrough"` records for Priya Anand and Lindell Elementary.
- Confirmed the live missed-VIP trust-collapse scenario lands the issue's hard-fail exemplar text and pass/fail success criteria.
- Confirmed the prompt-injection trap uses a `new_message` disruption, not `rule_change`, with world assertions forbidding action on the embedded body text.
- Confirmed the wrong-recipient trap requires explicit recipient confirmation before any send.
- Confirmed the false-urgency case demotes all-caps marketing urgency without weakening real VIP categories.

## Validation

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 -m compileall -q \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/comms_flood_triage.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/comms_flood_triage.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_personas.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/__init__.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/__init__.py
```

Passed.

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 - <<'PY'
from eliza_lifeops_bench.scenarios import count_lifeops_scenarios, validate_lifeops_scenarios, SCENARIOS_BY_ID
from eliza_lifeops_bench.scenarios.comms_flood_triage import COMMS_FLOOD_TRIAGE_SCENARIOS
from eliza_lifeops_bench.scenarios.live.comms_flood_triage import LIVE_COMMS_FLOOD_TRIAGE_SCENARIOS

ids = [s.id for s in COMMS_FLOOD_TRIAGE_SCENARIOS] + [s.id for s in LIVE_COMMS_FLOOD_TRIAGE_SCENARIOS]
print(count_lifeops_scenarios())
print(validate_lifeops_scenarios())
print(len(COMMS_FLOOD_TRIAGE_SCENARIOS), len(LIVE_COMMS_FLOOD_TRIAGE_SCENARIOS), len(ids))
print([i for i in ids if i not in SCENARIOS_BY_ID])
PY
```

Observed:

```text
{'suite': 'lifeops-bench', 'existing': 1314, 'added': 13140, 'total': 14454, 'multiplierAdded': 10.0, 'base': 1314, 'variantsPerBase': 10, 'totalRuns': 14454, 'summary': '1314 base scenarios; 10x prompt-prefix robustness variants = 14454 runs'}
{'valid': True, 'total': 14454, 'uniqueIds': 14454, 'duplicateIds': [], 'emptyInstructions': [], 'expansionMatches': True}
10 8 18
[]
```

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 -m pytest \
  packages/benchmarks/lifeops-bench/tests/test_scenarios_corpus.py::test_corpus_expands_current_core_by_exactly_10x -q
```

Passed.

```bash
python3 -m json.tool \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_catalogs/comms-flood-triage.catalog.json
```

Passed.

## Notes

Full `tests/test_scenarios_corpus.py` cannot be run in this worktree because
`packages/benchmarks/lifeops-bench/data/snapshots/` is absent. The focused checks
above cover compile/import, registry accounting, duplicate IDs, edge expansion,
scenario discoverability, and catalog JSON validity for this chunk.
