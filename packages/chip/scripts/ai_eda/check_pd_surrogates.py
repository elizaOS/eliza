#!/usr/bin/env python3
"""Validate CircuitNet3 GNN PD surrogate training artifacts.

The checker is dependency-free and never imports torch. It validates the JSON
training report and metrics: schema, claim boundary, no-release flag, device,
epochs, design-id split leakage, finite metrics with error-bar fields, the
serialized model file presence/nonzero size, and that the GNN matches or beats
the train-split mean baseline on at least one target on the test split.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/pd_surrogates/validation/gnn_training_run.json"
CLAIM_BOUNDARY = "circuitnet3_gnn_training_pretraining_only_no_e1_ppa_signoff_or_release_claim"
REQUIRED_SPLITS = ("train", "val", "test")
ERROR_BAR_FIELDS = ("mae", "mae_std", "abs_error_p50", "abs_error_p90")


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


def valid_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def as_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    parsed = float(value)
    return parsed if math.isfinite(parsed) else None


def validate_split_leakage(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    held_out = report.get("held_out_design_ids")
    if not isinstance(held_out, dict) or set(held_out) != set(REQUIRED_SPLITS):
        errors.append("held_out_design_ids must map train, val, and test to design id lists")
        return errors
    seen: dict[str, str] = {}
    split_id_sets: dict[str, set[str]] = {}
    for split in REQUIRED_SPLITS:
        ids = held_out.get(split)
        if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids):
            errors.append(f"held_out_design_ids[{split}] must be a list of strings")
            split_id_sets[split] = set()
            continue
        split_id_sets[split] = set(ids)
        for design_id in ids:
            if design_id in seen:
                errors.append(
                    f"design id leakage: {design_id} appears in {seen[design_id]} and {split}"
                )
            seen[design_id] = split
    if not split_id_sets.get("train"):
        errors.append("train split must contain at least one design id")
    return errors


def validate_metrics(metrics: dict[str, Any], report: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    beaten_targets: list[str] = []
    if metrics.get("schema") != "eliza.ai_eda.pd_surrogates_metrics.v1":
        errors.append("metrics schema must be eliza.ai_eda.pd_surrogates_metrics.v1")
    if metrics.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("metrics claim_boundary is missing or incorrect")
    if metrics.get("release_use_allowed") is not False:
        errors.append("metrics release_use_allowed must be false")
    if metrics.get("device") != report.get("device"):
        errors.append("metrics device does not match report device")
    if metrics.get("epochs") != report.get("epochs"):
        errors.append("metrics epochs does not match report epochs")

    splits = metrics.get("splits")
    if not isinstance(splits, list):
        errors.append("metrics.splits must be a list")
        return errors, beaten_targets
    by_split = {item.get("split"): item for item in splits if isinstance(item, dict)}
    if set(by_split) != set(REQUIRED_SPLITS):
        errors.append("metrics.splits must cover train, val, and test")
    split_counts = report.get("split_counts", {})
    for split in REQUIRED_SPLITS:
        item = by_split.get(split)
        if not isinstance(item, dict):
            continue
        if isinstance(split_counts, dict) and split_counts.get(split) != item.get("sample_count"):
            errors.append(f"{split}: metrics sample_count does not match report split_counts")
        target_metrics = item.get("targets")
        if not isinstance(target_metrics, dict):
            errors.append(f"{split}: targets must be a mapping")
            continue
        if split == "test" and not target_metrics:
            errors.append("test split must report at least one target")
        for target, values in target_metrics.items():
            if not isinstance(values, dict):
                errors.append(f"{split}/{target}: metrics must be a mapping")
                continue
            for field in ERROR_BAR_FIELDS:
                if not valid_number(values.get(field)):
                    errors.append(f"{split}/{target}: {field} must be finite")
            if not isinstance(values.get("sample_count"), int) or values["sample_count"] <= 0:
                errors.append(f"{split}/{target}: sample_count must be a positive integer")
            baseline_mae = values.get("baseline_mae")
            if baseline_mae is not None and not valid_number(baseline_mae):
                errors.append(f"{split}/{target}: baseline_mae must be finite or null")
            mae = as_float(values.get("mae"))
            baseline = as_float(baseline_mae)
            if split == "test" and mae is not None and baseline is not None and mae <= baseline + 1e-9:
                beaten_targets.append(target)

    history = metrics.get("loss_history")
    if not isinstance(history, list) or not history:
        errors.append("metrics.loss_history must be a non-empty list")
    else:
        previous = 0
        for item in history:
            if not isinstance(item, dict) or not isinstance(item.get("epoch"), int) or item["epoch"] <= previous:
                errors.append("metrics.loss_history epochs must be strictly increasing integers")
            else:
                previous = item["epoch"]
            if not valid_number(item.get("loss")) or float(item.get("loss", -1)) < 0:
                errors.append("metrics.loss_history loss must be a finite non-negative number")
    return errors, beaten_targets


def validate(report: dict[str, Any], report_path: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.pd_surrogates_training_run.v1":
        errors.append("report schema must be eliza.ai_eda.pd_surrogates_training_run.v1")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary is missing or incorrect")
    if report.get("release_use_allowed") is not False:
        errors.append("report release_use_allowed must be false")
    if report.get("device") not in {"cpu", "cuda"}:
        errors.append("report device must be cpu or cuda")
    if not isinstance(report.get("epochs"), int) or int(report["epochs"]) <= 0:
        errors.append("report epochs must be a positive integer")

    split_counts = report.get("split_counts")
    if not isinstance(split_counts, dict) or set(split_counts) != set(REQUIRED_SPLITS):
        errors.append("report split_counts must cover train, val, and test")
        split_counts = {}
    if not any(isinstance(v, int) and v > 0 for v in split_counts.values()):
        errors.append("report split_counts must include a populated split")

    errors.extend(validate_split_leakage(report))

    model_path = repo_path(str(report.get("model", "")))
    metrics_path = repo_path(str(report.get("metrics", "")))
    if not model_path.exists():
        errors.append(f"missing model file: {rel(model_path)}")
    elif model_path.stat().st_size <= 0:
        errors.append(f"model file is empty: {rel(model_path)}")
    if not metrics_path.exists():
        errors.append(f"missing metrics file: {rel(metrics_path)}")
        return errors, []

    metrics = load_json(metrics_path)
    metric_errors, beaten = validate_metrics(metrics, report)
    errors.extend(metric_errors)
    if not beaten:
        errors.append("GNN does not match or beat mean baseline on any test target")
    return errors, beaten


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.exists():
        print(f"STATUS: FAIL ai_eda.pd_surrogates missing_report {args.report}")
        return 1
    try:
        report = load_json(args.report)
        errors, beaten = validate(report, args.report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.pd_surrogates {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.pd_surrogates {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.pd_surrogates "
        f"device={report['device']} splits={report['split_counts']} "
        f"beats_baseline_on={','.join(sorted(beaten))} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
