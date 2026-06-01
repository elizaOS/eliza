# VisualWebBench — Agent Guide

Seven-subtask multimodal web understanding and grounding benchmark, faithfully
implementing [VisualWebBench](https://huggingface.co/datasets/visualwebbench/VisualWebBench)
(Apache-2.0). Evaluates ROUGE-L (captions/OCR), F1 (WebQA), and MCQ accuracy
(grounding/action). Registered in the suite registry as `visualwebbench`.

## Run

```bash
# Direct, from packages/benchmarks/visualwebbench/
PYTHONPATH=packages:packages/benchmarks/eliza-adapter \
  python -m benchmarks.visualwebbench --max-tasks 70

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks visualwebbench --provider <p> --model <m>
```

## Smoke test (no API keys, no HF download)

```bash
PYTHONPATH=packages:packages/benchmarks/eliza-adapter \
  python -m benchmarks.visualwebbench --use-sample-tasks --mock --max-tasks 7
```

`--mock` echoes `task.answer` through the oracle agent (always 100 %). Combined
with `--use-sample-tasks` it uses the bundled 7-row JSONL fixture — one row per
subtask, no images, no network calls. Scores from this path are not comparable
to upstream.

## Test the harness

```bash
pip install -e ".[dev]"
pytest visualwebbench/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | Argument parsing, `main()` entrypoint |
| `__main__.py` | `python -m benchmarks.visualwebbench` hook |
| `runner.py` | Async execution loop across all subtasks |
| `agent.py` | Eliza adapter + oracle mock agent |
| `dataset.py` | HF streaming loader and JSONL fixture reader |
| `evaluator.py` | Per-subtask ROUGE / F1 / MCQ scorers |
| `types.py` | Dataclasses and enums (`VisualWebBenchTaskType`, etc.) |
| `fixtures/smoke.jsonl` | 7-row offline fixture (one per subtask, no images) |
| `fixtures/local_vlm_real.jsonl` | Sample rows for local VLM (eliza-1) testing |
| `tests/test_visualwebbench.py` | pytest suite (metric unit tests + runner smoke) |

## Notes

- Results write to `benchmark_results/visualwebbench/<timestamp>/` (gitignored).
  Output files: `visualwebbench-results.json`, `summary.md`, `traces/<task-id>.json`.
- The `_visualwebbench_result` locator in `registry/commands.py` expects
  `visualwebbench-results.json` at the root of `output_dir`.
- Scored by `_score_from_visualwebbench_json` in `registry/scores.py`.
- HF dataset: `visualwebbench/VisualWebBench`, split `test`, seven configs (one
  per subtask). Images are lazily fetched and cached as PNG under
  `~/.cache/elizaos/visualwebbench/images/` by default.
- Use `--max-tasks N` to cap downloads during development.
- Full background: [README.md](README.md).
