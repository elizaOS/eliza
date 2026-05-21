#!/usr/bin/env python3
"""Fail-closed QoR regression gate.

Compares the latest captured QoR row for a (design, node_id) against the named
baseline row in the regression store (build/qor/qor_regression.jsonl) and fails
if any tracked metric regresses beyond a per-metric threshold.

Direction of "good" per metric (from the post-route PPA semantics):
  - route__wirelength            : lower is better
  - route__drc_errors            : lower is better (must not increase at all)
  - timing__setup__tns           : higher is better (less negative)
  - timing__hold__tns            : higher is better (less negative)
  - antenna__violating__nets     : lower is better (must not increase at all)
  - design__instance__count__macros : informational (no regression threshold)

The gate is fail-closed:
  - Missing store / no baseline / no candidate -> non-zero with a clear cause.
  - A blocked candidate (advanced node placeholder) -> exit 2 (BLOCKED, distinct
    from a real regression failure), naming the proving command.

Usage:
  scripts/check_qor_regression.py --design e1_chip_top --node-id sky130 \
      [--threshold-pct 5.0] [--run-id <id>]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qor_regression import (  # noqa: E402
    QorRow,
    filter_rows,
    latest_baseline,
    load_rows,
    required_metric_keys,
)

# higher_is_better: regression = a drop. Otherwise regression = a rise.
HIGHER_IS_BETTER = {"timing__setup__tns", "timing__hold__tns"}
# Metrics that must never increase regardless of percentage (hard counts).
HARD_NO_INCREASE = {"route__drc_errors", "antenna__violating__nets"}
# Informational metrics excluded from regression scoring.
INFORMATIONAL = {"design__instance__count__macros"}


def _pct_change(baseline: float, candidate: float) -> float:
    if baseline == 0:
        return 0.0 if candidate == 0 else float("inf")
    return (candidate - baseline) / abs(baseline) * 100.0


def evaluate(
    baseline: QorRow, candidate: QorRow, keys: list[str], threshold_pct: float
) -> list[str]:
    violations: list[str] = []
    for key in keys:
        if key in INFORMATIONAL:
            continue
        if key not in baseline.metrics or key not in candidate.metrics:
            violations.append(f"{key}: missing from baseline or candidate")
            continue
        base = baseline.metrics[key]
        cand = candidate.metrics[key]

        if key in HARD_NO_INCREASE:
            if cand > base:
                violations.append(
                    f"{key}: {base:g} -> {cand:g} (count increased; not allowed)"
                )
            continue

        if key in HIGHER_IS_BETTER:
            # Regression = candidate drops below baseline by more than threshold.
            drop_pct = _pct_change(base, cand)  # negative if worse
            if drop_pct < -threshold_pct:
                violations.append(
                    f"{key}: {base:g} -> {cand:g} ({drop_pct:+.2f}% < -{threshold_pct:g}%)"
                )
            continue

        # lower-is-better metric.
        rise_pct = _pct_change(base, cand)  # positive if worse
        if rise_pct > threshold_pct:
            violations.append(
                f"{key}: {base:g} -> {cand:g} ({rise_pct:+.2f}% > {threshold_pct:g}%)"
            )
    return violations


def _select_candidate(
    rows: list[QorRow], design: str, node_id: str, run_id: str | None
) -> QorRow | None:
    captured = [
        r for r in filter_rows(rows, design=design, node_id=node_id) if r.status == "captured"
    ]
    blocked = [
        r for r in filter_rows(rows, design=design, node_id=node_id) if r.status == "blocked"
    ]
    pool: list[QorRow] = captured + blocked
    if run_id is not None:
        pool = [r for r in pool if r.run_id == run_id]
    if not pool:
        return None
    return max(pool, key=lambda r: r.recorded_at)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--design", required=True)
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--threshold-pct", type=float, default=5.0)
    args = parser.parse_args()

    keys = required_metric_keys()
    rows = load_rows()
    if not rows:
        print(
            "BLOCK: QoR regression store empty; run a baseline first "
            "(scripts/run_sky130_qor_baseline.py)",
            file=sys.stderr,
        )
        return 2

    candidate = _select_candidate(rows, args.design, args.node_id, args.run_id)
    if candidate is None:
        print(
            f"FAIL: no QoR row for design={args.design} node_id={args.node_id}",
            file=sys.stderr,
        )
        return 1

    if candidate.status == "blocked":
        proving = candidate.extra.get("proving_command", "<unknown>")
        reason = candidate.extra.get("blocked_reason", "<unknown>")
        print(
            f"BLOCK: candidate run_id={candidate.run_id} is a fail-closed placeholder "
            f"({reason}); reproduce with: {proving}",
            file=sys.stderr,
        )
        return 2

    baseline = latest_baseline(rows, args.design, args.node_id)
    if baseline is None:
        print(
            f"FAIL: no baseline QoR row for design={args.design} node_id={args.node_id}; "
            "record one with `qor_regression.py record --baseline`",
            file=sys.stderr,
        )
        return 1

    if baseline.run_id == candidate.run_id and baseline.git_sha == candidate.git_sha:
        print(
            f"PASS: only the baseline run exists for design={args.design} "
            f"node_id={args.node_id}; nothing to regress against yet"
        )
        return 0

    violations = evaluate(baseline, candidate, keys, args.threshold_pct)
    if violations:
        print(
            f"FAIL: QoR regression design={args.design} node_id={args.node_id} "
            f"baseline={baseline.run_id} candidate={candidate.run_id}",
            file=sys.stderr,
        )
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        return 1

    print(
        f"PASS: no QoR regression design={args.design} node_id={args.node_id} "
        f"baseline={baseline.run_id} candidate={candidate.run_id} "
        f"(threshold {args.threshold_pct:g}%)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
