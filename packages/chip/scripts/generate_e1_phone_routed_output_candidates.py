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
import hashlib
import json
import shutil
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


def routed_visual_detail() -> dict[str, Any]:
    step_intake = load_yaml_if_present(STEP_INTAKE)
    routed_intake = load_yaml_if_present(ROUTED_INTAKE)
    return {
        "source_step_intake": chip_rel(STEP_INTAKE) if STEP_INTAKE.is_file() else "",
        "routed_development_intake": chip_rel(ROUTED_INTAKE) if ROUTED_INTAKE.is_file() else "",
        "source_board_sha256": step_intake.get("board_sha256", ""),
        "source_step_sha256": step_intake.get("step_sha256", ""),
        "routed_intake_step_sha256": routed_intake.get("development_step_sha256", ""),
        "footprint_envelope_count": int(step_intake.get("footprint_envelope_count", 0) or 0),
        "pad_contact_visual_count": int(step_intake.get("pad_contact_visual_count", 0) or 0),
        "route_segment_visual_count": int(step_intake.get("route_segment_visual_count", 0) or 0),
        "board_segment_count": int(step_intake.get("segment_count", 0) or 0),
        "board_via_count": int(step_intake.get("via_count", 0) or 0),
        "development_footprint_refs": int(step_intake.get("development_footprint_refs", 0) or 0),
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
        "visual_route_span_total_mm": float(coverage.get("visual_route_span_total_mm", 0) or 0),
        "endpoint_pair_distance_total_mm": float(
            coverage.get("endpoint_pair_distance_total_mm", 0) or 0
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


def write_dir_manifest(path: Path, artifact_id: str, source_requirement_id: str) -> dict[str, Any]:
    path.mkdir(parents=True, exist_ok=True)
    child = path / "candidate-placeholder.txt"
    child.write_text(
        "blocked routed-output candidate directory; release children and approvals are missing\n",
        encoding="utf-8",
    )
    manifest = blocked_metadata(artifact_id, source_requirement_id, child)
    manifest["artifact_id"] = artifact_id
    manifest["candidate_children"] = [child.name]
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

    for footprint in footprints:
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
        terminal_contract_matches_pad_visuals = all(pin in pad_names for pin in terminal_contract)
        models.append(
            {
                "reference": footprint.get("reference", ""),
                "footprint": footprint.get("footprint", ""),
                "layer": footprint.get("layer", ""),
                "at_mm": footprint.get("at_mm", {}),
                "model_source": "local_development_envelope",
                "model_binding_status": "blocked_pending_supplier_step_or_verified_package_drawing",
                "source_step_intake": chip_rel(intake_path) if intake_path.is_file() else "",
                "source_assembly_item": footprint.get("reference", ""),
                "supplier_approved": False,
                "envelope_mm": footprint.get("envelope_mm", {}),
                "pad_count": footprint.get("pad_count", 0),
                "electrical_pad_count": int(pad_record.get("electrical_pad_count", 0) or 0),
                "mechanical_pad_count": int(pad_record.get("mechanical_pad_count", 0) or 0),
                "mechanical_pads": [
                    str(pin) for pin in pad_record.get("mechanical_pads", []) if pin is not None
                ],
                "npth_mechanical_feature_count": int(
                    pad_record.get("npth_mechanical_feature_count", 0) or 0
                ),
                "npth_mechanical_features": [
                    dict(item)
                    for item in pad_record.get("npth_mechanical_features", [])
                    if isinstance(item, dict)
                ],
                "npth_mechanical_feature_contract": [
                    dict(item)
                    for item in pad_record.get("npth_mechanical_feature_contract", [])
                    if isinstance(item, dict)
                ],
                "npth_mechanical_feature_contract_source": pad_record.get(
                    "npth_mechanical_feature_contract_source", ""
                ),
                "npth_mechanical_feature_contract_matches_footprint": bool(
                    pad_record.get("npth_mechanical_feature_contract_matches_footprint", True)
                ),
                "non_signal_pad_contract": [
                    str(pin)
                    for pin in pad_record.get("non_signal_pad_contract", [])
                    if pin is not None
                ],
                "non_signal_pad_contract_source": pad_record.get(
                    "non_signal_pad_contract_source", ""
                ),
                "non_signal_pad_contract_matches_pad_visuals": bool(
                    pad_record.get("non_signal_pad_contract_matches_pad_visuals", True)
                ),
                "pad_visual_count": len(pads) if isinstance(pads, list) else 0,
                "pad_names": pad_names,
                "pinout_file": pad_record.get("pinout_file", ""),
                "pinout_status": pad_record.get("pinout_status", ""),
                "coverage": pad_record.get("coverage", ""),
                "land_pattern_basis": pad_record.get("land_pattern_basis", ""),
                "visual_package_class": visual_package_class(pad_record, footprint),
                "local_terminal_contract": terminal_contract,
                "local_terminal_contract_source": pad_record.get(
                    "local_terminal_contract_source", ""
                ),
                "terminal_contract_count": len(terminal_contract),
                "terminal_contract_matches_pad_visuals": terminal_contract_matches_pad_visuals,
                "support_pattern_has_explicit_provenance": bool(
                    pad_record.get("support_pattern_has_explicit_provenance", False)
                ),
                "pad_audit_record_source": chip_rel(PAD_AUDIT) if PAD_AUDIT.is_file() else "",
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
                "models_with_terminal_contract_or_no_electrical_pads_count": len(
                    models_with_terminal_contract_or_no_pads
                ),
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


def write_component_model_directory(path: Path, component_manifest_path: Path) -> dict[str, Any]:
    component_manifest = load_yaml_if_present(component_manifest_path)
    models = component_manifest.get("models", [])
    if not isinstance(models, list):
        models = []
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)

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
        filename = f"{safe_model_filename(reference)}.local-model.json"
        record_path = path / filename
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
            "pinout_file": model.get("pinout_file", ""),
            "coverage": model.get("coverage", ""),
            "visual_package_class": model.get("visual_package_class", ""),
            "local_terminal_contract": model.get("local_terminal_contract", []),
            "local_terminal_contract_source": model.get("local_terminal_contract_source", ""),
            "terminal_contract_count": model.get("terminal_contract_count", 0),
            "terminal_contract_matches_pad_visuals": model.get(
                "terminal_contract_matches_pad_visuals", False
            ),
            "support_pattern_has_explicit_provenance": model.get(
                "support_pattern_has_explicit_provenance", False
            ),
            "land_pattern_basis": model.get("land_pattern_basis", ""),
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
                "pinout_bound": bool(model.get("pinout_file")),
                "support_pattern_has_explicit_provenance": bool(
                    model.get("support_pattern_has_explicit_provenance", False)
                ),
                "terminal_contract_count": int(model.get("terminal_contract_count", 0) or 0),
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
            "terminal_contract_model_record_count": sum(
                1
                for model in models
                if isinstance(model, dict) and int(model.get("terminal_contract_count", 0) or 0) > 0
            ),
            "terminal_contract_total_count": sum(
                int(model.get("terminal_contract_count", 0) or 0)
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
    write_yaml(
        routed_board.with_suffix(routed_board.suffix + ".metadata.yaml"),
        blocked_metadata("routed_kicad_pcb_candidate", "routed_kicad_pcb", routed_board),
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
        if path.suffix == ".json":
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
