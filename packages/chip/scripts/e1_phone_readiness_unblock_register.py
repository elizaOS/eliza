#!/usr/bin/env python3
"""Build the fail-closed unblock register for E1 phone readiness."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
CHIP_ROOT = REPO_ROOT / "packages/chip"
BOARD_ROOT = CHIP_ROOT / "board/kicad/e1-phone"
REPORT_REL = "board/kicad/e1-phone/e1-phone-readiness-unblock-register-2026-05-22.yaml"
REPORT_PATH = CHIP_ROOT / REPORT_REL
REPORT_DATE = "2026-05-22"


def load_yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def exists(rel: str) -> bool:
    return (CHIP_ROOT / rel).exists()


NON_RELEASE_MARKERS = (
    "blocked_candidate_not_approved",
    "blocked_pending_supplier_return",
    "candidate_not_release",
    "fail_closed",
    "local candidate artifact only",
    "local fail-closed",
    "not release evidence",
    "not_approved",
    "not_measured",
    "not supplier evidence",
    "placeholder",
    "release_allowed: false",
    "release_credit: false",
    "template_manifest_fail_closed",
    "template_not_release",
    "unreviewed_local_candidate",
)


def artifact_probe_path(rel: str) -> Path:
    path = CHIP_ROOT / rel
    if path.is_dir():
        for name in ("release-manifest.yaml", "manifest.yaml", "rfq-response-pack.yaml"):
            candidate = path / name
            if candidate.is_file():
                return candidate
    return path


def non_release_reasons(rel: str) -> list[str]:
    path = CHIP_ROOT / rel
    if not path.exists():
        return ["missing_artifact"]
    probe = artifact_probe_path(rel)
    if not probe.is_file():
        return ["directory_without_release_manifest"] if path.is_dir() else []
    try:
        text = probe.read_text(encoding="utf-8", errors="ignore")[:65536].lower()
    except OSError:
        return ["unreadable_artifact"]
    reasons = [marker for marker in NON_RELEASE_MARKERS if marker in text]
    if probe.suffix.lower() in {".pdf", ".step"} and probe.stat().st_size < 1024:
        reasons.append("sentinel_small_binary_artifact")
    return sorted(dict.fromkeys(reasons))


def make_blocker(
    blocker_id: str,
    domain: str,
    owner: str,
    status: str,
    source_artifacts: list[str],
    required_evidence: list[str],
    acceptance_artifacts: list[str],
    next_unblock_action: str,
) -> dict[str, Any]:
    present = [path for path in acceptance_artifacts if exists(path)]
    missing = [path for path in acceptance_artifacts if not exists(path)]
    non_release = {path: reasons for path in present if (reasons := non_release_reasons(path))}
    artifact_presence_complete = not missing and bool(acceptance_artifacts)
    status_release_blocked = any(
        marker in status.lower()
        for marker in ("blocked", "template", "not_supplier", "not_release", "missing")
    )
    acceptance_complete = (
        artifact_presence_complete and not non_release and not status_release_blocked
    )
    evidence_class = "external_or_physical_release_evidence"
    if domain in {"routing", "production"}:
        evidence_class = "local_generated_outputs_plus_external_review"
    return {
        "id": blocker_id,
        "domain": domain,
        "owner": owner,
        "status": status,
        "evidence_class": evidence_class,
        "source_artifacts": source_artifacts,
        "required_evidence": required_evidence,
        "acceptance_artifacts": acceptance_artifacts,
        "present_acceptance_artifacts": present,
        "missing_acceptance_artifacts": missing,
        "artifact_presence_complete": artifact_presence_complete,
        "non_release_acceptance_artifacts": non_release,
        "non_release_acceptance_artifact_count": len(non_release),
        "acceptance_complete": acceptance_complete,
        "missing_acceptance_artifact_count": len(missing),
        "next_unblock_action": next_unblock_action,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()

    objective = load_yaml(BOARD_ROOT / "e1-phone-objective-completion-audit-2026-05-22.yaml")
    route_inventory = load_yaml(BOARD_ROOT / "kicad-route-readiness-inventory-2026-05-22.yaml")
    supplier_intake = load_yaml(
        BOARD_ROOT
        / "production/sourcing/supplier-evidence-outbound-intake-manifest-2026-05-22.yaml"
    )
    production_presence = load_yaml(
        BOARD_ROOT
        / "production/readiness/production-factory-required-output-presence-inventory-2026-05-22.yaml"
    )
    load_yaml(
        CHIP_ROOT / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"
    )
    bench = load_yaml(
        BOARD_ROOT / "production/test/bench-first-article-template-manifest-2026-05-22.yaml"
    )
    local_progress = objective.get("local_non_release_progress_evidence", {})

    supplier_acceptance: list[str] = []
    for record in supplier_intake["template_records"]:
        archives = record.get("expected_return_archives") or [record["expected_return_archive"]]
        for archive in archives:
            archive_dir = str(Path(archive).parent)
            supplier_acceptance.extend(
                f"{archive_dir}/{filename}" for filename in record["required_return_files"]
            )
    supplier_acceptance = sorted(dict.fromkeys(supplier_acceptance))
    route_acceptance = sorted(
        {row["path"] for row in route_inventory["missing_production_outputs"]}
    )
    production_acceptance = sorted(
        {row["path"] for row in production_presence["required_output_presence"]}
    )
    mechanical_acceptance = [
        "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        "board/kicad/e1-phone/production/reports/routed-board-clearance-release.yaml",
        "mechanical/e1-phone/review/supplier-evidence-acceptance.json",
        "mechanical/e1-phone/review/physical-process-validation-acceptance.json",
    ]
    bench_acceptance = sorted(
        {
            record["future_evidence_path"]
            for record in bench["template_inventory"]
            if isinstance(record.get("future_evidence_path"), str)
        }
    )

    blockers = [
        make_blocker(
            "supplier_return_packs",
            "supplier",
            "sourcing_ops",
            supplier_intake["status"],
            supplier_intake["source_artifacts"],
            [
                "supplier-returned RFQ response pack for every selected hardware lane",
                "2D drawing, STEP or B-rep, sample lot, lifecycle, stock, and reviewer identity",
                "mapping from supplier evidence into KiCad symbol, footprint, courtyard, and 3D model review",
            ],
            supplier_acceptance,
            "Send/track RFQs and populate returned supplier response packs; do not promote public listings or templates.",
        ),
        make_blocker(
            "routed_board_release",
            "routing",
            "layout_fabrication",
            route_inventory["status"],
            list(route_inventory["inputs"].values()),
            [
                "supplier footprints replace all placeholders",
                "routed KiCad PCB with tracks, vias, filled zones, net classes, and DRC/ERC reports",
                "SI/PI/RF reports and routed-board STEP export using production component models",
            ],
            route_acceptance,
            "Complete supplier footprint capture, route EVT1 board, run ERC/DRC/SI/PI/RF, and export release outputs.",
        ),
        make_blocker(
            "production_factory_outputs",
            "production",
            "manufacturing_ops",
            production_presence["status"],
            [production_presence["inputs"]["production_factory_output_burndown"]],
            [
                "fabrication, assembly, quote, fixture, first-article, and production-release files exist",
                "files are validated for correctness, signatures, freshness, and supplier/factory acceptance",
                "factory limits, probe coordinates, RF calibration, traceability, and commercial quotes are closed",
            ],
            production_acceptance,
            "Generate production/factory outputs from routed board package and selected factory quote workflow.",
        ),
        make_blocker(
            "enclosure_release_evidence",
            "mechanical",
            "mechanical_engineering",
            "blocked_enclosure_evidence_missing",
            ["mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"],
            [
                "routed-board STEP imported into enclosure CAD",
                "routed clearance results and boolean interference checks using supplier B-rep/STEP models",
                "physical fit, lifecycle, GD&T/FAI, process validation, and signed production enclosure handoff",
            ],
            mechanical_acceptance,
            "Replace concept envelope evidence with routed-board and supplier geometry evidence, then rerun clearance and physical validation gates.",
        ),
        make_blocker(
            "first_article_bench_evidence",
            "first_article",
            "manufacturing_validation",
            bench["status"],
            bench["source_artifacts"],
            [
                "executed first-article transcript and traveler",
                "USB-C PD, USB2/ADB, charger CC/CV, side-key force/travel/wake, display, camera, RF, and audio logs",
                "factory limits and probe coordinates derived from measured first articles",
            ],
            bench_acceptance,
            "Run first article on routed hardware and replace templates with executed signed logs and traveler.",
        ),
    ]

    report = {
        "schema": "eliza.e1_phone_readiness_unblock_register.v1",
        "status": "blocked_unblock_register_all_domains_waiting_on_release_evidence",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Action register for reaching fabrication, enclosure, factory, first-article, "
            "and end-to-end phone readiness. It does not itself prove any release state."
        ),
        "source_artifacts": [
            "board/kicad/e1-phone/e1-phone-objective-completion-audit-2026-05-22.yaml",
            "board/kicad/e1-phone/kicad-route-readiness-inventory-2026-05-22.yaml",
            "board/kicad/e1-phone/production/sourcing/supplier-evidence-outbound-intake-manifest-2026-05-22.yaml",
            "board/kicad/e1-phone/production/readiness/production-factory-required-output-presence-inventory-2026-05-22.yaml",
            "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml",
            "board/kicad/e1-phone/production/test/bench-first-article-template-manifest-2026-05-22.yaml",
        ],
        "summary": {
            "objective_status": objective["status"],
            "blocker_count": len(blockers),
            "complete_blocker_count": sum(1 for item in blockers if item["acceptance_complete"]),
            "open_blocker_count": sum(1 for item in blockers if not item["acceptance_complete"]),
            "artifact_presence_complete_blocker_count": sum(
                1 for item in blockers if item["artifact_presence_complete"]
            ),
            "acceptance_artifact_count": sum(
                len(item["acceptance_artifacts"]) for item in blockers
            ),
            "missing_acceptance_artifact_count": sum(
                len(item["missing_acceptance_artifacts"]) for item in blockers
            ),
            "non_release_acceptance_artifact_count": sum(
                len(item["non_release_acceptance_artifacts"]) for item in blockers
            ),
            "production_presence_release_output_count": production_presence["summary"][
                "manufacturing_closure_release_output_count"
            ],
            "production_presence_blocked_candidate_output_file_count": (
                production_presence["summary"][
                    "manufacturing_closure_blocked_candidate_output_file_count"
                ]
            ),
            "production_presence_has_blocked_candidate_outputs": production_presence["summary"][
                "manufacturing_closure_has_blocked_candidate_outputs"
            ],
            "fabrication_ready": False,
            "enclosure_ready": False,
            "end_to_end_phone_ready": False,
            "local_development_route_count": local_progress.get("development_route_count", 0),
            "local_development_segment_count": local_progress.get("development_segment_count", 0),
            "local_development_via_count": local_progress.get("development_via_count", 0),
            "local_development_required_shared_net_category_count": local_progress.get(
                "development_required_shared_net_category_count", 0
            ),
            "local_development_required_shared_net_count": local_progress.get(
                "development_required_shared_net_count", 0
            ),
            "local_development_routed_shared_net_count": local_progress.get(
                "development_routed_shared_net_count", 0
            ),
            "local_development_missing_required_shared_net_count": local_progress.get(
                "development_missing_required_shared_net_count", 0
            ),
            "local_development_route_domain_count": local_progress.get(
                "development_route_domain_count", 0
            ),
            "local_development_route_domain_required_net_count_total": local_progress.get(
                "development_route_domain_required_net_count_total", 0
            ),
            "local_development_route_domain_routed_or_aliased_net_count_total": local_progress.get(
                "development_route_domain_routed_or_aliased_net_count_total", 0
            ),
            "local_development_missing_route_domain_net_count": local_progress.get(
                "development_missing_route_domain_net_count", 0
            ),
            "local_development_all_route_domains_complete": local_progress.get(
                "development_all_route_domains_complete", False
            ),
            "local_real_footprint_development_refs": local_progress.get(
                "real_footprint_development_refs", 0
            ),
            "local_routed_step_candidate_present": local_progress.get(
                "routed_step_candidate_present", False
            ),
            "local_routed_step_candidate_release_credit": local_progress.get(
                "routed_step_candidate_release_credit", False
            ),
            "local_routed_step_candidate_sha256": local_progress.get(
                "routed_step_candidate_sha256", ""
            ),
            "local_routed_step_candidate_matches_development_source": local_progress.get(
                "routed_step_candidate_matches_development_source", False
            ),
            "local_routed_step_candidate_footprint_envelope_count": local_progress.get(
                "routed_step_candidate_footprint_envelope_count", 0
            ),
            "local_routed_step_candidate_pad_contact_visual_count": local_progress.get(
                "routed_step_candidate_pad_contact_visual_count", 0
            ),
            "local_routed_step_candidate_route_segment_visual_count": local_progress.get(
                "routed_step_candidate_route_segment_visual_count", 0
            ),
            "local_pinout_captured_file_count": local_progress.get("pinout_captured_file_count", 0),
            "local_pinout_declared_pin_count_total": local_progress.get(
                "pinout_declared_pin_count_total", 0
            ),
            "local_pinout_record_count_total": local_progress.get("pinout_record_count_total", 0),
            "local_pinout_public_source_count": local_progress.get("pinout_public_source_count", 0),
            "local_pinout_bound_footprint_count": local_progress.get(
                "pinout_bound_footprint_count", 0
            ),
            "local_pinout_exact_public_match_count": local_progress.get(
                "pinout_exact_public_match_count", 0
            ),
            "local_pinout_pending_supplier_pad_map_or_order_count": local_progress.get(
                "pinout_pending_supplier_pad_map_or_order_count", 0
            ),
            "local_pinout_all_bound_footprints_have_terminal_contract": local_progress.get(
                "pinout_all_bound_footprints_have_terminal_contract", False
            ),
            "local_pinout_all_expected_public_pins_present": local_progress.get(
                "pinout_all_expected_public_pins_present", False
            ),
            "local_pattern_explicit_support_pattern_count": local_progress.get(
                "pattern_explicit_support_pattern_count", 0
            ),
            "local_pattern_all_support_patterns_have_explicit_provenance": local_progress.get(
                "pattern_all_support_patterns_have_explicit_provenance", False
            ),
            "local_pattern_all_electrical_pad_counts_match_manifest": local_progress.get(
                "pattern_all_electrical_pad_counts_match_manifest", False
            ),
            "local_cad_connection_passing_count": local_progress.get(
                "cad_connection_passing_count", 0
            ),
            "local_cad_connection_terminal_marker_count": local_progress.get(
                "cad_connection_terminal_marker_count", 0
            ),
            "local_cad_connection_terminal_pair_count": local_progress.get(
                "cad_connection_terminal_pair_count", 0
            ),
            "local_cad_connection_solid_step_part_count": local_progress.get(
                "cad_connection_solid_step_part_count", 0
            ),
            "local_cad_connection_solid_step_part_set_count": local_progress.get(
                "cad_connection_solid_step_part_set_count", 0
            ),
            "local_cad_connection_solid_step_part_bytes_total": local_progress.get(
                "cad_connection_solid_step_part_bytes_total", 0
            ),
            "local_cad_connection_assembly_manifest_part_count": local_progress.get(
                "cad_connection_assembly_manifest_part_count", 0
            ),
            "local_cad_connection_assembly_manifest_terminal_marker_count": local_progress.get(
                "cad_connection_assembly_manifest_terminal_marker_count", 0
            ),
            "local_cad_connection_assembly_manifest_solid_step_part_count": local_progress.get(
                "cad_connection_assembly_manifest_solid_step_part_count", 0
            ),
            "local_cad_connection_assembly_manifest_missing_solid_step_part_count": local_progress.get(
                "cad_connection_assembly_manifest_missing_solid_step_part_count", 0
            ),
            "local_cad_connection_represented_net_count_total": local_progress.get(
                "cad_connection_represented_net_count_total", 0
            ),
            "local_cad_connection_record_count": local_progress.get(
                "cad_connection_record_count", 0
            ),
            "local_cad_connection_represented_net_list_total": local_progress.get(
                "cad_connection_represented_net_list_total", 0
            ),
            "local_cad_connection_all_records_have_represented_nets": local_progress.get(
                "cad_connection_all_records_have_represented_nets", False
            ),
            "local_cad_connection_all_represented_nets_match_routed_nets": (
                local_progress.get("cad_connection_all_represented_nets_match_routed_nets", False)
            ),
            "local_cad_connection_controlled_impedance_count": local_progress.get(
                "cad_connection_controlled_impedance_count", 0
            ),
            "local_cad_connection_controlled_impedance_requirement_defined_count": (
                local_progress.get(
                    "cad_connection_controlled_impedance_requirement_defined_count", 0
                )
            ),
            "local_cad_connection_bend_radius_requirement_defined_count": local_progress.get(
                "cad_connection_bend_radius_requirement_defined_count", 0
            ),
            "local_cad_connection_supplier_release_required_count": local_progress.get(
                "cad_connection_supplier_release_required_count", 0
            ),
            "local_cad_connection_release_credit": local_progress.get(
                "cad_connection_release_credit", False
            ),
            "local_component_model_count": local_progress.get("component_model_count", 0),
            "local_component_model_supplier_approved_count": local_progress.get(
                "component_model_supplier_approved_count", 0
            ),
            "local_component_model_release_allowed": local_progress.get(
                "component_model_release_allowed", False
            ),
            "local_component_model_pinout_bound_model_count": local_progress.get(
                "component_model_pinout_bound_model_count", 0
            ),
            "local_component_model_support_pattern_model_count": local_progress.get(
                "component_model_support_pattern_model_count", 0
            ),
            "local_component_model_terminal_contract_or_no_pad_model_count": local_progress.get(
                "component_model_terminal_contract_or_no_pad_model_count", 0
            ),
            "local_component_model_total_pad_contract_visual_count": local_progress.get(
                "component_model_total_pad_contract_visual_count", 0
            ),
            "local_component_model_uncovered_pad_visual_count": local_progress.get(
                "component_model_uncovered_pad_visual_count", 0
            ),
            "local_component_model_non_signal_pad_contract_count": local_progress.get(
                "component_model_non_signal_pad_contract_count", 0
            ),
            "local_component_model_npth_mechanical_feature_contract_count": local_progress.get(
                "component_model_npth_mechanical_feature_contract_count", 0
            ),
            "local_component_model_all_terminal_contract_flags_pass": local_progress.get(
                "component_model_all_terminal_contract_flags_pass", False
            ),
            "local_component_model_directory_record_count": local_progress.get(
                "component_model_directory_record_count", 0
            ),
            "local_component_model_directory_terminal_contract_model_record_count": (
                local_progress.get(
                    "component_model_directory_terminal_contract_model_record_count", 0
                )
            ),
            "local_component_model_directory_terminal_contract_total_count": local_progress.get(
                "component_model_directory_terminal_contract_total_count", 0
            ),
            "local_component_model_directory_total_pad_contract_visual_count": (
                local_progress.get(
                    "component_model_directory_total_pad_contract_visual_count", 0
                )
            ),
            "local_component_model_directory_uncovered_pad_visual_count": (
                local_progress.get(
                    "component_model_directory_uncovered_pad_visual_count", 0
                )
            ),
            "local_component_model_directory_non_signal_pad_contract_total_count": (
                local_progress.get(
                    "component_model_directory_non_signal_pad_contract_total_count", 0
                )
            ),
            "local_component_model_directory_npth_mechanical_feature_contract_total_count": (
                local_progress.get(
                    "component_model_directory_npth_mechanical_feature_contract_total_count", 0
                )
            ),
            "local_component_model_directory_source_routed_step_bound": local_progress.get(
                "component_model_directory_source_routed_step_bound", False
            ),
            "local_component_model_directory_records_release_credit_false": local_progress.get(
                "component_model_directory_records_release_credit_false", False
            ),
            "local_component_model_directory_all_terminal_contract_flags_pass": (
                local_progress.get(
                    "component_model_directory_all_terminal_contract_flags_pass", False
                )
            ),
            "local_component_model_directory_local_discrete_step_file_count": (
                local_progress.get("component_model_directory_local_discrete_step_file_count", 0)
            ),
            "local_component_model_directory_local_discrete_step_imported_solid_count": (
                local_progress.get(
                    "component_model_directory_local_discrete_step_imported_solid_count", 0
                )
            ),
            "local_component_model_directory_local_discrete_step_bbox_match_count": (
                local_progress.get("component_model_directory_local_discrete_step_bbox_match_count", 0)
            ),
            "local_component_model_directory_local_discrete_step_bytes_total": (
                local_progress.get("component_model_directory_local_discrete_step_bytes_total", 0)
            ),
            "local_component_model_directory_supplier_step_intake_placeholder_count": (
                local_progress.get(
                    "component_model_directory_supplier_step_intake_placeholder_count", 0
                )
            ),
            "local_component_model_directory_supplier_step_intake_local_surrogate_count": (
                local_progress.get(
                    "component_model_directory_supplier_step_intake_local_surrogate_count", 0
                )
            ),
            "local_component_model_directory_supplier_step_intake_missing_count": (
                local_progress.get(
                    "component_model_directory_supplier_step_intake_missing_count", 0
                )
            ),
            "local_component_model_directory_supplier_step_intake_not_applicable_count": (
                local_progress.get(
                    "component_model_directory_supplier_step_intake_not_applicable_count", 0
                )
            ),
            "local_component_model_directory_supplier_step_intake_release_candidate_count": (
                local_progress.get(
                    "component_model_directory_supplier_step_intake_release_candidate_count", 0
                )
            ),
            "local_component_model_directory_supplier_step_intake_lane_counts": (
                local_progress.get(
                    "component_model_directory_supplier_step_intake_lane_counts", {}
                )
            ),
            "local_component_model_directory_release_allowed": local_progress.get(
                "component_model_directory_release_allowed", False
            ),
        },
        "blockers": blockers,
        "release_policy": {
            "register_is_execution_plan_only": True,
            "release_allowed": False,
            "fabrication_release_allowed": False,
            "enclosure_release_allowed": False,
            "end_to_end_release_allowed": False,
            "all_blockers_must_have_validated_acceptance_artifacts_before_release": True,
        },
        "forbidden_claims": [
            "fabrication_ready",
            "enclosure_ready",
            "factory_ready",
            "first_article_passed",
            "end_to_end_phone_ready",
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
