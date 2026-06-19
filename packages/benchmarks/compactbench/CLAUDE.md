# CompactBench — Agent Guide

Measures the *compaction layer* of elizaOS agents: feeds an adversarial
multi-turn transcript into a conversation-compactor strategy, replaces
history with the compactor's output, then probes with scoring questions
about facts, locked decisions, deferred items, forbidden behaviors, and
entity integrity across repeated compact→continue→compact drift cycles.
Not registered in the suite orchestrator — run directly.

## Run

```bash
# From packages/benchmarks/compactbench/
export CEREBRAS_API_KEY=...
./run.sh                                   # NaiveSummaryCompactor, elite_practice suite

# Override the compactor strategy:
COMPACT_METHOD=HybridLedgerCompactor ./run.sh
COMPACT_METHOD=StructuredStateCompactor ./run.sh
COMPACT_METHOD=HierarchicalSummaryCompactor ./run.sh

# Programmatic runner (more flags):
python run_cerebras.py \
  --method ./eliza_compactbench/compactors/__init__.py:HybridLedgerCompactor \
  --suite starter \
  --benchmarks-dir external/compactbench-suites/benchmarks/public \
  --output results-hybrid.jsonl \
  --score --analyze-valid-hits
```

`run.sh` creates `.venv`, runs `pip install -e ".[dev]"`, clones the upstream
suite YAMLs into `./external/compactbench-suites` on first run, and falls back
to `--provider groq` (`COMPACTBENCH_GROQ_API_KEY`) if Cerebras registration
fails.

## Smoke test (no API keys)

No built-in `--mock` flag. To exercise the harness without live inference,
pass `--provider mock` directly to `compactbench run` after installing:

```bash
pip install -e ".[dev]"
compactbench run \
  --method ./eliza_compactbench/compactors/__init__.py:NaiveSummaryCompactor \
  --suite starter \
  --provider mock \
  --model mock-1 \
  --benchmarks-dir external/compactbench-suites/benchmarks/public \
  --output results-smoke.jsonl
```

## Test the harness

```bash
cd packages/benchmarks/compactbench
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/ -v                          # excludes live tests by default
pytest tests/test_valid_hits.py -v        # focused scorer tests
COMPACTBENCH_LIVE=1 pytest tests/live_test_cerebras.py  # needs CEREBRAS_API_KEY
```

## Layout

| Path | Role |
| --- | --- |
| `run.sh` | Primary shell entrypoint (venv + install + run) |
| `run_cerebras.py` | Programmatic Python runner with extra flags |
| `analyze_valid_hits.py` | Rerun + repaired-scorer analysis tool |
| `eliza_compactbench/compactors/__init__.py` | Five `compactbench.Compactor` subclasses |
| `eliza_compactbench/bridge.py` | Python→bun subprocess bridge |
| `eliza_compactbench/ts_bridge.ts` | TS shim that dispatches to TS strategies |
| `eliza_compactbench/cerebras_provider.py` | Cerebras OpenAI-compatible provider |
| `eliza_compactbench/valid_hits.py` | Repaired response-level scorer |
| `hermes_compactbench/compactors.py` | HermesNativeToolCompactor adapter |
| `tests/` | pytest suite (live tests gated by `COMPACTBENCH_LIVE=1`) |
| `external/` | Cloned upstream suite YAMLs (gitignored) |

## Compactor strategies

| Class | Strategy id | Notes |
| --- | --- | --- |
| `PromptStrippingPassthroughCompactor` | `prompt-stripping-passthrough` | Baseline; no semantic compaction |
| `NaiveSummaryCompactor` | `naive-summary` | Default in `run.sh` |
| `StructuredStateCompactor` | `structured-state` | Emits six-section schema |
| `HierarchicalSummaryCompactor` | `hierarchical-summary` | Better on long transcripts |
| `HybridLedgerCompactor` | `hybrid-ledger` | Highest expected; accumulates across cycles |

## Notes

- Results write to `./results/results.<timestamp>.jsonl` (created by `run.sh`)
  or the path given via `--output`.
- Not registered in the suite orchestrator (`registry/commands.py`); no
  `benchmarks.orchestrator run` invocation path.
- The upstream CompactBench scorer is lexical; the elizaOS harness ships a
  repaired scorer (`valid_hits.py`) that corrects morphological false negatives.
- `run_openclaw.py` is intentionally fail-closed (exits non-zero; OpenClaw CLI
  lacks the transcript-in/artifact-out API CompactBench requires).
- `bun` must be on `PATH` — the bridge spawns `bun run ts_bridge.ts`.
- Full background: [README.md](README.md).
