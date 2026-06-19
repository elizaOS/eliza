#!/usr/bin/env python3
"""Validate EDALearn conversion reports and internal records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/edalearn/validation/conversion_report.json"
CLAIM_BOUNDARY = "edalearn_conversion_training_only_no_e1_signoff_or_release_claim"
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


def validate_source(record: Any, label: str) -> list[str]:
    if not isinstance(record, dict):
        return [f"{label}: expected source mapping"]
    errors: list[str] = []
    path_value = record.get("path")
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}: missing path"]
    if not repo_path(path_value).exists():
        errors.append(f"{label}: missing file {path_value}")
    if not positive_int(record.get("bytes")):
        errors.append(f"{label}: bytes must be positive")
    sha = record.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64:
        errors.append(f"{label}: sha256 must be a 64-character digest")
    return errors


def validate_metrics(
    values: Any, record_id: str, node_count: int | None = None, edge_count: int | None = None
) -> list[str]:
    if not isinstance(values, dict):
        return [f"{record_id}: metrics must be a mapping"]
    errors: list[str] = []
    for field in (
        "rtl_file_count",
        "rtl_total_bytes",
        "rtl_total_lines",
        "graph_node_count",
        "graph_edge_count",
    ):
        if not positive_int(values.get(field)):
            errors.append(f"{record_id}: {field} must be positive")
    if node_count is not None and values.get("graph_node_count") != node_count:
        errors.append(f"{record_id}: graph_node_count does not match graph nodes")
    if edge_count is not None and values.get("graph_edge_count") != edge_count:
        errors.append(f"{record_id}: graph_edge_count does not match graph edges")
    if not isinstance(values.get("language_histogram"), dict) or not values["language_histogram"]:
        errors.append(f"{record_id}: language_histogram must be non-empty")
    return errors


def validate_design(record: dict[str, Any], path: Path) -> list[str]:
    record_id = record.get("id", rel(path))
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    errors.extend(validate_false_claim_flags(record, record_id))
    sources = record.get("sources")
    if not isinstance(sources, dict):
        return [f"{record_id}: sources must be a mapping"]
    rtl = sources.get("rtl")
    configs = sources.get("configs")
    if not isinstance(rtl, list) or not rtl:
        errors.append(f"{record_id}: sources.rtl must be non-empty")
    else:
        for index, source in enumerate(rtl[:20]):
            errors.extend(validate_source(source, f"{record_id}: rtl[{index}]"))
    if not isinstance(configs, list) or len(configs) != 1:
        errors.append(f"{record_id}: expected one config source")
    else:
        errors.extend(validate_source(configs[0], f"{record_id}: configs[0]"))
    technology = record.get("technology")
    if not isinstance(technology, dict) or technology.get("flow") != "EDALearn":
        errors.append(f"{record_id}: technology.flow must be EDALearn")
    return errors


def validate_graph(record: dict[str, Any], path: Path) -> tuple[list[str], dict[str, int]]:
    record_id = record.get("id", rel(path))
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    errors.extend(validate_false_claim_flags(record, record_id))
    graph = record.get("graph")
    labels = record.get("labels")
    if not isinstance(graph, dict):
        return [f"{record_id}: graph must be a mapping"], {}
    if not isinstance(labels, dict):
        return [f"{record_id}: labels must be a mapping"], {}
    nodes = graph.get("node_features")
    edges = graph.get("edge_features")
    if not isinstance(nodes, list) or not nodes:
        errors.append(f"{record_id}: node_features must be non-empty")
        nodes = []
    if not isinstance(edges, list) or not edges:
        errors.append(f"{record_id}: edge_features must be non-empty")
        edges = []
    if labels.get("label_status") != "public_edalearn_rtl_config_training_only_not_e1_signoff":
        errors.append(f"{record_id}: invalid label_status")
    if not any(
        isinstance(node, dict) and node.get("node_type") == "rtl_source_file" for node in nodes
    ):
        errors.append(f"{record_id}: graph must include rtl_source_file nodes")
    errors.extend(validate_metrics(labels.get("values"), record_id, len(nodes), len(edges)))
    return errors, {"node_count": len(nodes), "edge_count": len(edges)}


def validate_flow(record: dict[str, Any], path: Path) -> list[str]:
    record_id = record.get("id", rel(path))
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    errors.extend(validate_false_claim_flags(record, record_id))
    errors.extend(validate_metrics(record.get("metrics"), record_id))
    status = record.get("status")
    blockers = status.get("blockers") if isinstance(status, dict) else None
    if not isinstance(blockers, list) or not blockers:
        errors.append(f"{record_id}: status.blockers must be non-empty")
    inputs = record.get("inputs")
    if isinstance(inputs, dict):
        errors.extend(validate_source(inputs.get("config"), f"{record_id}: inputs.config"))
        rtl = inputs.get("rtl")
        if not isinstance(rtl, list) or not rtl:
            errors.append(f"{record_id}: inputs.rtl must be non-empty")
    else:
        errors.append(f"{record_id}: inputs must be a mapping")
    return errors


def design_from_path(path: Path) -> str:
    name = path.name.removeprefix("edalearn-")
    for suffix in ("-design-bundle.json", "-rtl-graph.json", "-flow-run.json"):
        if name.endswith(suffix):
            return name.removesuffix(suffix)
    return path.stem.removeprefix("edalearn-")


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.edalearn_conversion_report.v1":
        errors.append("report schema must be eliza.ai_eda.edalearn_conversion_report.v1")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary is missing or incorrect")
    errors.extend(validate_false_claim_flags(report, "report"))
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    converted_count = report.get("converted_design_count")
    record_count = report.get("converted_record_count")
    if not positive_int(converted_count):
        errors.append("converted_design_count must be positive")
    if record_count != int(converted_count or 0) * len(REQUIRED_SCHEMAS):
        errors.append("converted_record_count must equal converted_design_count * 3")
    if report.get("available_design_count", 0) < int(converted_count or 0):
        errors.append("available_design_count must be at least converted_design_count")
    converted = report.get("converted_records")
    if not isinstance(converted, list):
        return errors + ["converted_records must be a list"]
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
            errors.append("converted record is missing json path")
    actual_records = sorted((report_path.parent / "records").glob("edalearn-*.json"))
    if sorted(record_paths) != actual_records:
        errors.append("report converted paths must exactly match records directory")
    cases: dict[str, set[str]] = {}
    for path in record_paths:
        if not path.exists():
            errors.append(f"missing record {rel(path)}")
            continue
        record = load_json(path)
        schema = record.get("schema")
        cases.setdefault(design_from_path(path), set()).add(str(schema))
        if schema == "eda.design_bundle.v1":
            errors.extend(validate_design(record, path))
        elif schema == "eda.graph_sample.v1":
            graph_errors, _ = validate_graph(record, path)
            errors.extend(graph_errors)
        elif schema == "eda.flow_run.v1":
            errors.extend(validate_flow(record, path))
    for case, schemas in sorted(cases.items()):
        if schemas != REQUIRED_SCHEMAS:
            errors.append(f"{case}: expected one record for each required schema")
    if len(cases) != converted_count:
        errors.append("converted_design_count does not match unique designs")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.exists():
        print(f"STATUS: FAIL ai_eda.edalearn_conversion missing_report {report_path}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.edalearn_conversion {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.edalearn_conversion {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.edalearn_conversion "
        f"designs={report['converted_design_count']} records={report['converted_record_count']} "
        f"claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
