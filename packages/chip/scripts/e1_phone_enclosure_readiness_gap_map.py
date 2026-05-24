#!/usr/bin/env python3
"""Generate a fail-closed E1 phone enclosure readiness gap map."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
BOARD = ROOT / "board/kicad/e1-phone"
READINESS = BOARD / "production/readiness"
REPORT_DATE = "2026-05-22"
DEFAULT_BURNDOWN = BOARD / "enclosure-mechanical-release-burndown-2026-05-22.yaml"
DEFAULT_MECHANICAL_INVENTORY = (
    ROOT / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"
)
DEFAULT_FIRST_ARTICLE = (
    BOARD
    / "production/test/readiness/e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_SUPPLIER_MATRIX = (
    BOARD
    / "production/sourcing/readiness/supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_ROUTED_MATRIX = READINESS / "routed-board-release-acceptance-matrix-2026-05-22.yaml"
DEFAULT_FACTORY_INVENTORY = (
    READINESS / "production-factory-required-output-presence-inventory-2026-05-22.yaml"
)
DEFAULT_ROUTED_CLEARANCE_EXECUTION = BOARD / "routed-clearance-release-execution.yaml"
DEFAULT_BOARD_STEP = ROOT / "mechanical/e1-phone/review/board-step-readiness.json"
DEFAULT_ROUTED_CLEARANCE = ROOT / "mechanical/e1-phone/review/routed-board-clearance.json"
DEFAULT_REPORT = READINESS / f"enclosure-readiness-gap-map-{REPORT_DATE}.yaml"

CLEARANCE_CASE_SUPPLIER_FAMILIES = {
    "battery_back_void_foam_to_pouch": ["battery_power_thermal_stack"],
    "battery_to_pcb_islands": ["battery_power_thermal_stack"],
    "bottom_mic_to_usb": [
        "audio_haptics_split_interconnect",
        "usb_c_side_buttons_bottom_io",
    ],
    "front_camera_to_earpiece": [
        "audio_haptics_split_interconnect",
        "rear_front_camera_stack",
    ],
    "haptic_to_battery": [
        "audio_haptics_split_interconnect",
        "battery_power_thermal_stack",
    ],
    "haptic_to_pcb_islands": ["audio_haptics_split_interconnect"],
    "rear_camera_to_battery": [
        "battery_power_thermal_stack",
        "rear_front_camera_stack",
    ],
    "split_interconnect_connectors_on_pcb_islands": ["audio_haptics_split_interconnect"],
    "split_interconnect_flex_to_battery_edge": [
        "audio_haptics_split_interconnect",
        "battery_power_thermal_stack",
    ],
    "split_interconnect_flex_within_side_rail": ["audio_haptics_split_interconnect"],
    "usb_shell_to_external_aperture": ["usb_c_side_buttons_bottom_io"],
    "usb_to_bottom_speaker": [
        "audio_haptics_split_interconnect",
        "usb_c_side_buttons_bottom_io",
    ],
}

CLEARANCE_NEXT_COMMANDS = [
    "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
    "python3 scripts/e1_phone_enclosure_readiness_gap_map.py --write-report",
    (
        "python3 scripts/aggregate_tapeout_readiness.py --scope phone "
        "--report build/reports/phone-release-readiness-current.json"
    ),
]


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{rel(path)}: expected YAML mapping")
    return data


def read_json(path: Path) -> dict[str, Any]:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{rel(path)}: expected JSON mapping")
    return data


def existing_repo_paths(paths: list[str]) -> list[str]:
    rows = []
    for path in paths:
        candidate = ROOT / path
        if candidate.exists():
            rows.append(path)
    return rows


def supplier_family_index(supplier_families: list[Any]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for family in supplier_families:
        if not isinstance(family, dict) or not family.get("family"):
            continue
        index[str(family["family"])] = {
            "family": str(family["family"]),
            "selected_hardware": family.get("selected_hardware"),
            "required_step_or_brep_inputs": family.get("required_step_or_brep_inputs", []),
            "required_before_release": family.get("required_before_release", []),
            "release_allowed": False,
            "release_credit": False,
        }
    return index


def supplier_families_for_case(
    case_id: str,
    supplier_index: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    return [
        supplier_index[family]
        for family in CLEARANCE_CASE_SUPPLIER_FAMILIES.get(case_id, [])
        if family in supplier_index
    ]


def routed_step_input_map(
    board_step: dict[str, Any],
    release_execution: dict[str, Any],
) -> dict[str, Any]:
    required_inputs = release_execution.get("required_inputs", {})
    if not isinstance(required_inputs, dict):
        required_inputs = {}
    development_candidates = board_step.get("development_step_candidates", [])
    if not isinstance(development_candidates, list):
        development_candidates = []
    candidate_paths = [
        str(row.get("path"))
        for row in development_candidates
        if isinstance(row, dict) and row.get("path")
    ]
    blocked_candidates = board_step.get("blocked_candidate_step_files", [])
    if not isinstance(blocked_candidates, list):
        blocked_candidates = []
    candidate_paths.extend(str(path) for path in blocked_candidates if path)
    development_state = board_step.get("development_board_local_review_state", {})
    if isinstance(development_state, dict) and development_state.get("step_output"):
        candidate_paths.append(str(development_state["step_output"]))
    candidate_paths = list(dict.fromkeys(candidate_paths))
    detailed_candidate = board_step.get("detailed_routed_step_candidate", {})
    if not isinstance(detailed_candidate, dict):
        detailed_candidate = {}
    approved_steps = board_step.get("approved_production_step_files", [])
    if not isinstance(approved_steps, list):
        approved_steps = []
    return {
        "required_production_routed_step": required_inputs.get(
            "routed_board_step",
            "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        ),
        "required_routed_kicad_pcb": required_inputs.get("routed_kicad_pcb"),
        "required_drc_report": required_inputs.get("pcb_drc_report"),
        "required_erc_report": required_inputs.get("schematic_erc_report"),
        "approved_production_step_files": [str(path) for path in approved_steps],
        "blocked_candidate_step_files": [str(path) for path in blocked_candidates],
        "candidate_step_paths": candidate_paths,
        "candidate_step_paths_present": existing_repo_paths(candidate_paths),
        "detailed_candidate": {
            "path": detailed_candidate.get("path"),
            "present": detailed_candidate.get("present") is True,
            "sha256": detailed_candidate.get("sha256"),
            "size_bytes": detailed_candidate.get("size_bytes"),
            "reason_not_release": detailed_candidate.get("reason_not_release"),
            "release_credit": False,
        },
        "next_artifacts": [
            required_inputs.get(
                "routed_board_step",
                "board/kicad/e1-phone/production/step/routed-board-with-components.step",
            ),
            required_inputs.get(
                "supplier_3d_binding_report",
                "board/kicad/e1-phone/production/reports/component-3d-binding.yaml",
            ),
            required_inputs.get(
                "routed_boolean_interference_report",
                "board/kicad/e1-phone/production/reports/full-cad-boolean-interference-routed.yaml",
            ),
        ],
        "release_credit": False,
    }


def first_article_splits(matrix: dict[str, Any]) -> dict[str, Any]:
    rows = matrix.get("acceptance_matrix", [])
    if not isinstance(rows, list):
        rows = []
    missing = []
    templates = []
    present_unvalidated = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        state = row.get("acceptance_state")
        if state == "blocked_fail_closed_missing_required_evidence":
            missing.append(row)
        elif row.get("template_only") is True:
            templates.append(row)
        elif state == "present_unvalidated_still_fail_closed":
            present_unvalidated.append(row)
    return {
        "missing_required_non_template_count": len(missing),
        "template_row_count": len(templates),
        "present_unvalidated_count": len(present_unvalidated),
        "missing_required_paths": [row.get("path") for row in missing if row.get("path")],
        "template_paths": [row.get("path") for row in templates if row.get("path")],
    }


def supplier_splits(matrix: dict[str, Any]) -> dict[str, Any]:
    lanes = matrix.get("acceptance_matrix", [])
    if not isinstance(lanes, list):
        lanes = []
    lane_rows: list[dict[str, Any]] = []
    for lane in lanes:
        if not isinstance(lane, dict):
            continue
        evidence = lane.get("required_supplier_return_evidence", [])
        if not isinstance(evidence, list):
            evidence = []
        missing = [
            row
            for row in evidence
            if isinstance(row, dict) and row.get("current_presence") is not True
        ]
        present = [
            row for row in evidence if isinstance(row, dict) and row.get("current_presence") is True
        ]
        lane_rows.append(
            {
                "lane": lane.get("lane"),
                "function": lane.get("function"),
                "selected_hardware": lane.get("selected_hardware"),
                "required_count": len(evidence),
                "present_count": len(present),
                "missing_count": len(missing),
                "present_but_not_release_evidence_count": len(present),
                "release_allowed": False,
                "blocked_reason": (
                    "supplier-return files are missing"
                    if missing
                    else "supplier-return files are present but fail-closed as placeholder/non-release intake evidence"
                ),
                "missing_evidence_classes": [
                    row.get("evidence_class") for row in missing if row.get("evidence_class")
                ],
            }
        )
    return {
        "lane_count": len(lane_rows),
        "blocked_lane_count": sum(1 for row in lane_rows if row["release_allowed"] is not True),
        "present_but_not_release_evidence_count": sum(
            int(row["present_but_not_release_evidence_count"]) for row in lane_rows
        ),
        "lanes": lane_rows,
    }


def summary_int(summary: dict[str, Any], key: str) -> int:
    value = summary.get(key)
    return int(value) if isinstance(value, int) else 0


def release_action_inventory(
    supplier_matrix: dict[str, Any],
    routed_matrix: dict[str, Any],
    factory_inventory: dict[str, Any],
    first_article_matrix: dict[str, Any],
    routed_gap: dict[str, Any],
    handoff_gap: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    supplier_summary = supplier_matrix.get("summary", {})
    routed_summary = routed_matrix.get("summary", {})
    factory_summary = factory_inventory.get("summary", {})
    first_article_summary = first_article_matrix.get("summary", {})
    if not isinstance(supplier_summary, dict):
        supplier_summary = {}
    if not isinstance(routed_summary, dict):
        routed_summary = {}
    if not isinstance(factory_summary, dict):
        factory_summary = {}
    if not isinstance(first_article_summary, dict):
        first_article_summary = {}

    supplier_required = summary_int(supplier_summary, "required_supplier_return_evidence_count")
    supplier_missing = summary_int(supplier_summary, "missing_supplier_return_evidence_count")
    supplier_present_blocked = max(0, supplier_required - supplier_missing)
    routed_candidate_blocked = summary_int(
        routed_summary, "candidate_present_blocked_required_output_path_count"
    )
    routed_missing = summary_int(routed_summary, "missing_required_output_path_count")
    factory_candidate_blocked = summary_int(
        factory_summary, "candidate_present_blocked_required_output_path_count"
    )
    factory_missing = summary_int(factory_summary, "missing_required_output_path_count")
    first_article_templates = summary_int(first_article_summary, "template_row_count")
    first_article_unvalidated = summary_int(
        first_article_summary, "present_required_non_template_row_count"
    )
    first_article_missing = summary_int(
        first_article_summary, "missing_required_non_template_row_count"
    )

    return [
        {
            "id": "supplier_return_content_validation",
            "owner": "sourcing",
            "blocked_rows": supplier_missing + supplier_present_blocked,
            "missing_artifacts": supplier_missing,
            "present_but_unvalidated_or_placeholder": supplier_present_blocked,
            "required_action": (
                "replace outbound/template supplier returns with signed supplier quote, "
                "drawing, pinout, sample-lot, lifecycle, compliance, and STEP/B-rep "
                "records carrying approved metadata"
            ),
            "validation_command": "python3 scripts/check_e1_phone_supplier_return_content.py",
            "release_credit": False,
        },
        {
            "id": "routed_board_release_outputs",
            "owner": "layout_fabrication",
            "blocked_rows": routed_missing + routed_candidate_blocked,
            "missing_artifacts": routed_missing,
            "present_but_unvalidated_or_placeholder": routed_candidate_blocked,
            "required_action": (
                "replace routed-output candidates with real routed PCB release outputs, "
                "DRC/ERC, exact-net, SI/PI/RF, fabrication package, routed STEP, hashes, "
                "and approval records"
            ),
            "validation_command": "python3 scripts/check_e1_phone_routed_output_content.py",
            "release_credit": False,
        },
        {
            "id": "production_factory_release_outputs",
            "owner": "manufacturing",
            "blocked_rows": factory_missing + factory_candidate_blocked,
            "missing_artifacts": factory_missing,
            "present_but_unvalidated_or_placeholder": factory_candidate_blocked,
            "required_action": (
                "replace local factory-output candidates with fabricator/assembler "
                "release packages, fixture/program revisions, calibration, lot "
                "traceability, and signed package metadata"
            ),
            "validation_command": "python3 scripts/check_e1_phone_factory_output_content.py",
            "release_credit": False,
        },
        {
            "id": "first_article_execution_outputs",
            "owner": "manufacturing_validation",
            "blocked_rows": first_article_missing
            + first_article_templates
            + first_article_unvalidated,
            "missing_artifacts": first_article_missing,
            "present_but_unvalidated_or_placeholder": first_article_unvalidated,
            "template_rows": first_article_templates,
            "required_action": (
                "execute first-article traveler and bench logs on serialized routed "
                "hardware; templates and presence-only logs must be replaced with "
                "fixture-calibrated measurements and pass/fail disposition"
            ),
            "validation_command": "python3 scripts/check_e1_phone_first_article_content.py",
            "release_credit": False,
        },
        {
            "id": "enclosure_clearance_and_handoff",
            "owner": "mechanical_release",
            "blocked_rows": len(routed_gap.get("blocked_clearance_cases", [])) + len(handoff_gap),
            "blocked_clearance_cases": len(routed_gap.get("blocked_clearance_cases", [])),
            "handoff_packets": len(handoff_gap),
            "required_action": (
                "rerun all clearance cases against routed KiCad STEP with supplier "
                "component models, then attach physical-fit, process, drawing-pack, "
                "CMM/FAI, and approval-signature handoff evidence"
            ),
            "validation_command": "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            "release_credit": False,
        },
    ]


def approval_metadata_action_inventory(
    supplier_matrix: dict[str, Any],
    routed_matrix: dict[str, Any],
    factory_inventory: dict[str, Any],
    first_article_matrix: dict[str, Any],
    handoff_gap: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    supplier_summary = supplier_matrix.get("summary", {})
    routed_summary = routed_matrix.get("summary", {})
    factory_summary = factory_inventory.get("summary", {})
    first_article_summary = first_article_matrix.get("summary", {})
    if not isinstance(supplier_summary, dict):
        supplier_summary = {}
    if not isinstance(routed_summary, dict):
        routed_summary = {}
    if not isinstance(factory_summary, dict):
        factory_summary = {}
    if not isinstance(first_article_summary, dict):
        first_article_summary = {}

    handoff_missing_fields: dict[str, int] = {}
    for packet in handoff_gap:
        for field in packet.get("missing_required_fields") or packet.get("required_fields") or []:
            handoff_missing_fields[str(field)] = handoff_missing_fields.get(str(field), 0) + 1

    return [
        {
            "family": "supplier_return_approvals",
            "owner": "sourcing",
            "blocked_rows": summary_int(
                supplier_summary, "required_supplier_return_evidence_count"
            ),
            "required_metadata": [
                "supplier_name",
                "manufacturer_part_number",
                "drawing_revision",
                "sample_lot_or_quote_id",
                "signed_supplier_response",
                "pinout_or_land_pattern_source",
                "mechanical_model_source",
                "reviewer",
                "reviewed_at",
                "disposition=approved",
            ],
            "required_action": (
                "attach signed supplier-return metadata to each supplier evidence family "
                "before rerunning the supplier content gate"
            ),
            "validation_command": "python3 scripts/check_e1_phone_supplier_return_content.py",
            "release_credit": False,
        },
        {
            "family": "routed_release_approvals",
            "owner": "layout_fabrication",
            "blocked_rows": summary_int(
                routed_summary, "candidate_present_blocked_required_output_path_count"
            )
            + summary_int(routed_summary, "missing_required_output_path_count"),
            "required_metadata": [
                "artifact_sha256",
                "routed_pcb_hash",
                "erc_result",
                "drc_result",
                "stackup_revision",
                "si_pi_rf_report_references",
                "routed_step_reference",
                "external_review_authority",
                "signature_or_approval_record",
                "disposition=approved",
            ],
            "required_action": (
                "attach approved routed-output metadata, hashes, review authority, and "
                "signoff to real routed release artifacts"
            ),
            "validation_command": "python3 scripts/check_e1_phone_routed_output_content.py",
            "release_credit": False,
        },
        {
            "family": "factory_release_approvals",
            "owner": "manufacturing",
            "blocked_rows": summary_int(
                factory_summary, "candidate_present_blocked_required_output_path_count"
            )
            + summary_int(factory_summary, "missing_required_output_path_count"),
            "required_metadata": [
                "release_package_revision",
                "fab_vendor_or_assembler",
                "program_or_fixture_revision",
                "limits_revision",
                "calibration_state",
                "lot_or_serial_traceability",
                "signature_or_approval_record",
                "disposition=approved",
            ],
            "required_action": (
                "attach signed factory package metadata with lot traceability, fixture or "
                "program revisions, calibration, limits, and approved disposition"
            ),
            "validation_command": "python3 scripts/check_e1_phone_factory_output_content.py",
            "release_credit": False,
        },
        {
            "family": "first_article_approvals",
            "owner": "manufacturing_validation",
            "blocked_rows": summary_int(first_article_summary, "matrix_row_count"),
            "required_metadata": [
                "board_serial",
                "supplier_lot_ids",
                "fixture_id",
                "fixture_calibration_id",
                "test_software_revision",
                "operator",
                "limits_file",
                "measured_results",
                "pass_fail_disposition",
                "signature_or_approval_record",
                "disposition=approved",
            ],
            "required_action": (
                "replace templates with executed first-article records from serialized "
                "hardware and attach approval metadata"
            ),
            "validation_command": "python3 scripts/check_e1_phone_first_article_content.py",
            "release_credit": False,
        },
        {
            "family": "enclosure_handoff_approvals",
            "owner": "mechanical_release",
            "blocked_rows": len(handoff_gap),
            "missing_required_fields": dict(sorted(handoff_missing_fields.items())),
            "required_action": (
                "complete drawing, DFM, FAI/CMM, gasket/process, and validation handoff "
                "packets with approval signatures and executed physical evidence"
            ),
            "validation_command": "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            "release_credit": False,
        },
    ]


def interface_rows(burndown: dict[str, Any], supplier: dict[str, Any]) -> list[dict[str, Any]]:
    supplier_by_function = {
        str(row.get("function")): row for row in supplier.get("lanes", []) if row.get("function")
    }
    rows = []
    for item in burndown.get("physical_interface_burndown", []):
        if not isinstance(item, dict):
            continue
        interface = str(item.get("interface", ""))
        supplier_row = supplier_by_function.get(interface, {})
        rows.append(
            {
                "interface": interface,
                "placement_refs": item.get("placement_refs", []),
                "release_allowed": False,
                "required_release_checks": item.get("required_release_checks", []),
                "required_evidence": item.get("required_evidence", []),
                "supplier_missing_count": supplier_row.get("missing_count"),
                "next_external_or_physical_evidence_required": item.get("required_evidence", []),
            }
        )
    return rows


def handoff_packet_gap(burndown: dict[str, Any]) -> list[dict[str, Any]]:
    handoff = burndown.get("production_enclosure_handoff_evidence", {})
    if not isinstance(handoff, dict):
        return []
    packets = handoff.get("required_handoff_packets", [])
    if not isinstance(packets, list):
        return []
    rows = []
    for packet in packets:
        if not isinstance(packet, dict):
            continue
        expected_path = str(packet.get("expected_path") or "")
        required_fields = packet.get("required_fields", [])
        if not isinstance(required_fields, list):
            required_fields = []
        rows.append(
            {
                "id": str(packet.get("id") or ""),
                "deliverable": str(packet.get("deliverable") or ""),
                "expected_path": expected_path,
                "owner": str(packet.get("owner") or "unassigned"),
                "required_action": str(packet.get("required_action") or ""),
                "validation_command": str(
                    packet.get("validation_command")
                    or "python3 scripts/check_e1_phone_enclosure_mechanical_content.py"
                ),
                "required_fields": [str(field) for field in required_fields],
                "status": str(packet.get("status") or "missing"),
                "release_credit": False,
            }
        )
    return rows


def first_article_physical_fit_action_inventory(
    burndown: dict[str, Any],
) -> list[dict[str, Any]]:
    first_article = burndown.get("first_article_physical_fit_evidence", {})
    if not isinstance(first_article, dict):
        return []
    outputs = first_article.get("required_common_outputs", [])
    if not isinstance(outputs, list):
        return []
    required_inputs = {
        "serialized_routed_phone": "serialized EVT/DVT phone built from the routed production package",
        "routed_board_step": "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        "supplier_3d_models": "approved supplier STEP/B-rep models for physical interfaces",
        "routed_clearance_report": "board/kicad/e1-phone/production/reports/routed-board-clearance-release.yaml",
        "fixture_calibration": "calibrated force, plug-sweep, and measurement fixtures",
    }
    next_commands = [
        "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
        "python3 scripts/check_e1_phone_first_article_content.py",
        (
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone "
            "--report build/reports/phone-release-readiness-current.json"
        ),
    ]
    rows = []
    for output in outputs:
        path = str(output)
        if "routed-board-with-components.step" in path:
            evidence_class = "production_routed_board_step_release"
            action = "export the approved routed KiCad board with production component STEP models"
        elif "routed-board-clearance" in path:
            evidence_class = "physical_routed_board_clearance_result"
            action = "rerun all physical clearance cases against the approved routed STEP"
        elif "full-cad-boolean-interference" in path:
            evidence_class = "routed_full_cad_boolean_interference_report"
            action = (
                "rerun boolean interference on the approved routed board and enclosure assembly"
            )
        elif "assembly.pdf" in path:
            evidence_class = "released_assembly_drawing"
            action = (
                "release assembly drawing packet with production routed board and enclosure datums"
            )
        elif "first-article-test-transcript" in path:
            evidence_class = "executed_first_article_test_transcript"
            action = "execute the first-article physical-fit test on serialized hardware"
        elif path.endswith(".kicad_pcb"):
            evidence_class = "approved_routed_kicad_pcb"
            action = "attach approved routed KiCad PCB evidence and release metadata"
        else:
            evidence_class = "first_article_physical_fit_record"
            action = "capture approved physical-fit first-article evidence from serialized hardware"
        rows.append(
            {
                "path": path,
                "evidence_class": evidence_class,
                "present": (ROOT / path).is_file(),
                "owner": "manufacturing_validation",
                "required_action": action,
                "required_inputs": required_inputs,
                "next_commands": next_commands,
                "release_credit": False,
            }
        )
    return rows


def clearance_release_cases(contract: dict[str, Any]) -> dict[str, dict[str, Any]]:
    cases = contract.get("clearance_cases", [])
    if not isinstance(cases, list):
        return {}
    return {
        str(row["case_id"]): row for row in cases if isinstance(row, dict) and row.get("case_id")
    }


def routed_board_gap(
    board_step: dict[str, Any],
    clearance: dict[str, Any],
    routed_inputs: dict[str, Any],
    supplier_index: dict[str, dict[str, Any]],
    release_cases: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    release_cases = release_cases or {}
    production_step_files = board_step.get("production_step_files", [])
    if not isinstance(production_step_files, list):
        production_step_files = []
    blocked_candidate_step_files = board_step.get("blocked_candidate_step_files", [])
    if not isinstance(blocked_candidate_step_files, list):
        blocked_candidate_step_files = []
    development_step_candidates = board_step.get("development_step_candidates", [])
    if not isinstance(development_step_candidates, list):
        development_step_candidates = []
    candidate_paths = [
        str(row.get("path"))
        for row in development_step_candidates
        if isinstance(row, dict) and row.get("path")
    ] + [str(path) for path in blocked_candidate_step_files if path]
    candidate_paths = list(dict.fromkeys(candidate_paths))
    result_cases = clearance.get("result_cases", [])
    if not isinstance(result_cases, list):
        result_cases = []
    blocked_case_rows = []
    for row in result_cases:
        if not isinstance(row, dict):
            continue
        missing = []
        if row.get("evidence_class") != "physical_routed_board_clearance_result":
            missing.append("physical_routed_board_clearance_result")
        if row.get("measured_min_gap_mm") is None:
            missing.append("measured_min_gap_mm")
        if row.get("interference_count") not in (0, "0"):
            missing.append("interference_count_zero")
        if row.get("reviewer_present") is not True:
            missing.append("reviewer")
        if row.get("measurement_artifact_present") is not True:
            missing.append("measurement_artifact")
        if row.get("pass") is not True:
            missing.append("pass")
        if missing:
            case_id = str(row.get("case_id") or "")
            release_case = release_cases.get(case_id, {})
            next_artifacts = [
                release_case.get("required_release_report"),
                routed_inputs.get("required_production_routed_step"),
                routed_inputs.get("required_routed_kicad_pcb"),
                routed_inputs.get("required_drc_report"),
                routed_inputs.get("required_erc_report"),
                *routed_inputs.get("next_artifacts", []),
            ]
            blocked_case_rows.append(
                {
                    "case_id": case_id,
                    "required_release_report": release_case.get("required_release_report"),
                    "required_min_gap_mm": row.get("required_min_gap_mm"),
                    "required_inputs": routed_inputs,
                    "supplier_geometry_families": supplier_families_for_case(
                        case_id, supplier_index
                    ),
                    "next_artifacts": [artifact for artifact in next_artifacts if artifact],
                    "next_commands": CLEARANCE_NEXT_COMMANDS,
                    "missing": missing,
                    "release_credit": False,
                }
            )
    intake_cases = board_step.get("routed_board_intake_cases", [])
    if not isinstance(intake_cases, list):
        intake_cases = []
    missing_intake_fields: list[str] = []
    missing_intake_artifacts: list[str] = []
    for case in intake_cases:
        if not isinstance(case, dict):
            continue
        fields = case.get("missing_required_fields", [])
        if isinstance(fields, list):
            missing_intake_fields.extend(str(field) for field in fields)
        artifact_checks = case.get("artifact_path_checks", {})
        if isinstance(artifact_checks, dict):
            missing_intake_artifacts.extend(
                str(name) for name, present in artifact_checks.items() if present is not True
            )
    return {
        "release_allowed": False,
        "release_credit": False,
        "board_step_status": board_step.get("status"),
        "routed_clearance_status": clearance.get("status"),
        "production_routed_step_release_count": len(production_step_files),
        "candidate_routed_step_count": len(existing_repo_paths(candidate_paths)),
        "candidate_routed_step_paths": existing_repo_paths(candidate_paths),
        "candidate_paths_do_not_grant_release_credit": True,
        "clearance_results_complete": clearance.get("complete_clearance_result_count", 0),
        "clearance_results_expected": clearance.get("expected_clearance_case_count", 0),
        "blocked_clearance_cases": blocked_case_rows,
        "missing_routed_board_intake_fields": sorted(set(missing_intake_fields)),
        "missing_routed_board_intake_artifacts": sorted(set(missing_intake_artifacts)),
    }


def routed_clearance_release_action_inventory(
    routed_gap: dict[str, Any],
    release_execution: dict[str, Any],
) -> list[dict[str, Any]]:
    release_contract = release_execution.get("release_contract", {})
    required_inputs = release_execution.get("required_inputs", {})
    if not isinstance(release_contract, dict):
        release_contract = {}
    if not isinstance(required_inputs, dict):
        required_inputs = {}
    case_meta = clearance_release_cases(release_execution)
    next_commands = [
        "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
        "python3 scripts/e1_phone_enclosure_readiness_gap_map.py --write-report",
        (
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone "
            "--report build/reports/phone-release-readiness-current.json"
        ),
    ]
    rows = []
    for case in routed_gap.get("blocked_clearance_cases", []):
        if not isinstance(case, dict):
            continue
        case_id = str(case.get("case_id") or "")
        meta = case_meta.get(case_id, {})
        rows.append(
            {
                "case_id": case_id,
                "risk_level": meta.get("risk_level"),
                "rerun_priority": meta.get("rerun_priority"),
                "required_release_report": case.get("required_release_report")
                or meta.get("required_release_report"),
                "required_evidence_class": release_contract.get(
                    "required_evidence_class",
                    "physical_routed_board_clearance_result",
                ),
                "required_inputs": {
                    key: value
                    for key, value in required_inputs.items()
                    if key
                    in {
                        "routed_board_step",
                        "supplier_3d_binding_report",
                        "physical_fit_first_article",
                        "routed_boolean_interference_report",
                        "assembly_drawing",
                    }
                },
                "routed_step_input_map": case.get("required_inputs", {}),
                "supplier_geometry_families": case.get("supplier_geometry_families", []),
                "next_artifacts": [
                    artifact for artifact in case.get("next_artifacts", []) if artifact
                ],
                "missing": case.get("missing", []),
                "next_commands": next_commands,
                "release_credit": False,
            }
        )
    return sorted(
        rows,
        key=lambda item: (
            int(item.get("rerun_priority") or 999),
            str(item.get("case_id") or ""),
        ),
    )


def build_report(
    burndown_path: Path,
    mechanical_path: Path,
    first_article_path: Path,
    supplier_path: Path,
    report_path: Path,
    routed_matrix_path: Path = DEFAULT_ROUTED_MATRIX,
    factory_inventory_path: Path = DEFAULT_FACTORY_INVENTORY,
) -> dict[str, Any]:
    burndown = read_yaml(burndown_path)
    mechanical = read_yaml(mechanical_path)
    first_article = read_yaml(first_article_path)
    supplier_matrix = read_yaml(supplier_path)
    routed_matrix = read_yaml(routed_matrix_path)
    factory_inventory = read_yaml(factory_inventory_path)
    routed_clearance_execution = read_yaml(DEFAULT_ROUTED_CLEARANCE_EXECUTION)
    board_step = read_json(DEFAULT_BOARD_STEP)
    routed_clearance = read_json(DEFAULT_ROUTED_CLEARANCE)
    first_article_gap = first_article_splits(first_article)
    supplier_gap = supplier_splits(supplier_matrix)
    supplier_families = burndown.get("required_supplier_geometry_inputs", [])
    if not isinstance(supplier_families, list):
        supplier_families = []
    supplier_index = supplier_family_index(supplier_families)
    routed_inputs = routed_step_input_map(board_step, routed_clearance_execution)
    interfaces = interface_rows(burndown, supplier_gap)
    handoff_gap = handoff_packet_gap(burndown)
    first_article_fit_actions = first_article_physical_fit_action_inventory(burndown)
    routed_gap = routed_board_gap(
        board_step,
        routed_clearance,
        routed_inputs,
        supplier_index,
        clearance_release_cases(routed_clearance_execution),
    )
    unblock_inventory = release_action_inventory(
        supplier_matrix,
        routed_matrix,
        factory_inventory,
        first_article,
        routed_gap,
        handoff_gap,
    )
    approval_inventory = approval_metadata_action_inventory(
        supplier_matrix,
        routed_matrix,
        factory_inventory,
        first_article,
        handoff_gap,
    )
    clearance_action_inventory = routed_clearance_release_action_inventory(
        routed_gap,
        routed_clearance_execution,
    )
    missing_release_evidence = mechanical.get("missing_release_ready_evidence", [])
    if not isinstance(missing_release_evidence, list):
        missing_release_evidence = []

    return {
        "schema": "eliza.e1_phone_enclosure_readiness_gap_map.v1",
        "status": "blocked_fail_closed_diagnostic_only",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Diagnostic gap map joining enclosure burndown, mechanical CAD inventory, "
            "supplier-return matrix, and first-article matrix. It is not supplier evidence, "
            "not routed-board STEP evidence, not physical fit evidence, and grants no release credit."
        ),
        "inputs": {
            "enclosure_mechanical_burndown": rel(burndown_path),
            "mechanical_cad_evidence_inventory": rel(mechanical_path),
            "first_article_matrix": rel(first_article_path),
            "supplier_return_matrix": rel(supplier_path),
            "routed_output_matrix": rel(routed_matrix_path),
            "factory_output_inventory": rel(factory_inventory_path),
            "report_path": rel(report_path),
        },
        "summary": {
            "release_allowed": False,
            "release_credit": False,
            "missing_release_evidence_count": len(missing_release_evidence),
            "supplier_geometry_family_count": len(supplier_families),
            "supplier_geometry_families_blocked": sum(
                1
                for row in supplier_families
                if isinstance(row, dict) and row.get("release_allowed") is not True
            ),
            "physical_interface_count": len(interfaces),
            "physical_interfaces_blocked": len(interfaces),
            "supplier_return_blocked_lane_count": supplier_gap["blocked_lane_count"],
            "supplier_return_present_but_not_release_evidence_count": supplier_gap[
                "present_but_not_release_evidence_count"
            ],
            "first_article_missing_required_non_template_count": first_article_gap[
                "missing_required_non_template_count"
            ],
            "first_article_template_row_count": first_article_gap["template_row_count"],
            "first_article_present_unvalidated_count": first_article_gap[
                "present_unvalidated_count"
            ],
            "production_enclosure_handoff_packet_count": len(handoff_gap),
            "production_routed_step_release_count": routed_gap[
                "production_routed_step_release_count"
            ],
            "candidate_routed_step_count": routed_gap["candidate_routed_step_count"],
            "clearance_results_complete": routed_gap["clearance_results_complete"],
            "clearance_results_expected": routed_gap["clearance_results_expected"],
            "blocked_clearance_case_count": len(routed_gap["blocked_clearance_cases"]),
            "release_unblock_action_group_count": len(unblock_inventory),
            "approval_metadata_action_group_count": len(approval_inventory),
            "routed_clearance_release_action_count": len(clearance_action_inventory),
            "first_article_physical_fit_action_count": len(first_article_fit_actions),
            "clearance_supplier_family_mapping_count": sum(
                1 for row in clearance_action_inventory if row.get("supplier_geometry_families")
            ),
            "clearance_routed_step_input_mapping_count": sum(
                1 for row in clearance_action_inventory if row.get("routed_step_input_map")
            ),
            "release_unblock_blocked_row_count": sum(
                int(row.get("blocked_rows") or 0) for row in unblock_inventory
            ),
        },
        "fail_closed_policy": {
            "release_allowed": False,
            "release_credit": False,
            "candidate_or_concept_cad_counts_as_release_evidence": False,
            "presence_only_counts_as_release_evidence": False,
            "external_supplier_and_physical_fit_evidence_required": True,
        },
        "mechanical_missing_release_evidence": missing_release_evidence,
        "supplier_return_gap": supplier_gap,
        "physical_interface_gap_map": interfaces,
        "routed_board_clearance_gap": routed_gap,
        "production_enclosure_handoff_gap": handoff_gap,
        "first_article_gap": first_article_gap,
        "fabrication_enclosure_unblock_action_inventory": unblock_inventory,
        "approval_metadata_action_inventory": approval_inventory,
        "routed_clearance_release_action_inventory": clearance_action_inventory,
        "first_article_physical_fit_action_inventory": first_article_fit_actions,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--burndown", type=Path, default=DEFAULT_BURNDOWN)
    parser.add_argument("--mechanical-inventory", type=Path, default=DEFAULT_MECHANICAL_INVENTORY)
    parser.add_argument("--first-article", type=Path, default=DEFAULT_FIRST_ARTICLE)
    parser.add_argument("--supplier-matrix", type=Path, default=DEFAULT_SUPPLIER_MATRIX)
    parser.add_argument("--routed-matrix", type=Path, default=DEFAULT_ROUTED_MATRIX)
    parser.add_argument("--factory-inventory", type=Path, default=DEFAULT_FACTORY_INVENTORY)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--write-report", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(
        args.burndown,
        args.mechanical_inventory,
        args.first_article,
        args.supplier_matrix,
        args.report,
        args.routed_matrix,
        args.factory_inventory,
    )
    text = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False, width=100)
    if args.write_report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
