#!/usr/bin/env python3
"""Train/evaluate a tiny dependency-free PD surrogate over flow-run labels.

This proves the normalized `eda.flow_run.v1` label path can feed a model/eval
artifact before a generalizing PD predictor is trainable. When no explicit
`--flow-run` is given it auto-discovers every parsed OpenLane flow-label record
under `build/ai_eda/openlane_flow_labels/*/records/`, deduplicates by design
bundle + normalized-metric content (re-runs of the same signoff config collapse
to one label), and trains the constant-mean surrogate over the distinct labels.

The surrogate cannot generalize from a single design point: a constant-mean over
one (or N identical) label(s) has zero held-out signal. The run therefore emits
an explicit `generalization` gate that fails closed until `distinct_label_count
>= GENERALIZATION_MIN_DISTINCT_LABELS`, naming the command that seeds more real
OpenLane runs. The plumbing smoke still passes on one label; only the
generalization claim is gated.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
OPENLANE_FLOW_LABELS = ROOT / "build/ai_eda/openlane_flow_labels"
DEFAULT_FLOW_RUN = (
    OPENLANE_FLOW_LABELS / "validation/records/flow-run-with-metrics.json"
)
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/pd_surrogate_smoke"
CLAIM_BOUNDARY = "pd_surrogate_smoke_only_no_ppa_signoff_training_or_release_claim"

# A constant-mean surrogate needs distinct real signoff points to carry any
# held-out signal. Three independent designs/configs is the floor below which no
# generalization is even measurable.
GENERALIZATION_MIN_DISTINCT_LABELS = 3
SEED_MORE_LABELS_COMMAND = (
    "make ai-eda-openlane-flow-labels  # run pd/openlane on a new design/config, "
    "then re-run parse_openlane_metrics_to_flow_run.py to emit another distinct "
    "eda.flow_run.v1 label"
)
# Normalized labels that define a distinct signoff point (excludes bookkeeping
# fields like raw_metric_count so identical re-runs collapse to one label).
CONTENT_KEYS = (
    "timing_wns_ns",
    "timing_tns_ns",
    "hold_wns_ns",
    "hold_tns_ns",
    "die_area_um2",
    "instance_area_um2",
    "instance_count",
    "wirelength_um",
    "route_drc_count",
    "power_mw",
)

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


def is_real_label(flow_run: dict[str, Any]) -> bool:
    metrics = flow_run.get("metrics", {})
    return (
        metrics.get("label_status") == "deterministic_openlane_metrics_unreviewed"
        and metrics.get("deterministic_run_artifacts_present") is True
    )


def content_signature(flow_run: dict[str, Any]) -> str:
    """Stable key over design bundle + signoff-defining normalized metrics.

    Re-runs of the same OpenLane design/config produce identical metrics and
    therefore collapse to one distinct label, so the generalization gate counts
    independent signoff points rather than repeated runs.
    """
    normalized = flow_run.get("metrics", {}).get("normalized", {})
    payload = {
        "design_bundle_id": flow_run.get("design_bundle_id"),
        "metrics": {key: normalized.get(key) for key in CONTENT_KEYS},
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode("utf-8")
    ).hexdigest()


def discover_distinct_real_labels() -> list[tuple[Path, dict[str, Any]]]:
    """Load every parsed OpenLane flow label, keep one per distinct signoff."""
    by_signature: dict[str, tuple[Path, dict[str, Any]]] = {}
    for path in sorted(
        OPENLANE_FLOW_LABELS.glob("*/records/flow-run-with-metrics.json")
    ):
        record = load_json(path)
        if record.get("schema") != "eda.flow_run.v1" or not is_real_label(record):
            continue
        by_signature.setdefault(content_signature(record), (path, record))
    return list(by_signature.values())


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


def generalization_gate(distinct_label_count: int) -> dict[str, Any]:
    generalizable = distinct_label_count >= GENERALIZATION_MIN_DISTINCT_LABELS
    return {
        "distinct_label_count": distinct_label_count,
        "min_distinct_labels_required": GENERALIZATION_MIN_DISTINCT_LABELS,
        "generalization_allowed": generalizable,
        "status": "GENERALIZATION_READY"
        if generalizable
        else "BLOCKED_INSUFFICIENT_DISTINCT_LABELS",
        "blocker": None
        if generalizable
        else (
            f"only {distinct_label_count} distinct real OpenLane signoff label(s) available; "
            f"a generalizing surrogate needs >= {GENERALIZATION_MIN_DISTINCT_LABELS} "
            "independent design/config points (a constant-mean over identical "
            "re-runs has zero held-out signal)"
        ),
        "seed_more_labels_command": None if generalizable else SEED_MORE_LABELS_COMMAND,
    }


def evaluate(
    model: dict[str, Any], records: list[dict[str, Any]], gate: dict[str, Any]
) -> dict[str, Any]:
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
        "generalization": gate,
        "release_use_allowed": False,
        "limitations": [
            "constant-mean over distinct real labels; no generalization claim until the gate clears",
            "OpenLane metrics here are parsed-unreviewed, not PPA/signoff evidence",
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
    if args.flow_run:
        flow_paths = list(args.flow_run)
        records = [load_json(path) for path in flow_paths]
        distinct_label_count = len(
            {content_signature(record) for record in records if is_real_label(record)}
        )
    else:
        discovered = discover_distinct_real_labels()
        if discovered:
            flow_paths = [path for path, _ in discovered]
            records = [record for _, record in discovered]
            distinct_label_count = len(records)
        else:
            flow_paths = [DEFAULT_FLOW_RUN]
            records = [load_json(DEFAULT_FLOW_RUN)]
            distinct_label_count = (
                len({content_signature(records[0])}) if is_real_label(records[0]) else 0
            )
    gate = generalization_gate(distinct_label_count)
    model = train_constant_surrogate(records)
    evaluation = evaluate(model, records, gate)
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
        "generalization": gate,
        "inputs": {
            "flow_runs": [rel(path.resolve()) for path in flow_paths],
            "distinct_label_count": gate["distinct_label_count"],
            "feature_vectors": [feature_vector(record) for record in records],
        },
        "outputs": {
            "model": rel(model_path),
            "evaluation": rel(eval_path),
        },
        "release_use_allowed": False,
    }
    run_path.write_text(json.dumps(run, indent=2, sort_keys=True) + "\n")
    print(
        f"STATUS: PASS ai_eda.pd_surrogate_smoke distinct_labels={gate['distinct_label_count']} "
        f"generalization={gate['status']} {rel(run_path.resolve())}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
