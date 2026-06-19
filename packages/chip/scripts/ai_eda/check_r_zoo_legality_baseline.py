#!/usr/bin/env python3
"""Validate R-Zoo legality baseline training artifacts."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/r_zoo_legality_baseline/validation/training_run.json"
CLAIM_BOUNDARY = "r_zoo_legality_baseline_training_only_no_e1_signoff_or_release_claim"
REQUIRED_SPLITS = {"train", "val", "test"}
REQUIRED_FALSE_CLAIM_FLAGS = (
    "claim_allowed",
    "release_claim_allowed",
    "training_claim_allowed",
    "inference_claim_allowed",
    "e1_signoff_claim_allowed",
)


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
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def jsonl_count(path: Path) -> int:
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def finite(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def validate_false_claim_flags(record: dict[str, Any], label: str) -> list[str]:
    return [
        f"{label}: {field} must be false"
        for field in REQUIRED_FALSE_CLAIM_FLAGS
        if record.get(field) is not False
    ]


def validate(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.r_zoo_legality_training_run.v1":
        errors.append("report schema mismatch")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(report, "report"))
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be mapping")
    else:
        if policy.get("release_use_allowed") is not False:
            errors.append("policy.release_use_allowed must be false")
        if policy.get("e1_signoff_evidence") is not False:
            errors.append("policy.e1_signoff_evidence must be false")
        if policy.get("runs_openlane_or_openroad") is not False:
            errors.append("policy.runs_openlane_or_openroad must be false")
        for field in REQUIRED_FALSE_CLAIM_FLAGS:
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
    if report.get("sample_count") != 14:
        errors.append("sample_count must be 14")
    split_manifest = report.get("split_manifest")
    if not isinstance(split_manifest, str) or not split_manifest:
        errors.append("split_manifest must be present")
    elif split_manifest == "fallback_record_dir_stratified_split":
        errors.append("baseline must consume the deterministic R-Zoo split manifest")
    elif not repo_path(split_manifest).is_file():
        errors.append(f"split_manifest missing on disk: {split_manifest}")
    if (
        report.get("split_policy")
        != "deterministic_design_family_holdout_from_r_zoo_split_manifest"
    ):
        errors.append("split_policy must use deterministic design-family holdout")
    split_counts = report.get("split_counts")
    if not isinstance(split_counts, dict) or set(split_counts) != REQUIRED_SPLITS:
        errors.append("split_counts must cover train/val/test")
        split_counts = {}
    out_dir = report_path.parent
    total = 0
    for split in sorted(REQUIRED_SPLITS):
        path = out_dir / f"{split}.jsonl"
        if not path.is_file():
            errors.append(f"missing split file {rel(path)}")
            continue
        count = jsonl_count(path)
        total += count
        if split_counts.get(split) != count:
            errors.append(f"{split}: split count mismatch")
    if total != report.get("sample_count"):
        errors.append("split files do not sum to sample_count")
    model_path = repo_path(str(report.get("model", "")))
    metrics_path = repo_path(str(report.get("metrics", "")))
    if not model_path.is_file():
        errors.append(f"missing model {rel(model_path)}")
    if not metrics_path.is_file():
        errors.append(f"missing metrics {rel(metrics_path)}")
    if errors:
        return errors
    model = load_json(model_path)
    metrics = load_json(metrics_path)
    if model.get("schema") != "eliza.ai_eda.r_zoo_legality_model.v1":
        errors.append("model schema mismatch")
    if model.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("model claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(model, "model"))
    weights = model.get("weights")
    if not isinstance(weights, dict) or len(weights) < 5:
        errors.append("model weights must be non-empty")
    elif any(not finite(value) for value in weights.values()):
        errors.append("model weights must be finite")
    if metrics.get("schema") != "eliza.ai_eda.r_zoo_legality_metrics.v1":
        errors.append("metrics schema mismatch")
    if metrics.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("metrics claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(metrics, "metrics"))
    splits = metrics.get("splits")
    if (
        not isinstance(splits, list)
        or {item.get("split") for item in splits if isinstance(item, dict)} != REQUIRED_SPLITS
    ):
        errors.append("metrics splits must cover train/val/test")
    else:
        for item in splits:
            if not isinstance(item, dict):
                errors.append("metrics split entries must be mappings")
                continue
            accuracy = item.get("accuracy")
            if accuracy is not None and (not finite(accuracy) or not 0.0 <= float(accuracy) <= 1.0):
                errors.append(f"{item.get('split')}: accuracy must be in [0,1]")
            predictions = item.get("predictions")
            if not isinstance(predictions, list) or len(predictions) != item.get("sample_count"):
                errors.append(f"{item.get('split')}: predictions length mismatch")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.is_file():
        print(f"STATUS: FAIL ai_eda.r_zoo_legality_baseline missing_report {rel(report_path)}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.r_zoo_legality_baseline {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.r_zoo_legality_baseline {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.r_zoo_legality_baseline "
        f"samples={report['sample_count']} splits={report['split_counts']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
