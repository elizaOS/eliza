#!/usr/bin/env python3
"""Inventory E1 phone mechanical CAD evidence without promoting it to release.

The inventory is intentionally fail-closed: generated concept STEP/mesh assets
are counted as existing CAD output, while routed-board, supplier-returned CAD,
and physical fit/process evidence must be present in the review gates before
the enclosure can be treated as release-ready.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
CHIP_ROOT = REPO_ROOT / "packages/chip"
MECH_DIR = CHIP_ROOT / "mechanical/e1-phone"
OUT_DIR = MECH_DIR / "out"
REVIEW_DIR = MECH_DIR / "review"
DEFAULT_REPORT = REVIEW_DIR / "mechanical-cad-evidence-inventory-2026-05-22.yaml"
SUPPLIER_STEP_SURROGATE_INTAKE_DETAIL = REVIEW_DIR / "supplier-step-surrogate-intake-detail.json"
COMPONENT_MODEL_DIR_MANIFEST = (
    CHIP_ROOT / "board/kicad/e1-phone/production/step/component-models/release-manifest.yaml"
)
CANDIDATE_MANIFEST = (
    CHIP_ROOT / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
)
PUBLIC_CAD_SOURCE_INTAKE = (
    CHIP_ROOT / "board/kicad/e1-phone/public-cad-source-intake-2026-05-28.yaml"
)
PUBLIC_BOM_MARKET_COST_BANDS = REVIEW_DIR / "bom-public-market-cost-bands-2026-05-28.yaml"

REPORT_DATE = "2026-05-22"
SCRIPT_NAME = "e1_phone_mechanical_cad_evidence_inventory.py"

MANIFESTS = {
    "assembly": OUT_DIR / "assembly-manifest.json",
    "evt_fixtures": OUT_DIR / "evt-fixture-manifest.json",
    "tooling": OUT_DIR / "tooling-manifest.json",
}

REVIEW_GATES = {
    "routed_board_step_intake": REVIEW_DIR / "board-step-readiness.json",
    "routed_board_clearance": REVIEW_DIR / "routed-board-clearance.json",
    "supplier_evidence": REVIEW_DIR / "supplier-evidence-acceptance.json",
    "physical_process_validation": REVIEW_DIR / "physical-process-validation-acceptance.json",
    "concept_fit_check": REVIEW_DIR / "fit-check-report.json",
    "solid_cad_handoff": REVIEW_DIR / "solid-cad-handoff.json",
    "cad_connection_coverage": REVIEW_DIR / "cad-connection-coverage.json",
    "step_validation": REVIEW_DIR / "step-validation.json",
}

BLOCKED_STATUSES = {
    "blocked",
    "blocked_concept_pcb_no_routed_step",
    "blocked_local_routed_step_candidate_not_release",
    "blocked_no_physical_process_validation_results",
    "blocked_no_supplier_evidence",
    "blocked_waiting_for_physical_routed_board_clearance_result",
    "blocked_waiting_for_routed_board_step",
}

REQUIRED_RELEASE_EVIDENCE = {
    "routed_board_step_intake": "physical routed-board release STEP with component height models",
    "routed_board_clearance": "measured enclosure clearance against routed board STEP",
    "supplier_evidence": "supplier-returned quote, 2D drawing, STEP, sample, and traceability artifacts",
    "physical_fit_evidence": "fabricated enclosure/board/display/battery/button/port fit-check results with reviewer identity",
    "physical_process_validation": "finished-phone lab, EVT, FAI, build, traceability, and process-control results",
}


def chip_rel(path: Path) -> str:
    return path.resolve().relative_to(CHIP_ROOT).as_posix()


def repo_rel(path: Path) -> str:
    return chip_rel(path)


def read_json(path: Path) -> Any | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def read_yaml(path: Path) -> Any | None:
    if not path.exists():
        return None
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compact_connection_record(record: dict[str, Any]) -> dict[str, Any]:
    """Keep wire/flex/coax CAD evidence reviewable without duplicating full route rows."""
    return {
        "id": record.get("id"),
        "connection_type": record.get("connection_type"),
        "physical_medium": record.get("physical_medium"),
        "electrical_class": record.get("electrical_class"),
        "cad_part": record.get("cad_part"),
        "from": record.get("from"),
        "to": record.get("to"),
        "represented_nets": record.get("represented_nets", []),
        "represented_route_ids": record.get("represented_route_ids", []),
        "represented_net_count": int(record.get("represented_net_count") or 0),
        "represented_route_count": int(record.get("represented_route_count") or 0),
        "represented_route_record_count": int(record.get("represented_route_record_count") or 0),
        "represented_route_records_with_layer_count": int(
            record.get("represented_route_records_with_layer_count") or 0
        ),
        "represented_route_records_with_source_domain_count": int(
            record.get("represented_route_records_with_source_domain_count") or 0
        ),
        "represented_route_records_with_route_class_count": int(
            record.get("represented_route_records_with_route_class_count") or 0
        ),
        "represented_route_classification_gap_count": int(
            record.get("represented_route_classification_gap_count") or 0
        ),
        "solid_step_part_names": record.get("solid_step_part_names", []),
        "solid_step_part_count": int(record.get("solid_step_part_count") or 0),
        "terminal_marker_count": int(record.get("terminal_marker_count") or 0),
        "cad_step_bytes": int(record.get("cad_step_bytes") or 0),
        "solid_step_part_bytes_total": int(record.get("solid_step_part_bytes_total") or 0),
        "cad_part_present": record.get("cad_part_present") is True,
        "terminal_markers_present": record.get("terminal_markers_present") is True,
        "solid_step_parts_present": record.get("solid_step_parts_present") is True,
        "all_represented_nets_have_route_trace": (
            record.get("all_represented_nets_have_route_trace") is True
        ),
        "all_represented_routes_have_layer_source_and_class": (
            record.get("all_represented_routes_have_layer_source_and_class") is True
        ),
        "release_credit": record.get("release_credit") is True,
    }


def compact_component_model_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "reference": record.get("reference"),
        "footprint": record.get("footprint"),
        "pinout_bound": record.get("pinout_bound") is True,
        "support_pattern_has_explicit_provenance": (
            record.get("support_pattern_has_explicit_provenance") is True
        ),
        "terminal_contract_count": int(record.get("terminal_contract_count") or 0),
        "terminal_contract_matches_pad_visuals": (
            record.get("terminal_contract_matches_pad_visuals") is True
        ),
        "pad_contract_covered_count": int(record.get("pad_contract_covered_count") or 0),
        "all_pad_visuals_have_contract": (record.get("all_pad_visuals_have_contract") is True),
        "non_signal_pad_contract_count": int(record.get("non_signal_pad_contract_count") or 0),
        "non_signal_pad_contract_matches_pad_visuals": (
            record.get("non_signal_pad_contract_matches_pad_visuals") is True
        ),
        "npth_mechanical_feature_contract_count": int(
            record.get("npth_mechanical_feature_contract_count") or 0
        ),
        "npth_mechanical_feature_contract_matches_footprint": (
            record.get("npth_mechanical_feature_contract_matches_footprint") is True
        ),
        "combined_step_assembly_name": record.get("combined_step_assembly_name"),
        "local_discrete_step_file": record.get("local_discrete_step_file"),
        "local_discrete_step_sha256": record.get("local_discrete_step_sha256"),
        "local_discrete_step_bytes": int(record.get("local_discrete_step_bytes") or 0),
        "local_discrete_step_imported_as_solid": (
            record.get("local_discrete_step_imported_as_solid") is True
        ),
        "local_discrete_step_bbox_matches_envelope": (
            record.get("local_discrete_step_bbox_matches_envelope") is True
        ),
        "expected_supplier_step_file": record.get("expected_supplier_step_file"),
        "supplier_sourcing_lane": record.get("supplier_sourcing_lane"),
        "supplier_step_intake_status": record.get("supplier_step_intake_status"),
        "supplier_step_intake_file": record.get("supplier_step_intake_file"),
        "supplier_step_intake_release_credit": (
            record.get("supplier_step_intake_release_credit") is True
        ),
        "public_cad_step_overlay_status": record.get("public_cad_step_overlay_status"),
        "public_cad_step_overlay_file": record.get("public_cad_step_overlay_file"),
        "public_cad_step_overlay_sha256": record.get("public_cad_step_overlay_sha256"),
        "public_cad_step_overlay_bytes": int(record.get("public_cad_step_overlay_bytes") or 0),
        "public_cad_source_record": record.get("public_cad_source_record"),
        "public_cad_step_overlay_release_credit": (
            record.get("public_cad_step_overlay_release_credit") is True
        ),
        "source_routed_step": record.get("source_routed_step"),
        "release_credit": record.get("release_credit") is True,
    }


def component_model_directory_summary() -> dict[str, Any]:
    data = read_yaml(COMPONENT_MODEL_DIR_MANIFEST)
    if not isinstance(data, dict):
        return {
            "manifest": repo_rel(COMPONENT_MODEL_DIR_MANIFEST),
            "present": COMPONENT_MODEL_DIR_MANIFEST.exists(),
            "status": "missing",
        }
    model_records = data.get("model_records", [])
    if not isinstance(model_records, list):
        model_records = []
    return {
        "manifest": repo_rel(COMPONENT_MODEL_DIR_MANIFEST),
        "present": True,
        "status": data.get("status"),
        "model_record_count": int(data.get("model_record_count") or 0),
        "component_model_count": int(data.get("component_model_count") or 0),
        "supplier_approved_model_count": int(data.get("supplier_approved_model_count") or 0),
        "pinout_bound_model_record_count": int(data.get("pinout_bound_model_record_count") or 0),
        "support_pattern_model_record_count": int(
            data.get("support_pattern_model_record_count") or 0
        ),
        "all_model_records_present": data.get("all_model_records_present") is True,
        "all_model_records_source_routed_step_bound": (
            data.get("all_model_records_source_routed_step_bound") is True
        ),
        "all_model_records_have_combined_step_locator": (
            data.get("all_model_records_have_combined_step_locator") is True
        ),
        "all_model_records_have_local_discrete_step_file": (
            data.get("all_model_records_have_local_discrete_step_file") is True
        ),
        "all_local_discrete_step_files_import_as_solids": (
            data.get("all_local_discrete_step_files_import_as_solids") is True
        ),
        "all_local_discrete_step_bboxes_match_envelopes": (
            data.get("all_local_discrete_step_bboxes_match_envelopes") is True
        ),
        "all_model_records_have_expected_supplier_step_file": (
            data.get("all_model_records_have_expected_supplier_step_file") is True
        ),
        "local_discrete_step_imported_solid_count": int(
            data.get("local_discrete_step_imported_solid_count") or 0
        ),
        "local_discrete_step_bbox_match_count": int(
            data.get("local_discrete_step_bbox_match_count") or 0
        ),
        "local_discrete_step_file_count": int(data.get("local_discrete_step_file_count") or 0),
        "local_discrete_step_bytes_total": int(data.get("local_discrete_step_bytes_total") or 0),
        "missing_supplier_discrete_model_count": int(
            data.get("missing_supplier_discrete_model_count") or 0
        ),
        "supplier_step_intake_placeholder_count": int(
            data.get("supplier_step_intake_placeholder_count") or 0
        ),
        "supplier_step_intake_local_surrogate_count": int(
            data.get("supplier_step_intake_local_surrogate_count") or 0
        ),
        "supplier_step_intake_missing_count": int(
            data.get("supplier_step_intake_missing_count") or 0
        ),
        "supplier_step_intake_not_applicable_count": int(
            data.get("supplier_step_intake_not_applicable_count") or 0
        ),
        "supplier_step_intake_release_candidate_count": int(
            data.get("supplier_step_intake_release_candidate_count") or 0
        ),
        "supplier_step_intake_lane_counts": data.get("supplier_step_intake_lane_counts", {}),
        "expected_supplier_step_file_count": sum(
            1
            for item in model_records
            if isinstance(item, dict) and item.get("expected_supplier_step_file")
        ),
        "combined_step_locator_count": sum(
            1
            for item in model_records
            if isinstance(item, dict) and item.get("combined_step_assembly_name")
        ),
        "component_model_record_manifest": [
            compact_component_model_record(item) for item in model_records if isinstance(item, dict)
        ],
        "release_allowed": data.get("release_allowed") is True,
        "release_credit": False,
    }


def supplier_step_surrogate_intake_detail(
    component_model_dir: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = read_yaml(COMPONENT_MODEL_DIR_MANIFEST)
    if not isinstance(data, dict):
        return {
            "schema": "eliza.e1_phone_supplier_step_surrogate_intake_detail.v1",
            "present": False,
            "source_manifest": repo_rel(COMPONENT_MODEL_DIR_MANIFEST),
            "status": "missing_component_model_manifest",
            "release_credit": False,
            "release_allowed": False,
        }

    model_records = data.get("model_records", [])
    if not isinstance(model_records, list):
        model_records = []
    lane_surrogates = data.get("supplier_lane_surrogate_steps", {})
    if not isinstance(lane_surrogates, dict):
        lane_surrogates = {}

    records_by_intake_file: dict[str, list[dict[str, Any]]] = {}
    for record in model_records:
        if not isinstance(record, dict):
            continue
        intake_file = str(record.get("supplier_step_intake_file") or "")
        records_by_intake_file.setdefault(intake_file, []).append(record)

    lane_records: list[dict[str, Any]] = []
    all_hashes_match = True
    all_sizes_match = True
    for lane, item in sorted(lane_surrogates.items()):
        if not isinstance(item, dict):
            item = {}
        file_text = str(item.get("file") or "")
        step_path = CHIP_ROOT / file_text
        if not step_path.is_file():
            actual_sha256 = None
            actual_bytes = 0
            file_present = False
        else:
            actual_sha256 = file_sha256(step_path)
            actual_bytes = step_path.stat().st_size
            file_present = True
        all_hashes_match = all_hashes_match and actual_sha256 == item.get("sha256")
        all_sizes_match = all_sizes_match and actual_bytes == int(item.get("bytes") or 0)

        lane_components = sorted(
            records_by_intake_file.get(file_text, []),
            key=lambda record: str(record.get("reference") or ""),
        )
        lane_records.append(
            {
                "lane": lane,
                "status": item.get("status"),
                "file": file_text,
                "file_present": file_present,
                "sha256": item.get("sha256"),
                "actual_sha256": actual_sha256,
                "bytes": int(item.get("bytes") or 0),
                "actual_bytes": actual_bytes,
                "hash_matches_file": actual_sha256 == item.get("sha256"),
                "size_matches_file": actual_bytes == int(item.get("bytes") or 0),
                "release_credit": item.get("release_credit") is True,
                "component_reference_count": len(lane_components),
                "manifest_model_reference_count": int(item.get("model_reference_count") or 0),
                "component_references": [
                    str(record.get("reference") or "") for record in lane_components
                ],
                "expected_supplier_step_files": sorted(
                    {
                        str(record.get("expected_supplier_step_file") or "")
                        for record in lane_components
                        if record.get("expected_supplier_step_file")
                    }
                ),
                "footprints": sorted(
                    {
                        str(record.get("footprint") or "")
                        for record in lane_components
                        if record.get("footprint")
                    }
                ),
                "supplier_step_intake_statuses": sorted(
                    {
                        str(record.get("supplier_step_intake_status") or "")
                        for record in lane_components
                        if record.get("supplier_step_intake_status")
                    }
                ),
                "all_component_records_release_credit_false": all(
                    record.get("release_credit") is False for record in lane_components
                ),
                "all_component_records_reference_this_surrogate": all(
                    record.get("supplier_step_intake_file") == file_text
                    for record in lane_components
                ),
            }
        )

    if component_model_dir is None:
        component_model_dir = component_model_directory_summary()

    return {
        "schema": "eliza.e1_phone_supplier_step_surrogate_intake_detail.v1",
        "present": True,
        "source_manifest": repo_rel(COMPONENT_MODEL_DIR_MANIFEST),
        "status": "blocked_local_surrogate_steps_not_supplier_approved",
        "claim_boundary": (
            "Lane STEP files are local surrogate geometry for CAD continuity only; "
            "they are not supplier-returned, approved, or release evidence."
        ),
        "supplier_lane_surrogate_step_count": len(lane_records),
        "supplier_step_intake_local_surrogate_count": int(
            data.get("supplier_step_intake_local_surrogate_count") or 0
        ),
        "supplier_step_intake_not_applicable_count": int(
            data.get("supplier_step_intake_not_applicable_count") or 0
        ),
        "supplier_step_intake_missing_count": int(
            data.get("supplier_step_intake_missing_count") or 0
        ),
        "supplier_step_intake_release_candidate_count": int(
            data.get("supplier_step_intake_release_candidate_count") or 0
        ),
        "supplier_step_intake_lane_counts": data.get("supplier_step_intake_lane_counts", {}),
        "component_model_record_count": int(component_model_dir.get("model_record_count") or 0),
        "lane_records": lane_records,
        "all_lane_surrogates_present": all(record["file_present"] for record in lane_records),
        "all_lane_surrogate_hashes_match": all_hashes_match,
        "all_lane_surrogate_sizes_match": all_sizes_match,
        "all_lane_surrogates_release_credit_false": all(
            record["release_credit"] is False for record in lane_records
        ),
        "all_lane_component_reference_counts_match_manifest": all(
            record["component_reference_count"] == record["manifest_model_reference_count"]
            for record in lane_records
        ),
        "all_lane_component_records_release_credit_false": all(
            record["all_component_records_release_credit_false"] for record in lane_records
        ),
        "all_lane_component_records_reference_surrogate": all(
            record["all_component_records_reference_this_surrogate"] for record in lane_records
        ),
        "release_credit": False,
        "release_allowed": False,
    }


def public_sourcing_intake_summary() -> dict[str, Any]:
    public_cad = read_yaml(PUBLIC_CAD_SOURCE_INTAKE)
    public_bom = read_yaml(PUBLIC_BOM_MARKET_COST_BANDS)
    if not isinstance(public_cad, dict):
        public_cad = {}
    if not isinstance(public_bom, dict):
        public_bom = {}
    public_cad_records = public_cad.get("records", [])
    public_bom_records = public_bom.get("records", [])
    if not isinstance(public_cad_records, list):
        public_cad_records = []
    if not isinstance(public_bom_records, list):
        public_bom_records = []
    public_cad_summary = public_cad.get("summary", {})
    public_bom_summary = public_bom.get("summary", {})
    if not isinstance(public_cad_summary, dict):
        public_cad_summary = {}
    if not isinstance(public_bom_summary, dict):
        public_bom_summary = {}
    return {
        "ready": True,
        "scope": "public_cad_and_market_cost_intake_not_release_evidence",
        "public_cad_source_intake": repo_rel(PUBLIC_CAD_SOURCE_INTAKE),
        "public_market_bom_cost_bands": repo_rel(PUBLIC_BOM_MARKET_COST_BANDS),
        "public_cad_source_record_count": len(public_cad_records),
        "public_cad_source_step_or_3d_observed_count": int(
            public_cad_summary.get("public_step_or_3d_observed_count") or 0
        ),
        "public_cad_source_footprint_or_eda_observed_count": int(
            public_cad_summary.get("public_footprint_or_eda_observed_count") or 0
        ),
        "public_cad_source_local_downloaded_hashed_count": int(
            public_cad_summary.get("local_downloaded_hashed_count") or 0
        ),
        "public_cad_source_release_credit_record_count": int(
            public_cad_summary.get("release_credit_record_count") or 0
        ),
        "public_market_bom_cost_category_count": len(public_bom_records),
        "public_market_bom_cost_volume_count": int(public_bom_summary.get("volume_count") or 0),
        "public_market_bom_cost_avl_quote_count": int(
            public_bom_summary.get("avl_quote_count") or 0
        ),
        "public_market_bom_cost_signed_supplier_quote_count": int(
            public_bom_summary.get("signed_supplier_quote_count") or 0
        ),
        "public_market_bom_cost_subtotal_researched_categories_usd": public_bom.get(
            "subtotal_researched_categories_usd", {}
        ),
        "release_credit": False,
        "release_allowed": False,
    }


def count_files(root: Path) -> dict[str, Any]:
    files = sorted(path for path in root.rglob("*") if path.is_file())
    top_level_files = sorted(path for path in root.glob("*") if path.is_file())
    recursive_by_extension = Counter(path.suffix.lower() or "<none>" for path in files)
    top_level_by_extension = Counter(path.suffix.lower() or "<none>" for path in top_level_files)
    return {
        "directory": repo_rel(root),
        "total_files_recursive": len(files),
        "top_level_files": len(top_level_files),
        "recursive_by_extension": dict(sorted(recursive_by_extension.items())),
        "top_level_by_extension": dict(sorted(top_level_by_extension.items())),
    }


def manifest_inventory() -> dict[str, Any]:
    rows: dict[str, Any] = {}
    for name, path in MANIFESTS.items():
        data = read_json(path)
        if not isinstance(data, list):
            rows[name] = {
                "path": repo_rel(path),
                "present": path.exists(),
                "item_count": 0,
                "role_counts": {},
            }
            continue
        roles = Counter(
            str(item.get("role", "<missing>")) for item in data if isinstance(item, dict)
        )
        rows[name] = {
            "path": repo_rel(path),
            "present": True,
            "item_count": len(data),
            "role_counts": dict(sorted(roles.items())),
        }
    return rows


def review_gate_inventory() -> dict[str, Any]:
    gates: dict[str, Any] = {}
    for name, path in REVIEW_GATES.items():
        data = read_json(path)
        if not isinstance(data, dict):
            gates[name] = {"path": repo_rel(path), "present": path.exists(), "status": "missing"}
            continue

        gate: dict[str, Any] = {
            "path": repo_rel(path),
            "present": True,
            "status": data.get("status", "unknown"),
            "claim_boundary": data.get("claim_boundary"),
        }
        for key in (
            "production_step_files",
            "approved_production_step_files",
            "blocked_candidate_step_files",
            "development_step_candidates",
            "detailed_routed_step_candidate",
            "routed_board_step_intake_detail",
            "routed_board_kicad_cli_preflight",
            "demo_step_files_ignored",
            "required_routed_board_evidence_class",
            "routed_board_forbidden_evidence_classes",
            "expected_clearance_case_count",
            "complete_clearance_result_count",
            "expected_family_count",
            "complete_family_count",
            "missing_or_incomplete_families",
            "expected_gate_count",
            "complete_gate_count",
            "missing_or_incomplete_gates",
            "assembly_step",
            "assembly_step_bytes",
            "part_count",
            "validated_count",
            "required_connection_count",
            "passing_connection_count",
            "required_connection_terminal_marker_count",
            "passing_connection_terminal_pair_count",
            "required_connection_solid_step_part_count",
            "passing_connection_solid_step_part_set_count",
            "connection_solid_step_part_bytes_total",
            "represented_net_count_total",
            "represented_route_count_total",
            "represented_route_record_count_total",
            "represented_route_records_with_layer_count_total",
            "represented_route_records_with_source_domain_count_total",
            "represented_route_records_with_route_class_count_total",
            "represented_route_classification_gap_count",
            "all_represented_routes_have_layer_source_and_class",
            "represented_route_length_total_mm",
            "represented_controlled_impedance_route_count_total",
            "all_represented_nets_have_route_trace",
            "visual_route_span_total_mm",
            "physical_medium_counts",
            "electrical_class_counts",
            "controlled_impedance_connection_count",
            "controlled_impedance_requirement_defined_count",
            "bend_radius_requirement_defined_count",
            "supplier_release_required_connection_count",
            "routed_development_net_count",
            "release_credit",
            "remaining_blockers",
            "ocp_terminal_step_fallback_count",
            "ocp_terminal_step_fallback_error",
            "release_rule",
        ):
            if key in data:
                gate[key] = data[key]
        if name == "cad_connection_coverage":
            connection_records = [
                item for item in data.get("connections", []) if isinstance(item, dict)
            ]
            compact_records = [
                compact_connection_record(item)
                for item in sorted(
                    connection_records, key=lambda record: str(record.get("id") or "")
                )
            ]
            gate["cad_connection_record_count"] = len(connection_records)
            gate["cad_connection_record_manifest"] = compact_records
            gate["cad_connection_record_manifest_id_count"] = len(
                {str(item.get("id")) for item in compact_records}
            )
            gate["cad_connection_represented_net_list_total"] = sum(
                len(item.get("represented_nets", [])) for item in connection_records
            )
            gate["cad_connection_represented_route_id_list_total"] = sum(
                len(item.get("represented_route_ids", [])) for item in connection_records
            )
            gate["cad_connection_all_records_have_represented_nets"] = bool(
                connection_records
            ) and all(bool(item.get("represented_nets")) for item in connection_records)
            gate["cad_connection_all_records_have_represented_routes"] = bool(
                connection_records
            ) and all(bool(item.get("represented_route_ids")) for item in connection_records)
            gate["cad_connection_all_represented_nets_match_routed_nets"] = bool(
                connection_records
            ) and all(
                item.get("represented_nets") == item.get("nets", [])
                and int(item.get("represented_net_count") or 0)
                == len(item.get("represented_nets", []))
                for item in connection_records
            )
            gate["cad_connection_all_represented_routes_match_counts"] = bool(
                connection_records
            ) and all(
                int(item.get("represented_route_count") or 0)
                == len(item.get("represented_route_ids", []))
                for item in connection_records
            )
            gate["cad_connection_all_represented_routes_have_layer_source_and_class"] = bool(
                connection_records
            ) and all(
                item.get("all_represented_routes_have_layer_source_and_class") is True
                for item in connection_records
            )
            gate["cad_connection_all_records_have_terminal_markers"] = bool(
                connection_records
            ) and all(item.get("terminal_markers_present") is True for item in connection_records)
            gate["cad_connection_all_records_have_solid_step_parts"] = bool(
                connection_records
            ) and all(item.get("solid_step_parts_present") is True for item in connection_records)
            gate["cad_connection_all_records_have_cad_step_bytes"] = bool(
                connection_records
            ) and all(int(item.get("cad_step_bytes") or 0) > 1000 for item in connection_records)
            gate["cad_connection_all_records_have_cad_parts"] = bool(connection_records) and all(
                item.get("cad_part_present") is True for item in connection_records
            )
            gate["cad_connection_all_records_release_credit_false"] = bool(
                connection_records
            ) and all(item.get("release_credit") is False for item in connection_records)
        gates[name] = gate
    return gates


def missing_release_evidence(gates: dict[str, Any]) -> list[dict[str, Any]]:
    missing: list[dict[str, Any]] = []
    for gate_name, requirement in REQUIRED_RELEASE_EVIDENCE.items():
        if gate_name == "physical_fit_evidence":
            gate = gates.get("concept_fit_check", {})
            claim_boundary = str(gate.get("claim_boundary", "")).lower()
            source_status = gate.get("status", "missing")
            concept_only = (
                "not released" in claim_boundary
                or "not release" in claim_boundary
                or "not fabricated" in claim_boundary
                or "concept" in claim_boundary
            )
            if concept_only or source_status in BLOCKED_STATUSES:
                missing.append(
                    {
                        "gate": gate_name,
                        "required_evidence": requirement,
                        "status": "missing_release_physical_fit_evidence",
                        "path": gate.get("path"),
                        "source_status": source_status,
                        "source_claim_boundary": gate.get("claim_boundary"),
                    }
                )
            continue
        gate = gates.get(gate_name, {})
        status = gate.get("status", "missing")
        present = bool(gate.get("present"))
        blocked = status in BLOCKED_STATUSES or not present
        if blocked:
            row = {
                "gate": gate_name,
                "required_evidence": requirement,
                "status": status,
                "path": gate.get("path"),
            }
            for key in (
                "production_step_files",
                "approved_production_step_files",
                "blocked_candidate_step_files",
                "development_step_candidates",
                "detailed_routed_step_candidate",
                "routed_board_step_intake_detail",
                "routed_board_kicad_cli_preflight",
                "complete_clearance_result_count",
                "expected_clearance_case_count",
                "complete_family_count",
                "expected_family_count",
                "missing_or_incomplete_families",
                "complete_gate_count",
                "expected_gate_count",
                "missing_or_incomplete_gates",
            ):
                if key in gate:
                    row[key] = gate[key]
            missing.append(row)
    return missing


def build_report() -> dict[str, Any]:
    output_counts = count_files(OUT_DIR)
    manifests = manifest_inventory()
    gates = review_gate_inventory()
    missing = missing_release_evidence(gates)
    component_model_dir = component_model_directory_summary()
    supplier_surrogate_detail = supplier_step_surrogate_intake_detail(component_model_dir)
    public_sourcing_intake = public_sourcing_intake_summary()
    candidate_manifest = read_yaml(CANDIDATE_MANIFEST)
    if not isinstance(candidate_manifest, dict):
        candidate_manifest = {}
    routed_source_binding = candidate_manifest.get("routed_candidate_source_binding", {})
    if not isinstance(routed_source_binding, dict):
        routed_source_binding = {}

    assembly = manifests.get("assembly", {})
    solid_handoff = gates.get("solid_cad_handoff", {})
    connection_coverage = gates.get("cad_connection_coverage", {})
    step_validation = gates.get("step_validation", {})
    board_gate = gates.get("routed_board_step_intake", {})
    assembly_step_bytes = int(solid_handoff.get("assembly_step_bytes") or 0)
    assembly_manifest_part_count = int(assembly.get("item_count") or 0)
    ocp_terminal_step_fallback_count = int(
        solid_handoff.get("ocp_terminal_step_fallback_count") or 0
    )
    solid_handoff_generated = solid_handoff.get("status") == "generated"
    expected_terminal_marker_count = int(
        connection_coverage.get("required_connection_terminal_marker_count") or 0
    )
    ocp_terminal_step_fallback_required = not solid_handoff_generated
    ocp_terminal_step_fallback_complete = (
        ocp_terminal_step_fallback_required
        and ocp_terminal_step_fallback_count == expected_terminal_marker_count
        and not solid_handoff.get("ocp_terminal_step_fallback_error")
    )
    terminal_step_coverage_complete = solid_handoff_generated or ocp_terminal_step_fallback_complete
    step_validation_validated_count = int(step_validation.get("validated_count") or 0)
    required_connection_count = int(connection_coverage.get("required_connection_count") or 0)
    passing_connection_count = int(connection_coverage.get("passing_connection_count") or 0)
    cad_connection_coverage_complete = (
        connection_coverage.get("status") == "cad_connection_markers_complete_not_release"
        and required_connection_count > 0
        and passing_connection_count == required_connection_count
        and connection_coverage.get("release_credit") is False
    )
    detailed_routed_step_candidate = board_gate.get("detailed_routed_step_candidate", {})
    if not isinstance(detailed_routed_step_candidate, dict):
        detailed_routed_step_candidate = {}
    blocked_candidate_step_files = board_gate.get("blocked_candidate_step_files", [])
    if not isinstance(blocked_candidate_step_files, list):
        blocked_candidate_step_files = []
    approved_production_step_files = board_gate.get("approved_production_step_files", [])
    if not isinstance(approved_production_step_files, list):
        approved_production_step_files = []
    detailed_candidate_present = detailed_routed_step_candidate.get("present") is True
    detailed_candidate_release_credit = detailed_routed_step_candidate.get("release_credit")
    local_routed_step_candidate_ready = (
        detailed_candidate_present
        and detailed_routed_step_candidate.get("blocked_metadata") is True
        and detailed_candidate_release_credit is False
        and int(detailed_routed_step_candidate.get("size_bytes") or 0) > 0
    )
    local_cad_ready = (
        assembly_manifest_part_count > 0
        and solid_handoff.get("status") == "generated"
        and bool(solid_handoff.get("assembly_step"))
        and assembly_step_bytes > 0
        and cad_connection_coverage_complete
        and step_validation.get("status") == "pass"
        and step_validation_validated_count > 0
    )
    release_enclosure_ready = {
        "ready": False,
        "fail_closed": True,
        "release_claim_allowed": False,
        "reason": (
            "Release-ready enclosure evidence is absent until required routed-board STEP, "
            "routed-board clearance, supplier-returned evidence, and physical process "
            "validation gates are all present and passing."
        ),
        "missing_required_evidence_count": len(missing),
        "required_blockers": [row["gate"] for row in missing],
    }

    return {
        "report": "E1 phone mechanical CAD evidence inventory",
        "date": REPORT_DATE,
        "script": f"packages/chip/scripts/{SCRIPT_NAME}",
        "scope": {
            "mode": "read_only_inventory",
            "cad_output_dir": repo_rel(OUT_DIR),
            "review_dir": repo_rel(REVIEW_DIR),
            "claim_boundary": (
                "Existing generated/concept CAD outputs are counted, but do not prove "
                "release-ready enclosure fit without routed-board, supplier, and physical evidence."
            ),
        },
        "cad_output_file_counts": output_counts,
        "concept_generated_assets": {
            "assembly_manifest_part_count": assembly_manifest_part_count,
            "solid_handoff_status": solid_handoff.get("status"),
            "solid_handoff_part_count": solid_handoff.get("part_count"),
            "solid_assembly_step": solid_handoff.get("assembly_step"),
            "solid_assembly_step_bytes": assembly_step_bytes,
            "solid_handoff_native_terminal_step_export": solid_handoff_generated,
            "solid_handoff_terminal_step_coverage_complete": terminal_step_coverage_complete,
            "solid_handoff_ocp_terminal_step_fallback_required": (
                ocp_terminal_step_fallback_required
            ),
            "solid_handoff_ocp_terminal_step_fallback_count": (ocp_terminal_step_fallback_count),
            "solid_handoff_ocp_terminal_step_fallback_error": solid_handoff.get(
                "ocp_terminal_step_fallback_error"
            ),
            "cad_connection_coverage_status": connection_coverage.get("status"),
            "cad_connection_required_count": connection_coverage.get("required_connection_count"),
            "cad_connection_passing_count": connection_coverage.get("passing_connection_count"),
            "cad_connection_terminal_marker_count": connection_coverage.get(
                "required_connection_terminal_marker_count"
            ),
            "cad_connection_terminal_pair_count": connection_coverage.get(
                "passing_connection_terminal_pair_count"
            ),
            "cad_connection_solid_step_part_count": connection_coverage.get(
                "required_connection_solid_step_part_count"
            ),
            "cad_connection_solid_step_part_set_count": connection_coverage.get(
                "passing_connection_solid_step_part_set_count"
            ),
            "cad_connection_solid_step_part_bytes_total": connection_coverage.get(
                "connection_solid_step_part_bytes_total"
            ),
            "cad_connection_represented_net_count_total": connection_coverage.get(
                "represented_net_count_total"
            ),
            "cad_connection_represented_route_count_total": connection_coverage.get(
                "represented_route_count_total"
            ),
            "cad_connection_represented_route_record_count_total": connection_coverage.get(
                "represented_route_record_count_total"
            ),
            "cad_connection_represented_route_records_with_layer_count_total": (
                connection_coverage.get("represented_route_records_with_layer_count_total")
            ),
            "cad_connection_represented_route_records_with_source_domain_count_total": (
                connection_coverage.get("represented_route_records_with_source_domain_count_total")
            ),
            "cad_connection_represented_route_records_with_route_class_count_total": (
                connection_coverage.get("represented_route_records_with_route_class_count_total")
            ),
            "cad_connection_represented_route_classification_gap_count": (
                connection_coverage.get("represented_route_classification_gap_count")
            ),
            "cad_connection_all_represented_routes_have_layer_source_and_class": (
                connection_coverage.get("all_represented_routes_have_layer_source_and_class")
            ),
            "cad_connection_represented_route_length_total_mm": connection_coverage.get(
                "represented_route_length_total_mm"
            ),
            "cad_connection_represented_controlled_impedance_route_count_total": (
                connection_coverage.get("represented_controlled_impedance_route_count_total")
            ),
            "cad_connection_record_count": connection_coverage.get("cad_connection_record_count"),
            "cad_connection_record_manifest_id_count": connection_coverage.get(
                "cad_connection_record_manifest_id_count"
            ),
            "cad_connection_record_manifest": connection_coverage.get(
                "cad_connection_record_manifest", []
            ),
            "cad_connection_represented_net_list_total": connection_coverage.get(
                "cad_connection_represented_net_list_total"
            ),
            "cad_connection_represented_route_id_list_total": connection_coverage.get(
                "cad_connection_represented_route_id_list_total"
            ),
            "cad_connection_all_records_have_represented_nets": connection_coverage.get(
                "cad_connection_all_records_have_represented_nets"
            ),
            "cad_connection_all_records_have_represented_routes": connection_coverage.get(
                "cad_connection_all_records_have_represented_routes"
            ),
            "cad_connection_all_represented_nets_match_routed_nets": connection_coverage.get(
                "cad_connection_all_represented_nets_match_routed_nets"
            ),
            "cad_connection_all_represented_routes_match_counts": connection_coverage.get(
                "cad_connection_all_represented_routes_match_counts"
            ),
            "cad_connection_all_records_have_terminal_markers": connection_coverage.get(
                "cad_connection_all_records_have_terminal_markers"
            ),
            "cad_connection_all_records_have_solid_step_parts": connection_coverage.get(
                "cad_connection_all_records_have_solid_step_parts"
            ),
            "cad_connection_all_records_have_cad_step_bytes": connection_coverage.get(
                "cad_connection_all_records_have_cad_step_bytes"
            ),
            "cad_connection_all_records_have_cad_parts": connection_coverage.get(
                "cad_connection_all_records_have_cad_parts"
            ),
            "cad_connection_all_records_release_credit_false": connection_coverage.get(
                "cad_connection_all_records_release_credit_false"
            ),
            "cad_connection_all_represented_nets_have_route_trace": connection_coverage.get(
                "all_represented_nets_have_route_trace"
            ),
            "cad_connection_visual_route_span_total_mm": connection_coverage.get(
                "visual_route_span_total_mm"
            ),
            "cad_connection_physical_medium_counts": connection_coverage.get(
                "physical_medium_counts", {}
            ),
            "cad_connection_electrical_class_counts": connection_coverage.get(
                "electrical_class_counts", {}
            ),
            "cad_connection_controlled_impedance_count": connection_coverage.get(
                "controlled_impedance_connection_count"
            ),
            "cad_connection_controlled_impedance_requirement_defined_count": (
                connection_coverage.get("controlled_impedance_requirement_defined_count")
            ),
            "cad_connection_bend_radius_requirement_defined_count": connection_coverage.get(
                "bend_radius_requirement_defined_count"
            ),
            "cad_connection_supplier_release_required_count": connection_coverage.get(
                "supplier_release_required_connection_count"
            ),
            "cad_connection_release_credit": connection_coverage.get("release_credit"),
            "step_validation_status": step_validation.get("status"),
            "step_validation_validated_count": step_validation_validated_count,
            "concept_demo_board_steps_ignored": board_gate.get("demo_step_files_ignored", []),
            "local_routed_step_candidates_blocked": blocked_candidate_step_files,
            "classification": "generated_concept_or_evt0_envelope_not_release_ready",
        },
        "local_routed_step_candidate_ready": {
            "ready": local_routed_step_candidate_ready,
            "scope": "local_routed_output_candidate_not_release_evidence",
            "approved_production_step_count": len(approved_production_step_files),
            "blocked_candidate_step_count": len(blocked_candidate_step_files),
            "detailed_routed_step_candidate_present": detailed_candidate_present,
            "detailed_routed_step_candidate_ready_for_local_review": (
                local_routed_step_candidate_ready
            ),
            "detailed_routed_step_candidate_path": detailed_routed_step_candidate.get("path"),
            "routed_board_step_intake_detail": board_gate.get("routed_board_step_intake_detail"),
            "routed_board_kicad_cli_preflight": board_gate.get("routed_board_kicad_cli_preflight"),
            "detailed_routed_step_candidate_bytes": int(
                detailed_routed_step_candidate.get("size_bytes") or 0
            ),
            "detailed_routed_step_candidate_route_count": detailed_routed_step_candidate.get(
                "route_count"
            ),
            "detailed_routed_step_candidate_segment_count": detailed_routed_step_candidate.get(
                "segment_count"
            ),
            "detailed_routed_step_candidate_route_segment_net_name_count": (
                detailed_routed_step_candidate.get("route_segment_net_name_count")
            ),
            "detailed_routed_step_candidate_route_segment_trace_bound_count": (
                detailed_routed_step_candidate.get("route_segment_trace_bound_count")
            ),
            "detailed_routed_step_candidate_route_segment_trace_unbound_count": (
                detailed_routed_step_candidate.get("route_segment_trace_unbound_count")
            ),
            "detailed_routed_step_candidate_controlled_impedance_segment_visual_count": (
                detailed_routed_step_candidate.get("controlled_impedance_segment_visual_count")
            ),
            "detailed_routed_step_candidate_via_net_name_count": detailed_routed_step_candidate.get(
                "via_net_name_count"
            ),
            "routed_candidate_source_binding": {
                "manifest": repo_rel(CANDIDATE_MANIFEST),
                "source_board": routed_source_binding.get("source_board", ""),
                "candidate_board": routed_source_binding.get("candidate_board", ""),
                "candidate_matches_source_board": (
                    routed_source_binding.get("candidate_matches_source_board") is True
                ),
                "source_is_zero_placeholder_real_footprint_board": (
                    routed_source_binding.get("source_is_zero_placeholder_real_footprint_board")
                    is True
                ),
                "candidate_is_zero_placeholder_real_footprint_board": (
                    routed_source_binding.get("candidate_is_zero_placeholder_real_footprint_board")
                    is True
                ),
                "source_placeholder_marker_count": int(
                    routed_source_binding.get("source_placeholder_marker_count") or 0
                ),
                "candidate_placeholder_marker_count": int(
                    routed_source_binding.get("candidate_placeholder_marker_count") or 0
                ),
                "candidate_legacy_e1phone_footprint_ref_count": int(
                    routed_source_binding.get("candidate_legacy_e1phone_footprint_ref_count") or 0
                ),
                "candidate_footprint_count": int(
                    routed_source_binding.get("candidate_footprint_count") or 0
                ),
                "candidate_segment_count": int(
                    routed_source_binding.get("candidate_segment_count") or 0
                ),
                "candidate_via_count": int(routed_source_binding.get("candidate_via_count") or 0),
                "candidate_zone_count": int(routed_source_binding.get("candidate_zone_count") or 0),
                "candidate_filled_zone_count": int(
                    routed_source_binding.get("candidate_filled_zone_count") or 0
                ),
                "release_credit": routed_source_binding.get("release_credit") is True,
            },
            "detailed_routed_step_candidate_release_credit": detailed_candidate_release_credit,
            "release_claim_allowed": False,
        },
        "component_model_directory_ready": {
            "ready": (
                component_model_dir.get("present") is True
                and component_model_dir.get("model_record_count") == 89
                and component_model_dir.get("all_model_records_present") is True
                and component_model_dir.get("all_model_records_source_routed_step_bound") is True
                and component_model_dir.get("all_model_records_have_combined_step_locator") is True
                and component_model_dir.get("all_model_records_have_local_discrete_step_file")
                is True
                and component_model_dir.get("all_local_discrete_step_files_import_as_solids")
                is True
                and component_model_dir.get("all_local_discrete_step_bboxes_match_envelopes")
                is True
                and component_model_dir.get("all_model_records_have_expected_supplier_step_file")
                is True
                and component_model_dir.get("release_allowed") is False
            ),
            "scope": "local_component_model_directory_not_supplier_steps",
            "manifest": component_model_dir.get("manifest"),
            "supplier_step_surrogate_intake_detail": repo_rel(
                SUPPLIER_STEP_SURROGATE_INTAKE_DETAIL
            ),
            "model_record_count": component_model_dir.get("model_record_count"),
            "combined_step_locator_count": component_model_dir.get("combined_step_locator_count"),
            "local_discrete_step_file_count": component_model_dir.get(
                "local_discrete_step_file_count"
            ),
            "local_discrete_step_imported_solid_count": component_model_dir.get(
                "local_discrete_step_imported_solid_count"
            ),
            "local_discrete_step_bbox_match_count": component_model_dir.get(
                "local_discrete_step_bbox_match_count"
            ),
            "local_discrete_step_bytes_total": component_model_dir.get(
                "local_discrete_step_bytes_total"
            ),
            "expected_supplier_step_file_count": component_model_dir.get(
                "expected_supplier_step_file_count"
            ),
            "missing_supplier_discrete_model_count": component_model_dir.get(
                "missing_supplier_discrete_model_count"
            ),
            "supplier_step_intake_placeholder_count": component_model_dir.get(
                "supplier_step_intake_placeholder_count"
            ),
            "supplier_step_intake_local_surrogate_count": component_model_dir.get(
                "supplier_step_intake_local_surrogate_count"
            ),
            "supplier_step_intake_missing_count": component_model_dir.get(
                "supplier_step_intake_missing_count"
            ),
            "supplier_step_intake_not_applicable_count": component_model_dir.get(
                "supplier_step_intake_not_applicable_count"
            ),
            "supplier_step_intake_release_candidate_count": component_model_dir.get(
                "supplier_step_intake_release_candidate_count"
            ),
            "supplier_step_intake_lane_counts": component_model_dir.get(
                "supplier_step_intake_lane_counts"
            ),
            "supplier_lane_surrogate_step_count": supplier_surrogate_detail.get(
                "supplier_lane_surrogate_step_count"
            ),
            "supplier_lane_surrogate_records": supplier_surrogate_detail.get("lane_records", []),
            "all_lane_surrogates_present": supplier_surrogate_detail.get(
                "all_lane_surrogates_present"
            ),
            "all_lane_surrogate_hashes_match": supplier_surrogate_detail.get(
                "all_lane_surrogate_hashes_match"
            ),
            "all_lane_surrogate_sizes_match": supplier_surrogate_detail.get(
                "all_lane_surrogate_sizes_match"
            ),
            "all_lane_surrogates_release_credit_false": supplier_surrogate_detail.get(
                "all_lane_surrogates_release_credit_false"
            ),
            "all_lane_component_reference_counts_match_manifest": (
                supplier_surrogate_detail.get("all_lane_component_reference_counts_match_manifest")
            ),
            "all_lane_component_records_release_credit_false": supplier_surrogate_detail.get(
                "all_lane_component_records_release_credit_false"
            ),
            "all_lane_component_records_reference_surrogate": supplier_surrogate_detail.get(
                "all_lane_component_records_reference_surrogate"
            ),
            "all_model_records_source_routed_step_bound": component_model_dir.get(
                "all_model_records_source_routed_step_bound"
            ),
            "all_model_records_have_combined_step_locator": component_model_dir.get(
                "all_model_records_have_combined_step_locator"
            ),
            "all_model_records_have_local_discrete_step_file": component_model_dir.get(
                "all_model_records_have_local_discrete_step_file"
            ),
            "all_local_discrete_step_files_import_as_solids": component_model_dir.get(
                "all_local_discrete_step_files_import_as_solids"
            ),
            "all_local_discrete_step_bboxes_match_envelopes": component_model_dir.get(
                "all_local_discrete_step_bboxes_match_envelopes"
            ),
            "all_model_records_have_expected_supplier_step_file": component_model_dir.get(
                "all_model_records_have_expected_supplier_step_file"
            ),
            "component_model_record_manifest": component_model_dir.get(
                "component_model_record_manifest", []
            ),
            "release_claim_allowed": False,
        },
        "public_sourcing_intake_ready": public_sourcing_intake,
        "local_enclosure_cad_ready": {
            "ready": local_cad_ready,
            "scope": "generated_evt0_concept_cad_only",
            "solid_handoff_generated": solid_handoff_generated,
            "solid_handoff_native_terminal_step_export": solid_handoff_generated,
            "solid_handoff_terminal_step_coverage_complete": terminal_step_coverage_complete,
            "solid_handoff_ocp_terminal_step_fallback_required": (
                ocp_terminal_step_fallback_required
            ),
            "solid_handoff_ocp_terminal_step_fallback_count": (ocp_terminal_step_fallback_count),
            "solid_handoff_ocp_terminal_step_fallback_complete": (
                ocp_terminal_step_fallback_complete
            ),
            "cad_connection_coverage_complete": cad_connection_coverage_complete,
            "cad_connection_record_count": connection_coverage.get("cad_connection_record_count"),
            "cad_connection_record_manifest_id_count": connection_coverage.get(
                "cad_connection_record_manifest_id_count"
            ),
            "cad_connection_record_manifest": connection_coverage.get(
                "cad_connection_record_manifest", []
            ),
            "cad_connection_all_records_have_represented_nets": connection_coverage.get(
                "cad_connection_all_records_have_represented_nets"
            ),
            "cad_connection_all_records_have_represented_routes": connection_coverage.get(
                "cad_connection_all_records_have_represented_routes"
            ),
            "cad_connection_all_represented_nets_match_routed_nets": connection_coverage.get(
                "cad_connection_all_represented_nets_match_routed_nets"
            ),
            "cad_connection_all_represented_routes_match_counts": connection_coverage.get(
                "cad_connection_all_represented_routes_match_counts"
            ),
            "cad_connection_all_represented_routes_have_layer_source_and_class": (
                connection_coverage.get(
                    "cad_connection_all_represented_routes_have_layer_source_and_class"
                )
            ),
            "cad_connection_all_records_have_terminal_markers": connection_coverage.get(
                "cad_connection_all_records_have_terminal_markers"
            ),
            "cad_connection_all_records_have_solid_step_parts": connection_coverage.get(
                "cad_connection_all_records_have_solid_step_parts"
            ),
            "cad_connection_all_records_have_cad_step_bytes": connection_coverage.get(
                "cad_connection_all_records_have_cad_step_bytes"
            ),
            "cad_connection_all_records_have_cad_parts": connection_coverage.get(
                "cad_connection_all_records_have_cad_parts"
            ),
            "cad_connection_all_records_release_credit_false": connection_coverage.get(
                "cad_connection_all_records_release_credit_false"
            ),
            "assembly_step_present": bool(solid_handoff.get("assembly_step")),
            "assembly_step_bytes": assembly_step_bytes,
            "assembly_manifest_part_count": assembly_manifest_part_count,
            "step_validation_passed": step_validation.get("status") == "pass",
            "step_validation_validated_count": step_validation_validated_count,
            "release_claim_allowed": False,
        },
        "manifest_inventory": manifests,
        "review_gate_inventory": gates,
        "missing_release_ready_evidence": missing,
        "release_enclosure_ready": release_enclosure_ready,
        "release_readiness": {
            "release_ready": release_enclosure_ready["ready"],
            "fail_closed": release_enclosure_ready["fail_closed"],
            "reason": release_enclosure_ready["reason"],
            "missing_required_evidence_count": release_enclosure_ready[
                "missing_required_evidence_count"
            ],
        },
    }


def yaml_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if text == "":
        return '""'
    return json.dumps(text)


def to_yaml(value: Any, indent: int = 0) -> list[str]:
    prefix = " " * indent
    if isinstance(value, dict):
        lines: list[str] = []
        for key, child in value.items():
            if isinstance(child, (dict, list)):
                lines.append(f"{prefix}{key}:")
                lines.extend(to_yaml(child, indent + 2))
            else:
                lines.append(f"{prefix}{key}: {yaml_scalar(child)}")
        return lines
    if isinstance(value, list):
        if not value:
            return [f"{prefix}[]"]
        lines = []
        for item in value:
            if isinstance(item, (dict, list)):
                lines.append(f"{prefix}-")
                lines.extend(to_yaml(item, indent + 2))
            else:
                lines.append(f"{prefix}- {yaml_scalar(item)}")
        return lines
    return [f"{prefix}{yaml_scalar(value)}"]


def render_yaml(report: dict[str, Any]) -> str:
    return "\n".join(to_yaml(report)) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write",
        action="store_true",
        help=f"write the inventory to {repo_rel(DEFAULT_REPORT)}",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_REPORT,
        help="report path used with --write",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report()
    text = render_yaml(report)
    if args.write:
        detail = supplier_step_surrogate_intake_detail(component_model_directory_summary())
        SUPPLIER_STEP_SURROGATE_INTAKE_DETAIL.write_text(
            json.dumps(detail, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        args.output.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
