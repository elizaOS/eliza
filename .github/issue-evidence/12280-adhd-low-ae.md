# Issue #12280 Evidence: ADHD + Low-Activation A/E

Branch: `codex/lifeops-bench-adhd-low-ae`

Stack base: `codex/lifeops-bench-sleep-shift-b1-b2`

## Implemented

- Added `PERSONA_CASEY_ADHD` and `PERSONA_TARA_LOW` to `_personas.py` and `ALL_PERSONAS`.
- Added 12 static ADHD capture/start scenarios in `adhd_capture.py`.
- Added 8 live ADHD capture/start scenarios in `live/adhd_capture.py`.
- Added 16 live ADHD follow-through scenarios in `live/adhd_followthrough.py`.
- Added 10 static low-activation scenarios in `low_activation.py`.
- Added 8 live low-activation scenarios in `live/low_activation.py`.
- Registered the static and live scenario lists.
- Updated cumulative corpus accounting from 1346 base / 14806 runs to 1400 base / 15400 runs.

## Hand Review

- Confirmed `adhd.capture.buried_commitment_in_ramble` preserves the issue exemplar's buried landlord-form commitment, distractor suppression, fallback, and required outputs.
- Confirmed `live.adhd.task_initiation_two_minute_step` preserves the issue exemplar's one-step initiation support, consent boundary, non-shaming criteria, and expected mutation.
- Confirmed `live.lowact.crisis_language_boundary` preserves the issue exemplar's safety boundary, crisis-resource handoff, no-productivity criteria, and `expected_world_mutation="unchanged"`.
- Confirmed `casey_adhd` and `tara_low` are present exactly once.

## Validation

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 -m compileall -q \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/adhd_capture.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/adhd_capture.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/adhd_followthrough.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/low_activation.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/low_activation.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_personas.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/__init__.py \
  packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/__init__.py
```

Passed.

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 - <<'PY'
from eliza_lifeops_bench.scenarios import count_lifeops_scenarios, validate_lifeops_scenarios, SCENARIOS_BY_ID
from eliza_lifeops_bench.scenarios.adhd_capture import ADHD_CAPTURE_SCENARIOS
from eliza_lifeops_bench.scenarios.low_activation import LOW_ACTIVATION_SCENARIOS
from eliza_lifeops_bench.scenarios.live.adhd_capture import LIVE_ADHD_CAPTURE_SCENARIOS
from eliza_lifeops_bench.scenarios.live.adhd_followthrough import LIVE_ADHD_FOLLOWTHROUGH_SCENARIOS
from eliza_lifeops_bench.scenarios.live.low_activation import LIVE_LOW_ACTIVATION_SCENARIOS
from eliza_lifeops_bench.scenarios._personas import ALL_PERSONAS
ids = [s.id for s in ADHD_CAPTURE_SCENARIOS + LOW_ACTIVATION_SCENARIOS + LIVE_ADHD_CAPTURE_SCENARIOS + LIVE_ADHD_FOLLOWTHROUGH_SCENARIOS + LIVE_LOW_ACTIVATION_SCENARIOS]
print(count_lifeops_scenarios())
print(validate_lifeops_scenarios())
print(len(ADHD_CAPTURE_SCENARIOS), len(LIVE_ADHD_CAPTURE_SCENARIOS), len(LIVE_ADHD_FOLLOWTHROUGH_SCENARIOS), len(LOW_ACTIVATION_SCENARIOS), len(LIVE_LOW_ACTIVATION_SCENARIOS), len(ids))
print([i for i in ids if i not in SCENARIOS_BY_ID])
print([p.id for p in ALL_PERSONAS].count('casey_adhd'), [p.id for p in ALL_PERSONAS].count('tara_low'))
PY
```

Observed:

```text
{'suite': 'lifeops-bench', 'existing': 1400, 'added': 14000, 'total': 15400, 'multiplierAdded': 10.0, 'base': 1400, 'variantsPerBase': 10, 'totalRuns': 15400, 'summary': '1400 base scenarios; 10x prompt-prefix robustness variants = 15400 runs'}
{'valid': True, 'total': 15400, 'uniqueIds': 15400, 'duplicateIds': [], 'emptyInstructions': [], 'expansionMatches': True}
12 8 16 10 8 54
[]
1 1
```

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 -m pytest \
  packages/benchmarks/lifeops-bench/tests/test_scenarios_corpus.py::test_corpus_expands_current_core_by_exactly_10x -q
```

Passed.

## Notes

Full `tests/test_scenarios_corpus.py` cannot be run in this worktree because
`packages/benchmarks/lifeops-bench/data/snapshots/` is absent. The focused checks
above cover compile/import, registry accounting, duplicate IDs, edge expansion,
persona uniqueness, and scenario discoverability for this chunk.
