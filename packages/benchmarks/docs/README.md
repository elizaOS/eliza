# docs — benchmark suite cross-cutting documentation

Human-readable reference material produced during benchmark development and
certification passes. Not consumed programmatically; used by engineers reviewing
harness coverage, costs, and integration status.

## Files

| File | Contents |
|---|---|
| `BENCHMARK_PARITY_ASSESSMENT.md` | Audit of which benchmarks each harness (eliza / hermes / openclaw / smithers) supports, and where the asymmetry lies. Run via `orchestrator.discover_adapters`. |
| `RESULTS_MATRIX.md` | Benchmark × 4-harness score table, reconciled against the registry (44 registered + 9 adapter-only). Cells are real posted scores (from `benchmark_results/latest/`), `gated` (infra/credentials absent), or `not-run` (no committed graded run). |
| `COST_REPORT.md` | Per-benchmark token costs at calibration sample sizes for `gemma-4-31b` (Cerebras) and `claude-opus-4-8` (Anthropic); includes projected smithers rows. |
| `CERTIFICATION.md` | 4-harness certification pass record (2026-05-28): what was upgraded, what was posted, and what remains partial with blockers noted. |
| `BLOCKER_RESOLUTION.md` | Root-cause analysis and fixes for the three systemic infrastructure gaps (Docker daemon, missing Python deps, Node version) that previously blocked benchmark runs. |
| `SMITHERS_INTEGRATION.md` | Architecture of the Smithers harness adapter: how `SmithersClient` bridges Python orchestration to the Bun-based `OpenAIAgent`, including GEPA prompt-optimization wiring. |

## How it is used

These documents are written by benchmark runs and engineering analysis passes.
They are read by humans and referenced in `CERTIFICATION.md` cross-links. The
orchestrator itself does not parse this directory; canonical machine-readable
results live in `benchmark_results/latest/`.
