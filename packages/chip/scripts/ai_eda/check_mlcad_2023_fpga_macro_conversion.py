#!/usr/bin/env python3
"""Validate MLCAD 2023 FPGA macro-placement conversion records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/mlcad_2023_fpga_macro/validation/conversion_report.json"
CLAIM_BOUNDARY = "mlcad_2023_fpga_macro_conversion_training_only_no_e1_signoff_or_release_claim"
LABEL_STATUS = "public_mlcad_2023_fpga_macro_metadata_training_only_not_e1_signoff"
REQUIRED_SCHEMAS = {"eda.design_bundle.v1", "eda.graph_sample.v1", "eda.flow_run.v1"}
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


def positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_false_claim_flags(record: dict[str, Any], label: str) -> list[str]:
    return [
        f"{label}: {field} must be false"
        for field in REQUIRED_FALSE_CLAIM_FLAGS
        if record.get(field) is not False
    ]


def validate_file_record(record: Any, label: str) -> list[str]:
    if not isinstance(record, dict):
        return [f"{label}: expected file record"]
    errors: list[str] = []
    path_value = record.get("path")
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}: missing path"]
    if record.get("exists") is not True:
        errors.append(f"{label}: exists must be true")
    path = repo_path(path_value)
    if not path.is_file():
        errors.append(f"{label}: missing file {path_value}")
    if not positive_int(record.get("bytes")):
        errors.append(f"{label}: bytes must be positive")
    sha = record.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64:
        errors.append(f"{label}: sha256 must be a 64-character digest")
    return errors


def validate_design_record(record: dict[str, Any], path: Path) -> list[str]:
    record_id = str(record.get("id", rel(path)))
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    errors.extend(validate_false_claim_flags(record, record_id))
    sources = record.get("sources")
    if not isinstance(sources, dict):
        return errors + [f"{record_id}: sources must be a mapping"]
    specs = sources.get("benchmark_specs")
    if not isinstance(specs, list) or len(specs) < 4:
        errors.append(f"{record_id}: benchmark_specs must contain public spec files")
    else:
        for index, item in enumerate(specs):
            errors.extend(validate_file_record(item, f"{record_id}: benchmark_specs[{index}]"))
    case_files = sources.get("discovered_design_case_files")
    if not isinstance(case_files, list):
        errors.append(f"{record_id}: discovered_design_case_files must be a list")
    constraints = record.get("constraints")
    clocks = constraints.get("clocks") if isinstance(constraints, dict) else None
    if not isinstance(clocks, list) or len(clocks) != 1:
        errors.append(f"{record_id}: expected one clock bucket constraint")
    elif not positive_int(clocks[0].get("count")) or not clocks[0].get("design_ids"):
        errors.append(f"{record_id}: clock bucket must include count and design ids")
    technology = record.get("technology")
    if (
        not isinstance(technology, dict)
        or technology.get("flow") != "MLCAD 2023 FPGA Macro Placement Contest"
    ):
        errors.append(f"{record_id}: technology.flow mismatch")
    return errors


def validate_graph_record(record: dict[str, Any], path: Path) -> list[str]:
    record_id = str(record.get("id", rel(path)))
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    errors.extend(validate_false_claim_flags(record, record_id))
    graph = record.get("graph")
    labels = record.get("labels")
    if not isinstance(graph, dict):
        return errors + [f"{record_id}: graph must be a mapping"]
    if not isinstance(labels, dict):
        return errors + [f"{record_id}: labels must be a mapping"]
    nodes = graph.get("node_features")
    edges = graph.get("edge_features")
    if not isinstance(nodes, list) or len(nodes) < 5:
        errors.append(f"{record_id}: expected FPGA spec node features")
    if not isinstance(edges, list) or len(edges) < 3:
        errors.append(f"{record_id}: expected FPGA spec edge features")
    if labels.get("label_status") != LABEL_STATUS:
        errors.append(f"{record_id}: invalid label_status")
    values = labels.get("values")
    if not isinstance(values, dict):
        errors.append(f"{record_id}: labels.values must be a mapping")
    else:
        if not positive_int(values.get("clock_count")):
            errors.append(f"{record_id}: labels.values.clock_count must be positive")
        if not positive_int(values.get("design_count")):
            errors.append(f"{record_id}: labels.values.design_count must be positive")
        if not isinstance(values.get("design_ids"), list) or not values["design_ids"]:
            errors.append(f"{record_id}: labels.values.design_ids must be non-empty")
        status = values.get("full_design_case_conversion_status")
        if not isinstance(status, str) or "BLOCKED" not in status:
            errors.append(f"{record_id}: conversion status must remain blocked/fail-closed")
    sources = labels.get("label_sources")
    if not isinstance(sources, list) or not sources:
        errors.append(f"{record_id}: label_sources must be non-empty")
    return errors


def validate_flow_record(record: dict[str, Any], path: Path) -> list[str]:
    record_id = str(record.get("id", rel(path)))
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    errors.extend(validate_false_claim_flags(record, record_id))
    metrics = record.get("metrics")
    if not isinstance(metrics, dict):
        return errors + [f"{record_id}: metrics must be a mapping"]
    for field in (
        "clock_count",
        "design_count",
        "site_type_count",
        "site_count",
        "lib_cell_count",
        "lib_pin_count",
        "cascade_instance_count",
    ):
        if not positive_int(metrics.get(field)):
            errors.append(f"{record_id}: metrics.{field} must be positive")
    if metrics.get("label_status") != LABEL_STATUS:
        errors.append(f"{record_id}: invalid metrics.label_status")
    status = record.get("status")
    blockers = status.get("blockers") if isinstance(status, dict) else None
    if not isinstance(blockers, list) or len(blockers) < 3:
        errors.append(f"{record_id}: status.blockers must record replay/design-case blockers")
    inputs = record.get("inputs")
    if not isinstance(inputs, dict):
        errors.append(f"{record_id}: inputs must be a mapping")
    else:
        for name in ("clock_key", "device_layout", "library", "cascade_instances"):
            errors.extend(validate_file_record(inputs.get(name), f"{record_id}: inputs.{name}"))
    return errors


def case_from_path(path: Path) -> str:
    name = path.name.removeprefix("mlcad-2023-fpga-macro-")
    for suffix in ("-design-bundle.json", "-spec-graph.json", "-metadata-flow-run.json"):
        if name.endswith(suffix):
            return name.removesuffix(suffix)
    return path.stem


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.mlcad_2023_fpga_macro_conversion_report.v1":
        errors.append("report schema mismatch")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(report, "report"))
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for field in (
            "contains_vivado_design_checkpoints",
            "contains_hidden_benchmarks",
            "contains_macro_solution_labels",
            "release_use_allowed",
            "e1_signoff_evidence",
            *REQUIRED_FALSE_CLAIM_FLAGS,
        ):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        if policy.get("deterministic_replay_required_for_ppa_claims") is not True:
            errors.append("policy.deterministic_replay_required_for_ppa_claims must be true")
    bucket_count = report.get("converted_clock_bucket_count")
    design_count = report.get("converted_design_id_count")
    record_count = report.get("converted_record_count")
    if not positive_int(bucket_count):
        errors.append("converted_clock_bucket_count must be positive")
    if not positive_int(design_count):
        errors.append("converted_design_id_count must be positive")
    if record_count != int(bucket_count or 0) * len(REQUIRED_SCHEMAS):
        errors.append("converted_record_count must equal converted_clock_bucket_count * 3")
    if report.get("full_design_case_conversion_status") != "BLOCKED_MISSING_DESIGN_CASE_PAYLOAD":
        errors.append(
            "full_design_case_conversion_status must remain blocked until case payloads parse"
        )
    summaries = report.get("summaries")
    if not isinstance(summaries, dict):
        errors.append("summaries must be a mapping")
    else:
        dims = summaries.get("sitemap_dimensions")
        if (
            not isinstance(dims, dict)
            or not positive_int(dims.get("columns"))
            or not positive_int(dims.get("rows"))
        ):
            errors.append("summaries.sitemap_dimensions must include positive columns and rows")
        for field in ("lib_cell_count", "cascade_instance_count"):
            if not positive_int(summaries.get(field)):
                errors.append(f"summaries.{field} must be positive")
    converted = report.get("converted_records")
    if not isinstance(converted, list):
        return errors + ["converted_records must be a list"]
    if len(converted) != record_count:
        errors.append("converted_records length must match converted_record_count")
    record_paths: list[Path] = []
    for item in converted:
        if not isinstance(item, dict):
            errors.append("converted_records entries must be mappings")
            continue
        if item.get("schema") not in REQUIRED_SCHEMAS:
            errors.append(f"unsupported converted schema {item.get('schema')!r}")
        if not positive_int(item.get("clock_count")) or not positive_int(item.get("design_count")):
            errors.append(
                f"{item.get('id', '<unknown>')}: clock_count/design_count must be positive"
            )
        if item.get("status") != "CONVERTED_METADATA_ONLY_BLOCKED_MISSING_DESIGN_CASE_PAYLOAD":
            errors.append(f"{item.get('id', '<unknown>')}: status must remain blocked")
        path_value = item.get("json")
        if isinstance(path_value, str):
            record_paths.append(repo_path(path_value))
        else:
            errors.append("converted record missing json path")
    actual_records = sorted((report_path.parent / "records").glob("mlcad-2023-fpga-macro-*.json"))
    if sorted(record_paths) != actual_records:
        errors.append("report converted paths must exactly match records directory")
    cases: dict[str, set[str]] = {}
    for path in record_paths:
        if not path.is_file():
            errors.append(f"missing record {rel(path)}")
            continue
        record = load_json(path)
        schema = str(record.get("schema"))
        cases.setdefault(case_from_path(path), set()).add(schema)
        if schema == "eda.design_bundle.v1":
            errors.extend(validate_design_record(record, path))
        elif schema == "eda.graph_sample.v1":
            errors.extend(validate_graph_record(record, path))
        elif schema == "eda.flow_run.v1":
            errors.extend(validate_flow_record(record, path))
    for case, schemas in sorted(cases.items()):
        if schemas != REQUIRED_SCHEMAS:
            errors.append(f"{case}: expected one record for each required schema")
    if len(cases) != bucket_count:
        errors.append("converted_clock_bucket_count does not match unique cases")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.is_file():
        print(f"STATUS: FAIL ai_eda.mlcad_2023_fpga_macro_conversion missing_report {report_path}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.mlcad_2023_fpga_macro_conversion {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.mlcad_2023_fpga_macro_conversion {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.mlcad_2023_fpga_macro_conversion "
        f"clock_buckets={report['converted_clock_bucket_count']} "
        f"records={report['converted_record_count']} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
