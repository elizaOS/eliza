# MINT — Agent Guide

Faithful port of the UIUC **MINT** benchmark (Wang et al., ICLR 2024,
[arXiv:2309.10691](https://arxiv.org/abs/2309.10691)): evaluates LLMs in
**M**ulti-turn **INT**eraction across 8 subtasks (HumanEval, MBPP, MATH,
GSM8K, HotpotQA, MMLU, TheoremQA, AlfWorld) with tools and feedback ablations.
Registered in the suite registry as `mint`.

## Run

```bash
# Direct, from the repo root
python packages/benchmarks/mint/run_benchmark.py \
    --subtasks humaneval gsm8k math \
    --max-tasks 5 \
    --feedback templated \
    --provider openai \
    --model gpt-4

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks mint --provider <p> --model <m>
```

## Smoke test (no API keys, no network)

```bash
python packages/benchmarks/mint/run_benchmark.py \
    --use-sample-tasks \
    --provider mock \
    --no-ablation
```

`--use-sample-tasks` loads a tiny offline fixture. `--provider mock` enables
the ground-truth mock answer path (returns 100 % on the smoke set only; never
publishable).

## Test the harness

```bash
pytest packages/benchmarks/mint/ -v
```

73 tests, Python 3.12. No install step needed (package is imported from the
repo tree).

## Layout

| Path | Role |
| --- | --- |
| `run_benchmark.py` | CLI entrypoint |
| `runner.py` | Async execution loop, ablation orchestration |
| `agent.py` | `MINTAgent` — multi-turn solver |
| `evaluator.py` | Per-subtask graders (code_test, numeric, partial_match, …) |
| `executor.py` | `PythonExecutor` (Docker sandbox or restricted in-process) |
| `feedback.py` | `templated` and `llm` feedback generators |
| `metrics.py` | Turn-k success rate calculation |
| `types.py` | `MINTConfig`, `MINTSubtask`, `MINTResult`, `MINTMetrics` |
| `dataset.py` | Data loading + lazy upstream cache fetch |
| `tests/` | pytest suite (8 test files) |
| `upstream/` | Vendored Apache-2.0 upstream (executor sandbox, prompt templates) |

## Notes

- Results write to `./benchmark_results/mint/mint-benchmark-results.json`
  (gitignored).
- Scored by `_score_from_mint_json` in `registry/scores.py`.
- Upstream data is lazy-fetched into `~/.cache/elizaos/mint/processed` on
  first run. Pass `--data-path /path/to/mint-bench/data/processed` to use an
  existing checkout, or `--no-auto-fetch` to make missing data a hard error.
- AlfWorld requires `textworld` + downloaded game files; pass a prepared
  upstream data path when including it.
- Feedback mode: `templated` (deterministic, default) or `llm` (GPT-4 prompt
  template from upstream, requires a live provider).
- Full background: [README.md](README.md). Upstream attribution:
  [upstream/README.md](upstream/README.md).
