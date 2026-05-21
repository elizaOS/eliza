#!/usr/bin/env python3
"""Validate AiEDA/iDATA conversion reports and internal graph records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/aieda_idata/validation/conversion_report.json"
CLAIM_BOUNDARY = "aieda_idata_conversion_training_only_no_e1_signoff_or_release_claim"
REQUIRED_SCHEMAS = {"eda.design_bundle.v1", "eda.graph_sample.v1", "eda.flow_run.v1"}
LABEL_STATUS = "public_aieda_idata_routing_demand_training_only_not_e1_signoff"


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


def positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_source(record: Any, label: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(record, dict):
        return [f"{label}: expected source mapping"]
    path_value = record.get("path")
    if not isinstance(path_value, str) or not path_value:
        errors.append(f"{label}: missing path")
        return errors
    if not repo_path(path_value).exists():
        errors.append(f"{label}: missing file {path_value}")
    sha = record.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64:
        errors.append(f"{label}: sha256 must be a 64-character digest")
    return errors


def validate_stats(
    values: Any, record_id: str, node_count: int | None = None, edge_count: int | None = None
) -> list[str]:
    errors: list[str] = []
    if not isinstance(values, dict):
        return [f"{record_id}: stats must be a mapping"]
    for field in ("row_count", "col_count", "cell_count", "nonzero_count"):
        if not positive_int(values.get(field)):
            errors.append(f"{record_id}: {field} must be a positive integer")
    for field in (
        "max_demand",
        "total_demand",
        "mean_demand",
        "nonzero_mean_demand",
        "p95_nonzero_demand",
    ):
        if not positive_number(values.get(field)):
            errors.append(f"{record_id}: {field} must be a positive number")
    nonzero_density = values.get("nonzero_density")
    if (
        not isinstance(nonzero_density, (int, float))
        or isinstance(nonzero_density, bool)
        or nonzero_density <= 0
        or nonzero_density > 1
    ):
        errors.append(f"{record_id}: nonzero_density must be in (0, 1]")
    if not positive_int(values.get("edge_count")):
        errors.append(f"{record_id}: edge_count must be a positive integer")
    if node_count is not None and values.get("nonzero_count") != node_count:
        errors.append(f"{record_id}: nonzero_count does not match graph nodes")
    if edge_count is not None and values.get("edge_count") != edge_count:
        errors.append(f"{record_id}: edge_count does not match graph edges")
    if positive_int(values.get("row_count")) and positive_int(values.get("col_count")):
        if values.get("cell_count") != values["row_count"] * values["col_count"]:
            errors.append(f"{record_id}: cell_count must equal row_count * col_count")
        if (
            positive_int(values.get("nonzero_count"))
            and values["nonzero_count"] > values["cell_count"]
        ):
            errors.append(f"{record_id}: nonzero_count cannot exceed cell_count")
    return errors


def validate_design(record: dict[str, Any], path: Path) -> list[str]:
    errors: list[str] = []
    record_id = record.get("id", rel(path))
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    sources = record.get("sources")
    if not isinstance(sources, dict):
        return [f"{record_id}: sources must be a mapping"]
    grids = sources.get("grids")
    if not isinstance(grids, list) or len(grids) != 1:
        errors.append(f"{record_id}: expected one iDATA grid source")
    else:
        errors.extend(validate_source(grids[0], f"{record_id}: grids[0]"))
    technology = record.get("technology")
    if not isinstance(technology, dict) or technology.get("flow") != "AiEDA/iDATA":
        errors.append(f"{record_id}: technology.flow must be AiEDA/iDATA")
    return errors


def validate_graph(record: dict[str, Any], path: Path) -> tuple[list[str], dict[str, int]]:
    errors: list[str] = []
    record_id = record.get("id", rel(path))
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    graph = record.get("graph")
    labels = record.get("labels")
    if not isinstance(graph, dict):
        return [f"{record_id}: graph must be a mapping"], {}
    if not isinstance(labels, dict):
        return [f"{record_id}: labels must be a mapping"], {}
    nodes = graph.get("node_features")
    edges = graph.get("edge_features")
    values = labels.get("values")
    if not isinstance(nodes, list) or not nodes:
        errors.append(f"{record_id}: node_features must be non-empty")
        nodes = []
    if not isinstance(edges, list) or not edges:
        errors.append(f"{record_id}: edge_features must be non-empty")
        edges = []
    for index, node in enumerate(nodes[:20]):
        if not isinstance(node, dict) or node.get("node_type") != "route_demand_grid_cell":
            errors.append(f"{record_id}: node_features[{index}] must be a route_demand_grid_cell")
            continue
        if not positive_number(node.get("demand")):
            errors.append(f"{record_id}: node_features[{index}].demand must be positive")
    for index, edge in enumerate(edges[:20]):
        if (
            not isinstance(edge, dict)
            or not isinstance(edge.get("src"), str)
            or not isinstance(edge.get("dst"), str)
        ):
            errors.append(f"{record_id}: edge_features[{index}] must include src and dst")
    if labels.get("label_status") != LABEL_STATUS:
        errors.append(f"{record_id}: invalid label_status")
    errors.extend(validate_stats(values, record_id, len(nodes), len(edges)))
    return errors, {"nonzero_count": len(nodes), "edge_count": len(edges)}


def validate_flow(record: dict[str, Any], path: Path) -> list[str]:
    errors: list[str] = []
    record_id = record.get("id", rel(path))
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: invalid claim_boundary")
    errors.extend(validate_stats(record.get("metrics"), record_id))
    status = record.get("status")
    blockers = status.get("blockers") if isinstance(status, dict) else None
    if not isinstance(blockers, list) or not blockers:
        errors.append(f"{record_id}: status.blockers must be non-empty")
    inputs = record.get("inputs")
    if isinstance(inputs, dict):
        errors.extend(validate_source(inputs.get("demand_map"), f"{record_id}: inputs.demand_map"))
    else:
        errors.append(f"{record_id}: inputs must be a mapping")
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.aieda_idata_conversion_report.v1":
        errors.append("report schema must be eliza.ai_eda.aieda_idata_conversion_report.v1")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary is missing or incorrect")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    converted_count = report.get("converted_map_count")
    record_count = report.get("converted_record_count")
    if not positive_int(converted_count):
        errors.append("converted_map_count must be positive")
    if record_count != int(converted_count or 0) * len(REQUIRED_SCHEMAS):
        errors.append("converted_record_count must equal converted_map_count * 3")
    if report.get("available_map_count", 0) < int(converted_count or 0):
        errors.append("available_map_count must be at least converted_map_count")

    converted = report.get("converted_records")
    if not isinstance(converted, list):
        errors.append("converted_records must be a list")
        return errors
    if len(converted) != record_count:
        errors.append("converted_records length must match converted_record_count")

    record_paths = []
    for item in converted:
        if not isinstance(item, dict):
            errors.append("converted_records entries must be mappings")
            continue
        if item.get("schema") not in REQUIRED_SCHEMAS:
            errors.append(f"unsupported converted schema {item.get('schema')!r}")
        path_value = item.get("json")
        if not isinstance(path_value, str):
            errors.append("converted record is missing json path")
            continue
        record_paths.append(repo_path(path_value))

    records_dir = report_path.parent / "records"
    actual_records = sorted(records_dir.glob("aieda-idata-*.json"))
    if sorted(record_paths) != actual_records:
        errors.append("report converted paths must exactly match records directory")

    cases: dict[str, set[str]] = {}
    total_nodes = 0
    total_edges = 0
    for path in record_paths:
        if not path.exists():
            errors.append(f"missing record {rel(path)}")
            continue
        record = load_json(path)
        schema = record.get("schema")
        stem = path.name.removeprefix("aieda-idata-")
        case = stem.rsplit("-", 2)[0]
        cases.setdefault(case, set()).add(str(schema))
        if schema == "eda.design_bundle.v1":
            errors.extend(validate_design(record, path))
        elif schema == "eda.graph_sample.v1":
            graph_errors, counts = validate_graph(record, path)
            errors.extend(graph_errors)
            total_nodes += counts.get("nonzero_count", 0)
            total_edges += counts.get("edge_count", 0)
        elif schema == "eda.flow_run.v1":
            errors.extend(validate_flow(record, path))
    for case, schemas in sorted(cases.items()):
        if schemas != REQUIRED_SCHEMAS:
            errors.append(f"{case}: expected one record for each required schema")
    if len(cases) != converted_count:
        errors.append("converted_map_count does not match unique iDATA maps")
    if total_nodes <= 0 or total_edges <= 0:
        errors.append("converted graph totals must include positive node and edge counts")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.exists():
        print(f"STATUS: FAIL ai_eda.aieda_idata_conversion missing_report {report_path}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.aieda_idata_conversion {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.aieda_idata_conversion {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.aieda_idata_conversion "
        f"maps={report['converted_map_count']} records={report['converted_record_count']} "
        f"claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
