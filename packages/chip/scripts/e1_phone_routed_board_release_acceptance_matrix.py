#!/usr/bin/env python3
"""Build the E1 phone routed-board release acceptance matrix.

The matrix is fail-closed by construction: it inventories source requirements,
current file presence, missing nets, and next unblock actions without promoting
route, fabrication, enclosure, factory, or end-to-end readiness.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
E1_DIR = ROOT / "board/kicad/e1-phone"
READINESS_DIR = E1_DIR / "production/readiness"
REPORT_DATE = "2026-05-22"

DEFAULT_ROUTE_INVENTORY = E1_DIR / "kicad-route-readiness-inventory-2026-05-22.yaml"
DEFAULT_BURNDOWN = E1_DIR / "routed-layout-si-drc-burndown-2026-05-22.yaml"
DEFAULT_RELEASE_PLAN = E1_DIR / "routed-release-plan.yaml"
DEFAULT_YAML_REPORT = READINESS_DIR / f"routed-board-release-acceptance-matrix-{REPORT_DATE}.yaml"
DEFAULT_MD_REPORT = READINESS_DIR / f"routed-board-release-acceptance-matrix-{REPORT_DATE}.md"
DEFAULT_CANDIDATE_MANIFEST = E1_DIR / "production/routed-output-candidate-manifest-2026-05-22.yaml"
DEFAULT_COMPONENT_MODEL_MANIFEST = E1_DIR / "production/step/component-3d-model-manifest.yaml"
DEFAULT_COMPONENT_MODEL_DIR = E1_DIR / "production/step/component-models"
DEFAULT_COMPONENT_3D_BINDING_REPORT = E1_DIR / "production/reports/component-3d-binding.yaml"
DEFAULT_COMPONENT_3D_BINDING_MATRIX = E1_DIR / "production/reports/component-3d-binding-matrix.csv"


DOMAIN_REQUIREMENT_HINTS = {
    "usb_c_power_sidekey_spine": ("usb_c_power", "side_buttons", "battery"),
    "display_touch_mipi_dsi": ("display_touch",),
    "front_rear_camera_mipi_csi": ("cameras",),
    "cellular_wifi_bt_rf_host": ("radios",),
    "compute_memory_storage_escape": ("compute_storage",),
    "split_interconnect_and_audio_haptics": ("split_interconnect", "audio_haptics"),
    "factory_test_fiducials_and_manufacturing_coupons": ("manufacturing",),
}


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def read_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{display_rel(path)}: expected YAML mapping")
    return data


def display_rel(path: Path) -> str:
    if path.is_relative_to(REPO_ROOT):
        return path.relative_to(REPO_ROOT).as_posix()
    return str(path)


def resolve_repo_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return REPO_ROOT / path
    if path_text.startswith("board/"):
        return ROOT / path
    if path_text.startswith("mechanical/"):
        return ROOT / path
    return E1_DIR / path


def load_candidate_manifest(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    return read_yaml(path)


def candidate_artifacts(candidate_manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    artifacts: dict[str, dict[str, Any]] = {}
    for item in candidate_manifest.get("artifacts", []):
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        if isinstance(path, str) and path:
            artifacts[path] = item
    return artifacts


def candidate_end_to_end_context(
    candidate_manifest: dict[str, Any],
    candidate_manifest_path: Path,
    component_manifest_path: Path = DEFAULT_COMPONENT_MODEL_MANIFEST,
    component_model_dir: Path = DEFAULT_COMPONENT_MODEL_DIR,
    component_binding_report_path: Path = DEFAULT_COMPONENT_3D_BINDING_REPORT,
    component_binding_matrix_path: Path = DEFAULT_COMPONENT_3D_BINDING_MATRIX,
) -> dict[str, Any]:
    component_manifest = load_candidate_manifest(component_manifest_path)
    component_dir_manifest_path = component_model_dir / "release-manifest.yaml"
    component_dir_manifest = load_candidate_manifest(component_dir_manifest_path)
    component_binding_report = load_candidate_manifest(component_binding_report_path)
    terminal_binding = component_manifest.get("terminal_contract_binding", {})
    model_binding = component_manifest.get("model_to_footprint_binding", {})
    visual_summary = component_manifest.get("package_visual_summary", {})
    local_step_binding = component_manifest.get("local_discrete_step_binding", {})
    component_models = [
        item for item in component_manifest.get("models", []) if isinstance(item, dict)
    ]
    component_model_records = [
        {
            "reference": str(model.get("reference", "")),
            "footprint": str(model.get("footprint", "")),
            "visual_package_class": str(model.get("visual_package_class", "")),
            "pinout_file": str(model.get("pinout_file", "")),
            "pinout_status": str(model.get("pinout_status", "")),
            "coverage": str(model.get("coverage", "")),
            "land_pattern_basis": str(model.get("land_pattern_basis", "")),
            "support_pattern_has_explicit_provenance": bool(
                model.get("support_pattern_has_explicit_provenance") is True
            ),
            "pad_visual_count": int(model.get("pad_visual_count", 0) or 0),
            "pad_contract_covered_count": int(
                model.get("pad_contract_covered_count", 0) or 0
            ),
            "terminal_contract_count": int(model.get("terminal_contract_count", 0) or 0),
            "non_signal_pad_contract_count": len(model.get("non_signal_pad_contract", [])),
            "npth_mechanical_feature_contract_count": len(
                model.get("npth_mechanical_feature_contract", [])
            ),
            "all_pad_visuals_have_contract": bool(
                model.get("all_pad_visuals_have_contract") is True
            ),
            "terminal_contract_matches_pad_visuals": bool(
                model.get("terminal_contract_matches_pad_visuals") is True
            ),
            "non_signal_pad_contract_matches_pad_visuals": bool(
                model.get("non_signal_pad_contract_matches_pad_visuals") is True
            ),
            "npth_mechanical_feature_contract_matches_footprint": bool(
                model.get("npth_mechanical_feature_contract_matches_footprint") is True
            ),
            "local_discrete_step_file": str(model.get("local_discrete_step_file", "")),
            "local_discrete_step_sha256": str(model.get("local_discrete_step_sha256", "")),
            "local_discrete_step_bytes": int(model.get("local_discrete_step_bytes", 0) or 0),
            "local_discrete_step_imported_as_solid": bool(
                model.get("local_discrete_step_imported_as_solid") is True
            ),
            "local_discrete_step_bbox_matches_envelope": bool(
                model.get("local_discrete_step_bbox_matches_envelope") is True
            ),
            "release_credit": bool(model.get("release_credit") is True),
        }
        for model in sorted(component_models, key=lambda item: str(item.get("reference", "")))
    ]
    visual = candidate_manifest.get("routed_step_visual_detail", {})
    source_binding = candidate_manifest.get("routed_candidate_source_binding", {})
    if not isinstance(source_binding, dict):
        source_binding = {}
    connection = candidate_manifest.get("cad_connection_coverage", {})
    traceability = candidate_manifest.get("kicad_cad_traceability", {})
    connection_records = [
        item for item in connection.get("connection_records", []) if isinstance(item, dict)
    ]
    represented_net_list_total = sum(
        len(item.get("represented_nets", [])) for item in connection_records
    )
    represented_net_aliases_valid = all(
        item.get("represented_nets") == item.get("nets", [])
        and int(item.get("represented_net_count", 0) or 0) == len(item.get("represented_nets", []))
        for item in connection_records
    )
    return {
        "candidate_manifest": display_rel(candidate_manifest_path) if candidate_manifest else "",
        "component_model_manifest": display_rel(component_manifest_path)
        if component_manifest
        else "",
        "component_model_directory": display_rel(component_model_dir)
        if component_model_dir.exists()
        else "",
        "component_3d_binding_report": display_rel(component_binding_report_path)
        if component_binding_report
        else "",
        "component_3d_binding_matrix": display_rel(component_binding_matrix_path)
        if component_binding_matrix_path.is_file()
        else "",
        "status": candidate_manifest.get("status", ""),
        "release_credit": bool(candidate_manifest.get("release_credit") is True),
        "source_board": candidate_manifest.get("source_board", ""),
        "routed_candidate_source_binding": {
            "source_board": source_binding.get("source_board", ""),
            "candidate_board": source_binding.get("candidate_board", ""),
            "candidate_matches_source_board": bool(
                source_binding.get("candidate_matches_source_board") is True
            ),
            "source_is_zero_placeholder_real_footprint_board": bool(
                source_binding.get("source_is_zero_placeholder_real_footprint_board") is True
            ),
            "candidate_is_zero_placeholder_real_footprint_board": bool(
                source_binding.get("candidate_is_zero_placeholder_real_footprint_board") is True
            ),
            "source_placeholder_marker_count": int(
                source_binding.get("source_placeholder_marker_count", 0) or 0
            ),
            "candidate_placeholder_marker_count": int(
                source_binding.get("candidate_placeholder_marker_count", 0) or 0
            ),
            "candidate_legacy_e1phone_footprint_ref_count": int(
                source_binding.get("candidate_legacy_e1phone_footprint_ref_count", 0) or 0
            ),
            "candidate_footprint_count": int(
                source_binding.get("candidate_footprint_count", 0) or 0
            ),
            "candidate_segment_count": int(
                source_binding.get("candidate_segment_count", 0) or 0
            ),
            "candidate_via_count": int(source_binding.get("candidate_via_count", 0) or 0),
            "candidate_zone_count": int(source_binding.get("candidate_zone_count", 0) or 0),
            "candidate_filled_zone_count": int(
                source_binding.get("candidate_filled_zone_count", 0) or 0
            ),
            "release_credit": bool(source_binding.get("release_credit") is True),
        },
        "source_step": candidate_manifest.get("source_step", ""),
        "source_step_size_bytes": int(candidate_manifest.get("source_step_size_bytes", 0) or 0),
        "source_step_sha256": candidate_manifest.get("source_step_sha256", ""),
        "routed_step_visual_detail": {
            "footprint_envelope_count": int(visual.get("footprint_envelope_count", 0) or 0),
            "pad_contact_visual_count": int(visual.get("pad_contact_visual_count", 0) or 0),
            "route_segment_visual_count": int(visual.get("route_segment_visual_count", 0) or 0),
            "route_segment_net_name_count": int(
                visual.get("route_segment_net_name_count", 0) or 0
            ),
            "route_segment_trace_bound_count": int(
                visual.get("route_segment_trace_bound_count", 0) or 0
            ),
            "route_segment_trace_unbound_count": int(
                visual.get("route_segment_trace_unbound_count", 0) or 0
            ),
            "controlled_impedance_segment_visual_count": int(
                visual.get("controlled_impedance_segment_visual_count", 0) or 0
            ),
            "board_segment_count": int(visual.get("board_segment_count", 0) or 0),
            "board_via_count": int(visual.get("board_via_count", 0) or 0),
            "via_net_name_count": int(visual.get("via_net_name_count", 0) or 0),
            "development_footprint_refs": int(visual.get("development_footprint_refs", 0) or 0),
            "route_visual_record_count": int(visual.get("route_visual_record_count", 0) or 0),
            "route_visual_route_id_count": int(
                visual.get("route_visual_route_id_count", 0) or 0
            ),
            "route_visual_net_name_count": int(
                visual.get("route_visual_net_name_count", 0) or 0
            ),
            "route_visual_layer_counts": visual.get("route_visual_layer_counts", {}),
            "route_visual_route_class_counts": visual.get(
                "route_visual_route_class_counts", {}
            ),
            "route_visual_source_domain_counts": visual.get(
                "route_visual_source_domain_counts", {}
            ),
            "route_visual_all_records_have_route_id": bool(
                visual.get("route_visual_all_records_have_route_id") is True
            ),
            "route_visual_all_records_have_net": bool(
                visual.get("route_visual_all_records_have_net") is True
            ),
            "route_visual_all_records_have_layer": bool(
                visual.get("route_visual_all_records_have_layer") is True
            ),
            "route_visual_all_records_have_route_class": bool(
                visual.get("route_visual_all_records_have_route_class") is True
            ),
            "route_visual_all_records_have_source_domain": bool(
                visual.get("route_visual_all_records_have_source_domain") is True
            ),
            "route_visual_records": visual.get("route_visual_records", []),
            "via_visual_record_count": int(visual.get("via_visual_record_count", 0) or 0),
            "via_visual_net_name_count": int(visual.get("via_visual_net_name_count", 0) or 0),
            "via_visual_all_records_have_net": bool(
                visual.get("via_visual_all_records_have_net") is True
            ),
            "via_visual_all_records_have_layers": bool(
                visual.get("via_visual_all_records_have_layers") is True
            ),
            "via_visual_records": visual.get("via_visual_records", []),
            "filled_copper_zone_record_count": int(
                visual.get("filled_copper_zone_record_count", 0) or 0
            ),
            "filled_copper_zone_filled_polygon_count": int(
                visual.get("filled_copper_zone_filled_polygon_count", 0) or 0
            ),
            "filled_copper_zone_all_records_have_net": bool(
                visual.get("filled_copper_zone_all_records_have_net") is True
            ),
            "filled_copper_zone_all_records_have_bbox": bool(
                visual.get("filled_copper_zone_all_records_have_bbox") is True
            ),
            "filled_copper_zone_records": visual.get("filled_copper_zone_records", []),
            "release_credit": bool(visual.get("release_credit") is True),
        },
        "cad_connection_coverage": {
            "status": connection.get("status", ""),
            "assembly_manifest": connection.get("assembly_manifest", ""),
            "assembly_manifest_part_count": int(
                connection.get("assembly_manifest_part_count", 0) or 0
            ),
            "assembly_manifest_connection_terminal_marker_count": int(
                connection.get("assembly_manifest_connection_terminal_marker_count", 0) or 0
            ),
            "assembly_manifest_connection_solid_step_part_count": int(
                connection.get("assembly_manifest_connection_solid_step_part_count", 0) or 0
            ),
            "assembly_manifest_missing_connection_solid_step_part_count": int(
                connection.get("assembly_manifest_missing_connection_solid_step_part_count", 0) or 0
            ),
            "assembly_manifest_missing_connection_solid_step_part_names": connection.get(
                "assembly_manifest_missing_connection_solid_step_part_names", []
            ),
            "required_connection_count": int(connection.get("required_connection_count", 0) or 0),
            "passing_connection_count": int(connection.get("passing_connection_count", 0) or 0),
            "required_connection_terminal_marker_count": int(
                connection.get("required_connection_terminal_marker_count", 0) or 0
            ),
            "passing_connection_terminal_pair_count": int(
                connection.get("passing_connection_terminal_pair_count", 0) or 0
            ),
            "required_connection_solid_step_part_count": int(
                connection.get("required_connection_solid_step_part_count", 0) or 0
            ),
            "passing_connection_solid_step_part_set_count": int(
                connection.get("passing_connection_solid_step_part_set_count", 0) or 0
            ),
            "connection_solid_step_part_bytes_total": int(
                connection.get("connection_solid_step_part_bytes_total", 0) or 0
            ),
            "represented_net_count_total": int(
                connection.get("represented_net_count_total", 0) or 0
            ),
            "represented_route_record_count_total": int(
                connection.get("represented_route_record_count_total", 0) or 0
            ),
            "represented_route_records_with_layer_count_total": int(
                connection.get("represented_route_records_with_layer_count_total", 0) or 0
            ),
            "represented_route_records_with_source_domain_count_total": int(
                connection.get("represented_route_records_with_source_domain_count_total", 0)
                or 0
            ),
            "represented_route_records_with_route_class_count_total": int(
                connection.get("represented_route_records_with_route_class_count_total", 0) or 0
            ),
            "represented_route_classification_gap_count": int(
                connection.get("represented_route_classification_gap_count", 0) or 0
            ),
            "all_represented_routes_have_layer_source_and_class": bool(
                connection.get("all_represented_routes_have_layer_source_and_class", False)
            ),
            "connection_record_count": len(connection_records),
            "represented_net_list_total": represented_net_list_total,
            "all_connection_records_have_represented_nets": all(
                bool(item.get("represented_nets")) for item in connection_records
            ),
            "all_connection_represented_nets_match_routed_nets": represented_net_aliases_valid,
            "visual_route_span_total_mm": float(
                connection.get("visual_route_span_total_mm", 0) or 0
            ),
            "physical_medium_counts": connection.get("physical_medium_counts", {}),
            "electrical_class_counts": connection.get("electrical_class_counts", {}),
            "controlled_impedance_connection_count": int(
                connection.get("controlled_impedance_connection_count", 0) or 0
            ),
            "controlled_impedance_requirement_defined_count": int(
                connection.get("controlled_impedance_requirement_defined_count", 0) or 0
            ),
            "bend_radius_requirement_defined_count": int(
                connection.get("bend_radius_requirement_defined_count", 0) or 0
            ),
            "supplier_release_required_connection_count": int(
                connection.get("supplier_release_required_connection_count", 0) or 0
            ),
            "release_credit": bool(connection.get("release_credit") is True),
        },
        "kicad_cad_traceability": {
            "status": traceability.get("status", ""),
            "footprint_library_count": int(traceability.get("footprint_library_count", 0) or 0),
            "board_bound_instance_count": int(
                traceability.get("board_bound_instance_count", 0) or 0
            ),
            "step_footprint_instance_count": int(
                traceability.get("step_footprint_instance_count", 0) or 0
            ),
            "pinout_bound_footprint_count": int(
                traceability.get("pinout_bound_footprint_count", 0) or 0
            ),
            "all_pinout_bound_footprints_have_terminal_contract": bool(
                traceability.get("all_pinout_bound_footprints_have_terminal_contract", False)
            ),
            "cad_connection_count": int(traceability.get("cad_connection_count", 0) or 0),
            "cad_connection_represented_net_count_total": int(
                traceability.get("cad_connection_represented_net_count_total", 0) or 0
            ),
            "cad_connection_represented_route_count_total": int(
                traceability.get("cad_connection_represented_route_count_total", 0) or 0
            ),
            "cad_connection_represented_route_record_count_total": int(
                traceability.get("cad_connection_represented_route_record_count_total", 0) or 0
            ),
            "cad_connection_represented_route_records_with_layer_count_total": int(
                traceability.get(
                    "cad_connection_represented_route_records_with_layer_count_total", 0
                )
                or 0
            ),
            "cad_connection_represented_route_records_with_source_domain_count_total": int(
                traceability.get(
                    "cad_connection_represented_route_records_with_source_domain_count_total", 0
                )
                or 0
            ),
            "cad_connection_represented_route_records_with_route_class_count_total": int(
                traceability.get(
                    "cad_connection_represented_route_records_with_route_class_count_total", 0
                )
                or 0
            ),
            "cad_connection_represented_route_classification_gap_count": int(
                traceability.get("cad_connection_represented_route_classification_gap_count", 0)
                or 0
            ),
            "cad_connection_all_represented_routes_have_layer_source_and_class": bool(
                traceability.get(
                    "cad_connection_all_represented_routes_have_layer_source_and_class", False
                )
            ),
            "cad_connection_visual_route_span_total_mm": float(
                traceability.get("cad_connection_visual_route_span_total_mm", 0) or 0
            ),
            "cad_connection_terminal_marker_count": int(
                traceability.get("cad_connection_terminal_marker_count", 0) or 0
            ),
            "cad_connection_terminal_pair_count": int(
                traceability.get("cad_connection_terminal_pair_count", 0) or 0
            ),
            "cad_connection_solid_step_part_count": int(
                traceability.get("cad_connection_solid_step_part_count", 0) or 0
            ),
            "cad_connection_solid_step_part_set_count": int(
                traceability.get("cad_connection_solid_step_part_set_count", 0) or 0
            ),
            "cad_connection_solid_step_part_bytes_total": int(
                traceability.get("cad_connection_solid_step_part_bytes_total", 0) or 0
            ),
            "cad_connection_physical_medium_counts": traceability.get(
                "cad_connection_physical_medium_counts", {}
            ),
            "cad_connection_electrical_class_counts": traceability.get(
                "cad_connection_electrical_class_counts", {}
            ),
            "cad_connection_controlled_impedance_count": int(
                traceability.get("cad_connection_controlled_impedance_count", 0) or 0
            ),
            "cad_connection_controlled_impedance_requirement_defined_count": int(
                traceability.get("cad_connection_controlled_impedance_requirement_defined_count", 0)
                or 0
            ),
            "cad_connection_bend_radius_requirement_defined_count": int(
                traceability.get("cad_connection_bend_radius_requirement_defined_count", 0) or 0
            ),
            "cad_connection_supplier_release_required_count": int(
                traceability.get("cad_connection_supplier_release_required_count", 0) or 0
            ),
            "incomplete_footprint_count": int(
                traceability.get("incomplete_footprint_count", 0) or 0
            ),
            "incomplete_cad_connection_count": int(
                traceability.get("incomplete_cad_connection_count", 0) or 0
            ),
            "release_credit": bool(traceability.get("release_credit") is True),
        },
        "component_model_manifest_summary": {
            "status": component_manifest.get("status", ""),
            "component_model_count": int(component_manifest.get("component_model_count", 0) or 0),
            "supplier_approved_model_count": int(
                component_manifest.get("supplier_approved_model_count", 0) or 0
            ),
            "all_model_pad_counts_match_visuals": bool(
                model_binding.get("all_model_pad_counts_match_visuals", False)
            ),
            "visual_package_class_counts": visual_summary.get("visual_package_class_counts", {}),
            "total_electrical_pad_count": int(
                visual_summary.get("total_electrical_pad_count", 0) or 0
            ),
            "total_mechanical_pad_count": int(
                visual_summary.get("total_mechanical_pad_count", 0) or 0
            ),
            "total_pad_visual_count": int(visual_summary.get("total_pad_visual_count", 0) or 0),
            "all_models_have_visual_package_class": bool(
                visual_summary.get("all_models_have_visual_package_class", False)
            ),
            "all_package_visual_counts_match_step_intake": bool(
                visual_summary.get("all_package_visual_counts_match_step_intake", False)
            ),
            "pinout_bound_model_count": int(
                terminal_binding.get("pinout_bound_model_count", 0) or 0
            ),
            "support_pattern_model_count": int(
                terminal_binding.get("support_pattern_model_count", 0) or 0
            ),
            "models_with_terminal_contract_or_no_electrical_pads_count": int(
                terminal_binding.get("models_with_terminal_contract_or_no_electrical_pads_count", 0)
                or 0
            ),
            "total_pad_contract_visual_count": int(
                terminal_binding.get("total_pad_contract_visual_count", 0) or 0
            ),
            "uncovered_pad_visual_count": int(
                terminal_binding.get("uncovered_pad_visual_count", 0) or 0
            ),
            "all_model_pad_visuals_have_contract": bool(
                terminal_binding.get("all_model_pad_visuals_have_contract", False)
            ),
            "non_signal_pad_contract_count": int(
                terminal_binding.get("non_signal_pad_contract_count", 0) or 0
            ),
            "models_with_non_signal_pad_contract_count": int(
                terminal_binding.get("models_with_non_signal_pad_contract_count", 0) or 0
            ),
            "npth_mechanical_feature_contract_count": int(
                terminal_binding.get("npth_mechanical_feature_contract_count", 0) or 0
            ),
            "models_with_npth_mechanical_feature_contract_count": int(
                terminal_binding.get("models_with_npth_mechanical_feature_contract_count", 0) or 0
            ),
            "local_discrete_step_file_count": int(
                local_step_binding.get("local_discrete_step_file_count", 0) or 0
            ),
            "local_discrete_step_imported_solid_count": int(
                local_step_binding.get("local_discrete_step_imported_solid_count", 0) or 0
            ),
            "local_discrete_step_bbox_match_count": int(
                local_step_binding.get("local_discrete_step_bbox_match_count", 0) or 0
            ),
            "local_discrete_step_bytes_total": int(
                local_step_binding.get("local_discrete_step_bytes_total", 0) or 0
            ),
            "all_models_have_local_discrete_step_file": bool(
                local_step_binding.get("all_models_have_local_discrete_step_file", False)
            ),
            "all_local_discrete_step_hashes_match_files": bool(
                local_step_binding.get("all_local_discrete_step_hashes_match_files", False)
            ),
            "all_local_discrete_step_sizes_match_files": bool(
                local_step_binding.get("all_local_discrete_step_sizes_match_files", False)
            ),
            "all_local_discrete_steps_import_as_solids": bool(
                local_step_binding.get("all_local_discrete_steps_import_as_solids", False)
            ),
            "all_local_discrete_step_bboxes_match_envelopes": bool(
                local_step_binding.get("all_local_discrete_step_bboxes_match_envelopes", False)
            ),
            "all_pinout_bound_models_have_terminal_contract": bool(
                terminal_binding.get("all_pinout_bound_models_have_terminal_contract", False)
            ),
            "all_pinout_bound_model_contracts_match_pad_visuals": bool(
                terminal_binding.get("all_pinout_bound_model_contracts_match_pad_visuals", False)
            ),
            "all_support_pattern_models_have_explicit_provenance": bool(
                terminal_binding.get("all_support_pattern_models_have_explicit_provenance", False)
            ),
            "all_non_signal_pad_contracts_match_pad_visuals": bool(
                terminal_binding.get("all_non_signal_pad_contracts_match_pad_visuals", False)
            ),
            "all_npth_mechanical_features_have_contract": bool(
                terminal_binding.get("all_npth_mechanical_features_have_contract", False)
            ),
            "component_model_record_count": len(component_model_records),
            "component_model_record_manifest": component_model_records,
            "component_model_record_reference_count": len(
                {record["reference"] for record in component_model_records if record["reference"]}
            ),
            "all_component_model_records_have_local_step": bool(component_model_records)
            and all(record["local_discrete_step_file"] for record in component_model_records),
            "all_component_model_records_have_step_hash": bool(component_model_records)
            and all(record["local_discrete_step_sha256"] for record in component_model_records),
            "all_component_model_records_import_as_solids": bool(component_model_records)
            and all(
                record["local_discrete_step_imported_as_solid"]
                for record in component_model_records
            ),
            "all_component_model_records_match_step_envelope": bool(component_model_records)
            and all(
                record["local_discrete_step_bbox_matches_envelope"]
                for record in component_model_records
            ),
            "all_component_model_records_release_credit_false": bool(component_model_records)
            and all(record["release_credit"] is False for record in component_model_records),
            "release_allowed": bool(component_manifest.get("release_allowed") is True),
        },
        "component_model_directory_summary": {
            "status": component_dir_manifest.get("status", ""),
            "model_record_count": int(component_dir_manifest.get("model_record_count", 0) or 0),
            "component_model_count": int(
                component_dir_manifest.get("component_model_count", 0) or 0
            ),
            "supplier_approved_model_count": int(
                component_dir_manifest.get("supplier_approved_model_count", 0) or 0
            ),
            "pinout_bound_model_record_count": int(
                component_dir_manifest.get("pinout_bound_model_record_count", 0) or 0
            ),
            "support_pattern_model_record_count": int(
                component_dir_manifest.get("support_pattern_model_record_count", 0) or 0
            ),
            "terminal_contract_model_record_count": int(
                component_dir_manifest.get("terminal_contract_model_record_count", 0) or 0
            ),
            "terminal_contract_total_count": int(
                component_dir_manifest.get("terminal_contract_total_count", 0) or 0
            ),
            "total_pad_contract_visual_count": int(
                component_dir_manifest.get("total_pad_contract_visual_count", 0) or 0
            ),
            "uncovered_pad_visual_count": int(
                component_dir_manifest.get("uncovered_pad_visual_count", 0) or 0
            ),
            "all_model_pad_visuals_have_contract": bool(
                component_dir_manifest.get("all_model_pad_visuals_have_contract", False)
            ),
            "non_signal_pad_contract_total_count": int(
                component_dir_manifest.get("non_signal_pad_contract_total_count", 0) or 0
            ),
            "npth_mechanical_feature_contract_total_count": int(
                component_dir_manifest.get("npth_mechanical_feature_contract_total_count", 0) or 0
            ),
            "models_with_npth_mechanical_feature_contract_count": int(
                component_dir_manifest.get("models_with_npth_mechanical_feature_contract_count", 0)
                or 0
            ),
            "all_model_records_present": bool(
                component_dir_manifest.get("all_model_records_present", False)
            ),
            "all_model_records_source_routed_step_bound": bool(
                component_dir_manifest.get("all_model_records_source_routed_step_bound", False)
            ),
            "all_model_records_have_combined_step_locator": bool(
                component_dir_manifest.get("all_model_records_have_combined_step_locator", False)
            ),
            "all_model_records_have_local_discrete_step_file": bool(
                component_dir_manifest.get(
                    "all_model_records_have_local_discrete_step_file", False
                )
            ),
            "all_local_discrete_step_files_import_as_solids": bool(
                component_dir_manifest.get(
                    "all_local_discrete_step_files_import_as_solids", False
                )
            ),
            "all_local_discrete_step_bboxes_match_envelopes": bool(
                component_dir_manifest.get(
                    "all_local_discrete_step_bboxes_match_envelopes", False
                )
            ),
            "all_model_records_have_expected_supplier_step_file": bool(
                component_dir_manifest.get(
                    "all_model_records_have_expected_supplier_step_file", False
                )
            ),
            "local_discrete_step_imported_solid_count": int(
                component_dir_manifest.get("local_discrete_step_imported_solid_count", 0) or 0
            ),
            "local_discrete_step_bbox_match_count": int(
                component_dir_manifest.get("local_discrete_step_bbox_match_count", 0) or 0
            ),
            "local_discrete_step_file_count": int(
                component_dir_manifest.get("local_discrete_step_file_count", 0) or 0
            ),
            "local_discrete_step_bytes_total": int(
                component_dir_manifest.get("local_discrete_step_bytes_total", 0) or 0
            ),
            "missing_supplier_discrete_model_count": int(
                component_dir_manifest.get("missing_supplier_discrete_model_count", 0) or 0
            ),
            "supplier_step_intake_placeholder_count": int(
                component_dir_manifest.get("supplier_step_intake_placeholder_count", 0) or 0
            ),
            "supplier_step_intake_local_surrogate_count": int(
                component_dir_manifest.get("supplier_step_intake_local_surrogate_count", 0) or 0
            ),
            "supplier_step_intake_missing_count": int(
                component_dir_manifest.get("supplier_step_intake_missing_count", 0) or 0
            ),
            "supplier_step_intake_not_applicable_count": int(
                component_dir_manifest.get("supplier_step_intake_not_applicable_count", 0) or 0
            ),
            "supplier_step_intake_release_candidate_count": int(
                component_dir_manifest.get("supplier_step_intake_release_candidate_count", 0)
                or 0
            ),
            "supplier_step_intake_lane_counts": component_dir_manifest.get(
                "supplier_step_intake_lane_counts", {}
            ),
            "all_records_release_credit_false": bool(
                component_dir_manifest.get("all_records_release_credit_false", False)
            ),
            "all_pinout_bound_records_have_terminal_contract": bool(
                component_dir_manifest.get("all_pinout_bound_records_have_terminal_contract", False)
            ),
            "all_support_pattern_records_have_explicit_provenance": bool(
                component_dir_manifest.get(
                    "all_support_pattern_records_have_explicit_provenance", False
                )
            ),
            "all_terminal_contracts_match_pad_visuals": bool(
                component_dir_manifest.get("all_terminal_contracts_match_pad_visuals", False)
            ),
            "all_non_signal_pad_contracts_match_pad_visuals": bool(
                component_dir_manifest.get("all_non_signal_pad_contracts_match_pad_visuals", False)
            ),
            "all_npth_mechanical_features_have_contract": bool(
                component_dir_manifest.get("all_npth_mechanical_features_have_contract", False)
            ),
            "release_allowed": bool(component_dir_manifest.get("release_allowed") is True),
        },
        "component_3d_binding_gap_matrix": {
            "schema": component_binding_report.get("schema", ""),
            "status": component_binding_report.get("status", ""),
            "row_count": int(component_binding_report.get("row_count", 0) or 0),
            "csv_matrix": component_binding_report.get("csv_matrix", ""),
            "csv_matrix_sha256": component_binding_report.get("csv_matrix_sha256", ""),
            "csv_matrix_bytes": int(component_binding_report.get("csv_matrix_bytes", 0) or 0),
            "local_discrete_step_file_count": int(
                component_binding_report.get("local_discrete_step_file_count", 0) or 0
            ),
            "local_discrete_step_import_pass_count": int(
                component_binding_report.get("local_discrete_step_import_pass_count", 0) or 0
            ),
            "local_discrete_step_imported_solid_count": int(
                component_binding_report.get("local_discrete_step_imported_solid_count", 0) or 0
            ),
            "local_discrete_step_bbox_match_count": int(
                component_binding_report.get("local_discrete_step_bbox_match_count", 0) or 0
            ),
            "supplier_step_intake_status_counts": component_binding_report.get(
                "supplier_step_intake_status_counts", {}
            ),
            "supplier_lane_counts": component_binding_report.get("supplier_lane_counts", {}),
            "release_credit": bool(component_binding_report.get("release_credit") is True),
            "release_allowed": bool(component_binding_report.get("release_allowed") is True),
        },
        "local_candidate_can_satisfy_release_gate": False,
        "reason_not_release": (
            "Local routed-output candidate has routed development tracks, visible component "
            "envelopes, electrical terminal contracts, non-signal pad contracts, and CAD "
            "connection markers, but "
            "still lacks supplier-approved STEP/B-rep models, production DRC/ERC/SI/PI/RF, "
            "fabricator/assembler approval, and first-article evidence."
        ),
    }


def annotate_candidate_rows(
    rows: list[dict[str, Any]],
    candidate_manifest: dict[str, Any],
    candidate_manifest_path: Path,
) -> list[dict[str, Any]]:
    artifacts = candidate_artifacts(candidate_manifest)
    release_credit = bool(candidate_manifest.get("release_credit") is True)
    manifest_rel = display_rel(candidate_manifest_path) if artifacts else ""
    annotated: list[dict[str, Any]] = []
    for row in rows:
        candidate = artifacts.get(row["path"])
        candidate_present_blocked = bool(candidate and row.get("present") and not release_credit)
        annotated.append(
            {
                **row,
                "candidate_present_blocked": candidate_present_blocked,
                "candidate_manifest": manifest_rel if candidate else "",
                "candidate_release_credit": release_credit if candidate else None,
            }
        )
    return annotated


def flatten_exact_nets(node: Any) -> list[str]:
    nets: list[str] = []
    if isinstance(node, dict):
        for value in node.values():
            nets.extend(flatten_exact_nets(value))
    elif isinstance(node, list):
        nets.extend(str(item) for item in node)
    return nets


def path_presence(path_text: str, source_present: bool | None = None) -> dict[str, Any]:
    resolved = resolve_repo_path(path_text)
    exists = resolved.exists()
    kind = "missing"
    if resolved.is_file():
        kind = "file"
    elif resolved.is_dir():
        kind = "directory"
    return {
        "path": path_text,
        "resolved_path": display_rel(resolved),
        "present": exists,
        "artifact_kind": kind,
        "source_declared_present": source_present,
    }


def dedupe_by_path(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_path: dict[str, dict[str, Any]] = {}
    for row in rows:
        path = row["path"]
        existing = by_path.setdefault(path, {**row, "source_ids": [], "required_statuses": []})
        source_id = row.get("source_id")
        if source_id and source_id not in existing["source_ids"]:
            existing["source_ids"].append(source_id)
        required_status = row.get("required_status")
        if required_status and required_status not in existing["required_statuses"]:
            existing["required_statuses"].append(required_status)
        existing["present"] = bool(existing["present"] or row["present"])
        if existing["artifact_kind"] == "missing" and row["artifact_kind"] != "missing":
            existing["artifact_kind"] = row["artifact_kind"]
    return [by_path[path] for path in sorted(by_path)]


def collect_required_outputs(
    burndown: dict[str, Any], release_plan: dict[str, Any]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in burndown.get("required_kicad_routed_board_outputs", []):
        if not isinstance(item, dict):
            continue
        row = path_presence(str(item["path"]), item.get("present"))
        rows.append(
            {
                **row,
                "source": "routed-layout-si-drc-burndown.required_kicad_routed_board_outputs",
                "source_id": item.get("id"),
                "required_status": item.get("required_status"),
            }
        )
    for domain in burndown.get("route_domains", []):
        for output in domain.get("required_route_outputs", []):
            row = path_presence(str(output))
            rows.append(
                {
                    **row,
                    "source": "routed-layout-si-drc-burndown.route_domains.required_route_outputs",
                    "source_id": domain.get("id"),
                    "required_status": "domain_acceptance_required",
                }
            )
    manifest = release_plan.get("required_release_output_manifest", {})
    for output_id, item in manifest.items():
        if not isinstance(item, dict) or not item.get("release_required", False):
            continue
        row = path_presence(str(item["expected_path"]), item.get("present"))
        rows.append(
            {
                **row,
                "source": "routed-release-plan.required_release_output_manifest",
                "source_id": output_id,
                "required_status": item.get("blocker"),
                "owner": item.get("owner"),
            }
        )
    return dedupe_by_path(rows)


def collect_validation_evidence(burndown: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for evidence_id, evidence in burndown.get("validation_evidence_required", {}).items():
        if not isinstance(evidence, dict):
            continue
        artifacts = []
        for artifact in evidence.get("required_artifacts", []):
            artifacts.append(path_presence(str(artifact)))
        missing = [item["path"] for item in artifacts if not item["present"]]
        rows.append(
            {
                "id": evidence_id,
                "acceptance_rule": evidence.get("acceptance_rule"),
                "source_declared_present": evidence.get("present"),
                "present": not missing and bool(artifacts),
                "required_artifacts": artifacts,
                "missing_artifacts": missing,
            }
        )
    return rows


def first_matching_unblock_action(
    release_plan: dict[str, Any], missing_outputs: list[str], current_blockers: list[str]
) -> str:
    for step in release_plan.get("order_of_operations", []):
        exit_outputs = [str(item) for item in step.get("exit_outputs", [])]
        if any(output in missing_outputs for output in exit_outputs):
            actions = step.get("actions", [])
            return str(
                actions[0] if actions else step.get("current_status", "complete prior blocked step")
            )
    return (
        current_blockers[0]
        if current_blockers
        else "complete the first blocked routed-release prerequisite"
    )


def route_domain_rows(
    route_inventory: dict[str, Any],
    burndown: dict[str, Any],
    release_plan: dict[str, Any],
) -> list[dict[str, Any]]:
    inventory_by_id = {
        item.get("id"): item
        for item in route_inventory.get("route_domain_net_inventory", [])
        if isinstance(item, dict)
    }
    route_requirements = release_plan.get("route_completion_requirements", {})
    rows: list[dict[str, Any]] = []
    for domain in burndown.get("route_domains", []):
        domain_id = str(domain["id"])
        inventory = inventory_by_id.get(domain_id, {})
        exact_nets = sorted(set(flatten_exact_nets(domain.get("exact_nets", {}))))
        missing_nets = sorted(set(inventory.get("missing_exact_nets", [])))
        present_count = inventory.get(
            "exact_nets_present_count", len(exact_nets) - len(missing_nets)
        )
        outputs = [
            path_presence(str(output)) for output in domain.get("required_route_outputs", [])
        ]
        missing_outputs = [output["path"] for output in outputs if not output["present"]]
        evidence = []
        for requirement_id in DOMAIN_REQUIREMENT_HINTS.get(domain_id, ()):
            requirement = route_requirements.get(requirement_id)
            if isinstance(requirement, dict):
                evidence.append(
                    {
                        "id": requirement_id,
                        "required_nets": requirement.get("required_nets", []),
                        "required_evidence": requirement.get("required_evidence", []),
                    }
                )
        current_blockers = [str(item) for item in domain.get("current_blockers", [])]
        rows.append(
            {
                "id": domain_id,
                "owner": domain.get("owner"),
                "source_status": domain.get("status"),
                "route_classes": domain.get("route_classes", []),
                "route_regions": domain.get("route_regions", []),
                "required_exact_net_count": len(exact_nets),
                "present_exact_net_count": present_count,
                "missing_exact_net_count": len(missing_nets),
                "missing_exact_nets": missing_nets,
                "alias_satisfied_exact_net_count": inventory.get(
                    "alias_satisfied_exact_net_count", 0
                ),
                "alias_satisfied_exact_nets": inventory.get("alias_satisfied_exact_nets", []),
                "required_production_outputs": outputs,
                "missing_production_outputs": missing_outputs,
                "required_acceptance_evidence": evidence,
                "current_blockers": current_blockers,
                "current_presence": {
                    "nets_complete": not missing_nets,
                    "required_outputs_complete": not missing_outputs,
                    "route_execution_ready": False,
                    "release_accepted": False,
                },
                "next_unblock_action": first_matching_unblock_action(
                    release_plan, missing_outputs, current_blockers
                ),
            }
        )
    return rows


def build_report(
    route_inventory_path: Path,
    burndown_path: Path,
    release_plan_path: Path,
    yaml_report_path: Path,
    md_report_path: Path,
    candidate_manifest_path: Path = DEFAULT_CANDIDATE_MANIFEST,
) -> dict[str, Any]:
    route_inventory = read_yaml(route_inventory_path)
    burndown = read_yaml(burndown_path)
    release_plan = read_yaml(release_plan_path)

    domains = route_domain_rows(route_inventory, burndown, release_plan)
    candidate_manifest = load_candidate_manifest(candidate_manifest_path)
    candidate_context = candidate_end_to_end_context(candidate_manifest, candidate_manifest_path)
    required_outputs = annotate_candidate_rows(
        collect_required_outputs(burndown, release_plan),
        candidate_manifest,
        candidate_manifest_path,
    )
    validation_evidence = collect_validation_evidence(burndown)
    missing_outputs = [row for row in required_outputs if not row["present"]]
    candidate_present_blocked_outputs = [
        row for row in required_outputs if row.get("candidate_present_blocked") is True
    ]
    truly_missing_outputs = [
        row for row in missing_outputs if row.get("candidate_present_blocked") is not True
    ]
    missing_evidence = [row for row in validation_evidence if not row["present"]]
    domains_with_missing_nets = [row for row in domains if row["missing_exact_net_count"]]
    domains_with_missing_outputs = [row for row in domains if row["missing_production_outputs"]]

    forbidden_claims = sorted(
        set(route_inventory.get("forbidden_claims", []))
        | set(burndown.get("forbidden_claims", []))
        | set(release_plan.get("forbidden_claims", []))
    )
    development_snapshot = route_inventory.get("development_route_snapshot", {})
    development_route_context = {
        "present": bool(development_snapshot.get("present")),
        "board_file": development_snapshot.get("board_file"),
        "route_count": development_snapshot.get("route_count", 0),
        "segment_count": development_snapshot.get("segment_count", 0),
        "via_count": development_snapshot.get("via_count", 0),
        "controlled_impedance_route_count": development_snapshot.get(
            "controlled_impedance_route_count", 0
        ),
        "route_classification_gap_count": development_snapshot.get(
            "route_classification_gap_count", 0
        ),
        "route_segment_trace_bound_count": development_snapshot.get(
            "route_segment_trace_bound_count", 0
        ),
        "missing_nets": development_snapshot.get("missing_nets", []),
        "release_credit": False,
        "reason_not_release": development_snapshot.get(
            "reason_not_release", "development_routing_visualization_not_release"
        ),
    }

    return {
        "schema": "eliza.e1_phone_routed_board_release_acceptance_matrix.v1",
        "status": "blocked_fail_closed_routed_board_release_acceptance_not_met",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Fail-closed acceptance matrix generated from routed-board source inventories. "
            "This is not a routed PCB, DRC/ERC result, SI/PI/RF signoff, manufacturing package, "
            "routed STEP, enclosure release, factory release, or end-to-end phone readiness claim."
        ),
        "inputs": {
            "kicad_route_readiness_inventory": display_rel(route_inventory_path),
            "routed_layout_si_drc_burndown": display_rel(burndown_path),
            "routed_release_plan": display_rel(release_plan_path),
            "routed_output_candidate_manifest": display_rel(candidate_manifest_path),
            "yaml_report_path": display_rel(yaml_report_path),
            "markdown_report_path": display_rel(md_report_path),
            "source_statuses": {
                "kicad_route_readiness_inventory": route_inventory.get("status"),
                "routed_layout_si_drc_burndown": burndown.get("status"),
                "routed_release_plan": release_plan.get("status"),
            },
        },
        "summary": {
            "route_domain_count": len(domains),
            "domains_with_missing_exact_nets": len(domains_with_missing_nets),
            "domains_with_missing_production_outputs": len(domains_with_missing_outputs),
            "required_output_path_count": len(required_outputs),
            "missing_required_output_path_count": len(missing_outputs),
            "candidate_present_blocked_required_output_path_count": len(
                candidate_present_blocked_outputs
            ),
            "truly_missing_required_output_path_count": len(truly_missing_outputs),
            "candidate_board_matches_real_footprint_source": candidate_context[
                "routed_candidate_source_binding"
            ]["candidate_matches_source_board"],
            "candidate_board_placeholder_marker_count": candidate_context[
                "routed_candidate_source_binding"
            ]["candidate_placeholder_marker_count"],
            "candidate_board_legacy_e1phone_footprint_ref_count": candidate_context[
                "routed_candidate_source_binding"
            ]["candidate_legacy_e1phone_footprint_ref_count"],
            "candidate_step_size_bytes": candidate_context["source_step_size_bytes"],
            "candidate_step_component_model_count": candidate_context[
                "component_model_manifest_summary"
            ]["component_model_count"],
            "candidate_step_pinout_bound_model_count": candidate_context[
                "component_model_manifest_summary"
            ]["pinout_bound_model_count"],
            "candidate_step_cad_connection_count": candidate_context["cad_connection_coverage"][
                "passing_connection_count"
            ],
            "candidate_step_cad_connection_terminal_marker_count": candidate_context[
                "cad_connection_coverage"
            ]["required_connection_terminal_marker_count"],
            "candidate_step_cad_connection_terminal_pair_count": candidate_context[
                "cad_connection_coverage"
            ]["passing_connection_terminal_pair_count"],
            "validation_evidence_category_count": len(validation_evidence),
            "missing_validation_evidence_category_count": len(missing_evidence),
            "development_route_count": development_route_context["route_count"],
            "development_segment_count": development_route_context["segment_count"],
            "development_via_count": development_route_context["via_count"],
            "development_route_classification_gap_count": development_route_context[
                "route_classification_gap_count"
            ],
            "development_missing_net_count": len(development_route_context["missing_nets"]),
            "release_state": "blocked_fail_closed",
            "acceptance_allowed": False,
        },
        "fail_closed_policy": {
            "route_execution_ready": False,
            "routed_release_accepted": False,
            "fabrication_ready": False,
            "enclosure_ready": False,
            "factory_ready": False,
            "end_to_end_phone_ready": False,
            "acceptance_unlock_requires_all_route_domains_outputs_and_validation_evidence_present": True,
        },
        "candidate_end_to_end_context": candidate_context,
        "development_route_context": development_route_context,
        "route_domain_acceptance_matrix": domains,
        "required_production_outputs": required_outputs,
        "missing_production_outputs": missing_outputs,
        "candidate_present_blocked_required_outputs": candidate_present_blocked_outputs,
        "truly_missing_required_outputs": truly_missing_outputs,
        "required_acceptance_evidence": validation_evidence,
        "next_global_unblock_actions": [
            step
            for step in release_plan.get("order_of_operations", [])
            if str(step.get("current_status", "")).startswith("blocked")
        ],
        "forbidden_claims": forbidden_claims,
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# E1 Phone Routed-Board Release Acceptance Matrix",
        "",
        f"Date: {report['date']}",
        "",
        f"Status: `{report['status']}`",
        "",
        report["claim_boundary"],
        "",
        "## Summary",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
    ]
    for key, value in report["summary"].items():
        lines.append(f"| `{key}` | `{value}` |")
    candidate = report["candidate_end_to_end_context"]
    candidate_visual = candidate["routed_step_visual_detail"]
    candidate_connection = candidate["cad_connection_coverage"]
    candidate_models = candidate["component_model_manifest_summary"]
    candidate_model_dir = candidate["component_model_directory_summary"]
    candidate_binding = candidate["component_3d_binding_gap_matrix"]
    lines.extend(
        [
            "",
            "## Local Routed Candidate Context",
            "",
            "| Item | Value |",
            "| --- | ---: |",
            f"| Status | `{candidate['status']}` |",
            f"| Release credit | `{candidate['release_credit']}` |",
            f"| STEP bytes | `{candidate['source_step_size_bytes']}` |",
            f"| Component envelopes | `{candidate_visual['footprint_envelope_count']}` |",
            f"| Pad/contact visuals | `{candidate_visual['pad_contact_visual_count']}` |",
            f"| Route segment visuals | `{candidate_visual['route_segment_visual_count']}` |",
            f"| Via visuals | `{candidate_visual['board_via_count']}` |",
            f"| CAD connections passing | `{candidate_connection['passing_connection_count']}` |",
            "| CAD endpoint terminal markers | "
            f"`{candidate_connection['required_connection_terminal_marker_count']}` |",
            "| CAD terminal pairs passing | "
            f"`{candidate_connection['passing_connection_terminal_pair_count']}` |",
            "| CAD connection STEP parts | "
            f"`{candidate_connection['required_connection_solid_step_part_count']}` |",
            "| CAD connection STEP part sets passing | "
            f"`{candidate_connection['passing_connection_solid_step_part_set_count']}` |",
            f"| CAD represented nets | `{candidate_connection['represented_net_count_total']}` |",
            f"| CAD connection records | `{candidate_connection['connection_record_count']}` |",
            f"| CAD represented net list entries | `{candidate_connection['represented_net_list_total']}` |",
            "| CAD represented nets match routed nets | "
            f"`{candidate_connection['all_connection_represented_nets_match_routed_nets']}` |",
            f"| CAD visual route span mm | `{candidate_connection['visual_route_span_total_mm']}` |",
            "| CAD controlled-impedance connections | "
            f"`{candidate_connection['controlled_impedance_connection_count']}` |",
            "| CAD controlled-impedance requirements defined | "
            f"`{candidate_connection['controlled_impedance_requirement_defined_count']}` |",
            "| CAD bend-radius requirements defined | "
            f"`{candidate_connection['bend_radius_requirement_defined_count']}` |",
            "| CAD supplier-release-required connections | "
            f"`{candidate_connection['supplier_release_required_connection_count']}` |",
            f"| Component model rows | `{candidate_models['component_model_count']}` |",
            f"| Component pad visuals | `{candidate_models['total_pad_visual_count']}` |",
            f"| Electrical pads represented | `{candidate_models['total_electrical_pad_count']}` |",
            f"| Mechanical pads represented | `{candidate_models['total_mechanical_pad_count']}` |",
            f"| Pinout-bound model rows | `{candidate_models['pinout_bound_model_count']}` |",
            f"| Support-pattern model rows | `{candidate_models['support_pattern_model_count']}` |",
            "| Models with terminal contracts or no electrical pads | "
            f"`{candidate_models['models_with_terminal_contract_or_no_electrical_pads_count']}` |",
            f"| Non-signal pad contracts | `{candidate_models['non_signal_pad_contract_count']}` |",
            "| Models with non-signal pad contracts | "
            f"`{candidate_models['models_with_non_signal_pad_contract_count']}` |",
            "| NPTH mechanical feature contracts | "
            f"`{candidate_models['npth_mechanical_feature_contract_count']}` |",
            "| Models with NPTH mechanical feature contracts | "
            f"`{candidate_models['models_with_npth_mechanical_feature_contract_count']}` |",
            f"| Local per-reference model records | `{candidate_model_dir['model_record_count']}` |",
            "| Directory pinout-bound model records | "
            f"`{candidate_model_dir['pinout_bound_model_record_count']}` |",
            "| Directory support-pattern model records | "
            f"`{candidate_model_dir['support_pattern_model_record_count']}` |",
            "| Directory records with terminal contracts | "
            f"`{candidate_model_dir['terminal_contract_model_record_count']}` |",
            "| Directory terminal contracts | "
            f"`{candidate_model_dir['terminal_contract_total_count']}` |",
            "| Directory non-signal pad contracts | "
            f"`{candidate_model_dir['non_signal_pad_contract_total_count']}` |",
            "| Directory NPTH mechanical feature contracts | "
            f"`{candidate_model_dir['npth_mechanical_feature_contract_total_count']}` |",
            "| Directory records with NPTH mechanical contracts | "
            f"`{candidate_model_dir['models_with_npth_mechanical_feature_contract_count']}` |",
            "| Directory pinout records terminal-bound | "
            f"`{candidate_model_dir['all_pinout_bound_records_have_terminal_contract']}` |",
            "| Directory support records provenance-bound | "
            f"`{candidate_model_dir['all_support_pattern_records_have_explicit_provenance']}` |",
            "| Directory terminal contracts match visuals | "
            f"`{candidate_model_dir['all_terminal_contracts_match_pad_visuals']}` |",
            "| Directory non-signal contracts match visuals | "
            f"`{candidate_model_dir['all_non_signal_pad_contracts_match_pad_visuals']}` |",
            "| Directory NPTH contracts match footprints | "
            f"`{candidate_model_dir['all_npth_mechanical_features_have_contract']}` |",
            f"| Component 3D binding rows | `{candidate_binding['row_count']}` |",
            "| Component 3D binding local STEP files | "
            f"`{candidate_binding['local_discrete_step_file_count']}` |",
            "| Component 3D binding local STEP imported solids | "
            f"`{candidate_binding['local_discrete_step_imported_solid_count']}` |",
            "| Component 3D binding supplier intake statuses | "
            f"`{candidate_binding['supplier_step_intake_status_counts']}` |",
            "| Component 3D binding release credit | "
            f"`{candidate_binding['release_credit']}` |",
            f"| Supplier-approved model rows | `{candidate_models['supplier_approved_model_count']}` |",
            "",
            candidate["reason_not_release"],
        ]
    )
    lines.extend(
        [
            "",
            "## Route Domains",
            "",
            "| Domain | Missing nets | Missing outputs | Next unblock action |",
            "| --- | ---: | ---: | --- |",
        ]
    )
    for domain in report["route_domain_acceptance_matrix"]:
        lines.append(
            "| `{id}` | {nets} | {outputs} | {action} |".format(
                id=domain["id"],
                nets=domain["missing_exact_net_count"],
                outputs=len(domain["missing_production_outputs"]),
                action=str(domain["next_unblock_action"]).replace("|", "\\|"),
            )
        )
    lines.extend(
        [
            "",
            "## Required Acceptance Evidence",
            "",
            "| Evidence | Present | Missing artifacts | Acceptance rule |",
            "| --- | --- | ---: | --- |",
        ]
    )
    for evidence in report["required_acceptance_evidence"]:
        lines.append(
            "| `{id}` | `{present}` | {missing} | {rule} |".format(
                id=evidence["id"],
                present=evidence["present"],
                missing=len(evidence["missing_artifacts"]),
                rule=str(evidence["acceptance_rule"]).replace("|", "\\|"),
            )
        )
    lines.extend(
        [
            "",
            "## Fail-Closed Claims",
            "",
            "Acceptance remains blocked. Forbidden claims include:",
            "",
        ]
    )
    lines.extend(f"- `{claim}`" for claim in report["forbidden_claims"])
    lines.append("")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--route-inventory", type=Path, default=DEFAULT_ROUTE_INVENTORY)
    parser.add_argument("--burndown", type=Path, default=DEFAULT_BURNDOWN)
    parser.add_argument("--release-plan", type=Path, default=DEFAULT_RELEASE_PLAN)
    parser.add_argument("--candidate-manifest", type=Path, default=DEFAULT_CANDIDATE_MANIFEST)
    parser.add_argument("--yaml-report", type=Path, default=DEFAULT_YAML_REPORT)
    parser.add_argument("--md-report", type=Path, default=DEFAULT_MD_REPORT)
    parser.add_argument("--write-report", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(
        args.route_inventory,
        args.burndown,
        args.release_plan,
        args.yaml_report,
        args.md_report,
        args.candidate_manifest,
    )
    yaml_text = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False, width=100)
    md_text = render_markdown(report)
    if args.write_report:
        args.yaml_report.parent.mkdir(parents=True, exist_ok=True)
        args.yaml_report.write_text(yaml_text, encoding="utf-8")
        args.md_report.write_text(md_text, encoding="utf-8")
    else:
        print(yaml_text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
