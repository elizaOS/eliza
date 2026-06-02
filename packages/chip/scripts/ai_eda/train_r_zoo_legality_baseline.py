#!/usr/bin/env python3
"""Train a dependency-free R-Zoo rectilinear floorplan legality baseline."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean, pstdev
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RECORD_DIR = ROOT / "build/ai_eda/r_zoo_rectilinear_floorplan/validation/records"
DEFAULT_SPLIT_MANIFEST = (
    ROOT / "build/ai_eda/r_zoo_rectilinear_floorplan_splits/validation/split_manifest.json"
)
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/r_zoo_legality_baseline"
CLAIM_BOUNDARY = "r_zoo_legality_baseline_training_only_no_e1_signoff_or_release_claim"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "training_claim_allowed": False,
    "inference_claim_allowed": False,
    "e1_signoff_claim_allowed": False,
}
FEATURES = (
    "bias",
    "diearea_point_count",
    "first_point_repeated_as_last",
    "bbox_width_dbu",
    "bbox_height_dbu",
    "bbox_area_dbu2_log10",
    "row_count",
    "track_statement_count",
    "notch_single",
    "notch_multi",
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def numeric(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return default


def feature_vector(record: dict[str, Any]) -> dict[str, float]:
    graph = record.get("graph", {})
    nodes_value = graph.get("node_features") if isinstance(graph, dict) else []
    nodes = nodes_value if isinstance(nodes_value, list) else []
    node_by_id = {
        str(node.get("id")): node for node in nodes if isinstance(node, dict) and node.get("id")
    }
    values = record.get("labels", {}).get("values", {})
    diearea = values.get("diearea") if isinstance(values, dict) else {}
    bbox = diearea.get("bbox_dbu") if isinstance(diearea, dict) else {}
    metrics = values if isinstance(values, dict) else {}
    notch = str(metrics.get("notch_class", ""))
    row_count = numeric(node_by_id.get("rows", {}).get("count"))
    track_count = numeric(node_by_id.get("tracks", {}).get("count"))
    width = numeric(bbox.get("width") if isinstance(bbox, dict) else 0.0)
    height = numeric(bbox.get("height") if isinstance(bbox, dict) else 0.0)
    area = max(width * height, 1.0)
    return {
        "bias": 1.0,
        "diearea_point_count": numeric(
            diearea.get("point_count") if isinstance(diearea, dict) else 0.0
        ),
        "first_point_repeated_as_last": numeric(
            diearea.get("first_point_repeated_as_last") if isinstance(diearea, dict) else False
        ),
        "bbox_width_dbu": width,
        "bbox_height_dbu": height,
        "bbox_area_dbu2_log10": math.log10(area),
        "row_count": row_count,
        "track_statement_count": track_count,
        "notch_single": 1.0 if "single" in notch else 0.0,
        "notch_multi": 1.0 if "multi" in notch else 0.0,
    }


def load_samples(record_dir: Path) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for path in sorted(record_dir.glob("*diearea-legality-graph.json")):
        record = load_json(path)
        values = record.get("labels", {}).get("values", {})
        if not isinstance(values, dict) or values.get("public_legality") not in {
            "LEGAL",
            "ILLEGAL",
        }:
            continue
        features = feature_vector(record)
        samples.append(
            {
                "id": record["id"],
                "source": rel(path),
                "sha256": sha256_file(path),
                "label": values["public_legality"],
                "target": 1 if values["public_legality"] == "LEGAL" else 0,
                "features": features,
            }
        )
    return samples


def load_split_samples(split_manifest: Path) -> dict[str, list[dict[str, Any]]]:
    manifest = load_json(split_manifest)
    if manifest.get("schema") != "eliza.ai_eda.r_zoo_rectilinear_floorplan_split_manifest.v1":
        raise ValueError(f"{rel(split_manifest)}: split manifest schema mismatch")
    splits = manifest.get("splits")
    if not isinstance(splits, dict):
        raise ValueError(f"{rel(split_manifest)}: splits must be a mapping")
    result: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "test": []}
    for split in result:
        cases = splits.get(split)
        if not isinstance(cases, list):
            raise ValueError(f"{rel(split_manifest)}: missing {split} split")
        for case in cases:
            if not isinstance(case, dict):
                raise ValueError(f"{rel(split_manifest)}: malformed {split} case")
            records = case.get("records")
            if not isinstance(records, list):
                raise ValueError(f"{rel(split_manifest)}: malformed records for {split} case")
            graph_records = [
                record
                for record in records
                if isinstance(record, dict) and record.get("schema") == "eda.graph_sample.v1"
            ]
            if len(graph_records) != 1:
                raise ValueError(f"{rel(split_manifest)}: expected one graph record per case")
            path = ROOT / str(graph_records[0].get("path", ""))
            record = load_json(path)
            values = record.get("labels", {}).get("values", {})
            if not isinstance(values, dict) or values.get("public_legality") not in {
                "LEGAL",
                "ILLEGAL",
            }:
                raise ValueError(f"{rel(path)}: missing R-Zoo public legality label")
            result[split].append(
                {
                    "id": record["id"],
                    "source": rel(path),
                    "sha256": sha256_file(path),
                    "label": values["public_legality"],
                    "target": 1 if values["public_legality"] == "LEGAL" else 0,
                    "features": feature_vector(record),
                    "case_id": case.get("case_id"),
                    "design_family": case.get("design_family"),
                }
            )
        result[split].sort(key=lambda item: item["id"])
    return result


def standardizer(samples: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    stats: dict[str, dict[str, float]] = {}
    for feature in FEATURES:
        values = [float(sample["features"][feature]) for sample in samples]
        mu = mean(values) if values else 0.0
        sigma = pstdev(values) if len(values) > 1 else 0.0
        stats[feature] = {"mean": mu, "std": sigma if sigma > 0 else 1.0}
    stats["bias"] = {"mean": 0.0, "std": 1.0}
    return stats


def vector(sample: dict[str, Any], stats: dict[str, dict[str, float]]) -> list[float]:
    result = []
    for feature in FEATURES:
        value = float(sample["features"][feature])
        if feature == "bias":
            result.append(1.0)
        else:
            result.append((value - stats[feature]["mean"]) / stats[feature]["std"])
    return result


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def train_logistic(samples: list[dict[str, Any]], epochs: int, lr: float) -> dict[str, Any]:
    stats = standardizer(samples)
    weights = [0.0 for _ in FEATURES]
    for _ in range(epochs):
        for sample in samples:
            x = vector(sample, stats)
            y = float(sample["target"])
            pred = sigmoid(sum(w * xi for w, xi in zip(weights, x, strict=False)))
            error = pred - y
            for index, xi in enumerate(x):
                weights[index] -= lr * error * xi
    return {
        "schema": "eliza.ai_eda.r_zoo_legality_model.v1",
        "model_type": "standard_library_logistic_regression",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "features": list(FEATURES),
        "standardization": stats,
        "weights": dict(zip(FEATURES, weights, strict=False)),
        "threshold": 0.5,
        "release_use_allowed": False,
    }


def predict(model: dict[str, Any], sample: dict[str, Any]) -> dict[str, Any]:
    stats = model["standardization"]
    weights = [float(model["weights"][feature]) for feature in FEATURES]
    x = vector(sample, stats)
    probability = sigmoid(sum(w * xi for w, xi in zip(weights, x, strict=False)))
    predicted = 1 if probability >= float(model["threshold"]) else 0
    return {
        "id": sample["id"],
        "label": sample["label"],
        "target": sample["target"],
        "probability_legal": round(probability, 8),
        "predicted": predicted,
        "correct": predicted == sample["target"],
    }


def evaluate(model: dict[str, Any], split: str, samples: list[dict[str, Any]]) -> dict[str, Any]:
    predictions = [predict(model, sample) for sample in samples]
    correct = sum(1 for item in predictions if item["correct"])
    return {
        "split": split,
        "sample_count": len(samples),
        "correct": correct,
        "accuracy": round(correct / len(samples), 8) if samples else None,
        "predictions": predictions,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record-dir", type=Path, default=DEFAULT_RECORD_DIR)
    parser.add_argument("--split-manifest", type=Path, default=DEFAULT_SPLIT_MANIFEST)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--epochs", type=int, default=250)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.split_manifest.is_file():
        splits = load_split_samples(args.split_manifest)
        split_source = rel(args.split_manifest)
        samples = [sample for rows in splits.values() for sample in rows]
    else:
        samples = load_samples(args.record_dir)
        split_source = "fallback_record_dir_stratified_split"
        splits = {
            "train": samples[:10],
            "val": samples[10:12],
            "test": samples[12:],
        }
    if len(samples) != 14:
        print(f"STATUS: FAIL ai_eda.r_zoo_legality_baseline expected_14_samples got={len(samples)}")
        return 1
    if not splits["train"]:
        print("STATUS: FAIL ai_eda.r_zoo_legality_baseline empty_train_split")
        return 1
    model = train_logistic(splits["train"], args.epochs, args.learning_rate)
    evaluations = [evaluate(model, split, rows) for split, rows in splits.items()]
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    for split, rows in splits.items():
        (out_dir / f"{split}.jsonl").write_text(
            "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
            encoding="utf-8",
        )
    model_path = out_dir / "r_zoo_legality_model.json"
    metrics_path = out_dir / "metrics.json"
    run_path = out_dir / "training_run.json"
    model_path.write_text(json.dumps(model, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    metrics = {
        "schema": "eliza.ai_eda.r_zoo_legality_metrics.v1",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "splits": evaluations,
        "release_use_allowed": False,
    }
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    run = {
        "schema": "eliza.ai_eda.r_zoo_legality_training_run.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "record_dir": rel(args.record_dir),
        "split_manifest": split_source,
        "sample_count": len(samples),
        "split_counts": {split: len(rows) for split, rows in splits.items()},
        "split_policy": "deterministic_design_family_holdout_from_r_zoo_split_manifest",
        "model": rel(model_path),
        "metrics": rel(metrics_path),
        "policy": {
            "dependency_free": True,
            "release_use_allowed": False,
            "e1_signoff_evidence": False,
            "runs_openlane_or_openroad": False,
            **FALSE_CLAIM_FLAGS,
        },
        "next_required_gates": [
            "resolve R-Zoo license ambiguity before release use",
            "expand from evaluation DEFs to reviewed modeling/train split records",
            "compare legality predictions against deterministic local geometry checker",
            "use only as auxiliary pretraining until E1 OpenLane/OpenROAD replay evidence exists",
        ],
    }
    run_path.write_text(json.dumps(run, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    test_eval = next(item for item in evaluations if item["split"] == "test")
    print(
        "STATUS: PASS ai_eda.r_zoo_legality_baseline "
        f"samples={len(samples)} test_accuracy={test_eval['accuracy']} {rel(run_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
