# SWE-bench Multilingual — Agent Guide

Vendored clone of [SWE-bench/SWE-bench](https://github.com/SWE-bench/SWE-bench)
with per-language harness modules (Ruby, Go, Java, JavaScript/TS, PHP, Rust, C,
C++). Evaluates LLM patch generation against 300 real GitHub issues across 8
languages from the `SWE-bench/SWE-bench_Multilingual` HuggingFace dataset.
Not registered in the elizaOS orchestrator registry — run directly via the
upstream harness.

## Run

```bash
# Install the package (requires Docker daemon)
cd packages/benchmarks/swe-bench-multilingual
pip install -e .

# Evaluate patch predictions against the multilingual test split
python -m swebench.harness.run_evaluation \
    --dataset_name SWE-bench/SWE-bench_Multilingual \
    --split test \
    --predictions_path <path-to-predictions.json> \
    --max_workers 4 \
    --run_id <run-tag>

# Sanity-check gold patches (verifies harness + Docker setup)
python -m swebench.harness.run_evaluation \
    --dataset_name SWE-bench/SWE-bench_Multilingual \
    --split test \
    --predictions_path gold \
    --max_workers 1 \
    --instance_ids <single-instance-id> \
    --run_id validate-gold
```

Predictions file format (JSON/JSONL, one object per instance):
```json
{
  "instance_id": "facebook__react-12345",
  "model_name_or_path": "your-adapter-name",
  "model_patch": "diff --git a/... ...\n"
}
```

## Test the harness

```bash
pip install -e .[test]
pytest tests/ -v
```

> Note: `test_evaluation.py` requires a running Docker daemon.

## Layout

| Path | Role |
| --- | --- |
| `swebench/harness/run_evaluation.py` | CLI entrypoint (`python -m swebench.harness.run_evaluation`) |
| `swebench/harness/grading.py` | Scoring: resolved/unresolved per instance |
| `swebench/harness/reporting.py` | Aggregate JSON report generation |
| `swebench/harness/docker_build.py` | Per-instance Docker image build |
| `swebench/harness/constants/{go,java,javascript,php,ruby,rust,c}.py` | Per-language test commands and environment setup |
| `swebench/harness/log_parsers/` | Per-language test output parsers |
| `tests/` | pytest suite (unit + integration) |
| `INTEGRATION.md` | elizaOS adapter wiring notes |

## Notes

- Requires Docker (x86_64 recommended; arm64 experimental). Minimum 120 GB free
  disk, 16 GB RAM, 8 CPU cores.
- Results write to `logs/run_evaluation/<run_id>/` and a JSON summary in the
  working directory.
- Leaderboard metric: **% resolved over 300 instances**.
- Not registered in `registry/commands.py` or `registry/scores.py` — this is
  the raw upstream harness used by elizaOS adapter code.
- Cloud-based evaluation via Modal: add `--modal true` to the run command.
- Full background: [INTEGRATION.md](INTEGRATION.md) and [README.md](README.md).
