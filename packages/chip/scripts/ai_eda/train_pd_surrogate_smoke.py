#!/usr/bin/env python3
"""Train/evaluate a tiny dependency-free PD surrogate over flow-run labels.

This is a plumbing smoke test. It proves the normalized `eda.flow_run.v1`
records can feed a model/eval artifact path before real OpenLane/CircuitNet/iDATA
labels are available.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FLOW_RUN = (
    ROOT / "build/ai_eda/openlane_flow_labels/validation/records/flow-run-with-metrics.json"
)
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/pd_surrogate_smoke"
CLAIM_BOUNDARY = "pd_surrogate_smoke_only_no_ppa_signoff_training_or_release_claim"

TARGETS = (
    "timing_wns_ns",
    "timing_tns_ns",
    "hold_wns_ns",
    "hold_tns_ns",
    "die_area_um2",
    "instance_area_um2",
    "wirelength_um",
    "route_drc_count",
    "design_violation_count",
    "power_mw",
)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected JSON object")
    return data


def numeric_labels(flow_run: dict[str, Any]) -> dict[str, float]:
    normalized = flow_run.get("metrics", {}).get("normalized", {})
    if not isinstance(normalized, dict):
        raise SystemExit("flow-run metrics.normalized must be a mapping")
    labels: dict[str, float] = {}
    for key in TARGETS:
        value = normalized.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        labels[key] = float(value)
    return labels


def feature_vector(flow_run: dict[str, Any]) -> dict[str, float]:
    labels = numeric_labels(flow_run)
    return {
        "bias": 1.0,
        "log_instance_count_proxy": labels.get("instance_count", 0.0),
        "macro_count_proxy": labels.get("macro_count", 0.0),
        "utilization_pct_proxy": labels.get("utilization_pct", 0.0),
        "raw_metric_count": labels.get("raw_metric_count", 0.0),
    }


def train_constant_surrogate(records: list[dict[str, Any]]) -> dict[str, Any]:
    per_target: dict[str, list[float]] = {target: [] for target in TARGETS}
    for record in records:
        labels = numeric_labels(record)
        for target in TARGETS:
            if target in labels:
                per_target[target].append(labels[target])
    predictions = {target: mean(values) for target, values in per_target.items() if values}
    return {
        "schema": "eliza.ai_eda.pd_surrogate_model.v1",
        "model_type": "constant_mean_fixture_surrogate",
        "claim_boundary": CLAIM_BOUNDARY,
        "target_predictions": predictions,
        "feature_schema": [
            "bias",
            "log_instance_count_proxy",
            "macro_count_proxy",
            "utilization_pct_proxy",
            "raw_metric_count",
        ],
        "release_use_allowed": False,
    }


def evaluate(model: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]:
    predictions = model["target_predictions"]
    residuals: dict[str, list[float]] = {target: [] for target in predictions}
    for record in records:
        labels = numeric_labels(record)
        for target, prediction in predictions.items():
            if target in labels:
                residuals[target].append(labels[target] - float(prediction))
    metrics = {
        target: {
            "mae": mean(abs(value) for value in values) if values else None,
            "sample_count": len(values),
        }
        for target, values in residuals.items()
    }
    return {
        "schema": "eliza.ai_eda.pd_surrogate_eval.v1",
        "claim_boundary": CLAIM_BOUNDARY,
        "status": "PASS_FIXTURE_OVERFIT_SMOKE",
        "metrics": metrics,
        "release_use_allowed": False,
        "limitations": [
            "single fixture-derived label path; no generalization claim",
            "fixture OpenLane metrics are not PPA/signoff evidence",
            "real use requires deterministic OpenLane labels and held-out split audit",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flow-run", action="append", type=Path, default=[])
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    flow_paths = args.flow_run or [DEFAULT_FLOW_RUN]
    records = [load_json(path) for path in flow_paths]
    model = train_constant_surrogate(records)
    evaluation = evaluate(model, records)
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / "pd_surrogate_model.json"
    eval_path = out_dir / "pd_surrogate_eval.json"
    run_path = out_dir / "pd_surrogate_training_run.json"
    model_path.write_text(json.dumps(model, indent=2, sort_keys=True) + "\n")
    eval_path.write_text(json.dumps(evaluation, indent=2, sort_keys=True) + "\n")
    run = {
        "schema": "eliza.ai_eda.pd_surrogate_training_run.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": evaluation["status"],
        "inputs": {
            "flow_runs": [rel(path.resolve()) for path in flow_paths],
            "feature_vectors": [feature_vector(record) for record in records],
        },
        "outputs": {
            "model": rel(model_path),
            "evaluation": rel(eval_path),
        },
        "release_use_allowed": False,
    }
    run_path.write_text(json.dumps(run, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.pd_surrogate_smoke {run_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
