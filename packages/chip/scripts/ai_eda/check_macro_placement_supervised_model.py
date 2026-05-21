#!/usr/bin/env python3
"""Validate dependency-free supervised macro-placement training artifacts."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/macro_placement_supervised_model/validation/supervised_training_run.json"
)
CLAIM_BOUNDARY = "macro_placement_supervised_model_validation_only_no_openroad_replay_or_release_claim"
MODEL_CLAIM_BOUNDARY = "macro_placement_supervised_model_only_no_openroad_replay_or_release_claim"
REQUIRED_SPLITS = ("train", "val", "test")


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def jsonl_count(path: Path) -> int:
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def valid_metric(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value)) and 0.0 <= float(value) <= 2.0


def validate_metrics(metrics: dict[str, Any], dataset_dir: Path) -> list[str]:
    errors: list[str] = []
    if metrics.get("schema") != "eliza.ai_eda.macro_placement_supervised_metrics.v1":
        errors.append("metrics schema must be eliza.ai_eda.macro_placement_supervised_metrics.v1")
    if metrics.get("claim_boundary") != MODEL_CLAIM_BOUNDARY:
        errors.append("metrics claim_boundary is missing or incorrect")
    if metrics.get("release_use_allowed") is not False:
        errors.append("metrics release_use_allowed must be false")
    splits = metrics.get("splits")
    if not isinstance(splits, list):
        errors.append("metrics.splits must be a list")
        return errors
    by_split = {item.get("split"): item for item in splits if isinstance(item, dict)}
    for split in REQUIRED_SPLITS:
        item = by_split.get(split)
        if not isinstance(item, dict):
            errors.append(f"metrics missing split {split}")
            continue
        split_file = dataset_dir / f"{split}.jsonl"
        if not split_file.exists():
            errors.append(f"missing dataset split file {rel(split_file)}")
            continue
        expected_count = jsonl_count(split_file)
        if item.get("sample_count") != expected_count:
            errors.append(f"{split}: sample_count does not match dataset split file")
        for field in ("mae_x_over_core", "mae_y_over_core", "mean_l1_over_core"):
            if not valid_metric(item.get(field)):
                errors.append(f"{split}: invalid {field}")
        source_counts = item.get("prediction_source_counts")
        if not isinstance(source_counts, dict) or sum(int(value) for value in source_counts.values()) != expected_count:
            errors.append(f"{split}: prediction_source_counts do not sum to sample_count")
    return errors


def validate_model(model: dict[str, Any], train_count: int) -> list[str]:
    errors: list[str] = []
    if model.get("schema") != "eliza.ai_eda.macro_placement_supervised_mean_model.v1":
        errors.append("model schema must be eliza.ai_eda.macro_placement_supervised_mean_model.v1")
    if model.get("claim_boundary") != MODEL_CLAIM_BOUNDARY:
        errors.append("model claim_boundary is missing or incorrect")
    if model.get("release_use_allowed") is not False:
        errors.append("model release_use_allowed must be false")
    if model.get("training_sample_count") != train_count:
        errors.append("model training_sample_count does not match train split")
    for field in ("global", "by_macro_name", "by_type"):
        if not isinstance(model.get(field), dict):
            errors.append(f"model.{field} must be a mapping")
    global_item = model.get("global", {})
    if isinstance(global_item, dict):
        if global_item.get("count") != train_count:
            errors.append("model.global.count does not match train split")
        for field in ("x_over_core", "y_over_core"):
            if not valid_metric(global_item.get(field)):
                errors.append(f"model.global.{field} is invalid")
    return errors


def validate_candidate(path: Path) -> list[str]:
    errors: list[str] = []
    candidate = load_json(path)
    candidate_id = candidate.get("id", rel(path))
    if candidate.get("schema") != "eda.e1_candidate.v1":
        errors.append(f"{candidate_id}: candidate schema mismatch")
    if candidate.get("candidate_type") != "macro_placement":
        errors.append(f"{candidate_id}: candidate_type must be macro_placement")
    if candidate.get("claim_boundary") != MODEL_CLAIM_BOUNDARY:
        errors.append(f"{candidate_id}: claim_boundary mismatch")
    generated_by = candidate.get("generated_by")
    if not isinstance(generated_by, dict):
        errors.append(f"{candidate_id}: generated_by must be a mapping")
        return errors
    if generated_by.get("policy") != "supervised_mean_legalized_grid":
        errors.append(f"{candidate_id}: unexpected supervised policy")
    score = generated_by.get("score")
    if not isinstance(score, dict):
        errors.append(f"{candidate_id}: generated_by.score missing")
    geometry = generated_by.get("geometry")
    if not isinstance(geometry, dict):
        errors.append(f"{candidate_id}: generated_by.geometry missing")
    else:
        for field in ("unknown_target_count", "out_of_bounds_count", "overlap_count"):
            if geometry.get(field) != 0:
                errors.append(f"{candidate_id}: pre-replay geometry {field} is nonzero")
    decision = candidate.get("decision")
    if not isinstance(decision, dict) or decision.get("status") != "replayed_blocked":
        errors.append(f"{candidate_id}: supervised candidate must be replayed_blocked")
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.macro_placement_supervised_training_run.v1":
        errors.append("report schema must be eliza.ai_eda.macro_placement_supervised_training_run.v1")
    if report.get("claim_boundary") != MODEL_CLAIM_BOUNDARY:
        errors.append("report claim_boundary is missing or incorrect")
    if report.get("release_use_allowed") is not False:
        errors.append("report release_use_allowed must be false")

    dataset_dir = repo_path(str(report.get("dataset_dir", "")))
    model_path = repo_path(str(report.get("model", "")))
    metrics_path = repo_path(str(report.get("metrics", "")))
    for label, path in (("dataset_dir", dataset_dir), ("model", model_path), ("metrics", metrics_path)):
        if not path.exists():
            errors.append(f"missing {label}: {rel(path)}")
    if errors:
        return errors

    train_count = jsonl_count(dataset_dir / "train.jsonl")
    try:
        model = load_json(model_path)
        metrics = load_json(metrics_path)
    except Exception as exc:  # noqa: BLE001
        return [f"failed to load model or metrics: {exc}"]
    errors.extend(validate_model(model, train_count))
    errors.extend(validate_metrics(metrics, dataset_dir))

    candidates = report.get("candidates")
    if not isinstance(candidates, list):
        errors.append("report.candidates must be a list")
        candidates = []
    if report.get("candidate_count") != len(candidates):
        errors.append("candidate_count does not match candidates list")
    blocked = report.get("blocked_cases")
    if not isinstance(blocked, list):
        errors.append("blocked_cases must be a list")
        blocked = []
    if report.get("blocked_case_count") != len(blocked):
        errors.append("blocked_case_count does not match blocked_cases")

    candidate_dir = report_path.parent / "candidates"
    candidate_paths = sorted(candidate_dir.glob("*.json")) if candidate_dir.exists() else []
    if len(candidate_paths) != len(candidates):
        errors.append("candidate directory count does not match report")
    reported_paths = {item.get("path") for item in candidates if isinstance(item, dict)}
    for path in candidate_paths:
        if rel(path) not in reported_paths:
            errors.append(f"unreported candidate file {rel(path)}")
        try:
            errors.extend(validate_candidate(path))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{rel(path)}: {exc}")
    if not candidate_paths:
        errors.append("no supervised candidates emitted")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.exists():
        print(f"STATUS: FAIL ai_eda.macro_placement_supervised_model missing_report {args.report}")
        return 1
    try:
        report = load_json(args.report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.macro_placement_supervised_model {args.report}: {exc}")
        return 1
    errors = validate_report(report, args.report)
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_placement_supervised_model {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.macro_placement_supervised_model "
        f"candidates={report['candidate_count']} blocked={report['blocked_case_count']} "
        f"claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
