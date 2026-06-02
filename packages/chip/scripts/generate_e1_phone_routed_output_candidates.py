#!/usr/bin/env python3
"""Generate fail-closed E1 phone routed-output candidate artifacts.

These artifacts reduce the purely local "file missing" surface for routed-board
work products that can be derived from the current development board snapshot.
They are not release evidence: every generated metadata record is blocked and
unapproved until real DRC/ERC/SI/PI/RF/factory/supplier review is attached.
"""

from __future__ import annotations

import argparse
import csv
import gc
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DATE = "2026-05-22"
SOURCE_BOARD = (
    ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb"
)
SOURCE_STEP = ROOT / "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-routed-development.step"
OUT_MANIFEST = (
    ROOT / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
)
STEP_INTAKE = ROOT / "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml"
ROUTED_INTAKE = ROOT / "board/kicad/e1-phone/routed-development-board-intake-2026-05-22.yaml"
CAD_CONNECTION_COVERAGE = ROOT / "mechanical/e1-phone/review/cad-connection-coverage.json"
ASSEMBLY_MANIFEST = ROOT / "mechanical/e1-phone/out/assembly-manifest.json"
KICAD_CAD_TRACEABILITY = ROOT / "board/kicad/e1-phone/kicad-cad-traceability-matrix-2026-05-22.yaml"
PAD_AUDIT = ROOT / "board/kicad/e1-phone/development-pad-pin-coverage-audit-2026-05-22.yaml"
COMPONENT_MODEL_DIR = ROOT / "board/kicad/e1-phone/production/step/component-models"
SUPPLIER_SOURCING_DIR = ROOT / "board/kicad/e1-phone/production/sourcing"
COMPONENT_3D_BINDING_REPORT = (
    ROOT / "board/kicad/e1-phone/production/reports/component-3d-binding.yaml"
)
COMPONENT_3D_BINDING_MATRIX = (
    ROOT / "board/kicad/e1-phone/production/reports/component-3d-binding-matrix.csv"
)


def chip_rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_yaml(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(payload, sort_keys=False, width=100), encoding="utf-8")


