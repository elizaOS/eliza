# Issue #12186 Final Merged Validation

Date: 2026-07-04

Merged PRs:

- #12531: traveler timezone pack plus collapsed lower-stack changes into `develop`
- #12534: neurotypical control pack, merged into the traveler stack branch
- #12568: comms flood pack plus collapsed upper-stack changes, merged into the traveler stack branch
- #12584: night-owl + shift-rotation packs, merged into the comms stack branch
- #12595: ADHD + low-activation packs, merged into the sleep/shift stack branch

## Merged Corpus Validation

Ran on `origin/develop` after #12531 merged:

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 -m pytest \
  packages/benchmarks/lifeops-bench/tests/test_scenarios_corpus.py::test_corpus_expands_current_core_by_exactly_10x -q
```

Observed:

```text
.                                                                        [100%]
```

Ran:

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 - <<'PY'
from eliza_lifeops_bench.scenarios import count_lifeops_scenarios, validate_lifeops_scenarios
print(count_lifeops_scenarios())
print(validate_lifeops_scenarios())
PY
```

Observed:

```text
{'suite': 'lifeops-bench', 'existing': 1400, 'added': 14000, 'total': 15400, 'multiplierAdded': 10.0, 'base': 1400, 'variantsPerBase': 10, 'totalRuns': 15400, 'summary': '1400 base scenarios; 10x prompt-prefix robustness variants = 15400 runs'}
{'valid': True, 'total': 15400, 'uniqueIds': 15400, 'duplicateIds': [], 'emptyInstructions': [], 'expansionMatches': True}
```

## Live Model Probe

Ran a bounded Cerebras static probe on the merged corpus:

```bash
PYTHONPATH=packages/benchmarks/lifeops-bench python3 -m eliza_lifeops_bench \
  --agent cerebras-direct \
  --scenario adhd.capture.buried_commitment_in_ramble \
  --mode static \
  --limit 1 \
  --max-cost-usd 0.50 \
  --concurrency 1 \
  --output-dir .github/issue-evidence/12186-final-live-probe
```

Observed:

```text
Starting LifeOpsBench with 1 scenarios x 1 seeds...
Agent:           cerebras-direct
Model tier:      large (cerebras -> gemma-4-31b)
Scenarios run:      1
pass@1:             0.000
Total latency:      4.07s
Full results saved to: .github/issue-evidence/12186-final-live-probe/lifeops_gemma-4-31b_20260703_232110.json
```

Manual artifact review: the live model executed the real Cerebras path and
created a `LIFE_CREATE` reminder for the ADHD buried-commitment scenario. The
required output substrings matched, but the benchmark scored 0 because the model
used a different reminder shape from the exact ground truth, so this is a valid
pre-optimization baseline failure rather than a harness failure.

## Known Limits

- The full `tests/test_scenarios_corpus.py` suite still cannot run in this
  worktree because `packages/benchmarks/lifeops-bench/data/snapshots/` is absent.
- LIVE-mode judged runs require both `CEREBRAS_API_KEY` and `ANTHROPIC_API_KEY`;
  this environment only exposed Cerebras credentials, so the durable real-model
  proof is a static Cerebras probe.
