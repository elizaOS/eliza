# SWE-bench

elizaOS's SWE-bench Lite harness. The canonical single-shot flow lives in
`cli.py` (entry: `python -m benchmarks.swe_bench …`). Design notes and
historical context live in this README.

## Head-to-head comparison: elizaOS vs opencode

`harness/comparison.py` runs the same N SWE-bench Lite instances through
two paths and emits a side-by-side JSON report:

- **Path A — elizaOS** uses the existing canonical bridge (`cli._run_instance`):
  prompt the TS bench server, extract a unified diff, grade with
  `SWEBenchEvaluator`.
- **Path B — opencode** clones the target repo at `base_commit` into a
  per-instance sandbox, invokes `opencode run "<task>"` in that workdir,
  then captures the working-tree diff via `git diff` and grades it with
  the same `SWEBenchEvaluator`. If `opencode` is not on `PATH`, each
  Path B record is marked `status="skipped_opencode_missing"` and the
  run continues.

Both paths share dataset loading, sandboxing, and grading so the only
honest delta is the patch producer.

### Run it

```bash
# Stub-only — emits the report schema with placeholder entries, no Docker,
# no eliza bridge, no opencode call. Use this to inspect the JSON shape.
python -m benchmarks.swe_bench.harness.comparison --n 2 --stub

# Real smoke (requires: docker, the eliza TS bench bridge, and opencode on PATH)
python -m benchmarks.swe_bench.harness.comparison --n 2

# Pin specific Lite instances
python -m benchmarks.swe_bench.harness.comparison \
  --instances django__django-11099 sympy__sympy-20590
```

### Output schema

`comparison_<timestamp>.json` (or `comparison_smoke.json` for `--stub`):

```jsonc
{
  "schema_version": 1,
  "generated_at": "<ISO-8601 UTC>",
  "totals": {
    "instances": 2,
    "elizaos_resolved": 0,
    "opencode_resolved": 0,
    "elizaos_wins": 0,
    "opencode_wins": 0,
    "ties_resolved": 0,
    "ties_failed": 2
  },
  "records": [
    {
      "instance_id": "django__django-11099",
      "repo": "django/django",
      "base_commit": "<sha>",
      "path_a": {
        "path": "elizaos",
        "status": "resolved | failed | no_patch | error | not_run_yet",
        "patch": "<unified diff>",
        "resolved": false,
        "time_s": 0.0,
        "patch_status": "tests_passed | tests_failed | apply_failed | …",
        "tests_passed": [],
        "tests_failed": [],
        "error": null
      },
      "path_b": { "path": "opencode", "...": "(same shape, plus status=skipped_opencode_missing)" },
      "winner": "elizaos | opencode | tie_resolved | tie_failed"
    }
  ]
}
```

A pre-generated placeholder report lives at
`harness/fixtures/comparison_smoke.json` for downstream tooling that
wants to lock in the schema before the first real run.
