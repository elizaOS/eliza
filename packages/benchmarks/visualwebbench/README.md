# VisualWebBench Benchmark for ElizaOS

A faithful implementation of [VisualWebBench](https://huggingface.co/datasets/visualwebbench/VisualWebBench)
(Apache-2.0), a seven-subtask multimodal web understanding and grounding
benchmark.

The package routes through the real Eliza adapter by default and downloads
the dataset (with screenshots) lazily from Hugging Face.

## Subtasks and metrics

| Subtask              | Metric                                         |
|----------------------|------------------------------------------------|
| `web_caption`        | ROUGE-1 / ROUGE-2 / ROUGE-L F1 (headline = ROUGE-L) |
| `webqa`              | ROUGE-1 F1, best of reference list             |
| `heading_ocr`        | ROUGE-1 / ROUGE-2 / ROUGE-L F1                 |
| `element_ocr`        | ROUGE-1 / ROUGE-2 / ROUGE-L F1                 |
| `element_ground`     | MCQ accuracy                                   |
| `action_prediction`  | MCQ accuracy                                   |
| `action_ground`      | MCQ accuracy                                   |

These mirror the upstream scorers in `VisualWebBench/utils/eval_utils.py`. The
ROUGE implementation is in-tree (lcs- and ngram-based F1) and matches the
reference rouge package within rounding.

## Quick start

Run the seven subtasks against the live HF dataset using the Eliza adapter:

```bash
pip install -e "packages/benchmarks/visualwebbench[hf]"
PYTHONPATH=packages:packages/benchmarks/eliza-adapter \
  python -m benchmarks.visualwebbench --max-tasks 70
```

Screenshots are cached as PNG under `~/.cache/elizaos/visualwebbench/images/`
the first time each task is encountered.

## Offline / CI mode

A 7-row labeled JSONL fixture is bundled at `fixtures/smoke.jsonl` (one row
per subtask, no images). It is only a metric-plumbing helper — scores from it
are not comparable to upstream. Combine with `--mock` to short-circuit the
agent entirely:

```bash
PYTHONPATH=packages:packages/benchmarks/eliza-adapter \
  python -m benchmarks.visualwebbench --use-sample-tasks --mock --max-tasks 7
```

`--mock` reads `task.answer` and echoes a well-formed response, so it always
scores 100. It is gated to this flag — every other run path uses the real
agent.

## Outputs

- `visualwebbench-results.json` — full per-task records with per-subtask metrics
- `summary.md` — headline table plus per-subtask breakdown
- `traces/<task-id>.json` — one trace per task

## CLI flags worth knowing

| Flag                   | Purpose                                             |
|------------------------|-----------------------------------------------------|
| `--mock`               | Use the offline oracle (CI only)                    |
| `--use-sample-tasks`   | Use the bundled labeled JSONL helper                |
| `--max-tasks N`        | Cap total tasks (divided across subtasks)           |
| `--task-types a,b,c`   | Restrict to a subset of subtasks                    |
| `--image-cache-dir P`  | Override the on-disk image cache                    |
| `--no-image-cache`     | Keep image bytes in memory only                     |

## Hugging Face details

- Repo: `visualwebbench/VisualWebBench` (Apache-2.0)
- Splits: `test` only
- Each of the seven subtasks is its own HF *config*
- Images: PIL `Image` cells, decoded lazily; written to PNG on disk by default
- Sizes: ~1.5k rows total, several hundred MB of screenshots — fetched lazily
  so capping `--max-tasks` keeps downloads small.
