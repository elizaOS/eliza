#!/usr/bin/env python3
"""Validate ChiPBench-D conversion reports and internal placement records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/chipbench_d/validation/conversion_report.json"
CLAIM_BOUNDARY = "chipbench_d_conversion_training_only_no_e1_signoff_or_release_claim"
REQUIRED_SCHEMAS = {"eda.design_bundle.v1", "eda.placement_case.v1", "eda.flow_run.v1"}


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


def positive_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def validate_file_record(record: Any, label: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(record, dict):
        return [f"{label}: expected file record"]
    path_value = record.get("path")
    if not isinstance(path_value, str) or not path_value:
        errors.append(f"{label}: missing path")
        return errors
    if record.get("exists") is not True:
        errors.append(f"{label}: exists must be true")
    path = repo_path(path_value)
    if not path.exists():
        errors.append(f"{label}: missing file {path_value}")
    if not positive_number(record.get("bytes")):
        errors.append(f"{label}: bytes must be positive")
    sha = record.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64:
        errors.append(f"{label}: sha256 must be a 64-character hex digest")
    return errors


def validate_placement_record(record: dict[str, Any], path: Path) -> tuple[list[str], int]:
    errors: list[str] = []
    record_id = record.get("id", rel(path))
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    floorplan = record.get("floorplan")
    if not isinstance(floorplan, dict):
        errors.append(f"{record_id}: floorplan must be a mapping")
        return errors, 0
    die_area = floorplan.get("die_area_um")
    if not isinstance(die_area, list) or len(die_area) != 4 or die_area[2] <= die_area[0] or die_area[3] <= die_area[1]:
        errors.append(f"{record_id}: invalid die_area_um")
    rows = floorplan.get("rows")
    if not isinstance(rows, dict) or not positive_number(rows.get("count")):
        errors.append(f"{record_id}: rows.count must be positive")
    errors.extend(validate_file_record(floorplan.get("pre_place_def"), f"{record_id}: pre_place_def"))
    errors.extend(validate_file_record(floorplan.get("macro_placed_def"), f"{record_id}: macro_placed_def"))

    movable = record.get("movable_objects")
    if not isinstance(movable, list) or not movable:
        errors.append(f"{record_id}: movable_objects must be non-empty")
        return errors, 0
    target_count = 0
    for index, obj in enumerate(movable):
        label = f"{record_id}: movable_objects[{index}]"
        if not isinstance(obj, dict):
            errors.append(f"{label}: must be a mapping")
            continue
        for field in ("id", "type", "macro_name", "orientation"):
            if not obj.get(field):
                errors.append(f"{label}: missing {field}")
        for field in ("width_um", "height_um"):
            if not positive_number(obj.get(field)):
                errors.append(f"{label}: {field} must be positive")
        target = obj.get("target_placement")
        if isinstance(target, dict):
            target_count += 1
            if not isinstance(target.get("orientation"), str) or not target.get("orientation"):
                errors.append(f"{label}: target orientation is required")
            for field in ("x_um", "y_um"):
                value = target.get(field)
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    errors.append(f"{label}: target {field} must be numeric")
        else:
            errors.append(f"{label}: missing target_placement")
    return errors, target_count


def validate_flow_record(record: dict[str, Any], path: Path) -> list[str]:
    errors: list[str] = []
    record_id = record.get("id", rel(path))
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    metrics = record.get("metrics")
    if not isinstance(metrics, dict):
        return [f"{record_id}: metrics must be a mapping"]
    if metrics.get("label_status") != "public_chipbench_d_macro_targets_training_only_not_e1_signoff":
        errors.append(f"{record_id}: invalid label_status")
    if not positive_number(metrics.get("macro_target_count")):
        errors.append(f"{record_id}: macro_target_count must be positive")
    status = record.get("status")
    blockers = status.get("blockers") if isinstance(status, dict) else None
    if not isinstance(blockers, list) or not blockers:
        errors.append(f"{record_id}: status.blockers must list replay and release blockers")
    return errors


def validate_design_record(record: dict[str, Any], path: Path) -> list[str]:
    errors: list[str] = []
    record_id = record.get("id", rel(path))
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    sources = record.get("sources")
    if not isinstance(sources, dict):
        return [f"{record_id}: sources must be a mapping"]
    rtl = sources.get("rtl")
    if not isinstance(rtl, list) or not rtl:
        errors.append(f"{record_id}: sources.rtl must be non-empty")
    else:
        errors.extend(validate_file_record(rtl[0], f"{record_id}: rtl[0]"))
    lef = sources.get("lef")
    if not isinstance(lef, list) or not lef:
        errors.append(f"{record_id}: sources.lef must be non-empty")
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.chipbench_d_conversion_report.v1":
        errors.append("report schema must be eliza.ai_eda.chipbench_d_conversion_report.v1")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary is missing or incorrect")
    if report.get("available_case_count", 0) < report.get("converted_case_count", 0):
        errors.append("available_case_count must be at least converted_case_count")
    if report.get("record_count") != report.get("converted_case_count", 0) * len(REQUIRED_SCHEMAS):
        errors.append("record_count must equal converted_case_count * 3")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        if policy.get("release_use_allowed") is not False:
            errors.append("policy.release_use_allowed must be false")
        if policy.get("e1_signoff_evidence") is not False:
            errors.append("policy.e1_signoff_evidence must be false")
        if policy.get("deterministic_replay_required_for_ppa_claims") is not True:
            errors.append("policy.deterministic_replay_required_for_ppa_claims must be true")

    converted = report.get("converted")
    if not isinstance(converted, list):
        errors.append("converted must be a list")
        return errors
    if len(converted) != report.get("record_count"):
        errors.append("converted length must match record_count")
    record_paths = []
    for item in converted:
        if not isinstance(item, dict):
            errors.append("converted entries must be mappings")
            continue
        schema = item.get("schema")
        if schema not in REQUIRED_SCHEMAS:
            errors.append(f"converted entry has unsupported schema {schema!r}")
        path_value = item.get("json")
        if not isinstance(path_value, str):
            errors.append("converted entry is missing json path")
            continue
        record_paths.append(repo_path(path_value))

    records_dir = report_path.parent / "records"
    actual_records = sorted(records_dir.glob("chipbench-d-*.json"))
    if sorted(record_paths) != actual_records:
        errors.append("report converted paths must exactly match records directory")

    cases: dict[str, set[str]] = {}
    placement_targets = 0
    for path in record_paths:
        if not path.exists():
            errors.append(f"missing record {rel(path)}")
            continue
        record = load_json(path)
        schema = record.get("schema")
        stem = path.name.removeprefix("chipbench-d-")
        case = stem.rsplit("-", 2)[0]
        cases.setdefault(case, set()).add(str(schema))
        if schema == "eda.design_bundle.v1":
            errors.extend(validate_design_record(record, path))
        elif schema == "eda.placement_case.v1":
            placement_errors, target_count = validate_placement_record(record, path)
            errors.extend(placement_errors)
            placement_targets += target_count
        elif schema == "eda.flow_run.v1":
            errors.extend(validate_flow_record(record, path))
    for case, schemas in sorted(cases.items()):
        if schemas != REQUIRED_SCHEMAS:
            errors.append(f"{case}: expected one record for each required schema")
    if len(cases) != report.get("converted_case_count"):
        errors.append("converted_case_count does not match unique cases")
    if placement_targets <= 0:
        errors.append("no placement target labels were validated")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.exists():
        print(f"STATUS: FAIL ai_eda.chipbench_d_conversion missing_report {report_path}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.chipbench_d_conversion {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.chipbench_d_conversion {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.chipbench_d_conversion "
        f"cases={report['converted_case_count']} records={report['record_count']} "
        f"claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
