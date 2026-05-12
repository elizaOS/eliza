# VisualWebBench Benchmark for ElizaOS

Scaffold for [VisualWebBench](https://huggingface.co/datasets/visualwebbench/VisualWebBench), a seven-task multimodal web understanding and grounding benchmark.

The package defaults to a small bundled JSONL fixture and dry-run oracle agent so it can run offline without downloading the full dataset.

## Quick Start

```bash
PYTHONPATH=packages:packages/benchmarks/eliza-adapter \
  python -m benchmarks.visualwebbench --fixture --dry-run --output /tmp/visualwebbench-smoke
```

Outputs:

- `visualwebbench-results.json`
- `summary.md`
- `traces/<task-id>.json`

## Hugging Face Streaming

Install the optional dataset dependency, then request HF explicitly:

```bash
pip install -e "packages/benchmarks/visualwebbench[hf]"
PYTHONPATH=packages:packages/benchmarks/eliza-adapter \
  python -m benchmarks.visualwebbench --hf --max-tasks 10 --dry-run
```

The loader uses `datasets.load_dataset(..., streaming=True)` and only materializes rows consumed by the run.

## Task Configs

- `web_caption`
- `webqa`
- `heading_ocr`
- `element_ocr`
- `element_ground`
- `action_prediction`
- `action_ground`

## Scoring

This scaffold includes deterministic scoring stubs:

- exact-style tasks normalize text and compare against one or more references
- choice-style tasks compare predicted option index, with text fallback against options
- bbox-style grounding tasks accept either a choice index or a predicted normalized bbox and use IoU
