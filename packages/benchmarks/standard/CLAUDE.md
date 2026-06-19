# Standard Academic Benchmarks — Agent Guide

Four classic NLP/coding evaluation adapters — MMLU, HumanEval, GSM8K, and MT-Bench —
all dispatched through `../run.py` and registered in the suite registry as `mmlu`,
`humaneval`, `gsm8k`, and `mt_bench`.

## Run

```bash
# Direct — one adapter at a time (from the repo root or benchmarks/ dir)
python -m benchmarks.standard.mmlu \
    --provider openai --model gpt-4o-mini \
    --output /tmp/mmlu-out

python -m benchmarks.standard.humaneval \
    --provider openai --model gpt-4o-mini \
    --output /tmp/humaneval-out

python -m benchmarks.standard.gsm8k \
    --provider openai --model gpt-4o-mini \
    --output /tmp/gsm8k-out

python -m benchmarks.standard.mt_bench \
    --provider openai --model eliza-1-9b \
    --judge-provider openai --judge-model gpt-4o \
    --output /tmp/mt-bench-out

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks mmlu --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks humaneval --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks gsm8k --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks mt_bench --provider <p> --model <m>
```

## Smoke test (no API keys)

All four adapters support `--mock` for a deterministic offline run using built-in fixtures.

```bash
python -m benchmarks.standard.mmlu --mock --provider openai --model mock \
    --output /tmp/mmlu-smoke --api-key-env DOES_NOT_EXIST

python -m benchmarks.standard.humaneval --mock --provider openai --model mock \
    --output /tmp/humaneval-smoke --api-key-env DOES_NOT_EXIST

python -m benchmarks.standard.gsm8k --mock --provider openai --model mock \
    --output /tmp/gsm8k-smoke --api-key-env DOES_NOT_EXIST

python -m benchmarks.standard.mt_bench --mock --provider openai --model mock \
    --output /tmp/mt-bench-smoke --api-key-env DOES_NOT_EXIST
```

## Test the harness

```bash
# From the benchmarks/ package root
pytest standard/tests/ -v
```

No extra install step — the `standard/` package is part of the `benchmarks` namespace.

## Layout

| Path | Role |
| --- | --- |
| `mmlu.py` | MMLU adapter (cais/mmlu, 57-subject 4-way multiple choice) |
| `humaneval.py` | HumanEval adapter (164 Python pass@1 problems) |
| `gsm8k.py` | GSM8K adapter (grade-school math, `#### <int>` scoring) |
| `mt_bench.py` | MT-Bench adapter (80 multi-turn prompts, LLM-as-judge) |
| `trajectory_replay.py` | Trajectory replay adapter (shared module) |
| `agent_command.py` | Agent command execution helper |
| `code_agent_humaneval.py` | Code-agent variant of HumanEval |
| `_base.py` | Shared runner base classes, client abstractions, mock client |
| `_cli.py` | Shared argparse scaffolding (`build_parser`, `run_cli`) |
| `tests/` | pytest suite for all adapters |

## Notes

- Results write to `<output>/mmlu-results.json`, `humaneval-results.json`,
  `gsm8k-results.json`, or `mt-bench-results.json` respectively.
- Scored by `_score_from_mmlu_json`, `_score_from_humaneval_json`,
  `_score_from_gsm8k_json`, `_score_from_mt_bench_json` in `registry/scores.py`.
- MMLU and GSM8K load datasets lazily via `datasets` (HuggingFace); built-in
  fixtures are used as fallback when the package is absent or `--mock` is set.
- HumanEval prefers `bigcode-evaluation-harness` when installed; falls back to a
  built-in sandboxed execution loop.
- MT-Bench requires a separate judge model/endpoint; the judge and candidate model
  can be on different providers.
- All adapters record per-turn trajectories to `<output>/trajectories.jsonl`.
