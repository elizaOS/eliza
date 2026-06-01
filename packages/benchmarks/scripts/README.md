# scripts

Helper scripts for the elizaOS benchmark suite. These are standalone CLI tools that sit on top of the orchestrator and `lib/` modules; they are not benchmarks themselves.

## Files

| File | Purpose |
|---|---|
| `acceptance_gate.py` | Phase 7 acceptance gate. Runs a fixed sequence of verification steps (env precheck, Cerebras API smoke, per-agent smoke, sanity benchmark run, random-baseline comparison, trajectory normalization check) and exits `0` only when all required steps pass. Invokes `benchmarks.orchestrator` via subprocess so the full integration path is exercised. |
| `compute_costs.py` | Cost projection tool. Reads token-usage data from `benchmark_results/latest/<benchmark>__<harness>.json` snapshots and emits a markdown cost report (`docs/COST_REPORT.md`) priced against Cerebras `gpt-oss-120b` and Anthropic `claude-opus-4-8`. Also prints a per-harness summary to stdout. |

## How to run

```bash
# From packages/benchmarks:
python scripts/acceptance_gate.py --help
python -m scripts.compute_costs
python -m scripts.compute_costs --json   # machine-readable summary
```

Both scripts require `packages/benchmarks` to be on `sys.path` so they can import `benchmarks.lib.*`. The orchestrator and `lib/` internals are documented in `../AGENTS.md`.
