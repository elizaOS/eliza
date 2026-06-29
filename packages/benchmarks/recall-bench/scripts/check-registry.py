#!/usr/bin/env python3
"""recall-bench registry contract check (#9956).

Fails (non-zero) if `recall_bench` is not discoverable in the orchestrator
registry, if its command does not build, or if the `_score_from_recall_json`
extractor cannot read the committed baseline. Keeps the Python registration
honest in CI alongside the TS harness.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

BENCH_DIR = Path(__file__).resolve().parents[1]
BENCHMARKS_DIR = BENCH_DIR.parent  # packages/benchmarks
REPO_ROOT = BENCHMARKS_DIR.parents[1]  # eliza repo root

sys.path.insert(0, str(BENCHMARKS_DIR))

from registry.commands import get_benchmark_registry  # noqa: E402
from registry.scores import _score_from_recall_json  # noqa: E402


def main() -> int:
    reg = get_benchmark_registry(REPO_ROOT)
    by_id = {b.id: b for b in reg}
    if "recall_bench" not in by_id:
        print("FAIL: recall_bench not registered in registry/commands.py", file=sys.stderr)
        return 1
    rb = by_id["recall_bench"]

    out = Path("/tmp/recall-registry-check")
    cmd = rb.build_command(out, type("M", (), {"provider": "", "model": ""})(), {"tier": "1k"})
    if cmd[0] != "bun" or "run.ts" not in cmd or "--tier" not in cmd:
        print(f"FAIL: unexpected recall_bench command: {cmd}", file=sys.stderr)
        return 1
    if rb.locate_result(out).name != "recall-bench-results.json":
        print("FAIL: unexpected recall_bench result path", file=sys.stderr)
        return 1

    baseline = BENCH_DIR / "baseline-1k.json"
    score = _score_from_recall_json(json.loads(baseline.read_text()))
    if not (0.0 <= score.score <= 1.0):
        print(f"FAIL: baseline headline score out of range: {score.score}", file=sys.stderr)
        return 1
    if score.metrics.get("fail_open_observable") is not True:
        print("FAIL: committed baseline does not show an observable fail-open", file=sys.stderr)
        return 1

    print(
        f"OK: recall_bench registered; baseline Recall@5={score.score:.3f}, "
        f"fail-open drop={score.metrics.get('fail_open_recall_drop')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
