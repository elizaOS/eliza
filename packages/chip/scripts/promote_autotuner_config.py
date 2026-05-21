#!/usr/bin/env python3
"""Promote an OpenROAD AutoTuner Pareto front into a tuned OpenLane config.

scripts/openroad_autotuner.py writes build/pd/autotuner/<sweep_id>/pareto.json
(non-dominated trials over wirelength, setup_tns, drc_errors) but nothing
downstream consumes it. This script closes that gap:

  1. Read pareto.json.
  2. Pick the best point under a selectable objective (default: lexicographic
     min DRC, then max setup_tns, then min wirelength).
  3. Materialize pd/openlane/config.<node_id>.tuned.json by overlaying the
     winning trial's parameters onto the baseline config.
  4. Record the winning point's QoR metrics into the regression store as a
     captured (non-baseline) row, so check_qor_regression can compare the tuned
     config against the released baseline.

Fail-closed: missing pareto/baseline/empty front -> non-zero with a structured
error. The emitted tuned config carries a provenance block and never claims
release use.

Usage:
  scripts/promote_autotuner_config.py \
      --sweep-id <id> --node-id sky130 --design e1_chip_top \
      [--baseline-config pd/openlane/config.sky130.json] \
      [--objective drc_tns_wl|wl|tns] [--record]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qor_regression import (  # noqa: E402
    append_row,
    make_row,
    required_metric_keys,
)

ROOT = Path(__file__).resolve().parents[1]

DEFAULT_BASELINE = {
    "sky130": "pd/openlane/config.sky130.json",
}

# Pareto point fields -> post-route metric column names. The autotuner records
# wirelength / setup_tns / drc_errors; map them onto the validator columns the
# regression store expects so the tuned config is comparable to a baseline.
PARETO_TO_METRIC = {
    "wirelength": "route__wirelength",
    "setup_tns": "timing__setup__tns",
    "drc_errors": "route__drc_errors",
}


def fail(message: str, **context: Any) -> int:
    payload = {"error": message, **context}
    print(f"FAIL: {message}", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2, sort_keys=True)
    sys.stderr.write("\n")
    return 1


def select_best(pareto: list[dict[str, Any]], objective: str) -> dict[str, Any]:
    if objective == "wl":
        return min(pareto, key=lambda p: p["wirelength"])
    if objective == "tns":
        return max(pareto, key=lambda p: p["setup_tns"])
    # drc_tns_wl: minimize DRC, then maximize setup_tns, then minimize WL.
    return min(
        pareto,
        key=lambda p: (p["drc_errors"], -p["setup_tns"], p["wirelength"]),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sweep-id", required=True)
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--design", default="e1_chip_top")
    parser.add_argument("--baseline-config", default=None)
    parser.add_argument(
        "--objective", choices=["drc_tns_wl", "wl", "tns"], default="drc_tns_wl"
    )
    parser.add_argument(
        "--record",
        action="store_true",
        help="Record the winning point into the QoR regression store.",
    )
    args = parser.parse_args()

    baseline_rel = args.baseline_config or DEFAULT_BASELINE.get(args.node_id)
    if baseline_rel is None:
        return fail(
            "no baseline config for node_id; pass --baseline-config",
            node_id=args.node_id,
        )
    baseline_path = (ROOT / baseline_rel).resolve()
    if not baseline_path.is_file():
        return fail("baseline config missing", config=str(baseline_path))

    pareto_path = ROOT / "build" / "pd" / "autotuner" / args.sweep_id / "pareto.json"
    if not pareto_path.is_file():
        return fail(
            "pareto.json missing; run scripts/openroad_autotuner.py first",
            expected=str(pareto_path),
            proving_command=(
                f"python3 scripts/openroad_autotuner.py --sweep-id {args.sweep_id} "
                "--config " + baseline_rel
            ),
        )

    pareto_doc = json.loads(pareto_path.read_text())
    pareto = pareto_doc.get("pareto") if isinstance(pareto_doc, dict) else None
    if not isinstance(pareto, list) or not pareto:
        return fail("pareto front empty", pareto=str(pareto_path))

    best = select_best(pareto, args.objective)
    params = best.get("params")
    if not isinstance(params, dict) or not params:
        return fail("winning pareto point has no params", trial_id=best.get("trial_id"))

    base = json.loads(baseline_path.read_text())
    tuned = dict(base)
    tuned.update(params)
    tuned["_eliza_autotuner_provenance"] = {
        "schema": "eliza.qor_tuned_config.v1",
        "sweep_id": args.sweep_id,
        "node_id": args.node_id,
        "design": args.design,
        "baseline_config": baseline_rel,
        "objective": args.objective,
        "winning_trial_id": best.get("trial_id"),
        "winning_metrics": {
            "route__wirelength": best.get("wirelength"),
            "timing__setup__tns": best.get("setup_tns"),
            "route__drc_errors": best.get("drc_errors"),
        },
        "promoted_at": datetime.now(timezone.utc).isoformat(),
        "release_use_allowed": False,
        "claim_boundary": "autotuner_overlay_not_signoff",
    }

    out_path = ROOT / "pd" / "openlane" / f"config.{args.node_id}.tuned.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(tuned, indent=2, sort_keys=True) + "\n")
    print(
        f"PASS: tuned config written {out_path.relative_to(ROOT)} "
        f"(trial {best.get('trial_id')}, objective {args.objective})"
    )

    if args.record:
        keys = required_metric_keys()
        metrics: dict[str, float] = {}
        for pareto_key, metric_key in PARETO_TO_METRIC.items():
            value = best.get(pareto_key)
            if value is not None:
                metrics[metric_key] = float(value)
        missing = [k for k in keys if k not in metrics]
        if missing:
            print(
                "WARN: autotuner Pareto only covers "
                f"{sorted(metrics)}; not all validator metric keys present "
                f"(missing {missing}). Recording a partial autotuner row; the "
                "full PPA capture comes from run_post_route_ppa.py.",
                file=sys.stderr,
            )
        row = make_row(
            design=args.design,
            node_id=args.node_id,
            run_id=f"autotuner-{args.sweep_id}-trial{best.get('trial_id')}",
            metrics=metrics,
            source=f"openroad_autotuner sweep {args.sweep_id}",
            baseline=False,
            extra={
                "origin": "autotuner_pareto",
                "sweep_id": args.sweep_id,
                "objective": args.objective,
                "partial_metrics": bool(missing),
            },
        )
        append_row(row)
        print(f"PASS: recorded autotuner QoR row run_id={row.run_id}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
