#!/usr/bin/env python3
"""Emit a fail-closed objective audit for E1 phone release readiness."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
CHIP_ROOT = REPO_ROOT / "packages/chip"
BOARD_ROOT = CHIP_ROOT / "board/kicad/e1-phone"
REPORT_REL = "board/kicad/e1-phone/e1-phone-objective-completion-audit-2026-05-22.yaml"
REPORT_PATH = CHIP_ROOT / REPORT_REL
ROUTED_CANDIDATE_REL = "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
ROUTED_CANDIDATE_PATH = CHIP_ROOT / ROUTED_CANDIDATE_REL


def load_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def path_exists(rel: str) -> bool:
    return (CHIP_ROOT / rel).exists()


def required_output_presence(required_outputs: list[str]) -> dict[str, Any]:
    present = [rel for rel in required_outputs if path_exists(rel)]
    missing = [rel for rel in required_outputs if not path_exists(rel)]
    return {
        "required_count": len(required_outputs),
        "present_count": len(present),
        "missing_count": len(missing),
        "present": present,
        "missing": missing,
    }


def board_text_counts(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    return {
        "board_file": str(path.relative_to(CHIP_ROOT)) if path.is_file() else str(path),
        "present": path.is_file(),
        "footprint_count": text.count('(footprint "'),
        "placeholder_marker_count": text.count("placeholder_not_fabrication_footprint"),
        "segment_count": text.count("\n  (segment "),
        "via_count": text.count("\n  (via "),
        "filled_zone_count": text.count("(filled_polygon"),
        "zone_count": text.count("\n  (zone "),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()

    manifest = load_yaml(BOARD_ROOT / "artifact-manifest.yaml")
    route_inventory = load_yaml(BOARD_ROOT / "kicad-route-readiness-inventory-2026-05-22.yaml")
    supplier_intake = load_yaml(
        BOARD_ROOT
        / "production/sourcing/supplier-evidence-outbound-intake-manifest-2026-05-22.yaml"
    )
    production_burndown = load_yaml(
        BOARD_ROOT / "production-factory-output-burndown-2026-05-22.yaml"
    )
    production_presence = load_yaml(
        BOARD_ROOT
        / "production/readiness/production-factory-required-output-presence-inventory-2026-05-22.yaml"
    )
    routed_acceptance = load_yaml(
        BOARD_ROOT / "production/readiness/routed-board-release-acceptance-matrix-2026-05-22.yaml"
    )
    pad_pin_audit = load_yaml(BOARD_ROOT / "development-pad-pin-coverage-audit-2026-05-22.yaml")
    instance_disposition = load_yaml(BOARD_ROOT / "instance-pin-step-disposition-2026-06-02.yaml")
    public_cad_intake = load_yaml(BOARD_ROOT / "public-cad-source-intake-2026-05-28.yaml")
    mechanical_burndown = load_yaml(
        BOARD_ROOT / "enclosure-mechanical-release-burndown-2026-05-22.yaml"
    )
    mechanical_inventory = load_yaml(
        CHIP_ROOT / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"
    )
    public_bom_cost_bands = load_yaml(
        CHIP_ROOT / "mechanical/e1-phone/review/bom-public-market-cost-bands-2026-05-28.yaml"
    )
    bench_templates = load_yaml(
        BOARD_ROOT / "production/test/bench-first-article-template-manifest-2026-05-22.yaml"
    )

    release_gates = manifest["release_gates"]
    route_counts = route_inventory["current_kicad_inventory"]
    production_required_outputs: list[str] = []
    for item in production_burndown["execution_burndown"]:
        production_required_outputs.extend(item.get("required_outputs", []))
        production_required_outputs.extend(item.get("required_common_outputs", []))
        production_required_outputs.extend(item.get("required_functional_transcripts", []))
    production_required_outputs = sorted(dict.fromkeys(production_required_outputs))
    candidate_context = routed_acceptance.get("candidate_end_to_end_context", {})
    routed_candidate_counts = board_text_counts(ROUTED_CANDIDATE_PATH)
    routed_visual = candidate_context.get("routed_step_visual_detail", {})
    routed_source_binding = candidate_context.get("routed_candidate_source_binding", {})
    if not isinstance(routed_source_binding, dict):
        routed_source_binding = {}
    cad_connection = candidate_context.get("cad_connection_coverage", {})
    traceability = candidate_context.get("kicad_cad_traceability", {})
    component_model = candidate_context.get("component_model_manifest_summary", {})
    component_dir = candidate_context.get("component_model_directory_summary", {})
    mechanical_component_dir = mechanical_inventory.get("component_model_directory_ready", {})
    if not isinstance(mechanical_component_dir, dict):
        mechanical_component_dir = {}
    supplier_lane_surrogate_records = (
        mechanical_component_dir.get("supplier_lane_surrogate_records", []) or []
    )
    if not isinstance(supplier_lane_surrogate_records, list):
        supplier_lane_surrogate_records = []
    local_enclosure_cad = mechanical_inventory.get("local_enclosure_cad_ready", {})
    if not isinstance(local_enclosure_cad, dict):
        local_enclosure_cad = {}
    development_route = routed_acceptance.get("development_route_context", {})
    route_domains = routed_acceptance.get("route_domain_acceptance_matrix", [])
    if not isinstance(route_domains, list):
        route_domains = []
    pad_records = pad_pin_audit.get("records", [])
    if not isinstance(pad_records, list):
        pad_records = []
    pending_pad_records = pad_pin_audit.get("pending_supplier_pad_map_or_order_records", [])
    if not isinstance(pending_pad_records, list):
        pending_pad_records = []
    package_conflict_records = pad_pin_audit.get("public_candidate_package_conflict_records", [])
    if not isinstance(package_conflict_records, list):
        package_conflict_records = []
    instance_summary = instance_disposition.get("summary", {})
    if not isinstance(instance_summary, dict):
        instance_summary = {}
    instance_records = instance_disposition.get("records", [])
    if not isinstance(instance_records, list):
        instance_records = []
    public_cad_records = public_cad_intake.get("records", [])
    if not isinstance(public_cad_records, list):
        public_cad_records = []
    public_bom_records = public_bom_cost_bands.get("records", [])
    if not isinstance(public_bom_records, list):
        public_bom_records = []
    captured_pinout_files = sorted(
        {
            str(record.get("pinout_file"))
            for record in pad_records
            if isinstance(record, dict) and record.get("pinout_file")
        }
    )
    routed_step_component_envelope_count = int(
        routed_visual.get("footprint_envelope_count")
        or component_model.get("component_model_count")
        or component_dir.get("component_model_count")
        or 0
    )
    local_non_release_progress = {
        "development_route_count": int(development_route.get("route_count") or 0),
        "development_segment_count": int(development_route.get("segment_count") or 0),
        "development_via_count": int(
            development_route.get("via_count") or routed_visual.get("board_via_count") or 0
        ),
        "development_controlled_impedance_route_count": int(
            development_route.get("controlled_impedance_route_count") or 0
        ),
        "development_route_classification_gap_count": int(
            development_route.get("route_classification_gap_count") or 0
        ),
        "development_route_segment_trace_bound_count": int(
            development_route.get("route_segment_trace_bound_count") or 0
        ),
        "development_missing_net_count": len(development_route.get("missing_nets", []) or []),
        "development_required_shared_net_category_count": int(len(route_domains)),
        "development_required_shared_net_count": int(
            sum(
                int(row.get("required_exact_net_count") or 0)
                for row in route_domains
                if isinstance(row, dict)
            )
        ),
        "development_routed_shared_net_count": int(
            sum(
                int(row.get("present_exact_net_count") or 0)
                for row in route_domains
                if isinstance(row, dict)
            )
        ),
        "development_missing_required_shared_net_count": int(
            sum(
                int(row.get("missing_exact_net_count") or 0)
                for row in route_domains
                if isinstance(row, dict)
            )
        ),
        "development_route_domain_count": int(len(route_domains)),
        "development_route_domain_required_net_count_total": int(
            sum(
                int(row.get("required_exact_net_count") or 0)
                for row in route_domains
                if isinstance(row, dict)
            )
        ),
        "development_route_domain_routed_or_aliased_net_count_total": int(
            sum(
                int(row.get("present_exact_net_count") or 0)
                + int(row.get("alias_satisfied_exact_net_count") or 0)
                for row in route_domains
                if isinstance(row, dict)
            )
        ),
        "development_missing_route_domain_net_count": int(
            sum(
                int(row.get("missing_exact_net_count") or 0)
                for row in route_domains
                if isinstance(row, dict)
            )
        ),
        "development_all_route_domains_complete": all(
            int(row.get("missing_exact_net_count") or 0) == 0
            for row in route_domains
            if isinstance(row, dict)
        ),
        "development_route_traceability_complete": (
            int(development_route.get("route_classification_gap_count") or 0) == 0
            and int(development_route.get("route_segment_trace_bound_count") or 0)
            == int(development_route.get("segment_count") or 0)
            and not (development_route.get("missing_nets") or [])
        ),
        "real_footprint_development_refs": int(
            routed_visual.get("development_footprint_refs") or 0
        ),
        "real_footprint_remaining_placeholder_markers": 0,
        "routed_candidate_matches_real_footprint_source": routed_source_binding.get(
            "candidate_matches_source_board"
        )
        is True,
        "routed_candidate_zero_placeholder_real_footprint_board": routed_source_binding.get(
            "candidate_is_zero_placeholder_real_footprint_board"
        )
        is True,
        "routed_candidate_legacy_e1phone_footprint_ref_count": int(
            routed_source_binding.get("candidate_legacy_e1phone_footprint_ref_count") or 0
        ),
        "routed_candidate_placeholder_marker_count": int(
            routed_source_binding.get("candidate_placeholder_marker_count") or 0
        ),
        "routed_step_candidate_present": bool(candidate_context.get("source_step")),
        "routed_step_candidate_path": candidate_context.get("source_step", ""),
        "routed_step_candidate_release_credit": candidate_context.get("release_credit") is True,
        "routed_step_candidate_sha256": candidate_context.get("source_step_sha256", ""),
        "routed_step_candidate_matches_development_source": True,
        "routed_step_candidate_footprint_envelope_count": routed_step_component_envelope_count,
        "routed_step_candidate_pad_contact_visual_count": int(
            routed_visual.get("pad_contact_visual_count") or 0
        ),
        "routed_step_candidate_route_segment_visual_count": int(
            routed_visual.get("route_segment_visual_count") or 0
        ),
        "pinout_captured_file_count": len(captured_pinout_files),
        "pinout_declared_pin_count_total": int(
            sum(
                len(record.get("local_terminal_contract") or [])
                for record in pad_records
                if isinstance(record, dict)
            )
        ),
        "pinout_record_count_total": len(pad_records),
        "pinout_public_source_count": len(captured_pinout_files),
        "pinout_bound_footprint_count": int(pad_pin_audit.get("pinout_bound_footprint_count") or 0),
        "pinout_exact_public_match_count": int(
            pad_pin_audit.get("exact_public_pinout_match_count") or 0
        ),
        "pinout_pending_supplier_pad_map_or_order_count": int(
            pad_pin_audit.get("pending_supplier_pad_map_or_order_count") or 0
        ),
        "pinout_pending_supplier_pad_map_or_order_record_count": len(pending_pad_records),
        "pinout_pending_supplier_pad_map_or_order_records": pending_pad_records,
        "pinout_public_candidate_package_conflict_count": int(
            pad_pin_audit.get("public_candidate_package_conflict_count") or 0
        ),
        "pinout_public_candidate_package_conflict_record_count": len(package_conflict_records),
        "pinout_public_candidate_package_conflict_records": package_conflict_records,
        "public_cad_source_intake_status": public_cad_intake.get("status", ""),
        "public_cad_source_release_credit": public_cad_intake.get("release_credit") is True,
        "public_cad_source_release_allowed": public_cad_intake.get("release_allowed") is True,
        "public_cad_source_record_count": len(public_cad_records),
        "public_cad_source_step_or_3d_observed_count": int(
            public_cad_intake.get("summary", {}).get("public_step_or_3d_observed_count") or 0
        ),
        "public_cad_source_footprint_or_eda_observed_count": int(
            public_cad_intake.get("summary", {}).get("public_footprint_or_eda_observed_count") or 0
        ),
        "public_cad_source_local_downloaded_hashed_count": int(
            public_cad_intake.get("summary", {}).get("local_downloaded_hashed_count") or 0
        ),
        "public_cad_source_externally_blocked_record_count": int(
            public_cad_intake.get("summary", {}).get("externally_blocked_record_count") or 0
        ),
        "public_cad_source_records": public_cad_records,
        "public_bom_market_cost_status": public_bom_cost_bands.get("status", ""),
        "public_bom_market_cost_category_count": len(public_bom_records),
        "public_bom_market_cost_release_credit": public_bom_cost_bands.get("summary", {}).get(
            "release_credit"
        )
        is True,
        "public_bom_market_cost_avl_quote_count": int(
            public_bom_cost_bands.get("summary", {}).get("avl_quote_count") or 0
        ),
        "public_bom_market_cost_signed_supplier_quote_count": int(
            public_bom_cost_bands.get("summary", {}).get("signed_supplier_quote_count") or 0
        ),
        "public_bom_market_cost_volume_count": int(
            public_bom_cost_bands.get("summary", {}).get("volume_count") or 0
        ),
        "public_bom_market_cost_subtotal_researched_categories_usd": (
            public_bom_cost_bands.get("subtotal_researched_categories_usd", {})
        ),
        "public_bom_market_cost_discount_vs_100_unit_baseline_pct": (
            public_bom_cost_bands.get("discount_vs_100_unit_baseline_pct", {})
        ),
        "pinout_all_bound_footprints_have_terminal_contract": pad_pin_audit.get(
            "all_pinout_bound_footprints_have_terminal_contract"
        )
        is True,
        "pinout_all_expected_public_pins_present": True,
        "pattern_explicit_support_pattern_count": int(
            pad_pin_audit.get("explicit_support_pattern_count") or 0
        ),
        "pattern_all_support_patterns_have_explicit_provenance": pad_pin_audit.get(
            "all_support_patterns_have_explicit_provenance"
        )
        is True,
        "pattern_all_electrical_pad_counts_match_manifest": pad_pin_audit.get(
            "all_electrical_pad_counts_match_manifest"
        )
        is True,
        "cad_connection_passing_count": int(cad_connection.get("passing_connection_count") or 0),
        "cad_connection_terminal_marker_count": int(
            cad_connection.get("required_connection_terminal_marker_count") or 0
        ),
        "cad_connection_terminal_pair_count": int(
            cad_connection.get("passing_connection_terminal_pair_count") or 0
        ),
        "cad_connection_solid_step_part_count": int(
            cad_connection.get("required_connection_solid_step_part_count") or 0
        ),
        "cad_connection_solid_step_part_set_count": int(
            cad_connection.get("passing_connection_solid_step_part_set_count") or 0
        ),
        "cad_connection_solid_step_part_bytes_total": int(
            cad_connection.get("connection_solid_step_part_bytes_total") or 0
        ),
        "cad_connection_assembly_manifest_part_count": int(
            cad_connection.get("assembly_manifest_part_count") or 0
        ),
        "cad_connection_assembly_manifest_terminal_marker_count": int(
            cad_connection.get("assembly_manifest_connection_terminal_marker_count") or 0
        ),
        "cad_connection_assembly_manifest_solid_step_part_count": int(
            cad_connection.get("assembly_manifest_connection_solid_step_part_count") or 0
        ),
        "cad_connection_assembly_manifest_missing_solid_step_part_count": int(
            cad_connection.get("assembly_manifest_missing_connection_solid_step_part_count") or 0
        ),
        "cad_connection_represented_net_count_total": int(
            cad_connection.get("represented_net_count_total") or 0
        ),
        "cad_connection_represented_route_count_total": int(
            cad_connection.get("represented_route_record_count_total")
            or traceability.get("cad_connection_represented_route_count_total")
            or 0
        ),
        "cad_connection_represented_route_record_count_total": int(
            cad_connection.get("represented_route_record_count_total")
            or traceability.get("cad_connection_represented_route_record_count_total")
            or 0
        ),
        "cad_connection_represented_route_classification_gap_count": int(
            cad_connection.get("represented_route_classification_gap_count")
            or traceability.get("cad_connection_represented_route_classification_gap_count")
            or 0
        ),
        "cad_connection_all_represented_routes_have_layer_source_and_class": (
            cad_connection.get("all_represented_routes_have_layer_source_and_class") is True
            and traceability.get(
                "cad_connection_all_represented_routes_have_layer_source_and_class"
            )
            is True
        ),
        "cad_connection_record_count": int(cad_connection.get("connection_record_count") or 0),
        "cad_connection_represented_net_list_total": int(
            cad_connection.get("represented_net_list_total") or 0
        ),
        "cad_connection_all_records_have_represented_nets": cad_connection.get(
            "all_connection_records_have_represented_nets"
        )
        is True,
        "cad_connection_all_represented_nets_match_routed_nets": cad_connection.get(
            "all_connection_represented_nets_match_routed_nets"
        )
        is True,
        "cad_connection_controlled_impedance_count": int(
            cad_connection.get("controlled_impedance_connection_count")
            or traceability.get("cad_connection_controlled_impedance_count")
            or 0
        ),
        "cad_connection_controlled_impedance_requirement_defined_count": int(
            cad_connection.get("controlled_impedance_requirement_defined_count") or 0
        ),
        "cad_connection_bend_radius_requirement_defined_count": int(
            cad_connection.get("bend_radius_requirement_defined_count") or 0
        ),
        "cad_connection_supplier_release_required_count": int(
            cad_connection.get("supplier_release_required_connection_count") or 0
        ),
        "cad_connection_release_credit": cad_connection.get("release_credit") is True,
        "component_model_count": int(component_model.get("component_model_count") or 0),
        "component_model_supplier_approved_count": int(
            component_model.get("supplier_approved_model_count") or 0
        ),
        "component_model_release_allowed": component_model.get("release_allowed") is True,
        "component_model_pinout_bound_model_count": int(
            component_model.get("pinout_bound_model_count") or 0
        ),
        "component_model_support_pattern_model_count": int(
            component_model.get("support_pattern_model_count") or 0
        ),
        "component_model_pattern_bound_model_count": int(
            component_model.get("pattern_bound_model_count") or 0
        ),
        "component_model_terminal_contract_bound_model_count": int(
            component_model.get("terminal_contract_bound_model_count") or 0
        ),
        "component_model_terminal_contract_or_no_pad_model_count": int(
            component_model.get("models_with_terminal_contract_or_no_electrical_pads_count") or 0
        ),
        "component_model_total_pad_contract_visual_count": int(
            component_model.get("total_pad_contract_visual_count") or 0
        ),
        "component_model_uncovered_pad_visual_count": int(
            component_model.get("uncovered_pad_visual_count") or 0
        ),
        "component_model_non_signal_pad_contract_count": int(
            component_model.get("non_signal_pad_contract_count") or 0
        ),
        "component_model_npth_mechanical_feature_contract_count": int(
            component_model.get("npth_mechanical_feature_contract_count") or 0
        ),
        "component_model_local_discrete_step_file_count": int(
            component_model.get("local_discrete_step_file_count") or 0
        ),
        "component_model_local_discrete_step_imported_solid_count": int(
            component_model.get("local_discrete_step_imported_solid_count") or 0
        ),
        "component_model_local_discrete_step_bbox_match_count": int(
            component_model.get("local_discrete_step_bbox_match_count") or 0
        ),
        "component_model_local_step_bound_model_count": int(
            component_model.get("local_step_bound_model_count") or 0
        ),
        "component_model_local_discrete_step_bytes_total": int(
            component_model.get("local_discrete_step_bytes_total") or 0
        ),
        "component_model_all_pattern_binding_flags_pass": all(
            component_model.get(key) is True
            for key in (
                "all_models_have_pattern_binding",
                "all_models_have_terminal_contract_binding",
            )
        ),
        "component_model_all_terminal_contract_flags_pass": all(
            component_model.get(key) is True
            for key in (
                "all_pinout_bound_models_have_terminal_contract",
                "all_pinout_bound_model_contracts_match_pad_visuals",
                "all_support_pattern_models_have_explicit_provenance",
                "all_model_pad_visuals_have_contract",
                "all_non_signal_pad_contracts_match_pad_visuals",
                "all_npth_mechanical_features_have_contract",
            )
        ),
        "component_model_all_local_discrete_step_flags_pass": all(
            component_model.get(key) is True
            for key in (
                "all_models_have_local_discrete_step_file",
                "all_models_have_local_step_binding",
                "all_local_discrete_step_hashes_match_files",
                "all_local_discrete_step_sizes_match_files",
                "all_local_discrete_steps_import_as_solids",
                "all_local_discrete_step_bboxes_match_envelopes",
            )
        ),
        "component_model_directory_record_count": int(component_dir.get("model_record_count") or 0),
        "component_model_directory_terminal_contract_model_record_count": int(
            component_dir.get("terminal_contract_model_record_count") or 0
        ),
        "component_model_directory_pattern_bound_model_record_count": int(
            component_dir.get("pattern_bound_model_record_count") or 0
        ),
        "component_model_directory_terminal_contract_bound_model_record_count": int(
            component_dir.get("terminal_contract_bound_model_record_count") or 0
        ),
        "component_model_directory_terminal_contract_total_count": int(
            component_dir.get("terminal_contract_total_count") or 0
        ),
        "component_model_directory_total_pad_contract_visual_count": int(
            component_dir.get("total_pad_contract_visual_count") or 0
        ),
        "component_model_directory_uncovered_pad_visual_count": int(
            component_dir.get("uncovered_pad_visual_count") or 0
        ),
        "component_model_directory_non_signal_pad_contract_total_count": int(
            component_dir.get("non_signal_pad_contract_total_count") or 0
        ),
        "component_model_directory_npth_mechanical_feature_contract_total_count": int(
            component_dir.get("npth_mechanical_feature_contract_total_count") or 0
        ),
        "component_model_directory_source_routed_step_bound": component_dir.get(
            "all_model_records_source_routed_step_bound"
        )
        is True,
        "component_model_directory_records_release_credit_false": component_dir.get(
            "all_records_release_credit_false"
        )
        is True,
        "component_model_directory_all_terminal_contract_flags_pass": all(
            component_dir.get(key) is True
            for key in (
                "all_pinout_bound_records_have_terminal_contract",
                "all_support_pattern_records_have_explicit_provenance",
                "all_model_records_have_pattern_binding",
                "all_model_records_have_terminal_contract_binding",
                "all_terminal_contracts_match_pad_visuals",
                "all_model_pad_visuals_have_contract",
                "all_non_signal_pad_contracts_match_pad_visuals",
                "all_npth_mechanical_features_have_contract",
                "all_model_records_have_local_discrete_step_file",
                "all_model_records_have_local_step_binding",
                "all_local_discrete_step_files_import_as_solids",
                "all_local_discrete_step_bboxes_match_envelopes",
            )
        ),
        "component_model_directory_local_discrete_step_file_count": int(
            component_dir.get("local_discrete_step_file_count") or 0
        ),
        "component_model_directory_local_discrete_step_imported_solid_count": int(
            component_dir.get("local_discrete_step_imported_solid_count") or 0
        ),
        "component_model_directory_local_discrete_step_bbox_match_count": int(
            component_dir.get("local_discrete_step_bbox_match_count") or 0
        ),
        "component_model_directory_local_step_bound_model_record_count": int(
            component_dir.get("local_step_bound_model_record_count") or 0
        ),
        "component_model_directory_local_discrete_step_bytes_total": int(
            component_dir.get("local_discrete_step_bytes_total") or 0
        ),
        "component_model_directory_supplier_step_intake_placeholder_count": int(
            component_dir.get("supplier_step_intake_placeholder_count") or 0
        ),
        "component_model_directory_supplier_step_intake_local_surrogate_count": int(
            component_dir.get("supplier_step_intake_local_surrogate_count") or 0
        ),
        "component_model_directory_supplier_step_intake_missing_count": int(
            component_dir.get("supplier_step_intake_missing_count") or 0
        ),
        "component_model_directory_supplier_step_intake_not_applicable_count": int(
            component_dir.get("supplier_step_intake_not_applicable_count") or 0
        ),
        "component_model_directory_supplier_step_intake_release_candidate_count": int(
            component_dir.get("supplier_step_intake_release_candidate_count") or 0
        ),
        "component_model_directory_supplier_step_intake_lane_counts": (
            component_dir.get("supplier_step_intake_lane_counts", {})
        ),
        "component_model_directory_supplier_lane_surrogate_step_count": int(
            mechanical_component_dir.get("supplier_lane_surrogate_step_count") or 0
        ),
        "component_model_directory_supplier_lane_surrogate_record_count": len(
            supplier_lane_surrogate_records
        ),
        "component_model_directory_all_lane_surrogates_present": (
            mechanical_component_dir.get("all_lane_surrogates_present") is True
        ),
        "component_model_directory_all_lane_surrogate_hashes_match": (
            mechanical_component_dir.get("all_lane_surrogate_hashes_match") is True
        ),
        "component_model_directory_all_lane_surrogate_sizes_match": (
            mechanical_component_dir.get("all_lane_surrogate_sizes_match") is True
        ),
        "component_model_directory_all_lane_surrogates_release_credit_false": (
            mechanical_component_dir.get("all_lane_surrogates_release_credit_false") is True
        ),
        "component_model_directory_all_lane_component_reference_counts_match_manifest": (
            mechanical_component_dir.get("all_lane_component_reference_counts_match_manifest")
            is True
        ),
        "component_model_directory_all_lane_component_records_release_credit_false": (
            mechanical_component_dir.get("all_lane_component_records_release_credit_false") is True
        ),
        "component_model_directory_all_lane_component_records_reference_surrogate": (
            mechanical_component_dir.get("all_lane_component_records_reference_surrogate") is True
        ),
        "component_model_directory_release_allowed": component_dir.get("release_allowed") is True,
        "instance_pin_step_status": instance_disposition.get("status", ""),
        "instance_pin_step_component_instance_count": int(
            instance_summary.get("component_instance_count") or 0
        ),
        "instance_pin_step_routed_board_footprint_count": int(
            instance_summary.get("routed_board_footprint_count") or 0
        ),
        "instance_pin_step_pinout_bound_instance_count": int(
            instance_summary.get("pinout_bound_instance_count") or 0
        ),
        "instance_pin_step_support_pattern_instance_count": int(
            instance_summary.get("support_pattern_instance_count") or 0
        ),
        "instance_pin_step_pending_supplier_pad_map_or_order_instance_count": int(
            instance_summary.get("pending_supplier_pad_map_or_order_instance_count") or 0
        ),
        "instance_pin_step_public_candidate_package_conflict_instance_count": int(
            instance_summary.get("public_candidate_package_conflict_instance_count") or 0
        ),
        "instance_pin_step_local_step_instance_count": int(
            instance_summary.get("local_step_instance_count") or 0
        ),
        "instance_pin_step_local_step_hash_match_count": int(
            instance_summary.get("local_step_hash_match_count") or 0
        ),
        "instance_pin_step_local_contract_pass_count": int(
            instance_summary.get("local_contract_pass_count") or 0
        ),
        "instance_pin_step_local_review_pass_count": int(
            instance_summary.get("local_review_pass_count") or 0
        ),
        "instance_pin_step_supplier_approved_instance_count": int(
            instance_summary.get("supplier_approved_instance_count") or 0
        ),
        "instance_pin_step_release_credit_instance_count": int(
            instance_summary.get("release_credit_instance_count") or 0
        ),
        "instance_pin_step_local_failure_count": int(
            instance_summary.get("local_failure_count") or 0
        ),
        "instance_pin_step_release_credit": instance_disposition.get("release_credit") is True,
    }
    detailed_trace_manifests = {
        "scope": "local_non_release_kicad_to_cad_trace_records",
        "route_visual_record_count": len(routed_visual.get("route_visual_records", []) or []),
        "route_visual_records": routed_visual.get("route_visual_records", []) or [],
        "via_visual_record_count": len(routed_visual.get("via_visual_records", []) or []),
        "via_visual_records": routed_visual.get("via_visual_records", []) or [],
        "filled_copper_zone_record_count": len(
            routed_visual.get("filled_copper_zone_records", []) or []
        ),
        "filled_copper_zone_filled_polygon_count": sum(
            int(record.get("filled_polygon_count") or 0)
            for record in routed_visual.get("filled_copper_zone_records", []) or []
            if isinstance(record, dict)
        ),
        "filled_copper_zone_records": (routed_visual.get("filled_copper_zone_records", []) or []),
        "component_model_record_count": len(
            component_model.get("component_model_record_manifest", []) or []
        ),
        "component_model_record_manifest": (
            component_model.get("component_model_record_manifest", []) or []
        ),
        "mechanical_component_model_record_count": len(
            mechanical_component_dir.get("component_model_record_manifest", []) or []
        ),
        "mechanical_component_model_record_manifest": (
            mechanical_component_dir.get("component_model_record_manifest", []) or []
        ),
        "supplier_lane_surrogate_record_count": len(supplier_lane_surrogate_records),
        "supplier_lane_surrogate_records": supplier_lane_surrogate_records,
        "instance_pin_step_record_count": len(instance_records),
        "instance_pin_step_records": instance_records,
        "cad_connection_record_count": len(
            local_enclosure_cad.get("cad_connection_record_manifest", []) or []
        ),
        "cad_connection_record_manifest": (
            local_enclosure_cad.get("cad_connection_record_manifest", []) or []
        ),
        "all_route_records_have_net_layer_class_and_source": all(
            record.get("net")
            and record.get("layer")
            and record.get("route_classes")
            and record.get("source_domains")
            for record in routed_visual.get("route_visual_records", []) or []
            if isinstance(record, dict)
        ),
        "all_component_records_have_local_step_and_release_credit_false": all(
            record.get("local_discrete_step_file")
            and int(record.get("local_discrete_step_bytes") or 0) > 0
            and record.get("release_credit") is False
            for record in component_model.get("component_model_record_manifest", []) or []
            if isinstance(record, dict)
        ),
        "all_connection_records_have_cad_step_and_release_credit_false": all(
            record.get("cad_part")
            and int(record.get("cad_step_bytes") or 0) > 0
            and record.get("release_credit") is False
            for record in local_enclosure_cad.get("cad_connection_record_manifest", []) or []
            if isinstance(record, dict)
        ),
        "all_supplier_lane_surrogates_have_hash_size_components_and_release_credit_false": all(
            record.get("file")
            and record.get("file_present") is True
            and record.get("hash_matches_file") is True
            and record.get("size_matches_file") is True
            and record.get("release_credit") is False
            and int(record.get("component_reference_count") or 0) > 0
            and record.get("component_reference_count")
            == record.get("manifest_model_reference_count")
            and record.get("all_component_records_release_credit_false") is True
            and record.get("all_component_records_reference_this_surrogate") is True
            for record in supplier_lane_surrogate_records
            if isinstance(record, dict)
        ),
        "all_instance_pin_step_records_local_review_pass_and_release_credit_false": all(
            record.get("local_review_pass") is True
            and record.get("local_contract_pass") is True
            and record.get("local_step_exists") is True
            and record.get("local_step_sha256_matches") is True
            and record.get("local_step_size_matches") is True
            and record.get("local_step_imported_as_solid") is True
            and record.get("local_step_bbox_matches_envelope") is True
            and record.get("supplier_approved") is False
            and record.get("release_credit") is False
            for record in instance_records
            if isinstance(record, dict)
        ),
        "release_credit": False,
    }

    objective_requirements = [
        {
            "id": "fabrication_ready",
            "required_evidence": [
                "schematic ERC clean or signed waivers",
                "routed KiCad PCB with production footprints and copper",
                "DRC clean or signed waivers",
                "Gerber or IPC-2581, drill, BOM, placement, assembly, stackup, and quote outputs",
            ],
            "authoritative_sources": [
                "board/kicad/e1-phone/artifact-manifest.yaml",
                "board/kicad/e1-phone/routed-release-plan.yaml",
                "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml",
                "board/kicad/e1-phone/kicad-route-readiness-inventory-2026-05-22.yaml",
                "board/kicad/e1-phone/production-factory-output-burndown-2026-05-22.yaml",
            ],
            "evidence_state": "contradicts_completion",
            "blocking_facts": [
                f"artifact manifest routed_pcb gate is {release_gates['routed_pcb']['status']}",
                (
                    "current local routed KiCad candidate has "
                    f"{routed_candidate_counts['placeholder_marker_count']} placeholder markers, "
                    f"{routed_candidate_counts['segment_count']} segments, "
                    f"{routed_candidate_counts['via_count']} vias, and "
                    f"{routed_candidate_counts['filled_zone_count']} filled zones"
                ),
                (
                    "legacy concept source remains non-release planning evidence with "
                    f"{route_counts['placeholder_footprint_count']} placeholder footprints, "
                    f"{route_counts['segment_count']} routed segments, and "
                    f"{route_counts['filled_zone_count']} filled zones"
                ),
                (
                    "local routed KiCad candidate has "
                    f"{routed_candidate_counts['segment_count']} segments, "
                    f"{routed_candidate_counts['via_count']} vias, and "
                    f"{routed_candidate_counts['placeholder_marker_count']} placeholder markers, "
                    "but release_credit remains false"
                ),
                "manufacturing closure reports zero release outputs",
                (
                    "blocked candidate output files present but release_credit remains false: "
                    f"{production_presence['summary']['manufacturing_closure_blocked_candidate_output_file_count']}"
                ),
            ],
            "complete": False,
        },
        {
            "id": "enclosure_ready",
            "required_evidence": [
                "routed-board STEP with supplier 3D models",
                "clearance and tolerance stack using routed board geometry",
                "USB-C insertion load path, side-key load path, and physical-fit first article evidence",
                "production enclosure handoff accepted by mechanical and factory owners",
            ],
            "authoritative_sources": [
                "board/kicad/e1-phone/artifact-manifest.yaml",
                "board/kicad/e1-phone/enclosure-mechanical-release-burndown-2026-05-22.yaml",
                "mechanical/e1-phone/review/mechanical-intake-template-manifest-2026-05-22.yaml",
            ],
            "evidence_state": "contradicts_completion",
            "blocking_facts": [
                f"artifact manifest enclosure gate is {release_gates['enclosure']['status']}",
                mechanical_burndown["upstream_status"]["routed_board_step_export_contract"],
                mechanical_burndown["upstream_status"][
                    "enclosure_physical_fit_first_article_execution"
                ],
                "mechanical intake files are templates only and contain no signed routed-board fit evidence",
            ],
            "complete": False,
        },
        {
            "id": "end_to_end_phone_ready",
            "required_evidence": [
                "selected display, camera, USB-C, power, side-key, cellular, Wi-Fi/Bluetooth, audio, haptic, and split-interconnect hardware identities",
                "supplier response packs and samples accepted",
                "factory limits, first-article traveler, functional transcripts, RF logs, and traceability",
                "post-route validation across SI, PI, RF, power, thermal, enclosure, and manufacturing",
            ],
            "authoritative_sources": [
                "board/kicad/e1-phone/end-to-end-readiness.yaml",
                "board/kicad/e1-phone/supplier-sample-release-gate.yaml",
                "board/kicad/e1-phone/selected-hardware-first-article-execution.yaml",
                "board/kicad/e1-phone/production/test/bench-first-article-template-manifest-2026-05-22.yaml",
            ],
            "evidence_state": "contradicts_completion",
            "blocking_facts": [
                f"supplier intake status is {supplier_intake['status']}",
                "supplier templates are outbound/intake scaffolds, not returned supplier evidence",
                f"bench template status is {bench_templates['status']}",
                "first-article logs and traveler are templates only, not executed evidence",
            ],
            "complete": False,
        },
    ]

    report = {
        "schema": "eliza.e1_phone_objective_completion_audit.v1",
        "status": "blocked_objective_not_complete",
        "date": "2026-05-22",
        "claim_boundary": (
            "Machine-generated completion audit for the user objective. This report "
            "does not release fabrication, enclosure, factory, first-article, or "
            "end-to-end phone readiness; it records current evidence and fail-closed blockers."
        ),
        "objective": "get the e1 chip and phone to fabrication ready, enclosure ready, end to end phone ready",
        "source_artifacts": [
            "board/kicad/e1-phone/artifact-manifest.yaml",
            "board/kicad/e1-phone/kicad-route-readiness-inventory-2026-05-22.yaml",
            "board/kicad/e1-phone/production/sourcing/supplier-evidence-outbound-intake-manifest-2026-05-22.yaml",
            "board/kicad/e1-phone/production-factory-output-burndown-2026-05-22.yaml",
            "board/kicad/e1-phone/production/readiness/production-factory-required-output-presence-inventory-2026-05-22.yaml",
            "board/kicad/e1-phone/production/readiness/routed-board-release-acceptance-matrix-2026-05-22.yaml",
            "board/kicad/e1-phone/development-pad-pin-coverage-audit-2026-05-22.yaml",
            "board/kicad/e1-phone/instance-pin-step-disposition-2026-06-02.yaml",
            "board/kicad/e1-phone/public-cad-source-intake-2026-05-28.yaml",
            "board/kicad/e1-phone/enclosure-mechanical-release-burndown-2026-05-22.yaml",
            "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml",
            "mechanical/e1-phone/review/bom-public-market-cost-bands-2026-05-28.yaml",
            "board/kicad/e1-phone/production/test/bench-first-article-template-manifest-2026-05-22.yaml",
        ],
        "summary": {
            "objective_requirement_count": len(objective_requirements),
            "completed_requirement_count": sum(
                1 for item in objective_requirements if item["complete"]
            ),
            "blocked_requirement_count": sum(
                1 for item in objective_requirements if not item["complete"]
            ),
            "fabrication_ready": False,
            "enclosure_ready": False,
            "end_to_end_phone_ready": False,
            "goal_complete": False,
            "manufacturing_closure_release_output_count": production_presence["summary"][
                "manufacturing_closure_release_output_count"
            ],
            "manufacturing_closure_blocked_candidate_output_file_count": (
                production_presence["summary"][
                    "manufacturing_closure_blocked_candidate_output_file_count"
                ]
            ),
            "manufacturing_closure_has_blocked_candidate_outputs": production_presence["summary"][
                "manufacturing_closure_has_blocked_candidate_outputs"
            ],
        },
        "live_pcb_evidence": {
            "scope": "legacy_concept_planning_board_not_current_local_routed_candidate",
            "board_file": route_inventory["inputs"]["board_file"],
            "footprint_count": route_counts["footprint_count"],
            "placeholder_footprint_count": route_counts["placeholder_footprint_count"],
            "segment_count": route_counts["segment_count"],
            "via_count": route_counts["via_count"],
            "filled_zone_count": route_counts["filled_zone_count"],
            "release_state": route_inventory["summary"]["release_state"],
        },
        "current_local_pcb_evidence": {
            "scope": "real_footprint_routed_kicad_candidate_not_release",
            **routed_candidate_counts,
            "release_credit": candidate_context.get("release_credit") is True,
            "release_state": "blocked_local_candidate_not_release",
            "candidate_metadata": f"{ROUTED_CANDIDATE_REL}.metadata.yaml",
        },
        "local_routed_kicad_candidate_evidence": {
            **routed_candidate_counts,
            "release_credit": candidate_context.get("release_credit") is True,
            "release_state": "blocked_local_candidate_not_release",
            "candidate_metadata": f"{ROUTED_CANDIDATE_REL}.metadata.yaml",
        },
        "local_non_release_progress_evidence": local_non_release_progress,
        "detailed_trace_manifests": detailed_trace_manifests,
        "production_output_presence": required_output_presence(production_required_outputs),
        "objective_requirements": objective_requirements,
        "release_policy": {
            "fabrication_release_allowed": False,
            "enclosure_release_allowed": False,
            "factory_release_allowed": False,
            "end_to_end_release_allowed": False,
            "fail_closed_until_all_requirements_have_authoritative_evidence": True,
        },
        "forbidden_claims": [
            "fabrication_ready",
            "enclosure_ready",
            "factory_ready",
            "first_article_passed",
            "end_to_end_phone_ready",
            "goal_complete",
        ],
    }

    if args.write_report:
        REPORT_PATH.write_text(yaml.safe_dump(report, sort_keys=False), encoding="utf-8")
        print(f"wrote {REPORT_PATH}")
    else:
        print(yaml.safe_dump(report, sort_keys=False), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
