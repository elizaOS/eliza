#!/usr/bin/env python3
"""Validate CircuitNet3 surrogate training artifacts."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/circuitnet3_surrogate/validation/training_run.json"
CLAIM_BOUNDARY = (
    "circuitnet3_surrogate_training_pretraining_only_no_e1_ppa_signoff_or_release_claim"
)
REQUIRED_SPLITS = ("train", "val", "test")
REQUIRED_FALSE_CLAIM_FLAGS = (
    "claim_allowed",
    "release_claim_allowed",
    "training_claim_allowed",
    "inference_claim_allowed",
    "e1_signoff_claim_allowed",
    "ppa_signoff_claim_allowed",
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
        raise ValueError(f"{path}: expected JSON object")
    return data


def jsonl_count(path: Path) -> int:
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def valid_number(value: Any) -> bool:
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
    if report.get("schema") != "eliza.ai_eda.circuitnet3_surrogate_training_run.v1":
        errors.append("report schema must be eliza.ai_eda.circuitnet3_surrogate_training_run.v1")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary is missing or incorrect")
    if report.get("release_use_allowed") is not False:
        errors.append("report release_use_allowed must be false")
    errors.extend(validate_false_claim_flags(report, "report"))
    out_dir = report_path.parent
    split_counts = report.get("split_counts")
    if not isinstance(split_counts, dict):
        errors.append("report split_counts must be a mapping")
        split_counts = {}
    total = 0
    for split in REQUIRED_SPLITS:
        split_path = out_dir / f"{split}.jsonl"
        if not split_path.exists():
            errors.append(f"missing split file: {rel(split_path)}")
            continue
        count = jsonl_count(split_path)
        total += count
        if split_counts.get(split) != count:
            errors.append(f"{split}: split_counts does not match jsonl")
    if report.get("sample_count") != total:
        errors.append("report sample_count does not match split file counts")

    model_path = repo_path(str(report.get("model", "")))
    metrics_path = repo_path(str(report.get("metrics", "")))
    for label, path in (("model", model_path), ("metrics", metrics_path)):
        if not path.exists():
            errors.append(f"missing {label}: {rel(path)}")
    if errors:
        return errors
    model = load_json(model_path)
    metrics = load_json(metrics_path)
    if model.get("schema") != "eliza.ai_eda.circuitnet3_surrogate_model.v1":
        errors.append("model schema is incorrect")
    if model.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("model claim_boundary is missing or incorrect")
    errors.extend(validate_false_claim_flags(model, "model"))
    targets = model.get("targets")
    if not isinstance(targets, dict) or not targets:
        errors.append("model targets must be a non-empty mapping")
    elif any(not valid_number(value) for value in targets.values()):
        errors.append("model target predictions must be finite numbers")
    if metrics.get("schema") != "eliza.ai_eda.circuitnet3_surrogate_metrics.v1":
        errors.append("metrics schema is incorrect")
    if metrics.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("metrics claim_boundary is missing or incorrect")
    errors.extend(validate_false_claim_flags(metrics, "metrics"))
    splits = metrics.get("splits")
    if not isinstance(splits, list) or {
        item.get("split") for item in splits if isinstance(item, dict)
    } != set(REQUIRED_SPLITS):
        errors.append("metrics splits must cover train, val, and test")
    else:
        for item in splits:
            if not isinstance(item, dict):
                errors.append("metrics split entries must be objects")
                continue
            if split_counts.get(item.get("split")) != item.get("sample_count"):
                errors.append(f"{item.get('split')}: metrics sample_count does not match report")
            target_metrics = item.get("targets")
            if not isinstance(target_metrics, dict):
                errors.append(f"{item.get('split')}: targets must be a mapping")
                continue
            for target, values in target_metrics.items():
                if not isinstance(values, dict):
                    errors.append(f"{item.get('split')}/{target}: metrics must be a mapping")
                    continue
                if values.get("mae") is not None and not valid_number(values.get("mae")):
                    errors.append(f"{item.get('split')}/{target}: mae must be finite or null")
                if not valid_number(values.get("prediction")):
                    errors.append(f"{item.get('split')}/{target}: prediction must be finite")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.exists():
        print(f"STATUS: FAIL ai_eda.circuitnet3_surrogate missing_report {args.report}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report, args.report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.circuitnet3_surrogate {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.circuitnet3_surrogate {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.circuitnet3_surrogate "
        f"samples={report['sample_count']} splits={report['split_counts']} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
