#!/usr/bin/env python3
"""Train a dependency-free CircuitNet3 timing/power surrogate baseline."""

from __future__ import annotations

import argparse
import json
import math
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RECORD_DIR = ROOT / "build/ai_eda/circuitnet3/validation/records"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/circuitnet3_surrogate"
CLAIM_BOUNDARY = (
    "circuitnet3_surrogate_training_pretraining_only_no_e1_ppa_signoff_or_release_claim"
)
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "training_claim_allowed": False,
    "inference_claim_allowed": False,
    "e1_signoff_claim_allowed": False,
    "ppa_signoff_claim_allowed": False,
}
TARGETS = ("min_slack", "mean_slack", "max_at", "mean_delay", "mean_slew", "total_power")
FEATURES = (
    "instance_count",
    "timing_arc_count",
    "mean_fanout",
    "mean_delay",
    "mean_slew",
    "mean_setup",
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    parsed = float(value)
    return parsed if math.isfinite(parsed) else None


def load_samples(record_dirs: list[Path]) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for record_dir in record_dirs:
        if not record_dir.exists():
            continue
        for path in sorted(record_dir.glob("*flow-run.json")):
            record = load_json(path)
            if record.get("schema") != "eda.flow_run.v1":
                continue
            metrics = record.get("metrics", {})
            if not isinstance(metrics, dict):
                continue
            features = {key: number(metrics.get(key)) for key in FEATURES}
            labels = {key: number(metrics.get(key)) for key in TARGETS}
            features = {key: value for key, value in features.items() if value is not None}
            labels = {key: value for key, value in labels.items() if value is not None}
            if not features or not labels:
                continue
            samples.append(
                {
                    "id": record["id"],
                    "design_bundle_id": record["design_bundle_id"],
                    "source": rel(path),
                    "features": features,
                    "labels": labels,
                }
            )
    return samples


def split_samples(samples: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    ordered = sorted(samples, key=lambda item: item["id"])
    if len(ordered) == 1:
        return {"train": ordered, "val": [], "test": []}
    if len(ordered) == 2:
        return {"train": ordered[:1], "val": [], "test": ordered[1:]}
    if len(ordered) < 10:
        return {"train": ordered[:-2], "val": ordered[-2:-1], "test": ordered[-1:]}
    val_count = max(1, round(len(ordered) * 0.1))
    test_count = max(1, round(len(ordered) * 0.1))
    train_count = len(ordered) - val_count - test_count
    if train_count < 1:
        train_count = 1
        val_count = max(0, len(ordered) - train_count - test_count)
    return {
        "train": ordered[:train_count],
        "val": ordered[train_count : train_count + val_count],
        "test": ordered[train_count + val_count :],
    }


def mean_model(train_samples: list[dict[str, Any]]) -> dict[str, Any]:
    target_values: dict[str, list[float]] = {target: [] for target in TARGETS}
    feature_values: dict[str, list[float]] = {feature: [] for feature in FEATURES}
    for sample in train_samples:
        for target, value in sample["labels"].items():
            if target in target_values:
                target_values[target].append(float(value))
        for feature, value in sample["features"].items():
            if feature in feature_values:
                feature_values[feature].append(float(value))
    return {
        "schema": "eliza.ai_eda.circuitnet3_surrogate_model.v1",
        "model_type": "train_split_mean_baseline",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "targets": {target: mean(values) for target, values in target_values.items() if values},
        "feature_means": {
            feature: mean(values) for feature, values in feature_values.items() if values
        },
        "feature_schema": list(FEATURES),
        "release_use_allowed": False,
    }


def evaluate_split(
    model: dict[str, Any], split: str, samples: list[dict[str, Any]]
) -> dict[str, Any]:
    predictions = model["targets"]
    metrics: dict[str, dict[str, Any]] = {}
    for target, prediction in predictions.items():
        errors = [
            abs(float(sample["labels"][target]) - float(prediction))
            for sample in samples
            if target in sample["labels"]
        ]
        metrics[target] = {
            "sample_count": len(errors),
            "mae": round(mean(errors), 8) if errors else None,
            "prediction": round(float(prediction), 8),
        }
    return {"split": split, "sample_count": len(samples), "targets": metrics}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record-dir", action="append", type=Path, default=[])
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    record_dirs = args.record_dir or [DEFAULT_RECORD_DIR]
    samples = load_samples(record_dirs)
    if not samples:
        print("STATUS: FAIL ai_eda.circuitnet3_surrogate no_flow_run_samples")
        return 1
    splits = split_samples(samples)
    model = mean_model(splits["train"])
    evaluations = [evaluate_split(model, split, rows) for split, rows in splits.items()]
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    for split, rows in splits.items():
        path = out_dir / f"{split}.jsonl"
        path.write_text(
            "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8"
        )
    model_path = out_dir / "circuitnet3_surrogate_model.json"
    metrics_path = out_dir / "metrics.json"
    run_path = out_dir / "training_run.json"
    model_path.write_text(json.dumps(model, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    metrics = {
        "schema": "eliza.ai_eda.circuitnet3_surrogate_metrics.v1",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "splits": evaluations,
        "release_use_allowed": False,
    }
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    run = {
        "schema": "eliza.ai_eda.circuitnet3_surrogate_training_run.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "record_dirs": [rel(path) for path in record_dirs],
        "sample_count": len(samples),
        "split_counts": {split: len(rows) for split, rows in splits.items()},
        "split_policy": "deterministic_sorted_case_id_80_10_10_for_n_ge_10_else_holdout",
        "model": rel(model_path),
        "metrics": rel(metrics_path),
        "next_required_gates": [
            "increase converted CircuitNet3 sample count and preserve source-level split metadata",
            "train graph/layout neural predictors on CUDA after contamination checks",
            "compare predictions only against local replayed E1 OpenLane/OpenROAD labels before any optimization claim",
        ],
        "release_use_allowed": False,
    }
    run_path.write_text(json.dumps(run, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.circuitnet3_surrogate "
        f"samples={len(samples)} train={len(splits['train'])} val={len(splits['val'])} test={len(splits['test'])} {rel(run_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
