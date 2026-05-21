#!/usr/bin/env python3
"""Validate Macro Placement Challenge 2026 conversion records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/macro_place_challenge_2026/validation/conversion_report.json"
CLAIM_BOUNDARY = "macro_place_challenge_2026_conversion_training_only_no_e1_signoff_or_release_claim"
LABEL_STATUS = "public_macro_place_challenge_2026_proxy_and_baseline_training_only_not_e1_signoff"
REQUIRED_SCHEMAS = {"eda.design_bundle.v1", "eda.graph_sample.v1", "eda.flow_run.v1"}


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


def validate_file_record(record: Any, label: str, *, require_present: bool = True) -> list[str]:
    if not isinstance(record, dict):
        return [f"{label}: expected file record"]
    errors: list[str] = []
    path_value = record.get("path")
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}: missing path"]
    if require_present and record.get("exists") is not True:
        errors.append(f"{label}: exists must be true")
    path = repo_path(path_value)
    if require_present and not path.is_file():
        errors.append(f"{label}: missing file {path_value}")
    if require_present and not positive_number(record.get("bytes")):
        errors.append(f"{label}: bytes must be positive")
    sha = record.get("sha256")
    if require_present and (not isinstance(sha, str) or len(sha) != 64):
        errors.append(f"{label}: sha256 must be a 64-character digest")
    return errors


def validate_design_record(record: dict[str, Any], path: Path) -> list[str]:
    record_id = str(record.get("id", rel(path)))
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    sources = record.get("sources")
    if not isinstance(sources, dict):
        return errors + [f"{record_id}: sources must be a mapping"]
    tensors = sources.get("benchmark_tensors")
    if not isinstance(tensors, list) or len(tensors) != 1:
        errors.append(f"{record_id}: expected one benchmark tensor source")
    else:
        errors.extend(validate_file_record(tensors[0], f"{record_id}: benchmark_tensors[0]"))
    metadata = sources.get("metadata")
    if not isinstance(metadata, list) or len(metadata) < 1:
        errors.append(f"{record_id}: metadata sources must be non-empty")
    else:
        for index, item in enumerate(metadata):
            errors.extend(validate_file_record(item, f"{record_id}: metadata[{index}]"))
    technology = record.get("technology")
    if not isinstance(technology, dict) or technology.get("flow") != "Partcl/HRT Macro Placement Challenge 2026":
        errors.append(f"{record_id}: technology.flow mismatch")
    return errors


def validate_graph_record(record: dict[str, Any], path: Path) -> list[str]:
    record_id = str(record.get("id", rel(path)))
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    graph = record.get("graph")
    labels = record.get("labels")
    if not isinstance(graph, dict):
        return errors + [f"{record_id}: graph must be a mapping"]
    if not isinstance(labels, dict):
        return errors + [f"{record_id}: labels must be a mapping"]
    nodes = graph.get("node_features")
    edges = graph.get("edge_features")
    if not isinstance(nodes, list) or len(nodes) < 4:
        errors.append(f"{record_id}: expected benchmark summary node features")
    if not isinstance(edges, list) or not edges:
        errors.append(f"{record_id}: edge_features must be non-empty")
    if labels.get("label_status") != LABEL_STATUS:
        errors.append(f"{record_id}: invalid label_status")
    values = labels.get("values")
    if not isinstance(values, dict):
        errors.append(f"{record_id}: labels.values must be a mapping")
    else:
        initial = values.get("initial_placement")
        if not isinstance(initial, dict) or not positive_number(initial.get("proxy_cost")):
            errors.append(f"{record_id}: initial_placement.proxy_cost must be positive")
        ppa = values.get("ppa_baselines")
        if not isinstance(ppa, list):
            errors.append(f"{record_id}: ppa_baselines must be a list")
    sources = labels.get("label_sources")
    if not isinstance(sources, list) or not sources:
        errors.append(f"{record_id}: label_sources must be non-empty")
    return errors


def validate_flow_record(record: dict[str, Any], path: Path) -> list[str]:
    record_id = str(record.get("id", rel(path)))
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    metrics = record.get("metrics")
    if not isinstance(metrics, dict):
        return errors + [f"{record_id}: metrics must be a mapping"]
    for field in ("num_macros", "num_nets", "canvas_width_um", "canvas_height_um", "initial_proxy_cost"):
        if not positive_number(metrics.get(field)):
            errors.append(f"{record_id}: metrics.{field} must be positive")
    if metrics.get("label_status") != LABEL_STATUS:
        errors.append(f"{record_id}: invalid metrics.label_status")
    status = record.get("status")
    blockers = status.get("blockers") if isinstance(status, dict) else None
    if not isinstance(blockers, list) or not blockers:
        errors.append(f"{record_id}: status.blockers must be non-empty")
    return errors


def case_from_path(path: Path) -> str:
    name = path.name.removeprefix("macro-place-challenge-2026-")
    for suffix in ("-design-bundle.json", "-benchmark-summary-graph.json", "-baseline-flow-run.json"):
        if name.endswith(suffix):
            return name.removesuffix(suffix)
    return path.stem


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.macro_place_challenge_2026_conversion_report.v1":
        errors.append("report schema mismatch")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary mismatch")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for field in ("contains_tensor_payload", "contains_hidden_benchmarks", "release_use_allowed", "e1_signoff_evidence"):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        if policy.get("deterministic_replay_required_for_ppa_claims") is not True:
            errors.append("policy.deterministic_replay_required_for_ppa_claims must be true")
    converted_count = report.get("converted_benchmark_count")
    record_count = report.get("converted_record_count")
    if not isinstance(converted_count, int) or converted_count <= 0:
        errors.append("converted_benchmark_count must be positive")
    if record_count != int(converted_count or 0) * len(REQUIRED_SCHEMAS):
        errors.append("converted_record_count must equal converted_benchmark_count * 3")
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
        path_value = item.get("json")
        if isinstance(path_value, str):
            record_paths.append(repo_path(path_value))
        else:
            errors.append("converted record missing json path")
    actual_records = sorted((report_path.parent / "records").glob("macro-place-challenge-2026-*.json"))
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
    if len(cases) != converted_count:
        errors.append("converted_benchmark_count does not match unique cases")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.is_file():
        print(f"STATUS: FAIL ai_eda.macro_place_challenge_2026_conversion missing_report {report_path}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.macro_place_challenge_2026_conversion {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_place_challenge_2026_conversion {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.macro_place_challenge_2026_conversion "
        f"benchmarks={report['converted_benchmark_count']} records={report['converted_record_count']} "
        f"claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
