#!/usr/bin/env python3
"""Validate normalized R-Zoo rectilinear floorplan conversion records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/r_zoo_rectilinear_floorplan/validation/conversion_report.json"
CLAIM_BOUNDARY = (
    "r_zoo_rectilinear_floorplan_conversion_training_only_no_e1_signoff_or_release_claim"
)
LABEL_STATUS = "public_r_zoo_rectilinear_floorplan_legality_training_only_not_e1_signoff"
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
        raise ValueError(f"{rel(path)}: expected JSON object")
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
    path = repo_path(path_value)
    if record.get("exists") is not True:
        errors.append(f"{label}: exists must be true")
    if not path.is_file():
        errors.append(f"{label}: missing file {path_value}")
    if not positive_int(record.get("bytes")):
        errors.append(f"{label}: bytes must be positive")
    sha = record.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64:
        errors.append(f"{label}: sha256 must be 64 characters")
    return errors


def case_from_path(path: Path) -> str:
    name = path.name.removeprefix("r-zoo-rectilinear-floorplan-")
    for suffix in (
        "-design-bundle.json",
        "-diearea-legality-graph.json",
        "-legality-label-flow-run.json",
    ):
        if name.endswith(suffix):
            return name.removesuffix(suffix)
    return path.stem


def validate_design(record: dict[str, Any], record_id: str) -> list[str]:
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(record, record_id))
    sources = record.get("sources")
    if not isinstance(sources, dict):
        return errors + [f"{record_id}: sources must be mapping"]
    defs = sources.get("floorplan_defs")
    if not isinstance(defs, list) or len(defs) != 1:
        errors.append(f"{record_id}: expected one floorplan DEF source")
    else:
        errors.extend(validate_file_record(defs[0], f"{record_id}: floorplan_defs[0]"))
    technology = record.get("technology")
    if not isinstance(technology, dict) or "R-Zoo" not in str(technology.get("flow")):
        errors.append(f"{record_id}: technology.flow mismatch")
    return errors


def validate_graph(record: dict[str, Any], record_id: str) -> list[str]:
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(record, record_id))
    graph = record.get("graph")
    labels = record.get("labels")
    if not isinstance(graph, dict) or not isinstance(labels, dict):
        return errors + [f"{record_id}: graph and labels must be mappings"]
    nodes = graph.get("node_features")
    edges = graph.get("edge_features")
    if not isinstance(nodes, list) or len(nodes) < 4:
        errors.append(f"{record_id}: expected diearea/row/track/label nodes")
    if not isinstance(edges, list) or len(edges) < 2:
        errors.append(f"{record_id}: expected graph edges")
    if labels.get("label_status") != LABEL_STATUS:
        errors.append(f"{record_id}: label_status mismatch")
    values = labels.get("values")
    if not isinstance(values, dict):
        return errors + [f"{record_id}: labels.values must be mapping"]
    if values.get("public_legality") not in {"LEGAL", "ILLEGAL"}:
        errors.append(f"{record_id}: public_legality must be LEGAL or ILLEGAL")
    diearea = values.get("diearea")
    if not isinstance(diearea, dict):
        errors.append(f"{record_id}: diearea must be mapping")
    else:
        if diearea.get("diearea_found") is not True:
            errors.append(f"{record_id}: DIEAREA not found")
        if diearea.get("rectilinear_edges") is not True:
            errors.append(f"{record_id}: DIEAREA edges must be rectilinear")
        if not positive_int(diearea.get("point_count")):
            errors.append(f"{record_id}: point_count must be positive")
    return errors


def validate_flow(record: dict[str, Any], record_id: str) -> list[str]:
    errors: list[str] = []
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(record, record_id))
    metrics = record.get("metrics")
    if not isinstance(metrics, dict):
        return errors + [f"{record_id}: metrics must be mapping"]
    if metrics.get("label_status") != LABEL_STATUS:
        errors.append(f"{record_id}: metrics.label_status mismatch")
    if metrics.get("public_legality") not in {"LEGAL", "ILLEGAL"}:
        errors.append(f"{record_id}: metrics.public_legality invalid")
    if not positive_int(metrics.get("diearea_point_count")):
        errors.append(f"{record_id}: diearea_point_count must be positive")
    status = record.get("status")
    blockers = status.get("blockers") if isinstance(status, dict) else None
    if not isinstance(blockers, list) or not blockers:
        errors.append(f"{record_id}: status.blockers must be non-empty")
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.r_zoo_rectilinear_floorplan_conversion_report.v1":
        errors.append("schema mismatch")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(report, "report"))
    labels = report.get("label_counts")
    if not isinstance(labels, dict) or labels.get("LEGAL") != 11 or labels.get("ILLEGAL") != 3:
        errors.append("label_counts must be 11 legal / 3 illegal")
    if report.get("converted_case_count") != 14:
        errors.append("converted_case_count must be 14")
    if report.get("converted_record_count") != 42:
        errors.append("converted_record_count must be 42")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be mapping")
    else:
        for field in ("contains_external_payload", "release_use_allowed", "e1_signoff_evidence"):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        for field in REQUIRED_FALSE_CLAIM_FLAGS:
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        if policy.get("training_only") is not True:
            errors.append("policy.training_only must be true")
    converted = report.get("converted_records")
    if not isinstance(converted, list):
        return errors + ["converted_records must be list"]
    record_paths: list[Path] = []
    for item in converted:
        if not isinstance(item, dict):
            errors.append("converted_records entries must be mappings")
            continue
        if item.get("schema") not in REQUIRED_SCHEMAS:
            errors.append(f"unsupported schema {item.get('schema')!r}")
        path_value = item.get("json")
        if isinstance(path_value, str):
            record_paths.append(repo_path(path_value))
        else:
            errors.append("converted record missing json")
    actual = sorted((report_path.parent / "records").glob("*.json"))
    if sorted(record_paths) != actual:
        errors.append("converted paths must match records directory")
    cases: dict[str, set[str]] = {}
    legal_seen = {"LEGAL": 0, "ILLEGAL": 0}
    for path in record_paths:
        if not path.is_file():
            errors.append(f"missing record {rel(path)}")
            continue
        record = load_json(path)
        schema = str(record.get("schema"))
        record_id = str(record.get("id", rel(path)))
        cases.setdefault(case_from_path(path), set()).add(schema)
        if schema == "eda.design_bundle.v1":
            errors.extend(validate_design(record, record_id))
        elif schema == "eda.graph_sample.v1":
            errors.extend(validate_graph(record, record_id))
            values = record.get("labels", {}).get("values", {})
            if isinstance(values, dict) and values.get("public_legality") in legal_seen:
                legal_seen[values["public_legality"]] += 1
        elif schema == "eda.flow_run.v1":
            errors.extend(validate_flow(record, record_id))
    for case, schemas in sorted(cases.items()):
        if schemas != REQUIRED_SCHEMAS:
            errors.append(f"{case}: expected design, graph, and flow records")
    if len(cases) != 14:
        errors.append("expected 14 unique cases")
    if legal_seen != {"LEGAL": 11, "ILLEGAL": 3}:
        errors.append(f"graph label distribution mismatch: {legal_seen}")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.is_file():
        print(f"STATUS: FAIL ai_eda.r_zoo_conversion missing_report {rel(report_path)}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.r_zoo_conversion {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.r_zoo_conversion {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.r_zoo_conversion "
        f"cases={report['converted_case_count']} records={report['converted_record_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