def load_yaml_if_present(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def load_json_if_present(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def load_json_list_if_present(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def board_text_counts(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="ignore") if path.is_file() else ""
    return {
        "board_file": chip_rel(path) if path.is_file() else str(path),
        "present": path.is_file(),
        "sha256": sha256(path) if path.is_file() else "",
        "bytes": path.stat().st_size if path.is_file() else 0,
        "footprint_count": text.count('(footprint "'),
        "legacy_e1phone_footprint_ref_count": text.count('(footprint "E1Phone:'),
        "placeholder_not_fabrication_footprint_marker_count": text.count(
            "placeholder_not_fabrication_footprint"
        ),
        "segment_count": text.count("\n  (segment "),
        "via_count": text.count("\n  (via "),
        "zone_count": text.count("\n  (zone "),
        "filled_zone_count": text.count("(filled_polygon"),
    }


def routed_candidate_source_binding(candidate_board: Path) -> dict[str, Any]:
    source = board_text_counts(SOURCE_BOARD)
    candidate = board_text_counts(candidate_board)
    return {
        "source_board": chip_rel(SOURCE_BOARD),
        "candidate_board": chip_rel(candidate_board)
        if candidate_board.is_file()
        else str(candidate_board),
        "source_board_sha256": source["sha256"],
        "candidate_board_sha256": candidate["sha256"],
        "candidate_matches_source_board": bool(
            candidate["present"] and source["present"] and candidate["sha256"] == source["sha256"]
        ),
        "source_placeholder_marker_count": source[
            "placeholder_not_fabrication_footprint_marker_count"
        ],
        "candidate_placeholder_marker_count": candidate[
            "placeholder_not_fabrication_footprint_marker_count"
        ],
        "candidate_legacy_e1phone_footprint_ref_count": candidate[
            "legacy_e1phone_footprint_ref_count"
        ],
        "candidate_footprint_count": candidate["footprint_count"],
        "candidate_segment_count": candidate["segment_count"],
        "candidate_via_count": candidate["via_count"],
        "candidate_zone_count": candidate["zone_count"],
        "candidate_filled_zone_count": candidate["filled_zone_count"],
        "source_is_zero_placeholder_real_footprint_board": bool(
            source["present"]
            and source["placeholder_not_fabrication_footprint_marker_count"] == 0
            and source["legacy_e1phone_footprint_ref_count"] == 0
        ),
        "candidate_is_zero_placeholder_real_footprint_board": bool(
            candidate["present"]
            and candidate["placeholder_not_fabrication_footprint_marker_count"] == 0
            and candidate["legacy_e1phone_footprint_ref_count"] == 0
        ),
        "release_credit": False,
    }


def routed_visual_detail() -> dict[str, Any]:
    step_intake = load_yaml_if_present(STEP_INTAKE)
    routed_intake = load_yaml_if_present(ROUTED_INTAKE)
    route_records = [
        {
            "index": index,
            "route_id": str(segment.get("route_id", "")),
            "net": str(segment.get("net", "")),
            "layer": str(segment.get("layer", "")),
            "width_mm": segment.get("width_mm"),
            "start_mm": segment.get("start_mm", {}),
            "end_mm": segment.get("end_mm", {}),
            "route_classes": segment.get("route_classes", []),
            "source_domains": segment.get("source_domains", []),
            "controlled_impedance_targets_ohm": segment.get("controlled_impedance_targets_ohm", []),
        }
        for index, segment in enumerate(step_intake.get("segments", []), start=1)
        if isinstance(segment, dict)
    ]
    via_records = [
        {
            "index": index,
            "net": str(via.get("net", "")),
            "at_mm": via.get("at_mm", {}),
            "size_mm": via.get("size_mm"),
            "drill_mm": via.get("drill_mm"),
            "layers": via.get("layers", []),
        }
        for index, via in enumerate(step_intake.get("vias", []), start=1)
        if isinstance(via, dict)
    ]
    zone_records = [
        {
            "index": zone.get("index", index),
            "name": str(zone.get("name", "")),
            "net": str(zone.get("net", "")),
            "layers": zone.get("layers", []),
            "polygon_point_count": int(zone.get("polygon_point_count", 0) or 0),
            "filled_polygon_count": int(zone.get("filled_polygon_count", 0) or 0),
            "bbox_mm": zone.get("bbox_mm", {}),
        }
        for index, zone in enumerate(step_intake.get("filled_copper_zones", []), start=1)
        if isinstance(zone, dict)
    ]
    route_layer_counts: dict[str, int] = {}
    route_class_counts: dict[str, int] = {}
    route_source_domain_counts: dict[str, int] = {}
    for record in route_records:
        layer = record["layer"]
        if layer:
            route_layer_counts[layer] = route_layer_counts.get(layer, 0) + 1
        for route_class in record.get("route_classes", []):
            route_class_text = str(route_class)
            route_class_counts[route_class_text] = route_class_counts.get(route_class_text, 0) + 1
        for source_domain in record.get("source_domains", []):
            source_domain_text = str(source_domain)
            route_source_domain_counts[source_domain_text] = (
                route_source_domain_counts.get(source_domain_text, 0) + 1
            )
    return {
        "source_step_intake": chip_rel(STEP_INTAKE) if STEP_INTAKE.is_file() else "",
        "routed_development_intake": chip_rel(ROUTED_INTAKE) if ROUTED_INTAKE.is_file() else "",
        "source_board_sha256": step_intake.get("board_sha256", ""),
        "source_step_sha256": step_intake.get("step_sha256", ""),
        "routed_intake_step_sha256": routed_intake.get("development_step_sha256", ""),
        "footprint_envelope_count": int(step_intake.get("footprint_envelope_count", 0) or 0),
        "pad_contact_visual_count": int(step_intake.get("pad_contact_visual_count", 0) or 0),
        "route_segment_visual_count": int(step_intake.get("route_segment_visual_count", 0) or 0),
        "route_segment_net_name_count": int(
            step_intake.get("route_segment_net_name_count", 0) or 0
        ),
        "route_segment_trace_bound_count": int(
            step_intake.get("route_segment_trace_bound_count", 0) or 0
        ),
        "route_segment_trace_unbound_count": int(
            step_intake.get("route_segment_trace_unbound_count", 0) or 0
        ),
        "controlled_impedance_segment_visual_count": int(
            step_intake.get("controlled_impedance_segment_visual_count", 0) or 0
        ),
        "board_segment_count": int(step_intake.get("segment_count", 0) or 0),
        "board_via_count": int(step_intake.get("via_count", 0) or 0),
        "via_net_name_count": int(step_intake.get("via_net_name_count", 0) or 0),
        "development_footprint_refs": int(step_intake.get("development_footprint_refs", 0) or 0),
        "route_visual_record_count": len(route_records),
        "route_visual_route_id_count": len(
            {record["route_id"] for record in route_records if record["route_id"]}
        ),
        "route_visual_net_name_count": len(
            {record["net"] for record in route_records if record["net"]}
        ),
        "route_visual_layer_counts": dict(sorted(route_layer_counts.items())),
        "route_visual_route_class_counts": dict(sorted(route_class_counts.items())),
        "route_visual_source_domain_counts": dict(sorted(route_source_domain_counts.items())),
        "route_visual_all_records_have_route_id": bool(route_records)
        and all(record["route_id"] for record in route_records),
        "route_visual_all_records_have_net": bool(route_records)
        and all(record["net"] for record in route_records),
        "route_visual_all_records_have_layer": bool(route_records)
        and all(record["layer"] for record in route_records),
        "route_visual_all_records_have_route_class": bool(route_records)
        and all(bool(record.get("route_classes")) for record in route_records),
        "route_visual_all_records_have_source_domain": bool(route_records)
        and all(bool(record.get("source_domains")) for record in route_records),
        "route_visual_records": route_records,
        "via_visual_record_count": len(via_records),
        "via_visual_net_name_count": len(
            {record["net"] for record in via_records if record["net"]}
        ),
        "via_visual_all_records_have_net": bool(via_records)
        and all(record["net"] for record in via_records),
        "via_visual_all_records_have_layers": bool(via_records)
        and all(bool(record.get("layers")) for record in via_records),
        "via_visual_records": via_records,
        "filled_copper_zone_record_count": len(zone_records),
        "filled_copper_zone_filled_polygon_count": sum(
            int(record.get("filled_polygon_count") or 0) for record in zone_records
        ),
        "filled_copper_zone_all_records_have_net": bool(zone_records)
        and all(record["net"] for record in zone_records),
        "filled_copper_zone_all_records_have_bbox": bool(zone_records)
        and all(bool(record.get("bbox_mm")) for record in zone_records),
        "filled_copper_zone_records": zone_records,
        "release_credit": False,
    }


def cad_connection_summary() -> dict[str, Any]:
    coverage = load_json_if_present(CAD_CONNECTION_COVERAGE)
    assembly_manifest = load_json_list_if_present(ASSEMBLY_MANIFEST)
    assembly_names = {str(item.get("name", "")) for item in assembly_manifest if item.get("name")}
    assembly_terminal_marker_count = sum(
        1 for item in assembly_manifest if item.get("role") == "connection terminal"
    )
    connections = coverage.get("connections", [])
    connection_records = []
    for item in connections:
        if not isinstance(item, dict):
            continue
        connection_records.append(
            {
                "id": item.get("id", ""),
                "cad_part": item.get("cad_part", ""),
                "from": item.get("from", ""),
                "to": item.get("to", ""),
                "connection_type": item.get("connection_type", ""),
                "physical_medium": item.get("physical_medium", ""),
                "electrical_class": item.get("electrical_class", ""),
                "controlled_impedance_required": bool(
                    item.get("controlled_impedance_required", False)
                ),
                "impedance_requirement": item.get("impedance_requirement", ""),
                "min_bend_radius_mm": item.get("min_bend_radius_mm"),
                "supplier_release_required": bool(item.get("supplier_release_required", False)),
                "cad_step": item.get("cad_step", ""),
                "cad_step_bytes": int(item.get("cad_step_bytes", 0) or 0),
                "from_terminal_part": item.get("from_terminal_part", ""),
                "from_terminal_step": item.get("from_terminal_step", ""),
                "from_terminal_step_bytes": int(item.get("from_terminal_step_bytes", 0) or 0),
                "to_terminal_part": item.get("to_terminal_part", ""),
                "to_terminal_step": item.get("to_terminal_step", ""),
                "to_terminal_step_bytes": int(item.get("to_terminal_step_bytes", 0) or 0),
                "terminal_marker_count": int(item.get("terminal_marker_count", 0) or 0),
                "terminal_markers_present": bool(item.get("terminal_markers_present", False)),
                "terminal_step_bytes_total": int(item.get("terminal_step_bytes_total", 0) or 0),
                "solid_step_part_names": item.get("solid_step_part_names", []),
                "solid_step_parts_present": bool(item.get("solid_step_parts_present", False)),
                "solid_step_part_count": int(item.get("solid_step_part_count", 0) or 0),
                "solid_step_part_bytes_total": int(item.get("solid_step_part_bytes_total", 0) or 0),
                "net_count": len(item.get("nets", [])),
                "nets": item.get("nets", []),
                "represented_net_count": int(
                    item.get("represented_net_count", len(item.get("nets", []))) or 0
                ),
                "represented_nets": item.get("represented_nets", item.get("nets", [])),
                "represented_route_record_count": int(
                    item.get("represented_route_record_count", 0) or 0
                ),
                "represented_route_records_with_layer_count": int(
                    item.get("represented_route_records_with_layer_count", 0) or 0
                ),
                "represented_route_records_with_source_domain_count": int(
                    item.get("represented_route_records_with_source_domain_count", 0) or 0
                ),
                "represented_route_records_with_route_class_count": int(
                    item.get("represented_route_records_with_route_class_count", 0) or 0
                ),
                "represented_route_classification_gap_count": int(
                    item.get("represented_route_classification_gap_count", 0) or 0
                ),
                "all_represented_routes_have_layer_source_and_class": bool(
                    item.get("all_represented_routes_have_layer_source_and_class", False)
                ),
                "cad_part_present": bool(item.get("cad_part_present", False)),
                "endpoints_present": bool(item.get("endpoints_present", False)),
                "all_nets_in_routed_development_board": bool(
                    item.get("all_nets_in_routed_development_board", False)
                ),
                "controlled_impedance_requirement_defined": bool(
                    item.get("controlled_impedance_requirement_defined", False)
                ),
                "bend_radius_requirement_defined": bool(
                    item.get("bend_radius_requirement_defined", False)
                ),
                "pass": bool(item.get("pass", False)),
                "release_credit": bool(item.get("release_credit", True)),
            }
        )
    solid_step_part_names = {
        str(name) for item in connection_records for name in item.get("solid_step_part_names", [])
    }
    missing_assembly_solid_step_part_names = sorted(solid_step_part_names - assembly_names)
    return {
        "coverage_report": chip_rel(CAD_CONNECTION_COVERAGE)
        if CAD_CONNECTION_COVERAGE.is_file()
        else "",
        "assembly_manifest": chip_rel(ASSEMBLY_MANIFEST) if ASSEMBLY_MANIFEST.is_file() else "",
        "assembly_manifest_part_count": len(assembly_manifest),
        "assembly_manifest_connection_terminal_marker_count": assembly_terminal_marker_count,
        "assembly_manifest_connection_solid_step_part_count": len(
            solid_step_part_names & assembly_names
        ),
        "assembly_manifest_missing_connection_solid_step_part_count": len(
            missing_assembly_solid_step_part_names
        ),
        "assembly_manifest_missing_connection_solid_step_part_names": (
            missing_assembly_solid_step_part_names
        ),
        "status": coverage.get("status", ""),
        "required_connection_count": int(coverage.get("required_connection_count", 0) or 0),
        "passing_connection_count": int(coverage.get("passing_connection_count", 0) or 0),
        "required_connection_terminal_marker_count": int(
            coverage.get("required_connection_terminal_marker_count", 0) or 0
        ),
        "passing_connection_terminal_pair_count": int(
            coverage.get("passing_connection_terminal_pair_count", 0) or 0
        ),
        "required_connection_solid_step_part_count": int(
            coverage.get("required_connection_solid_step_part_count", 0) or 0
        ),
        "passing_connection_solid_step_part_set_count": int(
            coverage.get("passing_connection_solid_step_part_set_count", 0) or 0
        ),
        "connection_solid_step_part_bytes_total": int(
            coverage.get("connection_solid_step_part_bytes_total", 0) or 0
        ),
        "represented_net_count_total": int(coverage.get("represented_net_count_total", 0) or 0),
        "represented_route_record_count_total": int(
            coverage.get("represented_route_record_count_total", 0) or 0
        ),
        "represented_route_records_with_layer_count_total": int(
            coverage.get("represented_route_records_with_layer_count_total", 0) or 0
        ),
        "represented_route_records_with_source_domain_count_total": int(
            coverage.get("represented_route_records_with_source_domain_count_total", 0) or 0
        ),
        "represented_route_records_with_route_class_count_total": int(
            coverage.get("represented_route_records_with_route_class_count_total", 0) or 0
        ),
        "represented_route_classification_gap_count": int(
            coverage.get("represented_route_classification_gap_count", 0) or 0
        ),
        "all_represented_routes_have_layer_source_and_class": bool(
            coverage.get("all_represented_routes_have_layer_source_and_class", False)
        ),
        "visual_route_span_total_mm": float(coverage.get("visual_route_span_total_mm", 0) or 0),
        "endpoint_pair_distance_total_mm": float(
            coverage.get("endpoint_pair_distance_total_mm", 0) or 0
        ),
        "mechanical_envelope_defined_count": int(
            coverage.get("mechanical_envelope_defined_count", 0) or 0
        ),
        "mechanical_envelope_release_credit": bool(
            coverage.get("mechanical_envelope_release_credit", True)
        ),
        "physical_medium_counts": coverage.get("physical_medium_counts", {}),
        "electrical_class_counts": coverage.get("electrical_class_counts", {}),
        "controlled_impedance_connection_count": int(
            coverage.get("controlled_impedance_connection_count", 0) or 0
        ),
        "controlled_impedance_requirement_defined_count": int(
            coverage.get("controlled_impedance_requirement_defined_count", 0) or 0
        ),
        "bend_radius_requirement_defined_count": int(
            coverage.get("bend_radius_requirement_defined_count", 0) or 0
        ),
        "supplier_release_required_connection_count": int(
            coverage.get("supplier_release_required_connection_count", 0) or 0
        ),
        "release_boundary_summary": coverage.get("release_boundary_summary", {}),
        "release_credit": bool(coverage.get("release_credit", True)),
        "connection_ids": [item.get("id", "") for item in connection_records],
        "cad_parts": [item.get("cad_part", "") for item in connection_records],
        "connection_records": connection_records,
    }


def kicad_cad_traceability_summary() -> dict[str, Any]:
    traceability = load_yaml_if_present(KICAD_CAD_TRACEABILITY)
    summary = traceability.get("summary", {}) if isinstance(traceability, dict) else {}
    gaps = traceability.get("gaps", {}) if isinstance(traceability, dict) else {}
    return {
        "traceability_matrix": chip_rel(KICAD_CAD_TRACEABILITY)
        if KICAD_CAD_TRACEABILITY.is_file()
        else "",
        "status": traceability.get("status", ""),
        "footprint_library_count": int(summary.get("footprint_library_count", 0) or 0),
        "pad_audit_record_count": int(summary.get("pad_audit_record_count", 0) or 0),
        "board_bound_instance_count": int(summary.get("board_bound_instance_count", 0) or 0),
        "step_footprint_instance_count": int(summary.get("step_footprint_instance_count", 0) or 0),
        "captured_pinout_file_count": int(summary.get("captured_pinout_file_count", 0) or 0),
        "captured_pinout_declared_pin_count_total": int(
            summary.get("captured_pinout_declared_pin_count_total", 0) or 0
        ),
        "captured_pinout_record_count_total": int(
            summary.get("captured_pinout_record_count_total", 0) or 0
        ),
        "captured_pinout_public_source_count": int(
            summary.get("captured_pinout_public_source_count", 0) or 0
        ),
        "pinout_bound_footprint_count": int(summary.get("pinout_bound_footprint_count", 0) or 0),
        "all_pinout_bound_footprints_have_terminal_contract": bool(
            summary.get("all_pinout_bound_footprints_have_terminal_contract", False)
        ),
        "cad_connection_count": int(summary.get("cad_connection_count", 0) or 0),
        "cad_connection_represented_net_count_total": int(
            summary.get("cad_connection_represented_net_count_total", 0) or 0
        ),
        "cad_connection_represented_route_count_total": int(
            summary.get("cad_connection_represented_route_count_total", 0) or 0
        ),
        "cad_connection_represented_route_record_count_total": int(
            summary.get("cad_connection_represented_route_record_count_total", 0) or 0
        ),
        "cad_connection_represented_route_records_with_layer_count_total": int(
            summary.get("cad_connection_represented_route_records_with_layer_count_total", 0) or 0
        ),
        "cad_connection_represented_route_records_with_source_domain_count_total": int(
            summary.get(
                "cad_connection_represented_route_records_with_source_domain_count_total", 0
            )
            or 0
        ),
        "cad_connection_represented_route_records_with_route_class_count_total": int(
            summary.get("cad_connection_represented_route_records_with_route_class_count_total", 0)
            or 0
        ),
        "cad_connection_represented_route_classification_gap_count": int(
            summary.get("cad_connection_represented_route_classification_gap_count", 0) or 0
        ),
        "cad_connection_all_represented_routes_have_layer_source_and_class": bool(
            summary.get("cad_connection_all_represented_routes_have_layer_source_and_class", False)
        ),
        "cad_connection_visual_route_span_total_mm": float(
            summary.get("cad_connection_visual_route_span_total_mm", 0) or 0
        ),
        "cad_connection_terminal_marker_count": int(
            summary.get("cad_connection_terminal_marker_count", 0) or 0
        ),
        "cad_connection_terminal_pair_count": int(
            summary.get("cad_connection_terminal_pair_count", 0) or 0
        ),
        "cad_connection_solid_step_part_count": int(
            summary.get("cad_connection_solid_step_part_count", 0) or 0
        ),
        "cad_connection_solid_step_part_set_count": int(
            summary.get("cad_connection_solid_step_part_set_count", 0) or 0
        ),
        "cad_connection_solid_step_part_bytes_total": int(
            summary.get("cad_connection_solid_step_part_bytes_total", 0) or 0
        ),
        "cad_connection_physical_medium_counts": summary.get(
            "cad_connection_physical_medium_counts", {}
        ),
        "cad_connection_electrical_class_counts": summary.get(
            "cad_connection_electrical_class_counts", {}
        ),
        "cad_connection_controlled_impedance_count": int(
            summary.get("cad_connection_controlled_impedance_count", 0) or 0
        ),
        "cad_connection_controlled_impedance_requirement_defined_count": int(
            summary.get("cad_connection_controlled_impedance_requirement_defined_count", 0) or 0
        ),
        "cad_connection_bend_radius_requirement_defined_count": int(
            summary.get("cad_connection_bend_radius_requirement_defined_count", 0) or 0
        ),
        "cad_connection_mechanical_envelope_defined_count": int(
            summary.get("cad_connection_mechanical_envelope_defined_count", 0) or 0
        ),
        "cad_connection_all_records_have_mechanical_envelope": bool(
            summary.get("cad_connection_all_records_have_mechanical_envelope", False)
        ),
        "cad_connection_mechanical_envelope_release_credit": bool(
            summary.get("cad_connection_mechanical_envelope_release_credit", True)
        ),
        "cad_connection_supplier_release_required_count": int(
            summary.get("cad_connection_supplier_release_required_count", 0) or 0
        ),
        "incomplete_footprint_count": int(summary.get("incomplete_footprint_count", 0) or 0),
        "incomplete_cad_connection_count": int(
            summary.get("incomplete_cad_connection_count", 0) or 0
        ),
        "missing_captured_pinout_file_count": int(
            summary.get("missing_captured_pinout_file_count", 0) or 0
        ),
        "incomplete_captured_pinout_detail_count": int(
            summary.get("incomplete_captured_pinout_detail_count", 0) or 0
        ),
        "release_credit": bool(summary.get("release_credit", True)),
        "gaps": gaps,
    }


def supplier_lane_for_model(model: dict[str, Any]) -> str:
    reference = str(model.get("reference", ""))
    footprint = str(model.get("footprint", ""))
    pinout_file = str(model.get("pinout_file", ""))
    key = " ".join([reference, footprint, pinout_file]).lower()
    if "display" in key or "touch" in key or "dsi" in key:
        return "display_touch"
    if "rear_camera" in key or "cam0" in key:
        return "rear_camera"
    if "front_camera" in key or "cam1" in key:
        return "front_camera"
    if "usb4105" in key or "j_usb" in key or "usb_c" in key:
        return "usb_c_receptacle_evt0"
    if "tps65987" in key or "usb_pd" in key:
        return "usb_pd_controller"
    if "max77860" in key or "charger" in key:
        return "charger_power_path"
    if "battery" in key or "fuel_gauge" in key or "j_battery" in key:
        return "battery_pack"
    if "quectel" in key or "cell" in key or "gnss" in key:
        return "cellular"
    if "murata" in key or "wifi" in key:
        return "wifi_bluetooth"
    if "audio" in key or "mic" in key or "spk" in key:
        return "audio_speaker_microphone_flexes"
    if "haptic" in key or "side" in key or "power_vol" in key or "keys" in key:
        return "side_buttons"
    if "top_bottom" in key or "df40" in key or "hirose" in key:
        return "top_bottom_interconnect"
    if "pmic" in key or "rail" in key or "aon" in key or "vbat" in key or "sys" in key:
        return "pmic"
    return "board_support_passives_mechanicals"


def supplier_step_intake_for_lane(lane: str) -> dict[str, Any]:
    if lane == "board_support_passives_mechanicals":
        return {
            "supplier_step_intake_file": "",
            "supplier_step_intake_status": "not_applicable_board_level_support_pattern",
            "supplier_step_intake_release_credit": False,
            "supplier_step_intake_sha256": "",
            "supplier_step_intake_bytes": 0,
        }
    step_path = SUPPLIER_SOURCING_DIR / lane / "supplier-model.step"
    if not step_path.is_file():
        return {
            "supplier_step_intake_file": chip_rel(step_path),
            "supplier_step_intake_status": "missing_supplier_step_intake",
            "supplier_step_intake_release_credit": False,
            "supplier_step_intake_sha256": "",
            "supplier_step_intake_bytes": 0,
        }
    text = step_path.read_text(encoding="utf-8", errors="ignore").lower()
    release_credit = (
        "release_credit: true" in text
        and "placeholder" not in text
        and "blocked" not in text
        and "not supplier evidence" not in text
    )
    if release_credit:
        status = "supplier_step_intake_present_release_candidate"
    elif "supplier-return placeholder" in text or "placeholder" in text:
        status = "present_fail_closed_supplier_step_placeholder"
    else:
        status = "present_local_surrogate_step_not_supplier_approved"
    return {
        "supplier_step_intake_file": chip_rel(step_path),
        "supplier_step_intake_status": status,
        "supplier_step_intake_release_credit": release_credit,
        "supplier_step_intake_sha256": sha256(step_path),
        "supplier_step_intake_bytes": step_path.stat().st_size,
    }


def public_step_overlay_for_model(model: dict[str, Any]) -> dict[str, Any]:
    reference = str(model.get("reference", ""))
    footprint = str(model.get("footprint", ""))
    overlay_by_reference = {
        "J_REAR_CAMERA": {
            "record": "hirose_bm28b0_6_24dp_2_0_35v_53",
            "expected_footprints": {"CAMERA_24P_0P50_DEV"},
            "path": (
                "hirose_bm28b0_6_24dp_2_0_35v_53/"
                "BM28B0.6-24DP_2-0.35V_3d_stp.stp"
            ),
            "missing_status": "expected_hirose_bm28_24dp_step_missing",
        },
        "J_TOP_BOTTOM_FLEX_TOP": {
            "record": "hirose_df40c_80dp_0_4v_51",
            "expected_footprints": {"HIROSE_DF40_80P_0P4_DEV"},
            "path": "hirose_df40c_80dp_0_4v_51/DF40C-80DP-0.4V_3d_stp.stp",
            "missing_status": "expected_hirose_df40_80dp_step_missing",
        },
        "J_TOP_BOTTOM_FLEX_BOTTOM": {
            "record": "hirose_df40c_80dp_0_4v_51",
            "expected_footprints": {"HIROSE_DF40_80P_0P4_DEV"},
            "path": "hirose_df40c_80dp_0_4v_51/DF40C-80DP-0.4V_3d_stp.stp",
            "missing_status": "expected_hirose_df40_80dp_step_missing",
        },
    }
    overlay = overlay_by_reference.get(reference)
    if overlay is None:
        return {
            "public_cad_step_overlay_status": "not_applicable_or_not_downloaded",
            "public_cad_step_overlay_file": "",
            "public_cad_step_overlay_sha256": "",
            "public_cad_step_overlay_bytes": 0,
            "public_cad_source_record": "",
            "public_cad_step_overlay_release_credit": False,
        }
    step_path = (
        ROOT / "board/kicad/e1-phone/production/sourcing/public-cad-downloads/"
        / str(overlay["path"])
    )
    if not step_path.is_file():
        return {
            "public_cad_step_overlay_status": overlay["missing_status"],
            "public_cad_step_overlay_file": chip_rel(step_path),
            "public_cad_step_overlay_sha256": "",
            "public_cad_step_overlay_bytes": 0,
            "public_cad_source_record": overlay["record"],
            "public_cad_step_overlay_release_credit": False,
        }
    status = "downloaded_hashed_public_manufacturer_step_overlay_not_release"
    if footprint not in overlay["expected_footprints"]:
        status = "downloaded_hashed_public_manufacturer_step_overlay_footprint_mismatch"
    return {
        "public_cad_step_overlay_status": status,
        "public_cad_step_overlay_file": chip_rel(step_path),
        "public_cad_step_overlay_sha256": sha256(step_path),
        "public_cad_step_overlay_bytes": step_path.stat().st_size,
        "public_cad_source_record": overlay["record"],
        "public_cad_step_overlay_release_credit": False,
    }


def write_local_supplier_lane_surrogate_steps(models: list[dict[str, Any]]) -> dict[str, Any]:
    lane_models: dict[str, list[dict[str, Any]]] = {}
    for model in models:
        if not isinstance(model, dict):
            continue
        lane = supplier_lane_for_model(model)
        if lane == "board_support_passives_mechanicals":
            continue
        lane_models.setdefault(lane, []).append(model)

    records = {}
    for lane, lane_items in sorted(lane_models.items()):
        max_width = 0.1
        max_depth = 0.1
        max_height = 0.05
        area_sum = 0.0
        for item in lane_items:
            envelope = item.get("envelope_mm", {})
            if not isinstance(envelope, dict):
                envelope = {}
            width = max(float(envelope.get("width", 0) or 0), 0.1)
            depth = max(float(envelope.get("depth", 0) or 0), 0.1)
            height = max(float(envelope.get("height", 0) or 0), 0.05)
            max_width = max(max_width, width)
            max_depth = max(max_depth, depth)
            max_height = max(max_height, height)
            area_sum += width * depth
        surrogate_width = max(max_width, area_sum**0.5)
        surrogate_depth = max(max_depth, area_sum / surrogate_width)
        surrogate_model = {
            "reference": f"{lane}_LOCAL_SURROGATE_NOT_SUPPLIER_APPROVED",
            "envelope_mm": {
                "width": round(surrogate_width, 3),
                "depth": round(surrogate_depth, 3),
                "height": round(max_height, 3),
            },
        }
        lane_dir = SUPPLIER_SOURCING_DIR / lane
        lane_dir.mkdir(parents=True, exist_ok=True)
        step_path = lane_dir / "supplier-model.step"
        write_local_envelope_step(step_path, surrogate_model)
        records[lane] = {
            "file": chip_rel(step_path),
            "sha256": sha256(step_path),
            "bytes": step_path.stat().st_size,
            "model_reference_count": len(lane_items),
            "status": "present_local_surrogate_step_not_supplier_approved",
            "release_credit": False,
        }
    for record in records.values():
        step_path = ROOT / str(record["file"])
        record["sha256"] = sha256(step_path)
        record["bytes"] = step_path.stat().st_size
    return records


def blocked_metadata(artifact_id: str, source_requirement_id: str, path: Path) -> dict[str, Any]:
    visual = routed_visual_detail()
    connection = cad_connection_summary()
    return {
        "schema": "eliza.e1_phone_routed_output_candidate_metadata.v1",
        "artifact_id": artifact_id,
        "source_requirement_id": source_requirement_id,
        "owner": "local-routing-candidate-generator",
        "created_at": DATE,
        "tool_or_supplier_revision": "generate_e1_phone_routed_output_candidates.py",
        "input_artifact_hashes": {
            chip_rel(SOURCE_BOARD): sha256(SOURCE_BOARD),
            chip_rel(SOURCE_STEP): sha256(SOURCE_STEP) if SOURCE_STEP.exists() else "missing",
        },
        "reviewer": "unreviewed",
        "reviewed_at": "unreviewed_local_candidate_2026-05-22",
        "disposition": "blocked_candidate_not_approved",
        "external_review_authority": "missing_external_review_authority",
        "signature_or_approval_record": "missing_signature_or_approval_record",
        "artifact_sha256": sha256(path) if path.is_file() else "",
        "kicad_project_revision": "development_real_footprint_snapshot",
        "routed_pcb_hash": sha256(SOURCE_BOARD),
        "erc_result": "not_run",
        "drc_result": "not_run",
        "stackup_revision": "not_fabricator_approved",
        "impedance_coupon_reference": "missing_fabricator_coupon",
        "si_pi_rf_report_references": [
            "board/kicad/e1-phone/production/reports/si-pi/release-manifest.yaml",
            "board/kicad/e1-phone/production/reports/rf/release-manifest.yaml",
        ],
        "fab_output_manifest": chip_rel(OUT_MANIFEST),
        "routed_step_reference": "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        "routed_step_visual_detail": visual,
        "cad_connection_coverage": connection,
        "kicad_cad_traceability": kicad_cad_traceability_summary(),
        "release_package_revision": "local_candidate_not_release",
        "fab_vendor_or_assembler": "missing_external_supplier_or_factory",
        "program_or_fixture_revision": "not_run",
        "limits_revision": "not_approved",
        "calibration_state": "not_calibrated",
        "lot_or_serial_traceability": "missing",
        "release_allowed": False,
        "claim_boundary": (
            "Local routed-output candidate only. Not approved release evidence; "
            "requires real DRC/ERC/SI/PI/RF/fabricator/supplier review."
        ),
    }


def directory_child_inventory(
    path: Path, manifest_path: Path, artifact_paths: set[str]
) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    for child in sorted(path.rglob("*")):
        if not child.is_file() or child == manifest_path:
            continue
        rel_child = chip_rel(child)
        records.append(
            {
                "path": rel_child,
                "name": child.name,
                "size_bytes": child.stat().st_size,
                "sha256": sha256(child),
                "candidate_placeholder": child.name == "candidate-placeholder.txt",
                "covered_by_candidate_manifest_artifact": rel_child in artifact_paths,
                "release_credit": False,
            }
        )
    placeholder_paths = [record["path"] for record in records if record["candidate_placeholder"]]
    manifest_child_paths = [
        record["path"] for record in records if record["covered_by_candidate_manifest_artifact"]
    ]
    return {
        "child_artifact_inventory": records,
        "child_artifact_count": len(records),
        "candidate_placeholder_child_count": len(placeholder_paths),
        "candidate_placeholder_child_paths": placeholder_paths,
        "candidate_manifest_child_artifact_count": len(manifest_child_paths),
        "candidate_manifest_child_artifact_paths": manifest_child_paths,
        "untracked_non_manifest_child_count": sum(
            1
            for record in records
            if not record["candidate_placeholder"]
            and not record["covered_by_candidate_manifest_artifact"]
        ),
        "release_child_count": 0,
        "all_non_manifest_children_classified": all(
            record["candidate_placeholder"] or record["covered_by_candidate_manifest_artifact"]
            for record in records
        ),
    }


def refresh_dir_manifest(path: Path, artifact_paths: set[str]) -> None:
    manifest_path = path / "release-manifest.yaml"
    manifest = load_yaml_if_present(manifest_path)
    if not manifest:
        return
    manifest.update(directory_child_inventory(path, manifest_path, artifact_paths))
    manifest["release_children_complete"] = False
    write_yaml(manifest_path, manifest)


def write_dir_manifest(path: Path, artifact_id: str, source_requirement_id: str) -> dict[str, Any]:
    path.mkdir(parents=True, exist_ok=True)
    child = path / "candidate-placeholder.txt"
    child.write_text(
        "blocked routed-output candidate directory; release children and approvals are missing\n",
        encoding="utf-8",
    )
    manifest = blocked_metadata(artifact_id, source_requirement_id, child)
    manifest["artifact_id"] = artifact_id
    manifest["candidate_children"] = [chip_rel(child)]
    manifest.update(directory_child_inventory(path, path / "release-manifest.yaml", set()))
    manifest["release_children_complete"] = False
    write_yaml(path / "release-manifest.yaml", manifest)
    return {
        "path": chip_rel(path),
        "kind": "directory",
        "metadata": chip_rel(path / "release-manifest.yaml"),
    }


def write_json_report(path: Path, artifact_id: str, source_requirement_id: str) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": "eliza.e1_phone_routed_output_candidate_report.v1",
        "artifact_id": artifact_id,
        "source_requirement_id": source_requirement_id,
        "owner": "local-routing-candidate-generator",
        "created_at": DATE,
        "tool_or_supplier_revision": "generate_e1_phone_routed_output_candidates.py",
        "input_artifact_hashes": {chip_rel(SOURCE_BOARD): sha256(SOURCE_BOARD)},
        "reviewer": "unreviewed",
        "reviewed_at": "unreviewed_local_candidate_2026-05-22",
        "disposition": "blocked_candidate_not_approved",
        "kicad_project_revision": "development_real_footprint_snapshot",
        "routed_pcb_hash": sha256(SOURCE_BOARD),
        "erc_result": "not_run",
        "drc_result": "not_run",
        "stackup_revision": "not_fabricator_approved",
        "impedance_coupon_reference": "missing_fabricator_coupon",
        "si_pi_rf_report_references": [
            "board/kicad/e1-phone/production/reports/si-pi/release-manifest.yaml",
            "board/kicad/e1-phone/production/reports/rf/release-manifest.yaml",
        ],
        "fab_output_manifest": chip_rel(OUT_MANIFEST),
        "routed_step_reference": "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        "routed_step_visual_detail": routed_visual_detail(),
        "cad_connection_coverage": cad_connection_summary(),
        "release_package_revision": "local_candidate_not_release",
        "fab_vendor_or_assembler": "missing_external_supplier_or_factory",
        "program_or_fixture_revision": "not_run",
        "limits_revision": "not_approved",
        "calibration_state": "not_calibrated",
        "lot_or_serial_traceability": "missing",
        "release_allowed": False,
        "claim_boundary": "blocked local candidate; not release evidence",
    }
    if path == ROOT / "board/kicad/e1-phone/production/reports/drc.json":
        payload.update(
            {
                "raw_kicad_report_kind": "drc",
                "raw_kicad_report_status": "blocked_not_run",
                "raw_kicad_cli_command": (
                    "kicad-cli pcb drc --format json --output "
                    "board/kicad/e1-phone/production/reports/drc.json "
                    "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
                ),
                "kicad_cli_version": "",
                "source_board_sha256": sha256(SOURCE_BOARD),
                "tool_exit_code": "not_run",
                "raw_kicad_cli_report": {},
                "raw_kicad_cli_payload_required_for_release": True,
            }
        )
    if path == ROOT / "board/kicad/e1-phone/production/reports/erc.json":
        payload.update(
            {
                "raw_kicad_report_kind": "erc",
                "raw_kicad_report_status": "blocked_not_run",
                "raw_kicad_cli_command": (
                    "kicad-cli sch erc --format json --output "
                    "board/kicad/e1-phone/production/reports/erc.json "
                    "board/kicad/e1-phone/schematic/e1-phone.kicad_sch"
                ),
                "kicad_cli_version": "",
                "source_schematic_sha256": sha256(
                    ROOT / "board/kicad/e1-phone/schematic/e1-phone.kicad_sch"
                ),
                "tool_exit_code": "not_run",
                "raw_kicad_cli_report": {},
                "raw_kicad_cli_payload_required_for_release": True,
            }
        )
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"path": chip_rel(path), "kind": "json", "metadata": ""}


def extract_kicad_blocks(text: str, head: str) -> list[str]:
    blocks: list[str] = []
    start = 0
    while True:
        index = text.find(head, start)
        if index < 0:
            return blocks
        depth = 0
        end = index
        for pos in range(index, len(text)):
            char = text[pos]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    end = pos + 1
                    break
        if end <= index:
            return blocks
        blocks.append(text[index:end])
        start = end


def parse_zone_records(board_text: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for index, block in enumerate(extract_kicad_blocks(board_text, "(zone "), start=1):
        layers_match = re.search(r"\(layers\s+([^)]+)\)", block)
        layers = re.findall(r'"([^"]+)"', layers_match.group(1)) if layers_match else []
        points = [
            {"x": round(float(x), 3), "y": round(float(y), 3)}
            for x, y in re.findall(r"\(xy\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)", block)
        ]
        xs = [point["x"] for point in points]
        ys = [point["y"] for point in points]
        bbox = (
            {
                "x_min": min(xs),
                "y_min": min(ys),
                "x_max": max(xs),
                "y_max": max(ys),
                "width": round(max(xs) - min(xs), 3),
                "height": round(max(ys) - min(ys), 3),
            }
            if points
            else {}
        )
        name_match = re.search(r'\(name\s+"([^"]*)"\)', block)
        net_match = re.search(r"\(net\s+(-?\d+)\)", block)
        net_name_match = re.search(r'\(net_name\s+"([^"]*)"\)', block)
        records.append(
            {
                "index": index,
                "name": name_match.group(1) if name_match else "",
                "net": int(net_match.group(1)) if net_match else None,
                "net_name": net_name_match.group(1) if net_name_match else "",
                "layers": layers,
                "layer_count": len(layers),
                "is_keepout": "(keepout " in block,
                "has_fill_settings": "(fill " in block,
                "filled_polygon_count": block.count("(filled_polygon"),
                "polygon_point_count": len(points),
                "bbox_mm": bbox,
            }
        )
    return records


def write_zone_fill_report(path: Path) -> dict[str, Any]:
    board_text = SOURCE_BOARD.read_text(encoding="utf-8", errors="ignore")
    zones = parse_zone_records(board_text)
    keepout_zones = [zone for zone in zones if zone["is_keepout"]]
    copper_zones = [zone for zone in zones if not zone["is_keepout"]]
    filled_zones = [zone for zone in zones if int(zone["filled_polygon_count"] or 0) > 0]
    unfilled_copper_zone_count = sum(
        1 for zone in copper_zones if int(zone["filled_polygon_count"] or 0) == 0
    )
    local_filled_copper_zones_present = bool(copper_zones) and unfilled_copper_zone_count == 0
    payload = blocked_metadata("zone_fill_report_candidate", "zone_fill_report", SOURCE_BOARD)
    payload.update(
        {
            "schema": "eliza.e1_phone_zone_fill_report_candidate.v1",
            "status": (
                "blocked_local_routed_candidate_has_non_release_filled_copper_zones"
                if local_filled_copper_zones_present
                else "blocked_local_routed_candidate_has_keepouts_but_no_copper_filled_zones"
            ),
            "source_board": chip_rel(SOURCE_BOARD),
            "source_board_sha256": sha256(SOURCE_BOARD),
            "candidate_release_credit": False,
            "zone_summary": {
                "zone_count": len(zones),
                "keepout_zone_count": len(keepout_zones),
                "copper_zone_count": len(copper_zones),
                "filled_zone_count": len(filled_zones),
                "unfilled_copper_zone_count": unfilled_copper_zone_count,
                "all_zones_have_polygon_points": all(
                    int(zone["polygon_point_count"] or 0) > 0 for zone in zones
                ),
                "all_keepouts_have_copperpour_blocked": all(
                    bool(zone["is_keepout"]) for zone in keepout_zones
                ),
                "local_filled_copper_zones_present": local_filled_copper_zones_present,
                "local_filled_copper_zones_release_credit": False,
                "release_zone_fill_complete": False,
            },
            "zone_records": zones,
            "release_blockers": [
                (
                    "local copper zones are filled for development visualization only"
                    if local_filled_copper_zones_present
                    else "no copper zones are filled in the local routed candidate"
                ),
                "zone-fill output is local candidate evidence only and has not been run through release DRC",
                "production source still requires approved routed KiCad board, supplier footprints, and signed DRC/ERC/zone-fill review",
            ],
            "claim_boundary": (
                "Structured local zone inventory for the routed-development board. "
                "This records keepout and fill state but does not count as release "
                "zone-fill evidence."
            ),
            "release_allowed": False,
        }
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"path": chip_rel(path), "kind": "json", "metadata": ""}


def write_yaml_report(path: Path, artifact_id: str, source_requirement_id: str) -> dict[str, Any]:
    payload = blocked_metadata(artifact_id, source_requirement_id, SOURCE_BOARD)
    payload["artifact_sha256"] = ""
    payload["release_allowed"] = False
    write_yaml(path, payload)
    return {"path": chip_rel(path), "kind": "yaml", "metadata": ""}


def write_component_model_manifest(path: Path) -> dict[str, Any]:
    intake_path = STEP_INTAKE
    intake = load_yaml_if_present(intake_path)
    pad_audit = load_yaml_if_present(PAD_AUDIT)
    pad_records = {
        str(record.get("footprint", "")): record
        for record in pad_audit.get("records", [])
        if isinstance(record, dict) and record.get("footprint")
    }
    footprints = intake.get("footprints", []) if isinstance(intake, dict) else []
    models = []

    def visual_package_class(pad_record: dict[str, Any], footprint: dict[str, Any]) -> str:
        pinout_file = str(pad_record.get("pinout_file", ""))
        coverage = str(pad_record.get("coverage", ""))
        pinout_status = str(pad_record.get("pinout_status", ""))
        footprint_name = str(footprint.get("footprint", ""))
        reference = str(footprint.get("reference", ""))
        if pinout_file:
            return "pinout_bound_package_or_connector"
        if "testpoint" in pinout_status or "TESTPOINT" in footprint_name:
            return "test_access_land_pattern"
        if "fiducial" in pinout_status or "FIDUCIAL" in footprint_name:
            return "fiducial_land_pattern"
        if "mechanical_npth" in pinout_status or "MOUNTING_HOLE" in footprint_name:
            return "mechanical_land_pattern"
        if "rf_pi_match" in coverage or "PI_MATCH" in footprint_name:
            return "rf_matching_land_pattern"
        if "esd" in coverage or "ESD" in footprint_name or "TVS" in footprint_name:
            return "protection_land_pattern"
        if "RC_ARRAY" in footprint_name:
            return "passive_array_land_pattern"
        if reference.startswith(("R", "C", "L")) or any(
            token in footprint_name for token in ("R0402", "C0402", "L0402", "SHUNT")
        ):
            return "discrete_passive_land_pattern"
        return "support_land_pattern"

    for model_index, footprint in enumerate(footprints, start=1):
        pads = footprint.get("pads", [])
        pad_names = [
            str(pad.get("name", ""))
            for pad in pads
            if isinstance(pad, dict) and pad.get("name") is not None
        ]
        pad_record = pad_records.get(str(footprint.get("footprint", "")), {})
        terminal_contract = [
            str(pin) for pin in pad_record.get("local_terminal_contract", []) if pin is not None
        ]
        pinout_file = str(pad_record.get("pinout_file", "") or "")
        support_pattern_bound = bool(
            pad_record.get("support_pattern_has_explicit_provenance", False)
        )
        pattern_bound = bool(pinout_file) or support_pattern_bound
        non_signal_pad_contract = [
            str(pin) for pin in pad_record.get("non_signal_pad_contract", []) if pin is not None
        ]
        npth_feature_count = int(pad_record.get("npth_mechanical_feature_count", 0) or 0)
        npth_feature_contract = [
            dict(item)
            for item in pad_record.get("npth_mechanical_feature_contract", [])
            if isinstance(item, dict)
        ]
        pad_contract_records = []
        electrical_pad_count = int(pad_record.get("electrical_pad_count", 0) or 0)
        for pad_name in pad_names:
            if pad_name in terminal_contract:
                contract_kind = "electrical_terminal"
                contract_source = pad_record.get("pinout_file") or pad_record.get(
                    "local_terminal_contract_source", ""
                )
                covered = True
            elif pad_name in non_signal_pad_contract:
                contract_kind = "non_signal_mechanical_pad"
                contract_source = pad_record.get("non_signal_pad_contract_source", "")
                covered = True
            elif pad_name == "" and npth_feature_count > 0 and npth_feature_contract:
                contract_kind = "npth_mechanical_feature"
                contract_source = pad_record.get("npth_mechanical_feature_contract_source", "")
                covered = True
            else:
                contract_kind = "uncovered_pad_visual"
                contract_source = ""
                covered = False
            pad_contract_records.append(
                {
                    "pad": pad_name,
                    "contract_kind": contract_kind,
                    "contract_source": contract_source,
                    "covered": covered,
                }
            )
        terminal_contract_matches_pad_visuals = all(pin in pad_names for pin in terminal_contract)
        models.append(
            {
                "reference": footprint.get("reference", ""),
                "footprint": footprint.get("footprint", ""),
                "combined_step_assembly_name": (
                    f"{model_index:02d}_{footprint.get('reference', '')}_"
                    f"{footprint.get('footprint', '')}"
                ),
                "layer": footprint.get("layer", ""),
                "at_mm": footprint.get("at_mm", {}),
                "model_source": "local_development_envelope",
                "model_binding_status": "blocked_pending_supplier_step_or_verified_package_drawing",
                "source_step_intake": chip_rel(intake_path) if intake_path.is_file() else "",
                "source_assembly_item": footprint.get("reference", ""),
                "supplier_approved": False,
                "envelope_mm": footprint.get("envelope_mm", {}),
                "pad_count": footprint.get("pad_count", 0),
                "electrical_pad_count": electrical_pad_count,
                "mechanical_pad_count": int(pad_record.get("mechanical_pad_count", 0) or 0),
                "mechanical_pads": [
                    str(pin) for pin in pad_record.get("mechanical_pads", []) if pin is not None
                ],
                "npth_mechanical_feature_count": npth_feature_count,
                "npth_mechanical_features": [
                    dict(item)
                    for item in pad_record.get("npth_mechanical_features", [])
                    if isinstance(item, dict)
                ],
                "npth_mechanical_feature_contract": npth_feature_contract,
                "npth_mechanical_feature_contract_source": pad_record.get(
                    "npth_mechanical_feature_contract_source", ""
                ),
                "npth_mechanical_feature_contract_matches_footprint": bool(
                    pad_record.get("npth_mechanical_feature_contract_matches_footprint", True)
                ),
                "non_signal_pad_contract": non_signal_pad_contract,
                "non_signal_pad_contract_source": pad_record.get(
                    "non_signal_pad_contract_source", ""
                ),
                "non_signal_pad_contract_matches_pad_visuals": bool(
                    pad_record.get("non_signal_pad_contract_matches_pad_visuals", True)
                ),
                "pad_visual_count": len(pads) if isinstance(pads, list) else 0,
                "pad_names": pad_names,
                "pad_contract_records": pad_contract_records,
                "pad_contract_covered_count": sum(
                    1 for record in pad_contract_records if record["covered"]
                ),
                "uncovered_pad_visuals": [
                    record["pad"] for record in pad_contract_records if not record["covered"]
                ],
                "all_pad_visuals_have_contract": all(
                    record["covered"] for record in pad_contract_records
                )
                and len(pad_contract_records) == len(pads),
                "pinout_file": pinout_file,
                "pinout_bound": bool(pinout_file),
                "pinout_status": pad_record.get("pinout_status", ""),
                "coverage": pad_record.get("coverage", ""),
                "land_pattern_basis": pad_record.get("land_pattern_basis", ""),
                "visual_package_class": visual_package_class(pad_record, footprint),
                "local_terminal_contract": terminal_contract,
                "local_terminal_contract_source": pad_record.get(
                    "local_terminal_contract_source", ""
                ),
                "terminal_contract_count": len(terminal_contract),
                "terminal_contract_bound": bool(terminal_contract) or electrical_pad_count == 0,
                "terminal_contract_matches_pad_visuals": terminal_contract_matches_pad_visuals,
                "support_pattern_bound": support_pattern_bound,
                "support_pattern_has_explicit_provenance": support_pattern_bound,
                "pattern_bound": pattern_bound,
                "pattern_binding_status": (
                    "pinout_bound_public_or_captured_contract"
                    if pinout_file
                    else (
                        "support_pattern_bound_to_explicit_local_terminal_contract"
                        if support_pattern_bound
                        else "unbound_pattern_missing_pinout_or_support_provenance"
                    )
                ),
                "pad_audit_record_source": chip_rel(PAD_AUDIT) if PAD_AUDIT.is_file() else "",
                "local_step_bound": False,
                "release_credit": False,
            }
        )
    pinout_bound_models = [model for model in models if model["pinout_file"]]
    support_pattern_models = [
        model for model in models if model["support_pattern_has_explicit_provenance"]
    ]
    models_with_terminal_contract_or_no_pads = [
        model
        for model in models
        if model["terminal_contract_count"] > 0 or int(model["electrical_pad_count"] or 0) == 0
    ]
    total_pad_contract_visual_count = sum(
        int(model.get("pad_contract_covered_count") or 0) for model in models
    )
    uncovered_pad_visual_count = sum(
        len(model.get("uncovered_pad_visuals", [])) for model in models
    )
    layer_counts: dict[str, int] = {}
    coverage_counts: dict[str, int] = {}
    pinout_status_counts: dict[str, int] = {}
    visual_package_class_counts: dict[str, int] = {}
    for model in models:
        for counts, key in [
            (layer_counts, str(model.get("layer", ""))),
            (coverage_counts, str(model.get("coverage", ""))),
            (pinout_status_counts, str(model.get("pinout_status", ""))),
            (visual_package_class_counts, str(model.get("visual_package_class", ""))),
        ]:
            counts[key] = counts.get(key, 0) + 1
    payload = blocked_metadata(
        "component_3d_model_manifest_candidate",
        "supplier_component_3d_model_manifest",
        intake_path if intake_path.is_file() else SOURCE_BOARD,
    )
    payload.update(
        {
            "schema": "eliza.e1_phone_component_3d_model_manifest_candidate.v1",
            "status": "blocked_local_development_envelopes_not_supplier_models",
            "source_step_intake": chip_rel(intake_path) if intake_path.is_file() else "",
            "routed_step_reference": "board/kicad/e1-phone/production/step/routed-board-with-components.step",
            "routed_step_visual_detail": routed_visual_detail(),
            "cad_connection_coverage": cad_connection_summary(),
            "kicad_cad_traceability": kicad_cad_traceability_summary(),
            "component_model_count": len(models),
            "pad_contact_visual_count": intake.get("pad_contact_visual_count", 0),
            "route_segment_visual_count": intake.get("route_segment_visual_count", 0),
            "supplier_approved_model_count": 0,
            "model_to_footprint_binding": {
                "source": chip_rel(intake_path) if intake_path.is_file() else "",
                "binding_basis": "KiCad reference, footprint, board layer, XY rotation, envelope, and pad-name list from the generated real-footprint development STEP intake.",
                "all_models_have_reference": all(bool(model["reference"]) for model in models),
                "all_models_have_footprint": all(bool(model["footprint"]) for model in models),
                "all_models_have_layer": all(bool(model["layer"]) for model in models),
                "all_models_have_at_mm": all(bool(model["at_mm"]) for model in models),
                "all_model_pad_counts_match_visuals": all(
                    int(model["pad_count"] or 0) == int(model["pad_visual_count"] or 0)
                    for model in models
                ),
                "release_credit": False,
            },
            "package_visual_summary": {
                "source": chip_rel(intake_path) if intake_path.is_file() else "",
                "binding_basis": (
                    "Per-model visual classes derived from local development STEP intake, "
                    "pad/pin audit coverage, and generated support land-pattern records."
                ),
                "layer_counts": dict(sorted(layer_counts.items())),
                "coverage_counts": dict(sorted(coverage_counts.items())),
                "pinout_status_counts": dict(sorted(pinout_status_counts.items())),
                "visual_package_class_counts": dict(sorted(visual_package_class_counts.items())),
                "total_electrical_pad_count": sum(
                    int(model.get("electrical_pad_count") or 0) for model in models
                ),
                "total_mechanical_pad_count": sum(
                    int(model.get("mechanical_pad_count") or 0) for model in models
                ),
                "total_pad_visual_count": sum(
                    int(model.get("pad_visual_count") or 0) for model in models
                ),
                "all_models_have_visual_package_class": all(
                    bool(model.get("visual_package_class")) for model in models
                ),
                "all_package_visual_counts_match_step_intake": (
                    sum(int(model.get("pad_visual_count") or 0) for model in models)
                    == int(intake.get("pad_contact_visual_count", 0) or 0)
                    and len(models) == int(intake.get("footprint_envelope_count", 0) or 0)
                ),
                "release_credit": False,
            },
            "terminal_contract_binding": {
                "source": chip_rel(PAD_AUDIT) if PAD_AUDIT.is_file() else "",
                "binding_basis": (
                    "Per-model pinout and support-pattern terminal contracts copied from the "
                    "development pad/pin coverage audit; contracts are local development "
                    "traceability only and do not replace supplier package drawings."
                ),
                "pinout_bound_model_count": len(pinout_bound_models),
                "support_pattern_model_count": len(support_pattern_models),
                "pattern_bound_model_count": sum(
                    1 for model in models if model.get("pattern_bound") is True
                ),
                "all_models_have_pattern_binding": all(
                    model.get("pattern_bound") is True for model in models
                ),
                "terminal_contract_bound_model_count": sum(
                    1 for model in models if model.get("terminal_contract_bound") is True
                ),
                "all_models_have_terminal_contract_binding": all(
                    model.get("terminal_contract_bound") is True for model in models
                ),
                "models_with_terminal_contract_or_no_electrical_pads_count": len(
                    models_with_terminal_contract_or_no_pads
                ),
                "total_pad_contract_visual_count": total_pad_contract_visual_count,
                "uncovered_pad_visual_count": uncovered_pad_visual_count,
                "all_model_pad_visuals_have_contract": all(
                    model.get("all_pad_visuals_have_contract") is True for model in models
                )
                and total_pad_contract_visual_count
                == sum(int(model.get("pad_visual_count") or 0) for model in models),
                "non_signal_pad_contract_count": sum(
                    len(model["non_signal_pad_contract"]) for model in models
                ),
                "models_with_non_signal_pad_contract_count": sum(
                    1 for model in models if model["non_signal_pad_contract"]
                ),
                "all_pinout_bound_models_have_terminal_contract": all(
                    model["terminal_contract_count"] > 0 for model in pinout_bound_models
                ),
                "all_pinout_bound_model_contracts_match_pad_visuals": all(
                    model["terminal_contract_matches_pad_visuals"] for model in pinout_bound_models
                ),
                "all_support_pattern_models_have_explicit_provenance": all(
                    bool(model["land_pattern_basis"])
                    and model["local_terminal_contract_source"]
                    == "generated_development_footprint_support_pattern_basis"
                    for model in support_pattern_models
                ),
                "all_non_signal_pad_contracts_match_pad_visuals": all(
                    model["mechanical_pad_count"] == len(model["non_signal_pad_contract"])
                    and model["non_signal_pad_contract_matches_pad_visuals"] is True
                    for model in models
                ),
                "npth_mechanical_feature_contract_count": sum(
                    len(model["npth_mechanical_feature_contract"]) for model in models
                ),
                "models_with_npth_mechanical_feature_contract_count": sum(
                    1 for model in models if model["npth_mechanical_feature_contract"]
                ),
                "all_npth_mechanical_features_have_contract": all(
                    model["npth_mechanical_feature_count"]
                    == len(model["npth_mechanical_feature_contract"])
                    and model["npth_mechanical_feature_contract_matches_footprint"] is True
                    for model in models
                    if model["npth_mechanical_feature_count"] > 0
                ),
                "release_credit": False,
            },
            "models": models,
            "release_allowed": False,
            "claim_boundary": (
                "Local component envelope manifest for routed-output candidate review only; "
                "not a supplier-approved 3D model manifest and not release evidence."
            ),
        }
    )
    write_yaml(path, payload)
    return {"path": chip_rel(path), "kind": "yaml", "metadata": ""}


def safe_model_filename(reference: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in reference)
    return safe or "unnamed_model"


def write_local_envelope_step(path: Path, model: dict[str, Any]) -> None:
    envelope = model.get("envelope_mm", {})
    if not isinstance(envelope, dict):
        envelope = {}
    width = max(float(envelope.get("width", 0) or 0), 0.1)
    depth = max(float(envelope.get("depth", 0) or 0), 0.1)
    height = max(float(envelope.get("height", 0) or 0), 0.05)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        from OCP.gp import gp_Pnt
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

        shape = BRepPrimAPI_MakeBox(
            gp_Pnt(-width / 2.0, -depth / 2.0, -height / 2.0),
            width,
            depth,
            height,
        ).Shape()
        writer = STEPControl_Writer()
        writer.Transfer(shape, STEPControl_AsIs)
        status = writer.Write(str(path))
        if status != IFSelect_RetDone:
            raise RuntimeError(f"OCP STEP write failed: {status}")
        del writer
        del shape
        gc.collect()
        return
    except ModuleNotFoundError:
        pass

    reference = str(model.get("reference", "LOCAL_ENVELOPE"))
    half_w = width / 2.0
    half_d = depth / 2.0
    points = [
        (-half_w, -half_d, 0.0),
        (half_w, -half_d, 0.0),
        (half_w, half_d, 0.0),
        (-half_w, half_d, 0.0),
        (-half_w, -half_d, height),
        (half_w, -half_d, height),
        (half_w, half_d, height),
        (-half_w, half_d, height),
    ]
    triangles = [
        (1, 2, 3),
        (1, 3, 4),
        (5, 7, 6),
        (5, 8, 7),
        (1, 5, 6),
        (1, 6, 2),
        (2, 6, 7),
        (2, 7, 3),
        (3, 7, 8),
        (3, 8, 4),
        (4, 8, 5),
        (4, 5, 1),
    ]
    point_text = ",".join(f"({x:.4f},{y:.4f},{z:.4f})" for x, y, z in points)
    triangle_text = ",".join(f"({a},{b},{c})" for a, b, c in triangles)
    path.write_text(
        "\n".join(
            [
                "ISO-10303-21;",
                "HEADER;",
                "FILE_DESCRIPTION(('E1 phone local development envelope STEP'),'2;1');",
                f"FILE_NAME('{path.name}','2026-05-22',('eliza'),('elizaOS'),'generate_e1_phone_routed_output_candidates.py','local','non-release');",
                "FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));",
                "ENDSEC;",
                "DATA;",
                f"#1=CARTESIAN_POINT_LIST_3D('{reference}',({point_text}));",
                f"#2=TRIANGULATED_FACE_SET('{reference}_LOCAL_ENVELOPE',#1,$,.T.,({triangle_text}),$);",
                "#3=GEOMETRIC_REPRESENTATION_CONTEXT(3);",
                "#4=SHAPE_REPRESENTATION('local_development_envelope',(#2),#3);",
                "ENDSEC;",
                "END-ISO-10303-21;",
                "",
            ]
        ),
        encoding="utf-8",
    )


def validate_local_envelope_step(path: Path, model: dict[str, Any]) -> dict[str, Any]:
    envelope = model.get("envelope_mm", {})
    if not isinstance(envelope, dict):
        envelope = {}
    expected = {
        "width": max(float(envelope.get("width", 0) or 0), 0.1),
        "depth": max(float(envelope.get("depth", 0) or 0), 0.1),
        "height": max(float(envelope.get("height", 0) or 0), 0.05),
    }

    def validate_with_python(python: Path | None = None) -> dict[str, Any]:
        code = (
            "import cadquery as cq, json, sys\n"
            "path = sys.argv[1]\n"
            "shape = cq.importers.importStep(path)\n"
            "solid = shape.val()\n"
            "box = solid.BoundingBox()\n"
            "print(json.dumps({"
            "'import_status':'pass',"
            "'solid_type':type(solid).__name__,"
            "'bbox_mm':{'width':box.xlen,'depth':box.ylen,'height':box.zlen}"
            "}, sort_keys=True))\n"
        )
        if python is None:
            import cadquery as cq

            shape = cq.importers.importStep(str(path))
            solid = shape.val()
            assert hasattr(solid, "BoundingBox"), (
                f"Expected a Shape with BoundingBox, got {type(solid).__name__}"
            )
            box = solid.BoundingBox()
            return {
                "import_status": "pass",
                "solid_type": type(solid).__name__,
                "bbox_mm": {
                    "width": box.xlen,
                    "depth": box.ylen,
                    "height": box.zlen,
                },
            }
        result = subprocess.run(
            [str(python), "-c", code, str(path)],
            check=True,
            capture_output=True,
            text=True,
        )
        data = json.loads(result.stdout)
        return data if isinstance(data, dict) else {"import_status": "invalid_output"}

    def validate_with_ocp() -> dict[str, Any]:
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import BRepBndLib
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.STEPControl import STEPControl_Reader

        reader = STEPControl_Reader()
        status = reader.ReadFile(str(path))
        if status != IFSelect_RetDone:
            raise RuntimeError(f"OCP STEP read failed: {status}")
        reader.TransferRoots()
        shape = reader.OneShape()
        box = Bnd_Box()
        BRepBndLib.Add_s(shape, box)
        xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
        return {
            "import_status": "pass",
            "solid_type": "Solid",
            "validation_tool": "ocp_step_reader",
            "bbox_mm": {
                "width": float(xmax - xmin),
                "depth": float(ymax - ymin),
                "height": float(zmax - zmin),
            },
        }

    try:
        validation = validate_with_python()
    except ModuleNotFoundError:
        try:
            validation = validate_with_ocp()
        except ModuleNotFoundError:
            venv_python = ROOT / ".venv/bin/python"
            if not venv_python.is_file():
                validation = {
                    "import_status": "not_run_cadquery_or_ocp_unavailable",
                    "solid_type": "",
                    "bbox_mm": {},
                }
            else:
                validation = validate_with_python(venv_python)
    except Exception as exc:
        validation = {
            "import_status": "failed",
            "solid_type": "",
            "bbox_mm": {},
            "error": str(exc),
        }

    bbox = validation.get("bbox_mm", {})
    if not isinstance(bbox, dict):
        bbox = {}
    matches = all(
        abs(float(bbox.get(key, 0.0) or 0.0) - expected[key]) <= 0.01
        for key in ("width", "depth", "height")
    )
    validation["expected_bbox_mm"] = expected
    validation["bbox_matches_envelope"] = matches
    return validation


def write_component_model_directory(path: Path, component_manifest_path: Path) -> dict[str, Any]:
    component_manifest = load_yaml_if_present(component_manifest_path)
    models = component_manifest.get("models", [])
    if not isinstance(models, list):
        models = []
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)
    supplier_lane_surrogate_steps = write_local_supplier_lane_surrogate_steps(models)

    source_routed_step = (
        ROOT / "board/kicad/e1-phone/production/step/routed-board-with-components.step"
    )
    source_routed_step_rel = chip_rel(source_routed_step)
    source_routed_step_sha256 = sha256(source_routed_step) if source_routed_step.is_file() else ""
    source_routed_step_bytes = (
        source_routed_step.stat().st_size if source_routed_step.is_file() else 0
    )
    model_records = []
    for model in models:
        if not isinstance(model, dict):
            continue
        reference = str(model.get("reference", ""))
        safe_reference = safe_model_filename(reference)
        filename = f"{safe_reference}.local-model.json"
        record_path = path / filename
        local_step_path = path / f"{safe_reference}.local-envelope.step"
        supplier_lane = supplier_lane_for_model(model)
        supplier_step_intake = supplier_step_intake_for_lane(supplier_lane)
        write_local_envelope_step(local_step_path, model)
        local_step_rel = chip_rel(local_step_path)
        local_step_validation = validate_local_envelope_step(local_step_path, model)
        local_step_sha256 = sha256(local_step_path)
        local_step_bytes = local_step_path.stat().st_size
        local_discrete_step_imported_as_solid = (
            local_step_validation.get("import_status") == "pass"
            and local_step_validation.get("solid_type") == "Solid"
        )
        record = {
            "schema": "eliza.e1_phone_local_component_model_record.v1",
            "status": "blocked_local_development_envelope_not_supplier_step",
            "reference": reference,
            "footprint": model.get("footprint", ""),
            "layer": model.get("layer", ""),
            "at_mm": model.get("at_mm", {}),
            "envelope_mm": model.get("envelope_mm", {}),
            "model_source": model.get("model_source", ""),
            "model_binding_status": model.get("model_binding_status", ""),
            "source_routed_step": source_routed_step_rel,
            "source_routed_step_sha256": source_routed_step_sha256,
            "source_routed_step_bytes": source_routed_step_bytes,
            "combined_step_assembly_name": model.get("combined_step_assembly_name", ""),
            "combined_step_locator_status": (
                "development_envelope_named_subshape_in_combined_routed_step"
            ),
            "local_discrete_step_file": local_step_rel,
            "local_discrete_step_sha256": local_step_sha256,
            "local_discrete_step_bytes": local_step_bytes,
            "local_discrete_step_status": "local_development_envelope_not_supplier_model",
            "local_discrete_step_import_status": local_step_validation.get("import_status", ""),
            "local_discrete_step_solid_type": local_step_validation.get("solid_type", ""),
            "local_discrete_step_imported_as_solid": local_discrete_step_imported_as_solid,
            "local_discrete_step_bbox_mm": local_step_validation.get("bbox_mm", {}),
            "local_discrete_step_expected_bbox_mm": local_step_validation.get(
                "expected_bbox_mm", {}
            ),
            "local_discrete_step_bbox_matches_envelope": local_step_validation.get(
                "bbox_matches_envelope", False
            ),
            "expected_supplier_step_file": f"{safe_model_filename(reference)}.step",
            "expected_supplier_brep_or_step_status": (
                "missing_supplier_approved_discrete_component_model"
            ),
            "supplier_sourcing_lane": supplier_lane,
            **supplier_step_intake,
            **public_step_overlay_for_model(model),
            "source_step_intake": model.get("source_step_intake", ""),
            "source_assembly_item": model.get("source_assembly_item", ""),
            "discrete_supplier_step_file": "",
            "discrete_supplier_step_status": "missing_supplier_approved_component_step",
            "local_geometry_status": (
                "represented_as_development_envelope_inside_combined_routed_step_candidate"
            ),
            "supplier_approved": False,
            "pad_count": model.get("pad_count", 0),
            "electrical_pad_count": model.get("electrical_pad_count", 0),
            "mechanical_pad_count": model.get("mechanical_pad_count", 0),
            "mechanical_pads": model.get("mechanical_pads", []),
            "npth_mechanical_feature_count": model.get("npth_mechanical_feature_count", 0),
            "npth_mechanical_features": model.get("npth_mechanical_features", []),
            "npth_mechanical_feature_contract": model.get("npth_mechanical_feature_contract", []),
            "npth_mechanical_feature_contract_source": model.get(
                "npth_mechanical_feature_contract_source", ""
            ),
            "npth_mechanical_feature_contract_matches_footprint": model.get(
                "npth_mechanical_feature_contract_matches_footprint", False
            ),
            "non_signal_pad_contract": model.get("non_signal_pad_contract", []),
            "non_signal_pad_contract_source": model.get("non_signal_pad_contract_source", ""),
            "non_signal_pad_contract_matches_pad_visuals": model.get(
                "non_signal_pad_contract_matches_pad_visuals", False
            ),
            "pad_visual_count": model.get("pad_visual_count", 0),
            "pad_names": model.get("pad_names", []),
            "pad_contract_records": model.get("pad_contract_records", []),
            "pad_contract_covered_count": model.get("pad_contract_covered_count", 0),
            "uncovered_pad_visuals": model.get("uncovered_pad_visuals", []),
            "all_pad_visuals_have_contract": model.get("all_pad_visuals_have_contract", False),
            "pinout_file": model.get("pinout_file", ""),
            "pinout_bound": bool(model.get("pinout_file")),
            "coverage": model.get("coverage", ""),
            "visual_package_class": model.get("visual_package_class", ""),
            "local_terminal_contract": model.get("local_terminal_contract", []),
            "local_terminal_contract_source": model.get("local_terminal_contract_source", ""),
            "terminal_contract_count": model.get("terminal_contract_count", 0),
            "terminal_contract_bound": bool(model.get("terminal_contract_bound", False)),
            "terminal_contract_matches_pad_visuals": model.get(
                "terminal_contract_matches_pad_visuals", False
            ),
            "support_pattern_bound": bool(model.get("support_pattern_bound", False)),
            "support_pattern_has_explicit_provenance": model.get(
                "support_pattern_has_explicit_provenance", False
            ),
            "pattern_bound": bool(model.get("pattern_bound", False)),
            "pattern_binding_status": model.get("pattern_binding_status", ""),
            "land_pattern_basis": model.get("land_pattern_basis", ""),
            "local_step_bound": local_discrete_step_imported_as_solid
            and bool(local_step_rel)
            and bool(local_step_validation.get("bbox_matches_envelope", False)),
            "release_credit": False,
            "release_allowed": False,
            "claim_boundary": (
                "Per-reference local model metadata only. This is not a discrete "
                "supplier-approved STEP/B-rep model and cannot satisfy routed-board "
                "release or enclosure clearance."
            ),
        }
        record_path.write_text(
            json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        record_sha256 = sha256(record_path)
        model_records.append(
            {
                "reference": reference,
                "footprint": model.get("footprint", ""),
                "metadata": record_path.name,
                "metadata_sha256": record_sha256,
                "source_routed_step": source_routed_step_rel,
                "source_routed_step_sha256": source_routed_step_sha256,
                "source_routed_step_bytes": source_routed_step_bytes,
                "combined_step_assembly_name": record["combined_step_assembly_name"],
                "local_discrete_step_file": record["local_discrete_step_file"],
                "local_discrete_step_sha256": record["local_discrete_step_sha256"],
                "local_discrete_step_bytes": record["local_discrete_step_bytes"],
                "local_discrete_step_status": record["local_discrete_step_status"],
                "local_discrete_step_import_status": record["local_discrete_step_import_status"],
                "local_discrete_step_solid_type": record["local_discrete_step_solid_type"],
                "local_discrete_step_imported_as_solid": record[
                    "local_discrete_step_imported_as_solid"
                ],
                "local_discrete_step_bbox_mm": record["local_discrete_step_bbox_mm"],
                "local_discrete_step_expected_bbox_mm": record[
                    "local_discrete_step_expected_bbox_mm"
                ],
                "local_discrete_step_bbox_matches_envelope": record[
                    "local_discrete_step_bbox_matches_envelope"
                ],
                "local_step_bound": record["local_step_bound"],
                "expected_supplier_step_file": record["expected_supplier_step_file"],
                "expected_supplier_brep_or_step_status": record[
                    "expected_supplier_brep_or_step_status"
                ],
                "supplier_sourcing_lane": record["supplier_sourcing_lane"],
                "supplier_step_intake_file": record["supplier_step_intake_file"],
                "supplier_step_intake_status": record["supplier_step_intake_status"],
                "supplier_step_intake_release_credit": record[
                    "supplier_step_intake_release_credit"
                ],
                "supplier_step_intake_sha256": record["supplier_step_intake_sha256"],
                "supplier_step_intake_bytes": record["supplier_step_intake_bytes"],
                "public_cad_step_overlay_status": record["public_cad_step_overlay_status"],
                "public_cad_step_overlay_file": record["public_cad_step_overlay_file"],
                "public_cad_step_overlay_sha256": record["public_cad_step_overlay_sha256"],
                "public_cad_step_overlay_bytes": record["public_cad_step_overlay_bytes"],
                "public_cad_source_record": record["public_cad_source_record"],
                "public_cad_step_overlay_release_credit": record[
                    "public_cad_step_overlay_release_credit"
                ],
                "pinout_bound": bool(model.get("pinout_file")),
                "support_pattern_bound": bool(model.get("support_pattern_bound", False)),
                "support_pattern_has_explicit_provenance": bool(
                    model.get("support_pattern_has_explicit_provenance", False)
                ),
                "pattern_bound": bool(model.get("pattern_bound", False)),
                "pattern_binding_status": model.get("pattern_binding_status", ""),
                "terminal_contract_count": int(model.get("terminal_contract_count", 0) or 0),
                "terminal_contract_bound": bool(model.get("terminal_contract_bound", False)),
                "pad_contract_covered_count": int(model.get("pad_contract_covered_count", 0) or 0),
                "all_pad_visuals_have_contract": bool(
                    model.get("all_pad_visuals_have_contract", False)
                ),
                "terminal_contract_matches_pad_visuals": bool(
                    model.get("terminal_contract_matches_pad_visuals", False)
                ),
                "non_signal_pad_contract_count": len(model.get("non_signal_pad_contract", [])),
                "non_signal_pad_contract_matches_pad_visuals": bool(
                    model.get("non_signal_pad_contract_matches_pad_visuals", False)
                ),
                "npth_mechanical_feature_contract_count": len(
                    model.get("npth_mechanical_feature_contract", [])
                ),
                "npth_mechanical_feature_contract_matches_footprint": bool(
                    model.get("npth_mechanical_feature_contract_matches_footprint", False)
                ),
                "supplier_approved": False,
                "release_credit": False,
            }
        )

    for record in model_records:
        local_step_path = ROOT / str(record["local_discrete_step_file"])
        record_path = path / str(record["metadata"])
        local_step_sha256 = sha256(local_step_path)
        local_step_bytes = local_step_path.stat().st_size
        record["local_discrete_step_sha256"] = local_step_sha256
        record["local_discrete_step_bytes"] = local_step_bytes
        metadata = json.loads(record_path.read_text(encoding="utf-8"))
        metadata["local_discrete_step_sha256"] = local_step_sha256
        metadata["local_discrete_step_bytes"] = local_step_bytes
        record_path.write_text(
            json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        record["metadata_sha256"] = sha256(record_path)

    records_by_reference = {
        str(record.get("reference", "")): record
        for record in model_records
        if record.get("reference")
    }
    for model in models:
        if not isinstance(model, dict):
            continue
        matched_record: dict[str, Any] | None = records_by_reference.get(
            str(model.get("reference", ""))
        )
        if not matched_record:
            continue
        model["local_discrete_step_file"] = matched_record["local_discrete_step_file"]
        model["local_discrete_step_sha256"] = matched_record["local_discrete_step_sha256"]
        model["local_discrete_step_bytes"] = matched_record["local_discrete_step_bytes"]
        model["local_discrete_step_status"] = matched_record["local_discrete_step_status"]
        model["local_discrete_step_import_status"] = matched_record[
            "local_discrete_step_import_status"
        ]
        model["local_discrete_step_solid_type"] = matched_record["local_discrete_step_solid_type"]
        model["local_discrete_step_imported_as_solid"] = matched_record[
            "local_discrete_step_imported_as_solid"
        ]
        model["local_step_bound"] = bool(matched_record.get("local_step_bound", False))
        model["local_discrete_step_bbox_mm"] = matched_record["local_discrete_step_bbox_mm"]
        model["local_discrete_step_expected_bbox_mm"] = matched_record[
            "local_discrete_step_expected_bbox_mm"
        ]
        model["local_discrete_step_bbox_matches_envelope"] = matched_record[
            "local_discrete_step_bbox_matches_envelope"
        ]
        model["public_cad_step_overlay_status"] = matched_record["public_cad_step_overlay_status"]
        model["public_cad_step_overlay_file"] = matched_record["public_cad_step_overlay_file"]
        model["public_cad_step_overlay_sha256"] = matched_record["public_cad_step_overlay_sha256"]
        model["public_cad_step_overlay_bytes"] = matched_record["public_cad_step_overlay_bytes"]
        model["public_cad_source_record"] = matched_record["public_cad_source_record"]
        model["public_cad_step_overlay_release_credit"] = matched_record[
            "public_cad_step_overlay_release_credit"
        ]
    component_manifest["local_discrete_step_binding"] = {
        "source": chip_rel(path / "release-manifest.yaml"),
        "binding_basis": (
            "Per-reference local STEP envelope files generated from the same "
            "development model records as the combined routed-board STEP candidate. "
            "These files are local review geometry and do not replace supplier STEP "
            "or B-rep models."
        ),
        "model_count": len(models),
        "model_record_count": len(model_records),
        "local_discrete_step_file_count": sum(
            1 for item in model_records if item.get("local_discrete_step_file")
        ),
        "local_discrete_step_imported_solid_count": sum(
            1
            for item in model_records
            if item.get("local_discrete_step_import_status") == "pass"
            and item.get("local_discrete_step_solid_type") == "Solid"
        ),
        "local_discrete_step_bbox_match_count": sum(
            1
            for item in model_records
            if item.get("local_discrete_step_bbox_matches_envelope") is True
        ),
        "local_step_bound_model_record_count": sum(
            1 for item in model_records if item.get("local_step_bound") is True
        ),
        "local_discrete_step_bytes_total": sum(
            int(item.get("local_discrete_step_bytes", 0) or 0) for item in model_records
        ),
        "public_cad_step_overlay_count": sum(
            1
            for item in model_records
            if item.get("public_cad_step_overlay_status")
            == "downloaded_hashed_public_manufacturer_step_overlay_not_release"
        ),
        "public_cad_step_overlay_release_candidate_count": sum(
            1 for item in model_records if item.get("public_cad_step_overlay_release_credit")
        ),
        "all_models_have_local_discrete_step_file": len(model_records) == len(models)
        and all(
            bool(item.get("local_discrete_step_file"))
            and (ROOT / str(item.get("local_discrete_step_file"))).is_file()
            for item in model_records
        ),
        "all_model_records_have_local_step_binding": len(model_records) == len(models)
        and all(item.get("local_step_bound") is True for item in model_records),
        "all_local_discrete_step_hashes_match_files": all(
            item.get("local_discrete_step_sha256")
            == sha256(ROOT / str(item.get("local_discrete_step_file")))
            for item in model_records
            if item.get("local_discrete_step_file")
        ),
        "all_local_discrete_step_sizes_match_files": all(
            int(item.get("local_discrete_step_bytes", 0) or 0)
            == (ROOT / str(item.get("local_discrete_step_file"))).stat().st_size
            for item in model_records
            if item.get("local_discrete_step_file")
        ),
        "all_local_discrete_steps_import_as_solids": all(
            item.get("local_discrete_step_import_status") == "pass"
            and item.get("local_discrete_step_solid_type") == "Solid"
            for item in model_records
        ),
        "all_local_discrete_step_bboxes_match_envelopes": all(
            item.get("local_discrete_step_bbox_matches_envelope") is True for item in model_records
        ),
        "release_credit": False,
    }
    component_manifest["models"] = models
    write_yaml(component_manifest_path, component_manifest)

    manifest = blocked_metadata(
        "component_model_directory_candidate",
        "supplier_component_model_directory",
        component_manifest_path if component_manifest_path.is_file() else SOURCE_BOARD,
    )
    manifest.update(
        {
            "schema": "eliza.e1_phone_local_component_model_directory.v1",
            "status": "blocked_local_component_model_directory_not_supplier_steps",
            "component_model_manifest": chip_rel(component_manifest_path),
            "source_routed_step": source_routed_step_rel,
            "source_routed_step_sha256": source_routed_step_sha256,
            "source_routed_step_bytes": source_routed_step_bytes,
            "model_record_count": len(model_records),
            "component_model_count": int(component_manifest.get("component_model_count", 0) or 0),
            "supplier_approved_model_count": 0,
            "pinout_bound_model_record_count": sum(
                1 for model in models if isinstance(model, dict) and model.get("pinout_file")
            ),
            "support_pattern_model_record_count": sum(
                1
                for model in models
                if isinstance(model, dict)
                and model.get("support_pattern_has_explicit_provenance") is True
            ),
            "pattern_bound_model_record_count": sum(
                1
                for model in models
                if isinstance(model, dict) and model.get("pattern_bound") is True
            ),
            "all_model_records_have_pattern_binding": all(
                model.get("pattern_bound") is True for model in models if isinstance(model, dict)
            ),
            "terminal_contract_model_record_count": sum(
                1
                for model in models
                if isinstance(model, dict) and int(model.get("terminal_contract_count", 0) or 0) > 0
            ),
            "terminal_contract_bound_model_record_count": sum(
                1
                for model in models
                if isinstance(model, dict) and model.get("terminal_contract_bound") is True
            ),
            "all_model_records_have_terminal_contract_binding": all(
                model.get("terminal_contract_bound") is True
                for model in models
                if isinstance(model, dict)
            ),
            "terminal_contract_total_count": sum(
                int(model.get("terminal_contract_count", 0) or 0)
                for model in models
                if isinstance(model, dict)
            ),
            "total_pad_contract_visual_count": sum(
                int(model.get("pad_contract_covered_count", 0) or 0)
                for model in models
                if isinstance(model, dict)
            ),
            "uncovered_pad_visual_count": sum(
                len(model.get("uncovered_pad_visuals", []))
                for model in models
                if isinstance(model, dict)
            ),
            "all_model_pad_visuals_have_contract": all(
                model.get("all_pad_visuals_have_contract") is True
                for model in models
                if isinstance(model, dict)
            ),
            "non_signal_pad_contract_total_count": sum(
                len(model.get("non_signal_pad_contract", []))
                for model in models
                if isinstance(model, dict)
            ),
            "npth_mechanical_feature_contract_total_count": sum(
                len(model.get("npth_mechanical_feature_contract", []))
                for model in models
                if isinstance(model, dict)
            ),
            "models_with_npth_mechanical_feature_contract_count": sum(
                1
                for model in models
                if isinstance(model, dict) and model.get("npth_mechanical_feature_contract")
            ),
            "all_pinout_bound_records_have_terminal_contract": all(
                int(model.get("terminal_contract_count", 0) or 0) > 0
                for model in models
                if isinstance(model, dict) and model.get("pinout_file")
            ),
            "all_support_pattern_records_have_explicit_provenance": all(
                bool(model.get("land_pattern_basis"))
                and bool(model.get("local_terminal_contract_source"))
                for model in models
                if isinstance(model, dict)
                and model.get("support_pattern_has_explicit_provenance") is True
            ),
            "all_terminal_contracts_match_pad_visuals": all(
                model.get("terminal_contract_matches_pad_visuals") is True
                for model in models
                if isinstance(model, dict) and int(model.get("terminal_contract_count", 0) or 0) > 0
            ),
            "all_non_signal_pad_contracts_match_pad_visuals": all(
                model.get("non_signal_pad_contract_matches_pad_visuals") is True
                for model in models
                if isinstance(model, dict) and model.get("non_signal_pad_contract")
            ),
            "all_npth_mechanical_features_have_contract": all(
                int(model.get("npth_mechanical_feature_count", 0) or 0)
                == len(model.get("npth_mechanical_feature_contract", []))
                and model.get("npth_mechanical_feature_contract_matches_footprint") is True
                for model in models
                if isinstance(model, dict)
                and int(model.get("npth_mechanical_feature_count", 0) or 0) > 0
            ),
            "all_model_records_present": len(model_records)
            == int(component_manifest.get("component_model_count", 0) or 0),
            "all_model_records_source_routed_step_bound": all(
                item.get("source_routed_step") == source_routed_step_rel
                and item.get("source_routed_step_sha256") == source_routed_step_sha256
                and int(item.get("source_routed_step_bytes", 0) or 0) == source_routed_step_bytes
                for item in model_records
            ),
            "all_model_records_have_combined_step_locator": all(
                bool(item.get("combined_step_assembly_name")) for item in model_records
            ),
            "all_model_records_have_local_discrete_step_file": all(
                bool(item.get("local_discrete_step_file"))
                and (ROOT / str(item.get("local_discrete_step_file"))).is_file()
                and item.get("local_discrete_step_sha256")
                == sha256(ROOT / str(item.get("local_discrete_step_file")))
                and int(item.get("local_discrete_step_bytes", 0) or 0)
                == (ROOT / str(item.get("local_discrete_step_file"))).stat().st_size
                for item in model_records
            ),
            "local_step_bound_model_record_count": sum(
                1 for item in model_records if item.get("local_step_bound") is True
            ),
            "all_model_records_have_local_step_binding": all(
                item.get("local_step_bound") is True for item in model_records
            ),
            "all_local_discrete_step_files_import_as_solids": all(
                item.get("local_discrete_step_import_status") == "pass"
                and item.get("local_discrete_step_solid_type") == "Solid"
                for item in model_records
            ),
            "all_local_discrete_step_bboxes_match_envelopes": all(
                item.get("local_discrete_step_bbox_matches_envelope") is True
                for item in model_records
            ),
            "all_model_records_have_expected_supplier_step_file": all(
                bool(item.get("expected_supplier_step_file")) for item in model_records
            ),
            "all_record_local_step_hashes_match_files": all(
                bool(item.get("local_discrete_step_file"))
                and item.get("local_discrete_step_sha256")
                == sha256(ROOT / str(item.get("local_discrete_step_file")))
                for item in model_records
            ),
            "all_record_local_step_sizes_match_files": all(
                bool(item.get("local_discrete_step_file"))
                and int(item.get("local_discrete_step_bytes", 0) or 0)
                == (ROOT / str(item.get("local_discrete_step_file"))).stat().st_size
                for item in model_records
            ),
            "all_record_metadata_hashes_match_files": all(
                bool(item.get("metadata"))
                and item.get("metadata_sha256") == sha256(path / str(item.get("metadata")))
                for item in model_records
            ),
            "local_discrete_step_imported_solid_count": sum(
                1
                for item in model_records
                if item.get("local_discrete_step_import_status") == "pass"
                and item.get("local_discrete_step_solid_type") == "Solid"
            ),
            "local_discrete_step_bbox_match_count": sum(
                1
                for item in model_records
                if item.get("local_discrete_step_bbox_matches_envelope") is True
            ),
            "local_discrete_step_file_count": sum(
                1 for item in model_records if item.get("local_discrete_step_file")
            ),
            "local_discrete_step_bytes_total": sum(
                int(item.get("local_discrete_step_bytes", 0) or 0) for item in model_records
            ),
            "missing_supplier_discrete_model_count": sum(
                1
                for item in model_records
                if item.get("expected_supplier_brep_or_step_status")
                == "missing_supplier_approved_discrete_component_model"
            ),
            "supplier_step_intake_placeholder_count": sum(
                1
                for item in model_records
                if item.get("supplier_step_intake_status")
                == "present_fail_closed_supplier_step_placeholder"
            ),
            "supplier_step_intake_missing_count": sum(
                1
                for item in model_records
                if item.get("supplier_step_intake_status") == "missing_supplier_step_intake"
            ),
            "supplier_step_intake_not_applicable_count": sum(
                1
                for item in model_records
                if item.get("supplier_step_intake_status")
                == "not_applicable_board_level_support_pattern"
            ),
            "supplier_step_intake_local_surrogate_count": sum(
                1
                for item in model_records
                if item.get("supplier_step_intake_status")
                == "present_local_surrogate_step_not_supplier_approved"
            ),
            "supplier_lane_surrogate_step_count": len(supplier_lane_surrogate_steps),
            "supplier_lane_surrogate_steps": supplier_lane_surrogate_steps,
            "supplier_step_intake_release_candidate_count": sum(
                1 for item in model_records if item.get("supplier_step_intake_release_credit")
            ),
            "public_cad_step_overlay_count": sum(
                1
                for item in model_records
                if item.get("public_cad_step_overlay_status")
                == "downloaded_hashed_public_manufacturer_step_overlay_not_release"
            ),
            "public_cad_step_overlay_release_candidate_count": sum(
                1 for item in model_records if item.get("public_cad_step_overlay_release_credit")
            ),
            "supplier_step_intake_lane_counts": dict(
                sorted(
                    {
                        lane: sum(
                            1
                            for item in model_records
                            if item.get("supplier_sourcing_lane") == lane
                        )
                        for lane in {
                            str(item.get("supplier_sourcing_lane", "")) for item in model_records
                        }
                    }.items()
                )
            ),
            "all_records_release_credit_false": True,
            "model_records": model_records,
            "release_allowed": False,
            "claim_boundary": (
                "Local per-reference component model metadata directory for routed-output "
                "candidate review only. The combined routed STEP contains development "
                "envelopes; discrete supplier-approved component STEP/B-rep files are "
                "still required for release."
            ),
        }
    )
    write_yaml(path / "release-manifest.yaml", manifest)
    return {
        "path": chip_rel(path),
        "kind": "directory",
        "metadata": chip_rel(path / "release-manifest.yaml"),
    }


def write_component_3d_binding_gap_matrix(component_model_dir: Path) -> list[dict[str, Any]]:
    manifest_path = component_model_dir / "release-manifest.yaml"
    manifest = load_yaml_if_present(manifest_path)
    model_records = manifest.get("model_records", [])
    if not isinstance(model_records, list):
        model_records = []

    rows: list[dict[str, Any]] = []
    for item in model_records:
        if not isinstance(item, dict):
            continue
        supplier_step = str(item.get("supplier_step_intake_file") or "")
        local_step = str(item.get("local_discrete_step_file") or "")
        rows.append(
            {
                "reference": str(item.get("reference") or ""),
                "footprint": str(item.get("footprint") or ""),
                "supplier_sourcing_lane": str(item.get("supplier_sourcing_lane") or ""),
                "pinout_bound": str(bool(item.get("pinout_bound"))).lower(),
                "support_pattern_has_explicit_provenance": str(
                    bool(item.get("support_pattern_has_explicit_provenance"))
                ).lower(),
                "terminal_contract_count": str(int(item.get("terminal_contract_count", 0) or 0)),
                "combined_step_assembly_name": str(item.get("combined_step_assembly_name") or ""),
                "local_discrete_step_file": local_step,
                "local_discrete_step_sha256": str(item.get("local_discrete_step_sha256") or ""),
                "local_discrete_step_bytes": str(
                    int(item.get("local_discrete_step_bytes", 0) or 0)
                ),
                "local_discrete_step_import_status": str(
                    item.get("local_discrete_step_import_status") or ""
                ),
                "local_discrete_step_imported_as_solid": str(
                    item.get("local_discrete_step_imported_as_solid") is True
                ).lower(),
                "local_discrete_step_bbox_matches_envelope": str(
                    item.get("local_discrete_step_bbox_matches_envelope") is True
                ).lower(),
                "expected_supplier_step_file": str(item.get("expected_supplier_step_file") or ""),
                "expected_supplier_brep_or_step_status": str(
                    item.get("expected_supplier_brep_or_step_status") or ""
                ),
                "supplier_step_intake_file": supplier_step,
                "supplier_step_intake_status": str(item.get("supplier_step_intake_status") or ""),
                "supplier_step_intake_sha256": str(item.get("supplier_step_intake_sha256") or ""),
                "supplier_step_intake_bytes": str(
                    int(item.get("supplier_step_intake_bytes", 0) or 0)
                ),
                "public_cad_step_overlay_file": str(item.get("public_cad_step_overlay_file") or ""),
                "public_cad_step_overlay_status": str(
                    item.get("public_cad_step_overlay_status") or ""
                ),
                "public_cad_step_overlay_sha256": str(
                    item.get("public_cad_step_overlay_sha256") or ""
                ),
                "public_cad_step_overlay_bytes": str(
                    int(item.get("public_cad_step_overlay_bytes", 0) or 0)
                ),
                "public_cad_source_record": str(item.get("public_cad_source_record") or ""),
                "supplier_step_intake_release_credit": str(
                    item.get("supplier_step_intake_release_credit") is True
                ).lower(),
                "supplier_approved": str(item.get("supplier_approved") is True).lower(),
                "release_credit": str(item.get("release_credit") is True).lower(),
                "release_allowed": "false",
                "next_release_action": (
                    "replace fail-closed supplier intake placeholder with signed supplier STEP/B-rep"
                    if supplier_step
                    else "bind board-level support pattern to approved assembly/fab drawing where applicable"
                ),
            }
        )

    COMPONENT_3D_BINDING_MATRIX.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = (
        list(rows[0])
        if rows
        else [
            "reference",
            "footprint",
            "supplier_sourcing_lane",
        ]
    )
    with COMPONENT_3D_BINDING_MATRIX.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    lane_counts: dict[str, int] = {}
    status_counts: dict[str, int] = {}
    for row in rows:
        lane = row["supplier_sourcing_lane"]
        status = row["supplier_step_intake_status"]
        lane_counts[lane] = lane_counts.get(lane, 0) + 1
        status_counts[status] = status_counts.get(status, 0) + 1

    payload = blocked_metadata(
        "component_3d_binding_gap_matrix_candidate",
        "supplier_component_3d_model_binding_matrix",
        COMPONENT_3D_BINDING_MATRIX,
    )
    payload.update(
        {
            "schema": "eliza.e1_phone_component_3d_binding_gap_matrix.v1",
            "status": "blocked_local_component_binding_gap_matrix_not_supplier_approval",
            "component_model_directory_manifest": chip_rel(manifest_path),
            "component_model_directory_manifest_sha256": (
                sha256(manifest_path) if manifest_path.is_file() else ""
            ),
            "csv_matrix": chip_rel(COMPONENT_3D_BINDING_MATRIX),
            "csv_matrix_sha256": sha256(COMPONENT_3D_BINDING_MATRIX),
            "csv_matrix_bytes": COMPONENT_3D_BINDING_MATRIX.stat().st_size,
            "row_count": len(rows),
            "supplier_lane_counts": dict(sorted(lane_counts.items())),
            "supplier_step_intake_status_counts": dict(sorted(status_counts.items())),
            "local_discrete_step_file_count": sum(
                1 for row in rows if row["local_discrete_step_file"]
            ),
            "local_discrete_step_import_pass_count": sum(
                1 for row in rows if row["local_discrete_step_import_status"] == "pass"
            ),
            "local_discrete_step_imported_solid_count": sum(
                1 for row in rows if row["local_discrete_step_imported_as_solid"] == "true"
            ),
            "local_discrete_step_bbox_match_count": sum(
                1 for row in rows if row["local_discrete_step_bbox_matches_envelope"] == "true"
            ),
            "supplier_step_intake_placeholder_count": status_counts.get(
                "present_fail_closed_supplier_step_placeholder", 0
            ),
            "supplier_step_intake_local_surrogate_count": status_counts.get(
                "present_local_surrogate_step_not_supplier_approved", 0
            ),
            "supplier_step_intake_not_applicable_count": status_counts.get(
                "not_applicable_board_level_support_pattern", 0
            ),
            "supplier_step_intake_release_candidate_count": sum(
                1 for row in rows if row["supplier_step_intake_release_credit"] == "true"
            ),
            "public_cad_step_overlay_count": sum(
                1
                for row in rows
                if row["public_cad_step_overlay_status"]
                == "downloaded_hashed_public_manufacturer_step_overlay_not_release"
            ),
            "all_rows_release_credit_false": all(row["release_credit"] == "false" for row in rows),
            "all_rows_release_allowed_false": all(
                row["release_allowed"] == "false" for row in rows
            ),
            "release_allowed": False,
            "release_credit": False,
            "claim_boundary": (
                "Per-reference component 3D binding gap matrix for local routed-output "
                "review. It maps every component model record to local STEP evidence "
                "and supplier intake status, but it is not supplier approval."
            ),
            "rows": rows,
        }
    )
    write_yaml(COMPONENT_3D_BINDING_REPORT, payload)
    return [
        {
            "path": chip_rel(COMPONENT_3D_BINDING_REPORT),
            "kind": "yaml",
            "metadata": "",
        },
        {
            "path": chip_rel(COMPONENT_3D_BINDING_MATRIX),
            "kind": "csv",
            "metadata": chip_rel(COMPONENT_3D_BINDING_REPORT),
        },
    ]


def write_csv_report(path: Path, rows: list[dict[str, str]]) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["net", "measured_value", "limit", "result"])
        writer.writeheader()
        writer.writerows(rows)
    return {"path": chip_rel(path), "kind": "csv", "metadata": ""}


def write_factory_limits_candidate(path: Path) -> dict[str, Any]:
    payload = blocked_metadata("factory_test_limits_candidate", "factory_test_limits", SOURCE_BOARD)
    payload.update(
        {
            "schema": "eliza.e1_phone_factory_test_limits_candidate.v1",
            "status": "blocked_local_limits_template_not_factory_approved",
            "limits_release_allowed": False,
            "fixture_revision": "not_run",
            "limits": [
                {
                    "domain": "routed_board_candidate",
                    "measurement": "all_limits",
                    "limit": "not_approved",
                    "result": "blocked",
                }
            ],
        }
    )
    write_yaml(path, payload)
    return {"path": chip_rel(path), "kind": "yaml", "metadata": ""}


def write_text_pdf(path: Path, title: str) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        (
            "%PDF-1.4\n"
            "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
            "2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n"
            "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] >> endobj\n"
            f"% {title}: blocked local candidate, not release evidence\n"
            "%%EOF\n"
        ).encode()
    )
    write_yaml(
        path.with_suffix(path.suffix + ".metadata.yaml"), blocked_metadata(title, title, path)
    )
    return {
        "path": chip_rel(path),
        "kind": "pdf",
        "metadata": chip_rel(path.with_suffix(path.suffix + ".metadata.yaml")),
    }


def generate() -> dict[str, Any]:
    if not SOURCE_BOARD.is_file():
        raise SystemExit(f"missing source board: {SOURCE_BOARD}")
    artifacts: list[dict[str, Any]] = []

    routed_board = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
    routed_board.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE_BOARD, routed_board)
    routed_board_metadata = blocked_metadata(
        "routed_kicad_pcb_candidate", "routed_kicad_pcb", routed_board
    )
    routed_board_metadata["routed_candidate_source_binding"] = routed_candidate_source_binding(
        routed_board
    )
    write_yaml(
        routed_board.with_suffix(routed_board.suffix + ".metadata.yaml"),
        routed_board_metadata,
    )
    artifacts.append(
        {
            "path": chip_rel(routed_board),
            "kind": "kicad_pcb",
            "metadata": chip_rel(routed_board.with_suffix(routed_board.suffix + ".metadata.yaml")),
        }
    )

    if SOURCE_STEP.is_file():
        step = ROOT / "board/kicad/e1-phone/production/step/routed-board-with-components.step"
        step.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE_STEP, step)
        write_yaml(
            step.with_suffix(step.suffix + ".metadata.yaml"),
            blocked_metadata("routed_step_candidate", "routed_step_with_supplier_models", step),
        )
        artifacts.append(
            {
                "path": chip_rel(step),
                "kind": "step",
                "metadata": chip_rel(step.with_suffix(step.suffix + ".metadata.yaml")),
            }
        )
        artifacts.append(
            write_dir_manifest(
                step.parent, "routed_step_directory_candidate", "board_step_with_supplier_models"
            )
        )
        artifacts.append(
            write_component_model_manifest(
                ROOT / "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml"
            )
        )
        artifacts.append(
            write_component_model_directory(
                COMPONENT_MODEL_DIR,
                ROOT / "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml",
            )
        )
        artifacts.extend(write_component_3d_binding_gap_matrix(COMPONENT_MODEL_DIR))

    for path_text, title in [
        (
            "board/kicad/e1-phone/production/pdf/assembly.pdf",
            "assembly_drawing_candidate",
        ),
        (
            "board/kicad/e1-phone/production/pdf/split-interconnect-assembly.pdf",
            "split_interconnect_assembly_drawing_candidate",
        ),
    ]:
        artifacts.append(write_text_pdf(ROOT / path_text, title))

    for directory, artifact_id in [
        ("board/kicad/e1-phone/production/fab-quote", "fab_quote_directory_candidate"),
        ("board/kicad/e1-phone/production/first-article", "first_article_directory_candidate"),
        ("board/kicad/e1-phone/production/reports/si-pi", "si_pi_candidate"),
        ("board/kicad/e1-phone/production/reports/rf", "rf_candidate"),
        (
            "board/kicad/e1-phone/production/reports/power-thermal",
            "power_thermal_directory_candidate",
        ),
    ]:
        artifacts.append(write_dir_manifest(ROOT / directory, artifact_id, artifact_id))

    for path_text, artifact_id in [
        ("board/kicad/e1-phone/production/reports/zone-fill.json", "zone_fill_report_candidate"),
        (
            "board/kicad/e1-phone/production/reports/audio-haptic-functional-log.json",
            "audio_haptic_functional_log_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/camera-capture-log.json",
            "camera_capture_log_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/charger-cc-cv-cycle.json",
            "charger_cc_cv_cycle_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/display-touch-bringup-log.json",
            "display_touch_bringup_log_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/memory-training-log.json",
            "memory_training_log_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/rf/conducted-cellular-wifi-bt.json",
            "rf_conducted_cellular_wifi_bt_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/rf/cellular-conducted.json",
            "rf_cellular_conducted_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/rf/wifi-bt-conducted.json",
            "rf_wifi_bt_conducted_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/side-key-force-travel-wake-log.json",
            "side_key_force_travel_wake_log_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/ufs-link-training-log.json",
            "ufs_link_training_log_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/usb-c-pd-attach-log.json",
            "usb_c_pd_attach_log_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/rf/coexistence-matrix.json",
            "rf_coexistence_candidate",
        ),
        ("board/kicad/e1-phone/production/reports/rf/vna-s11-s21.json", "rf_vna_candidate"),
        ("board/kicad/e1-phone/production/reports/si-pi/usb2-channel.json", "usb2_si_candidate"),
        (
            "board/kicad/e1-phone/production/reports/si-pi/display-touch-mipi-dsi.json",
            "display_si_candidate",
        ),
        ("board/kicad/e1-phone/production/reports/si-pi/camera-csi.json", "camera_si_candidate"),
        (
            "board/kicad/e1-phone/production/reports/si-pi/pcie-cellular-wifi.json",
            "pcie_cellular_wifi_si_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/si-pi/memory-storage-length-skew.json",
            "memory_si_candidate",
        ),
        ("board/kicad/e1-phone/production/reports/si-pi/pdn-return-path.json", "pdn_candidate"),
        (
            "board/kicad/e1-phone/production/reports/si-pi/split-interconnect-usb-audio.json",
            "split_si_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/power-thermal/load-step.json",
            "power_thermal_load_step_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/power-thermal/rail-efficiency-and-soak.json",
            "power_thermal_rail_efficiency_soak_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/rf/sar-prescan-plan.json",
            "rf_sar_prescan_plan_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/escape-density-via-count.yaml",
            "escape_density_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/routed-courtyard-utilization.yaml",
            "courtyard_candidate",
        ),
    ]:
        path = ROOT / path_text
        if path_text == "board/kicad/e1-phone/production/reports/zone-fill.json":
            artifacts.append(write_zone_fill_report(path))
        elif path.suffix == ".json":
            artifacts.append(write_json_report(path, artifact_id, artifact_id))
        else:
            artifacts.append(write_yaml_report(path, artifact_id, artifact_id))

    artifacts.append(
        write_text_pdf(
            ROOT / "board/kicad/e1-phone/production/stackup/impedance-coupon-drawing.pdf",
            "impedance_coupon_drawing_candidate",
        )
    )
    artifacts.append(
        write_factory_limits_candidate(
            ROOT / "board/kicad/e1-phone/production/test/factory-test-limits.yaml"
        )
    )

    for path_text in [
        "board/kicad/e1-phone/production/reports/length-skew.csv",
        "board/kicad/e1-phone/production/reports/usb2-length-skew.csv",
    ]:
        artifacts.append(
            write_csv_report(
                ROOT / path_text,
                [
                    {
                        "net": "candidate",
                        "measured_value": "not_run",
                        "limit": "not_approved",
                        "result": "blocked",
                    }
                ],
            )
        )

    artifacts.append(
        write_csv_report(
            ROOT / "board/kicad/e1-phone/production/test/probe-coordinates.csv",
            [
                {
                    "net": "candidate",
                    "measured_value": "not_measured",
                    "limit": "not_approved",
                    "result": "blocked",
                }
            ],
        )
    )

    directory_manifest_paths = [
        ROOT / "board/kicad/e1-phone/production/fab-quote",
        ROOT / "board/kicad/e1-phone/production/first-article",
        ROOT / "board/kicad/e1-phone/production/reports/si-pi",
        ROOT / "board/kicad/e1-phone/production/reports/rf",
        ROOT / "board/kicad/e1-phone/production/reports/power-thermal",
    ]
    artifact_paths = {
        str(value)
        for artifact in artifacts
        if isinstance(artifact, dict)
        for value in (artifact.get("path"), artifact.get("metadata"))
        if value
    }
    for dir_path in directory_manifest_paths:
        refresh_dir_manifest(dir_path, artifact_paths)

    manifest = {
        "schema": "eliza.e1_phone_routed_output_candidate_manifest.v1",
        "date": DATE,
        "status": "blocked_local_candidate_outputs_not_release",
        "claim_boundary": (
            "Generated local routed-output candidate files. These reduce missing-file "
            "inventory only and do not prove routed release, fabrication, enclosure, "
            "factory, or end-to-end readiness."
        ),
        "source_board": chip_rel(SOURCE_BOARD),
        "source_step": chip_rel(SOURCE_STEP) if SOURCE_STEP.exists() else "",
        "source_step_size_bytes": SOURCE_STEP.stat().st_size if SOURCE_STEP.exists() else 0,
        "source_step_sha256": sha256(SOURCE_STEP) if SOURCE_STEP.exists() else "",
        "source_board_sha256": sha256(SOURCE_BOARD),
        "routed_candidate_source_binding": routed_candidate_source_binding(routed_board),
        "routed_step_visual_detail": routed_visual_detail(),
        "cad_connection_coverage": cad_connection_summary(),
        "kicad_cad_traceability": kicad_cad_traceability_summary(),
        "artifact_count": len(artifacts),
        "release_credit": False,
        "artifacts": artifacts,
        "intentionally_not_generated": [
            "conducted RF measurement logs",
            "approved charger cycle, load-step, rail-efficiency, and thermal soak measurement logs",
            "display, camera, memory-training, UFS-link, audio-haptic, USB attach, and side-key first-article logs",
            "fabricator stackup, coupon drawings, impedance tables, and commercial quote outputs",
            "DFM, DFA, stencil, AOI, X-ray, and cleaning supplier return reports",
            "factory limits, fixture programs, RF calibration procedures, and signed first-article travelers",
        ],
    }
    write_yaml(OUT_MANIFEST, manifest)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    manifest = generate()
    print(
        "STATUS: BLOCKED E1 phone routed-output candidates "
        f"generated={manifest['artifact_count']} release_credit=false"
    )
    print(chip_rel(OUT_MANIFEST))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
