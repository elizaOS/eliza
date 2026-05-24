#!/usr/bin/env python3
"""Fail-closed content gate for E1 phone enclosure/mechanical release evidence."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
BURNDOWN = ROOT / "board/kicad/e1-phone/enclosure-mechanical-release-burndown-2026-05-22.yaml"
REPORT = ROOT / "build/reports/e1_phone_enclosure_mechanical_content.json"
MECH_REVIEW = ROOT / "mechanical/e1-phone/review"
MECH_INVENTORY = MECH_REVIEW / "mechanical-cad-evidence-inventory-2026-05-22.yaml"
BOARD_STEP = MECH_REVIEW / "board-step-readiness.json"
ROUTED_CLEARANCE = MECH_REVIEW / "routed-board-clearance.json"
STEP_VALIDATION = MECH_REVIEW / "step-validation.json"
FULL_CAD_BOOLEAN = MECH_REVIEW / "full-cad-boolean-interference.json"
CAD_CONNECTION_COVERAGE = MECH_REVIEW / "cad-connection-coverage.json"
ROUTED_CLEARANCE_EXECUTION = ROOT / "board/kicad/e1-phone/routed-clearance-release-execution.yaml"
EXPECTED_SCHEMA = "eliza.e1_phone_enclosure_mechanical_release_burndown.v1"
RELEASE_POLICY_FLAGS = {
    "ready_for_enclosure",
    "ready_for_routed_step_export",
    "ready_for_clearance_release",
    "ready_for_physical_fit_first_article",
    "ready_for_production_enclosure_handoff",
    "release_allowed_without_supplier_step_or_brep",
    "release_allowed_without_routed_board_step",
    "release_allowed_without_boolean_interference_report",
    "release_allowed_without_usb_plug_sweep",
    "release_allowed_without_button_force_load_bypass",
    "release_allowed_without_tolerance_stack_measurements",
    "release_allowed_without_first_article_fit_evidence",
    "release_allowed_from_concept_cad",
}

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
    "split_interconnect_connectors_on_pcb_islands": [
        "audio_haptics_split_interconnect"
    ],
    "split_interconnect_flex_to_battery_edge": [
        "audio_haptics_split_interconnect",
        "battery_power_thermal_stack",
    ],
    "split_interconnect_flex_within_side_rail": [
        "audio_haptics_split_interconnect"
    ],
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


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def repo_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return ROOT.parents[1] / path
    return ROOT / path


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing file: {rel(path)}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a YAML mapping")
    return data


def load_json_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing file: {rel(path)}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a JSON object")
    return data


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fail-closed content gate for E1 phone enclosure/mechanical release evidence."
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=REPORT,
        help="JSON report path to write.",
    )
    return parser.parse_args()


def write_report(payload: dict[str, Any], report_path: Path) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def present_count(paths: list[str]) -> int:
    return sum(1 for path in paths if repo_path(path).exists())


def missing_paths(paths: list[str]) -> list[str]:
    return [path for path in paths if not repo_path(path).exists()]


def existing_paths(paths: list[str]) -> list[str]:
    return [path for path in paths if repo_path(path).exists()]


def artifact_inventory(
    paths: list[str],
    *,
    evidence_kind: str,
    release_credit: bool,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        artifact_path = repo_path(path)
        rows.append(
            {
                "path": path,
                "evidence_kind": evidence_kind,
                "present": artifact_path.exists(),
                "is_file": artifact_path.is_file(),
                "size_bytes": artifact_path.stat().st_size if artifact_path.is_file() else 0,
                "release_credit": release_credit,
            }
        )
    return rows


def count_by_field(rows: list[dict[str, Any]], field: str) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for row in rows:
        value = row.get(field)
        if value not in (None, "", []):
            counts[str(value)] += 1
    return dict(sorted(counts.items()))


def release_evidence_diagnostics(
    missing_release_evidence: list[Any],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, item in enumerate(missing_release_evidence):
        if not isinstance(item, dict):
            rows.append(
                {
                    "index": index,
                    "gate": f"missing_release_evidence_{index}",
                    "category": "missing_release_evidence_record_invalid",
                    "status": "invalid_record",
                    "release_credit": False,
                }
            )
            continue
        gate = str(item.get("gate") or f"missing_release_evidence_{index}")
        category = "missing_release_evidence"
        if gate == "routed_board_step_intake":
            detailed_candidate = item.get("detailed_routed_step_candidate", {})
            category = (
                "local_cad_candidate_present_no_release"
                if isinstance(detailed_candidate, dict)
                and detailed_candidate.get("present") is True
                else "production_routed_step_missing"
            )
        elif gate == "routed_board_clearance":
            category = "routed_clearance_release_results_missing"
        elif gate == "supplier_evidence":
            category = "supplier_geometry_and_return_evidence_missing"
        elif gate == "physical_fit_evidence":
            category = "physical_fit_first_article_evidence_missing"
        elif gate == "physical_process_validation":
            category = "physical_process_validation_results_missing"
        rows.append(
            {
                "index": index,
                "gate": gate,
                "category": category,
                "required_evidence": item.get("required_evidence"),
                "status": item.get("status"),
                "path": item.get("path"),
                "release_credit": False,
            }
        )
    return rows


def release_evidence_generation_plan(
    blockers: list[dict[str, Any]],
    *,
    routed_inputs: dict[str, Any],
    present_candidate_step_paths: list[str],
    routed_intake_diagnostics: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    blocked_intake_reasons = sorted(
        {
            reason
            for row in routed_intake_diagnostics
            for reason in row.get("missing", [])
            if reason
        }
    )
    plan_by_gate: dict[str, dict[str, Any]] = {
        "routed_board_step_intake": {
            "repo_generation_status": "blocked_candidate_present_no_release",
            "repo_generatable_now": False,
            "candidate_artifacts_present": bool(present_candidate_step_paths),
            "candidate_paths": present_candidate_step_paths,
            "required_release_artifacts": [
                routed_inputs.get("required_production_routed_step"),
                routed_inputs.get("required_routed_kicad_pcb"),
                routed_inputs.get("required_drc_report"),
                routed_inputs.get("required_erc_report"),
                *routed_inputs.get("next_artifacts", []),
            ],
            "blocked_by": blocked_intake_reasons
            or [
                "production_routed_step_release_intake_missing",
                "approved_supplier_component_3d_models_missing",
                "routed_clearance_release_missing",
            ],
            "generation_commands": [
                "python3 scripts/generate_e1_phone_cad.py",
                "python3 scripts/check_e1_phone_routed_output_content.py",
                "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            ],
            "next_external_inputs": [
                "approved routed KiCad PCB release package with clean DRC/ERC",
                "approved supplier component STEP/B-rep binding manifest",
                "signed routed-board STEP release intake metadata",
                "measured routed clearance release result",
            ],
        },
        "routed_board_clearance": {
            "repo_generation_status": "blocked_waiting_for_release_step_and_measurements",
            "repo_generatable_now": False,
            "candidate_artifacts_present": bool(present_candidate_step_paths),
            "candidate_paths": present_candidate_step_paths,
            "required_release_artifacts": [
                "board/kicad/e1-phone/production/reports/routed-board-clearance-release.yaml",
                routed_inputs.get("required_production_routed_step"),
                routed_inputs.get("next_artifacts", [None, None, None])[2],
            ],
            "blocked_by": [
                "production_routed_step_release_missing",
                "approved_supplier_geometry_missing",
                "measured_min_gap_results_missing",
                "reviewer_and_measurement_artifact_missing",
            ],
            "generation_commands": CLEARANCE_NEXT_COMMANDS,
            "next_external_inputs": [
                "approved production routed STEP with supplier component models",
                "measurement artifacts for all routed clearance cases",
                "reviewer signoff for physical_routed_board_clearance_result rows",
            ],
        },
        "supplier_evidence": {
            "repo_generation_status": "external_supplier_return_required",
            "repo_generatable_now": False,
            "candidate_artifacts_present": False,
            "candidate_paths": [],
            "required_release_artifacts": [
                "board/kicad/e1-phone/production/sourcing/readiness/supplier-return-evidence-acceptance-matrix-2026-05-22.yaml",
            ],
            "blocked_by": [
                "supplier_quote_drawing_step_sample_traceability_not_validated",
                "approval_metadata_missing",
            ],
            "generation_commands": [
                "python3 scripts/check_e1_phone_supplier_return_content.py",
                "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            ],
            "next_external_inputs": [
                "supplier returned quote, 2D drawing, STEP/B-rep, sample, and traceability packs",
            ],
        },
        "physical_fit_evidence": {
            "repo_generation_status": "hardware_execution_required",
            "repo_generatable_now": False,
            "candidate_artifacts_present": False,
            "candidate_paths": [],
            "required_release_artifacts": [
                "mechanical/e1-phone/review/fit-check-report.json",
                "board/kicad/e1-phone/production/test/first-article-test-transcript.json",
            ],
            "blocked_by": [
                "serialized_hardware_fit_check_missing",
                "reviewer_identity_and_measurement_artifacts_missing",
            ],
            "generation_commands": [
                "python3 scripts/check_e1_phone_first_article_content.py",
                "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            ],
            "next_external_inputs": [
                "fabricated enclosure/board/display/battery/button/port fit-check results",
            ],
        },
        "physical_process_validation": {
            "repo_generation_status": "finished_phone_validation_required",
            "repo_generatable_now": False,
            "candidate_artifacts_present": False,
            "candidate_paths": [],
            "required_release_artifacts": [
                "mechanical/e1-phone/review/physical-process-validation-acceptance.json",
            ],
            "blocked_by": [
                "lab_evt_fai_traceability_build_process_control_results_missing",
            ],
            "generation_commands": [
                "python3 scripts/check_e1_phone_first_article_content.py",
                "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            ],
            "next_external_inputs": [
                "finished-phone lab, EVT, FAI, build, traceability, and process-control results",
            ],
        },
    }
    for blocker in blockers:
        gate = str(blocker.get("gate") or "")
        plan = dict(plan_by_gate.get(gate, {}))
        if not plan:
            plan = {
                "repo_generation_status": "unknown_blocked_release_evidence",
                "repo_generatable_now": False,
                "candidate_artifacts_present": False,
                "candidate_paths": [],
                "required_release_artifacts": [blocker.get("path")],
                "blocked_by": [blocker.get("category") or "missing_release_evidence"],
                "generation_commands": [
                    "python3 scripts/check_e1_phone_enclosure_mechanical_content.py"
                ],
                "next_external_inputs": [],
            }
        rows.append(
            {
                "gate": gate,
                "category": blocker.get("category"),
                "status": blocker.get("status"),
                "path": blocker.get("path"),
                "required_evidence": blocker.get("required_evidence"),
                "release_credit": False,
                **plan,
            }
        )
    return rows


def routed_step_release_generation_plan(
    *,
    production_step_files: list[Any],
    candidate_step_paths: list[str],
    present_candidate_step_paths: list[str],
    routed_inputs: dict[str, Any],
    routed_intake_diagnostics: list[dict[str, Any]],
) -> dict[str, Any]:
    blocked_reasons = sorted(
        {
            reason
            for row in routed_intake_diagnostics
            for reason in row.get("missing", [])
            if reason
        }
    )
    next_artifacts = routed_inputs.get("next_artifacts", [])
    if not isinstance(next_artifacts, list):
        next_artifacts = []
    return {
        "required_production_routed_step": routed_inputs.get(
            "required_production_routed_step"
        ),
        "routed_step_files": len(production_step_files),
        "candidate_step_file_count": len(present_candidate_step_paths),
        "candidate_step_paths": present_candidate_step_paths,
        "candidate_paths_checked": candidate_step_paths,
        "repo_can_generate_release_step_now": False,
        "repo_generatable_release_step_count": 0,
        "repo_generatable_candidate_step_count": len(present_candidate_step_paths),
        "candidate_release_credit": False,
        "release_credit": False,
        "blocked_by": blocked_reasons
        or [
            "approved_production_step_files_empty",
            "candidate_outputs_lack_release_intake",
        ],
        "required_release_inputs": {
            "routed_board_step": routed_inputs.get("required_production_routed_step"),
            "routed_kicad_pcb": routed_inputs.get("required_routed_kicad_pcb"),
            "drc_report": routed_inputs.get("required_drc_report"),
            "erc_report": routed_inputs.get("required_erc_report"),
            "supplier_3d_binding_report": (
                next_artifacts[1] if len(next_artifacts) > 1 else None
            ),
            "routed_boolean_interference_report": (
                next_artifacts[2] if len(next_artifacts) > 2 else None
            ),
        },
        "local_candidate_generation_commands": [
            "python3 scripts/generate_e1_phone_cad.py",
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
        ],
        "release_promotion_commands": [
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            (
                "python3 scripts/aggregate_tapeout_readiness.py --scope phone "
                "--report build/reports/phone-release-readiness-current.json"
            ),
        ],
        "next_external_inputs": [
            "approved routed KiCad PCB release package with clean DRC/ERC",
            "approved production component STEP/B-rep binding manifest",
            "signed release metadata for the routed STEP artifact",
            "measured routed enclosure clearance pass and reviewer signoff",
        ],
    }


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


def supplier_family_blocker_inventory(
    supplier_families: list[Any],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, family in enumerate(supplier_families):
        if not isinstance(family, dict):
            rows.append(
                {
                    "index": index,
                    "family": f"supplier_family_{index}",
                    "category": "supplier_family_record_invalid",
                    "release_allowed": False,
                    "release_credit": False,
                }
            )
            continue
        if family.get("release_allowed") is True:
            continue
        required_geometry = family.get("required_step_or_brep_inputs", [])
        required_before_release = family.get("required_before_release", [])
        if not isinstance(required_geometry, list):
            required_geometry = []
        if not isinstance(required_before_release, list):
            required_before_release = []
        rows.append(
            {
                "index": index,
                "family": str(family.get("family") or f"supplier_family_{index}"),
                "selected_hardware": family.get("selected_hardware"),
                "category": "supplier_geometry_return_blocker",
                "required_step_or_brep_input_count": len(required_geometry),
                "required_before_release_count": len(required_before_release),
                "required_step_or_brep_inputs": required_geometry,
                "required_before_release": required_before_release,
                "release_allowed": False,
                "release_credit": False,
            }
        )
    return rows


def physical_interface_blocker_inventory(
    physical_interfaces: list[Any],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, interface in enumerate(physical_interfaces):
        if not isinstance(interface, dict):
            rows.append(
                {
                    "index": index,
                    "interface": f"physical_interface_{index}",
                    "category": "physical_interface_record_invalid",
                    "release_allowed": False,
                    "release_credit": False,
                }
            )
            continue
        if interface.get("release_allowed") is True:
            continue
        required_checks = interface.get("required_release_checks", [])
        required_evidence = interface.get("required_evidence", [])
        if not isinstance(required_checks, list):
            required_checks = []
        if not isinstance(required_evidence, list):
            required_evidence = []
        rows.append(
            {
                "index": index,
                "interface": str(interface.get("interface") or f"physical_interface_{index}"),
                "placement_refs": interface.get("placement_refs", []),
                "category": "physical_interface_release_blocker",
                "required_release_check_count": len(required_checks),
                "required_evidence_count": len(required_evidence),
                "required_release_checks": required_checks,
                "required_evidence": required_evidence,
                "release_allowed": False,
                "release_credit": False,
            }
        )
    return rows


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
    contract: dict[str, Any],
) -> dict[str, Any]:
    required_inputs = contract.get("required_inputs", {})
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
        "candidate_step_paths_present": existing_paths(candidate_paths),
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


def routed_release_intake_diagnostics(board_step: dict[str, Any]) -> list[dict[str, Any]]:
    cases = board_step.get("routed_board_intake_cases", [])
    if not isinstance(cases, list):
        return []
    rows: list[dict[str, Any]] = []
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            rows.append(
                {
                    "index": index,
                    "pass": False,
                    "release_credit": False,
                    "missing": ["intake_case_not_mapping"],
                }
            )
            continue
        artifact_checks = case.get("artifact_path_checks", {})
        if not isinstance(artifact_checks, dict):
            artifact_checks = {}
        missing_artifacts = [
            str(name) for name, present in artifact_checks.items() if present is not True
        ]
        missing_required_fields = case.get("missing_required_fields", [])
        if not isinstance(missing_required_fields, list):
            missing_required_fields = []
        missing = [f"missing_field:{field}" for field in missing_required_fields]
        missing.extend(f"missing_artifact:{artifact}" for artifact in missing_artifacts)
        for flag in (
            "evidence_class_allowed",
            "required_fields_present",
            "routed_step_sha256_matches",
            "drc_status_clean",
            "erc_status_clean",
            "component_3d_model_manifest_approved",
            "enclosure_clearance_passed",
            "approval_signature_present",
        ):
            if case.get(flag) is not True:
                missing.append(f"{flag}:false")
        rows.append(
            {
                "index": index,
                "release_id": str(case.get("release_id") or ""),
                "evidence_class": str(case.get("evidence_class") or ""),
                "pass": case.get("pass") is True,
                "release_credit": False,
                "missing_required_fields": [str(field) for field in missing_required_fields],
                "missing_artifacts": missing_artifacts,
                "missing": missing,
            }
        )
    return rows


def clearance_case_diagnostics(
    clearance_results: list[Any],
    rerun_matrix: list[Any],
    routed_inputs: dict[str, Any],
    supplier_index: dict[str, dict[str, Any]],
    release_cases: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    rerun_by_case = {
        str(row.get("case_id")): row for row in rerun_matrix if isinstance(row, dict)
    }
    release_cases = release_cases or {}
    rows: list[dict[str, Any]] = []
    for index, row in enumerate(clearance_results):
        if not isinstance(row, dict):
            rows.append(
                {
                    "case_id": str(index),
                    "pass": False,
                    "release_credit": False,
                    "missing": ["clearance_result_not_mapping"],
                }
            )
            continue
        case_id = str(row.get("case_id") or index)
        release_case = release_cases.get(case_id, {})
        missing: list[str] = []
        if row.get("evidence_class") != "physical_routed_board_clearance_result":
            missing.append("evidence_class:physical_routed_board_clearance_result")
        if row.get("measured_min_gap_mm") is None:
            missing.append("measured_min_gap_mm")
        if row.get("interference_count") not in (0, "0"):
            missing.append("interference_count_zero")
        if row.get("reviewer_present") is not True:
            missing.append("reviewer")
        if row.get("measurement_artifact_present") is not True:
            missing.append("measurement_artifact")
        if row.get("pass") is not True:
            missing.append("case_pass")
        rerun = rerun_by_case.get(case_id, {})
        rows.append(
            {
                "case_id": case_id,
                "pass": row.get("pass") is True,
                "release_credit": False,
                "risk_level": rerun.get("risk_level"),
                "rerun_priority": rerun.get("rerun_priority"),
                "concept_actual_mm": rerun.get("concept_actual_mm"),
                "concept_required_mm": rerun.get("concept_required_mm"),
                "concept_margin_mm": rerun.get("concept_margin_mm"),
                "required_release_report": release_case.get("required_release_report"),
                "required_inputs": routed_inputs,
                "supplier_geometry_families": supplier_families_for_case(
                    case_id, supplier_index
                ),
                "next_artifacts": [
                    release_case.get("required_release_report"),
                    routed_inputs.get("required_production_routed_step"),
                    routed_inputs.get("required_routed_kicad_pcb"),
                    routed_inputs.get("required_drc_report"),
                    routed_inputs.get("required_erc_report"),
                    *routed_inputs.get("next_artifacts", []),
                ],
                "next_commands": CLEARANCE_NEXT_COMMANDS,
                "required_min_gap_mm": row.get("required_min_gap_mm"),
                "measured_min_gap_mm": row.get("measured_min_gap_mm"),
                "interference_count": row.get("interference_count"),
                "missing": missing,
                "measurement_instruction": rerun.get(
                    "measurement_instruction",
                    "Rerun against routed KiCad STEP with production component 3D models.",
                ),
            }
        )
    return rows


def clearance_release_cases(contract: dict[str, Any]) -> dict[str, dict[str, Any]]:
    cases = contract.get("clearance_cases", [])
    if not isinstance(cases, list):
        return {}
    by_id: dict[str, dict[str, Any]] = {}
    for row in cases:
        if isinstance(row, dict) and row.get("case_id"):
            by_id[str(row["case_id"])] = row
    return by_id


def clearance_release_action_inventory(
    diagnostics: list[dict[str, Any]],
    contract: dict[str, Any],
) -> list[dict[str, Any]]:
    release_contract = contract.get("release_contract", {})
    required_inputs = contract.get("required_inputs", {})
    if not isinstance(release_contract, dict):
        release_contract = {}
    if not isinstance(required_inputs, dict):
        required_inputs = {}
    rows: list[dict[str, Any]] = []
    for row in diagnostics:
        if row.get("pass") is True:
            continue
        rows.append(
            {
                "case_id": row.get("case_id"),
                "risk_level": row.get("risk_level"),
                "rerun_priority": row.get("rerun_priority"),
                "required_release_report": row.get("required_release_report"),
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
                "routed_step_input_map": row.get("required_inputs", {}),
                "supplier_geometry_families": row.get("supplier_geometry_families", []),
                "next_artifacts": [
                    artifact
                    for artifact in row.get("next_artifacts", [])
                    if artifact
                ],
                "missing": row.get("missing", []),
                "next_commands": CLEARANCE_NEXT_COMMANDS,
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


def clearance_missing_reason_counts(
    diagnostics: list[dict[str, Any]],
) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for row in diagnostics:
        for reason in row.get("missing", []):
            counts[str(reason)] += 1
    return dict(sorted(counts.items()))


def handoff_packet_failures(packet: dict[str, Any]) -> list[str]:
    packet_id = str(packet.get("id") or "<missing-id>")
    failures: list[str] = []
    if not packet.get("id"):
        failures.append("missing_handoff_packet_id")
    expected_path = packet.get("expected_path")
    if not isinstance(expected_path, str) or not expected_path:
        failures.append(f"{packet_id}:missing_expected_path")
        return failures
    for field in ("owner", "required_action", "validation_command"):
        if not isinstance(packet.get(field), str) or not packet.get(field):
            failures.append(f"{packet_id}:missing_{field}")
    if packet.get("release_credit") is True:
        failures.append(f"{packet_id}:release_credit_true")
    required_fields = packet.get("required_fields")
    if not isinstance(required_fields, list) or not required_fields:
        failures.append(f"{packet_id}:missing_required_fields")
    evidence_path = repo_path(expected_path)
    if not evidence_path.is_file():
        failures.append(f"{packet_id}:missing_expected_path:{expected_path}")
        return failures
    data = yaml.safe_load(evidence_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        failures.append(f"{packet_id}:expected_path_not_mapping:{expected_path}")
        return failures
    if data.get("release_credit") is True and data.get("status") not in {
        "passed",
        "approved",
        "executed_pass",
    }:
        failures.append(f"{packet_id}:unapproved_release_credit:{expected_path}")
    for field in required_fields:
        if str(field) not in data or data.get(str(field)) in (None, "", []):
            failures.append(f"{packet_id}:missing_field:{field}")
    return failures


def handoff_packet_action(packet: dict[str, Any]) -> dict[str, Any]:
    expected_path = str(packet.get("expected_path") or "")
    required_fields = packet.get("required_fields")
    if not isinstance(required_fields, list):
        required_fields = []
    evidence_path = repo_path(expected_path) if expected_path else None
    present = bool(evidence_path and evidence_path.is_file())
    missing_required_fields: list[str] = []
    if present and evidence_path is not None:
        data = yaml.safe_load(evidence_path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            missing_required_fields = [
                str(field)
                for field in required_fields
                if str(field) not in data or data.get(str(field)) in (None, "", [])
            ]
        else:
            missing_required_fields = [str(field) for field in required_fields]
    else:
        missing_required_fields = [str(field) for field in required_fields]
    return {
        "id": str(packet.get("id") or ""),
        "deliverable": str(packet.get("deliverable") or ""),
        "expected_path": expected_path,
        "owner": str(packet.get("owner") or "unassigned"),
        "required_action": str(packet.get("required_action") or ""),
        "validation_command": str(
            packet.get("validation_command")
            or "python3 scripts/check_e1_phone_enclosure_mechanical_content.py"
        ),
        "present": present,
        "release_credit": packet.get("release_credit") is True,
        "missing_required_fields": missing_required_fields,
    }


def first_article_physical_fit_action_inventory(paths: list[str]) -> list[dict[str, Any]]:
    commands = [
        "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
        "python3 scripts/check_e1_phone_first_article_content.py",
        (
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone "
            "--report build/reports/phone-release-readiness-current.json"
        ),
    ]
    required_inputs = {
        "serialized_routed_phone": "serialized EVT/DVT phone built from the routed production package",
        "routed_board_step": "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        "supplier_3d_models": "approved supplier STEP/B-rep models for physical interfaces",
        "routed_clearance_report": "board/kicad/e1-phone/production/reports/routed-board-clearance-release.yaml",
        "fixture_calibration": "calibrated force, plug-sweep, and measurement fixtures",
    }
    rows: list[dict[str, Any]] = []
    for path in paths:
        evidence_path = repo_path(path)
        suffix = evidence_path.suffix.lower()
        if "routed-board-with-components.step" in path:
            evidence_class = "production_routed_board_step_release"
            action = "export the approved routed KiCad board with production component STEP models"
        elif "routed-board-clearance" in path:
            evidence_class = "physical_routed_board_clearance_result"
            action = "rerun all physical clearance cases against the approved routed STEP"
        elif "full-cad-boolean-interference" in path:
            evidence_class = "routed_full_cad_boolean_interference_report"
            action = "rerun boolean interference on the approved routed board and enclosure assembly"
        elif "assembly.pdf" in path:
            evidence_class = "released_assembly_drawing"
            action = "release assembly drawing packet with production routed board and enclosure datums"
        elif "first-article-test-transcript" in path:
            evidence_class = "executed_first_article_test_transcript"
            action = "execute the first-article physical-fit test on serialized hardware"
        elif suffix == ".kicad_pcb":
            evidence_class = "approved_routed_kicad_pcb"
            action = "attach approved routed KiCad PCB evidence and release metadata"
        else:
            evidence_class = "first_article_physical_fit_record"
            action = "capture approved physical-fit first-article evidence from serialized hardware"
        rows.append(
            {
                "path": path,
                "evidence_class": evidence_class,
                "present": evidence_path.is_file(),
                "owner": "manufacturing_validation",
                "required_action": action,
                "required_inputs": required_inputs,
                "next_commands": commands,
                "release_credit": False,
            }
        )
    return rows


def main() -> int:
    args = parse_args()
    try:
        burndown = load_yaml_mapping(BURNDOWN)
        if burndown.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {burndown.get('schema')!r}")
        mechanical = load_yaml_mapping(MECH_INVENTORY)
        board_step = load_json_mapping(BOARD_STEP)
        routed_clearance = load_json_mapping(ROUTED_CLEARANCE)
        step_validation = load_json_mapping(STEP_VALIDATION)
        full_cad_boolean = load_json_mapping(FULL_CAD_BOOLEAN)
        routed_clearance_execution = load_yaml_mapping(ROUTED_CLEARANCE_EXECUTION)
        connection_coverage = load_json_mapping(CAD_CONNECTION_COVERAGE)

        release_policy = burndown.get("release_policy")
        if not isinstance(release_policy, dict):
            raise ValueError("release_policy must be a mapping")
        unsafe_true = sorted(
            flag for flag in RELEASE_POLICY_FLAGS if release_policy.get(flag) is True
        )
        if unsafe_true:
            raise ValueError(f"release policy unexpectedly true: {', '.join(unsafe_true)}")

        missing_release_evidence = mechanical.get("missing_release_ready_evidence")
        if not isinstance(missing_release_evidence, list):
            raise ValueError("mechanical inventory missing release evidence list")
        inventory_connection_gate = mechanical.get("review_gate_inventory", {}).get(
            "cad_connection_coverage", {}
        )
        if not isinstance(inventory_connection_gate, dict):
            raise ValueError("mechanical inventory missing CAD connection coverage gate")
        if inventory_connection_gate.get("path") != rel(CAD_CONNECTION_COVERAGE):
            raise ValueError("mechanical inventory CAD connection coverage path stale")
        inventory_board_step_gate = mechanical.get("review_gate_inventory", {}).get(
            "routed_board_step_intake", {}
        )
        if not isinstance(inventory_board_step_gate, dict):
            raise ValueError("mechanical inventory missing routed-board STEP intake gate")
        local_ready = mechanical.get("local_enclosure_cad_ready", {})
        if not isinstance(local_ready, dict):
            raise ValueError("mechanical inventory local_enclosure_cad_ready must be a mapping")
        if local_ready.get("cad_connection_coverage_complete") is not True:
            raise ValueError("local enclosure CAD ready must include complete CAD connection coverage")
        concept_assets = mechanical.get("concept_generated_assets", {})
        if not isinstance(concept_assets, dict):
            raise ValueError("mechanical inventory concept_generated_assets must be a mapping")
        expected_connection_asset_fields = {
            "solid_handoff_ocp_terminal_step_fallback_count": 42,
            "solid_handoff_ocp_terminal_step_fallback_error": "",
            "cad_connection_coverage_status": connection_coverage.get("status"),
            "cad_connection_required_count": connection_coverage.get(
                "required_connection_count"
            ),
            "cad_connection_passing_count": connection_coverage.get(
                "passing_connection_count"
            ),
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
            "cad_connection_record_count": len(
                [
                    item
                    for item in connection_coverage.get("connections", [])
                    if isinstance(item, dict)
                ]
            ),
            "cad_connection_represented_net_list_total": sum(
                len(item.get("represented_nets", []))
                for item in connection_coverage.get("connections", [])
                if isinstance(item, dict)
            ),
            "cad_connection_all_records_have_represented_nets": all(
                bool(item.get("represented_nets"))
                for item in connection_coverage.get("connections", [])
                if isinstance(item, dict)
            ),
            "cad_connection_all_represented_nets_match_routed_nets": all(
                item.get("represented_nets") == item.get("nets", [])
                and int(item.get("represented_net_count") or 0)
                == len(item.get("represented_nets", []))
                for item in connection_coverage.get("connections", [])
                if isinstance(item, dict)
            ),
            "cad_connection_visual_route_span_total_mm": connection_coverage.get(
                "visual_route_span_total_mm"
            ),
            "cad_connection_physical_medium_counts": connection_coverage.get(
                "physical_medium_counts"
            ),
            "cad_connection_electrical_class_counts": connection_coverage.get(
                "electrical_class_counts"
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
        }
        for key, value in expected_connection_asset_fields.items():
            if concept_assets.get(key) != value:
                raise ValueError(f"mechanical inventory CAD connection asset field stale: {key}")
        solid_handoff_gate = mechanical.get("review_gate_inventory", {}).get(
            "solid_cad_handoff", {}
        )
        if not isinstance(solid_handoff_gate, dict):
            raise ValueError("mechanical inventory missing solid CAD handoff gate")
        if int(solid_handoff_gate.get("ocp_terminal_step_fallback_count") or 0) != 42:
            raise ValueError("mechanical inventory lost OCP terminal STEP fallback count")
        if solid_handoff_gate.get("ocp_terminal_step_fallback_error") not in ("", None):
            raise ValueError("mechanical inventory OCP terminal STEP fallback has error")
        if local_ready.get("solid_handoff_ocp_terminal_step_fallback_count") != 42:
            raise ValueError("local enclosure CAD ready lost terminal STEP fallback count")
        if local_ready.get("solid_handoff_ocp_terminal_step_fallback_complete") is not True:
            raise ValueError("local enclosure CAD ready terminal STEP fallback incomplete")
        step_validation_status = step_validation.get("status")
        step_validation_passed = step_validation_status == "pass"
        if step_validation_status not in {"pass", "blocked"}:
            raise ValueError("STEP validation source status is unrecognized")
        if local_ready.get("step_validation_passed") is not step_validation_passed:
            raise ValueError("mechanical inventory STEP validation status stale")
        if int(local_ready.get("step_validation_validated_count") or 0) != int(
            step_validation.get("validated_count") or 0
        ):
            raise ValueError("mechanical inventory STEP validation count stale")
        full_cad_boolean_status = full_cad_boolean.get("overall_status")
        full_cad_boolean_passed = full_cad_boolean_status == "pass"
        if full_cad_boolean_passed:
            if full_cad_boolean.get("evidence_class") != (
                "concept_envelope_brep_boolean_interference_result"
            ):
                raise ValueError("full CAD boolean interference evidence class diverges")
            if int(full_cad_boolean.get("parts_loaded") or 0) <= 0:
                raise ValueError("full CAD boolean interference loaded part count stale")
            if full_cad_boolean.get("unintentional_clashes") not in ([], None):
                raise ValueError("full CAD boolean interference has unintentional clashes")
        elif full_cad_boolean_status != "blocked_boolean_interference_incomplete":
            raise ValueError("full CAD boolean interference source status is unrecognized")
        local_routed_step_candidate_ready = mechanical.get("local_routed_step_candidate_ready", {})
        if not isinstance(local_routed_step_candidate_ready, dict):
            raise ValueError(
                "mechanical inventory local_routed_step_candidate_ready must be a mapping"
            )
        supplier_families = burndown.get("required_supplier_geometry_inputs")
        if not isinstance(supplier_families, list):
            raise ValueError("required_supplier_geometry_inputs must be a list")
        supplier_index = supplier_family_index(supplier_families)
        supplier_blocker_inventory = supplier_family_blocker_inventory(supplier_families)
        physical_interfaces = burndown.get("physical_interface_burndown")
        if not isinstance(physical_interfaces, list):
            raise ValueError("physical_interface_burndown must be a list")
        physical_interface_blocker_inventory_rows = physical_interface_blocker_inventory(
            physical_interfaces
        )

        first_article = burndown.get("first_article_physical_fit_evidence")
        if not isinstance(first_article, dict):
            raise ValueError("first_article_physical_fit_evidence must be a mapping")
        handoff = burndown.get("production_enclosure_handoff_evidence")
        if not isinstance(handoff, dict):
            raise ValueError("production_enclosure_handoff_evidence must be a mapping")

        first_article_outputs = first_article.get("required_common_outputs")
        if not isinstance(first_article_outputs, list):
            raise ValueError("first_article required_common_outputs must be a list")
        first_article_paths = [str(path) for path in first_article_outputs]
        first_article_present = present_count(first_article_paths)
        handoff_outputs = handoff.get("required_handoff_outputs")
        if not isinstance(handoff_outputs, list):
            raise ValueError("handoff required_handoff_outputs must be a list")
        handoff_packets = handoff.get("required_handoff_packets")
        if not isinstance(handoff_packets, list):
            raise ValueError("handoff required_handoff_packets must be a list")
        if len(handoff_packets) != len(handoff_outputs):
            raise ValueError("handoff packet count must match required_handoff_outputs")
        invalid_handoff_packets = [
            f"packet_{index}:not_mapping"
            for index, packet in enumerate(handoff_packets)
            if not isinstance(packet, dict)
        ]
        handoff_packet_maps = [
            packet for packet in handoff_packets if isinstance(packet, dict)
        ]
        handoff_packet_ids = [str(packet.get("id") or "") for packet in handoff_packet_maps]
        if len(set(handoff_packet_ids)) != len(handoff_packet_ids):
            invalid_handoff_packets.append("duplicate_handoff_packet_ids")
        if any(not packet_id for packet_id in handoff_packet_ids):
            invalid_handoff_packets.append("missing_handoff_packet_id")
        handoff_packet_failures_flat = [
            failure
            for packet in handoff_packet_maps
            for failure in handoff_packet_failures(packet)
        ]
        invalid_handoff_packets.extend(handoff_packet_failures_flat)
        handoff_packet_actions = [
            handoff_packet_action(packet) for packet in handoff_packet_maps
        ]
        missing_handoff_packet_ids = [
            str(packet.get("id") or f"packet_{index}")
            for index, packet in enumerate(handoff_packet_maps)
            if not isinstance(packet.get("expected_path"), str)
            or not repo_path(str(packet.get("expected_path"))).is_file()
        ]
        handoff_required_items = [str(path) for path in handoff_outputs]
        handoff_paths = [
            str(packet.get("expected_path"))
            for packet in handoff_packet_maps
            if isinstance(packet.get("expected_path"), str)
            and packet.get("expected_path")
        ]
        handoff_external_items = list(handoff_required_items)
        handoff_present = present_count(handoff_paths)
        handoff_present = present_count(
            [
                str(path)
                for path in handoff_outputs
                if str(path).startswith(("board/", "mechanical/"))
            ]
        )

        production_step_files = board_step.get("production_step_files")
        if not isinstance(production_step_files, list):
            raise ValueError("board-step production_step_files must be a list")
        development_step_candidates = board_step.get("development_step_candidates", [])
        if not isinstance(development_step_candidates, list):
            raise ValueError("board-step development_step_candidates must be a list")
        detailed_routed_step_candidate = board_step.get("detailed_routed_step_candidate", {})
        if detailed_routed_step_candidate and not isinstance(
            detailed_routed_step_candidate, dict
        ):
            raise ValueError("board-step detailed_routed_step_candidate must be a mapping")
        if detailed_routed_step_candidate:
            if detailed_routed_step_candidate.get("release_credit") is not False:
                raise ValueError("detailed routed STEP candidate cannot grant release credit")
            if detailed_routed_step_candidate.get("present") is not True:
                raise ValueError("detailed routed STEP candidate must be present")
            if detailed_routed_step_candidate.get("blocked_metadata") is not True:
                raise ValueError("detailed routed STEP candidate must carry blocked metadata")
            if int(detailed_routed_step_candidate.get("size_bytes") or 0) <= 1_000_000:
                raise ValueError("detailed routed STEP candidate is too small")
            if int(detailed_routed_step_candidate.get("route_count") or 0) != 153:
                raise ValueError("detailed routed STEP candidate route count diverges")
            if int(detailed_routed_step_candidate.get("segment_count") or 0) != 306:
                raise ValueError("detailed routed STEP candidate segment count diverges")
            if detailed_routed_step_candidate.get("candidate_matches_development_source") is not True:
                raise ValueError("detailed routed STEP candidate hash does not match development source")
        blocked_candidate_step_files = board_step.get("blocked_candidate_step_files", [])
        if not isinstance(blocked_candidate_step_files, list):
            raise ValueError("board-step blocked_candidate_step_files must be a list")
        if (
            inventory_board_step_gate.get("blocked_candidate_step_files")
            != blocked_candidate_step_files
        ):
            raise ValueError("mechanical inventory blocked candidate STEP files stale")
        if (
            inventory_board_step_gate.get("approved_production_step_files")
            != board_step.get("approved_production_step_files", [])
        ):
            raise ValueError("mechanical inventory approved production STEP files stale")
        if (
            inventory_board_step_gate.get("development_step_candidates")
            != development_step_candidates
        ):
            raise ValueError("mechanical inventory development STEP candidates stale")
        if (
            inventory_board_step_gate.get("detailed_routed_step_candidate")
            != detailed_routed_step_candidate
        ):
            raise ValueError("mechanical inventory detailed routed STEP candidate stale")
        if local_routed_step_candidate_ready.get("release_claim_allowed") is not False:
            raise ValueError("local routed STEP candidate inventory cannot allow release")
        if local_routed_step_candidate_ready.get(
            "detailed_routed_step_candidate_release_credit"
        ) is not False:
            raise ValueError("local routed STEP candidate inventory cannot grant release credit")
        if int(local_routed_step_candidate_ready.get("approved_production_step_count") or 0) != len(
            board_step.get("approved_production_step_files", [])
        ):
            raise ValueError("local routed STEP approved production count stale")
        if int(local_routed_step_candidate_ready.get("blocked_candidate_step_count") or 0) != len(
            blocked_candidate_step_files
        ):
            raise ValueError("local routed STEP blocked candidate count stale")
        if bool(
            local_routed_step_candidate_ready.get("detailed_routed_step_candidate_present")
        ) != bool(detailed_routed_step_candidate.get("present") is True):
            raise ValueError("local routed STEP detailed candidate presence stale")
        if (
            int(
                local_routed_step_candidate_ready.get(
                    "detailed_routed_step_candidate_bytes"
                )
                or 0
            )
            != int(detailed_routed_step_candidate.get("size_bytes") or 0)
        ):
            raise ValueError("local routed STEP detailed candidate byte count stale")
        if detailed_routed_step_candidate and local_routed_step_candidate_ready.get(
            "detailed_routed_step_candidate_ready_for_local_review"
        ) is not True:
            raise ValueError("local routed STEP candidate must be ready for local review")
        development_board_local_review_state = board_step.get(
            "development_board_local_review_state", {}
        )
        if development_board_local_review_state and not isinstance(
            development_board_local_review_state, dict
        ):
            raise ValueError("development_board_local_review_state must be a mapping")
        clearance_results = routed_clearance.get("result_cases")
        if not isinstance(clearance_results, list):
            raise ValueError("routed clearance result_cases must be a list")
        rerun_matrix = routed_clearance.get("rerun_matrix", [])
        if not isinstance(rerun_matrix, list):
            raise ValueError("routed clearance rerun_matrix must be a list")
        development_clearance_context = routed_clearance.get("development_clearance_context", {})
        if development_clearance_context and not isinstance(development_clearance_context, dict):
            raise ValueError("development_clearance_context must be a mapping")
        if development_clearance_context.get("release_credit") is True:
            raise ValueError("development clearance context cannot grant release credit")
        if development_clearance_context:
            if development_clearance_context.get("release_credit") is not False:
                raise ValueError("development clearance context release_credit must be false")
            if (
                detailed_routed_step_candidate
                and development_clearance_context.get("candidate_ready_for_local_review")
                is not True
            ):
                raise ValueError("development clearance context must map the detailed candidate")
        development_step_local_review = routed_clearance.get("development_step_local_review", {})
        if development_step_local_review and not isinstance(development_step_local_review, dict):
            raise ValueError("development_step_local_review must be a mapping")
        if development_step_local_review.get("release_credit") is True:
            raise ValueError("development step local review cannot grant release credit")
        development_step_output = development_board_local_review_state.get("step_output")
        development_candidate_paths = [
            str(row.get("path"))
            for row in development_step_candidates
            if isinstance(row, dict) and row.get("path")
        ] + [
            str(row)
            for row in development_step_candidates
            if isinstance(row, str) and row
        ]
        candidate_step_paths = [
            str(path)
            for path in [
                *development_candidate_paths,
                *blocked_candidate_step_files,
                development_step_output,
            ]
            if path
        ]
        candidate_step_paths = list(dict.fromkeys(candidate_step_paths))
        present_candidate_step_paths = existing_paths(candidate_step_paths)
        production_step_inventory = artifact_inventory(
            [str(path) for path in production_step_files],
            evidence_kind="production_routed_board_step_release",
            release_credit=True,
        )
        candidate_step_inventory = artifact_inventory(
            candidate_step_paths,
            evidence_kind="local_routed_step_candidate_not_release",
            release_credit=False,
        )
        routed_intake_diagnostics = routed_release_intake_diagnostics(board_step)
        complete_clearance = int(routed_clearance.get("complete_clearance_result_count") or 0)
        expected_clearance = int(routed_clearance.get("expected_clearance_case_count") or 0)
        if (
            routed_clearance_execution.get("schema")
            != "eliza.e1_phone_routed_clearance_release_execution.v1"
        ):
            raise ValueError("routed clearance release execution schema diverges")
        release_contract = routed_clearance_execution.get("release_contract", {})
        if not isinstance(release_contract, dict):
            raise ValueError("routed clearance release contract must be a mapping")
        if (
            release_contract.get("required_evidence_class")
            != "physical_routed_board_clearance_result"
        ):
            raise ValueError("routed clearance release evidence class diverges")
        release_cases = clearance_release_cases(routed_clearance_execution)
        if len(release_cases) != expected_clearance:
            raise ValueError("routed clearance release case count stale")
        routed_inputs = routed_step_input_map(board_step, routed_clearance_execution)
        routed_step_generation_plan = routed_step_release_generation_plan(
            production_step_files=production_step_files,
            candidate_step_paths=candidate_step_paths,
            present_candidate_step_paths=present_candidate_step_paths,
            routed_inputs=routed_inputs,
            routed_intake_diagnostics=routed_intake_diagnostics,
        )
        candidate_clearance_cases_mapped = int(
            development_clearance_context.get("cases_mapped_to_candidate_step") or 0
        )
        if (
            not candidate_clearance_cases_mapped
            and development_step_local_review.get("ready") is True
        ):
            candidate_clearance_cases_mapped = expected_clearance
        failed_clearance_cases = [
            str(row.get("case_id") or index)
            for index, row in enumerate(clearance_results)
            if not isinstance(row, dict)
            or row.get("pass") is not True
            or row.get("reviewer_present") is not True
            or row.get("measurement_artifact_present") is not True
            or row.get("interference_count") not in (0, "0")
        ]
        clearance_diagnostics = clearance_case_diagnostics(
            clearance_results,
            rerun_matrix,
            routed_inputs,
            supplier_index,
            release_cases,
        )
        clearance_release_actions = clearance_release_action_inventory(
            clearance_diagnostics,
            routed_clearance_execution,
        )
        clearance_missing_counts = clearance_missing_reason_counts(clearance_diagnostics)
        if connection_coverage.get("schema") != "eliza.e1_phone_cad_connection_coverage.v1":
            raise ValueError("CAD connection coverage schema diverges")
        if connection_coverage.get("status") != "cad_connection_markers_complete_not_release":
            raise ValueError("CAD connection coverage must be complete but non-release")
        if connection_coverage.get("release_credit") is not False:
            raise ValueError("CAD connection coverage cannot grant release credit")
        connections = connection_coverage.get("connections")
        if not isinstance(connections, list):
            raise ValueError("CAD connection coverage connections must be a list")
        if connection_coverage.get("required_connection_count") != 21:
            raise ValueError("CAD connection coverage required count stale")
        if connection_coverage.get("passing_connection_count") != 21:
            raise ValueError("CAD connection coverage passing count stale")
        required_connection_ids = {
            "display_touch_fpc",
            "rear_camera_csi_fpc",
            "front_camera_csi_fpc",
            "side_key_flex",
            "battery_lead_flex",
            "usb_c_escape_tail",
            "bottom_speaker_lead_pair",
            "bottom_microphone_flex",
            "top_microphone_flex",
            "earpiece_receiver_lead_flex",
            "haptic_flex",
            "sim_esim_signal_flex",
            "nfc_loop_antenna_flex",
            "compute_som_sodimm_carrier",
            "cellular_main_rf_feed",
            "cellular_diversity_rf_feed",
            "cellular_antenna_aperture_tuner",
            "cellular_gnss_rf_feed",
            "wifi_bt_rf0_feed",
            "wifi_bt_rf1_feed",
            "split_interconnect_side_flex",
        }
        connection_ids = {str(row.get("id")) for row in connections if isinstance(row, dict)}
        if connection_ids != required_connection_ids:
            raise ValueError("CAD connection coverage ids diverge")
        failed_connections = [
            str(row.get("id") or index)
            for index, row in enumerate(connections)
            if not isinstance(row, dict)
            or row.get("pass") is not True
            or row.get("cad_part_present") is not True
            or row.get("endpoints_present") is not True
            or row.get("all_nets_in_routed_development_board") is not True
            or int(row.get("cad_step_bytes") or 0) <= 1000
            or row.get("release_credit") is not False
        ]
        if failed_connections:
            raise ValueError(f"CAD connection coverage incomplete: {', '.join(failed_connections)}")

        supplier_blocked = sum(
            1 for row in supplier_families if row.get("release_allowed") is not True
        )
        interface_blocked = sum(
            1 for row in physical_interfaces if row.get("release_allowed") is not True
        )
        blockers = burndown.get("release_blockers")
        if not isinstance(blockers, list):
            raise ValueError("release_blockers must be a list")
        release_evidence_blockers = release_evidence_diagnostics(
            missing_release_evidence
        )
        release_generation_plan = release_evidence_generation_plan(
            release_evidence_blockers,
            routed_inputs=routed_inputs,
            present_candidate_step_paths=present_candidate_step_paths,
            routed_intake_diagnostics=routed_intake_diagnostics,
        )
        missing_first_article_paths = missing_paths(first_article_paths)
        first_article_physical_fit_actions = first_article_physical_fit_action_inventory(
            first_article_paths
        )
        missing_handoff_paths = missing_paths(handoff_paths)
        missing_handoff_items = [*missing_handoff_paths, *handoff_external_items]
    except ValueError as exc:
        write_report(
            {
                "schema": "eliza.e1_phone_enclosure_mechanical_content_report.v1",
                "status": "fail",
                "summary": {"release_ready": False},
                "findings": [
                    {
                        "code": "enclosure_mechanical_contract_invalid",
                        "severity": "error",
                        "message": str(exc),
                        "evidence": rel(BURNDOWN),
                    }
                ],
            },
            args.report,
        )
        print(f"FAIL: E1 phone enclosure mechanical content contract invalid: {exc}")
        return 1

    if (
        missing_release_evidence
        or supplier_blocked
        or interface_blocked
        or not production_step_files
        or complete_clearance != expected_clearance
        or failed_clearance_cases
        or first_article_present != len(first_article_outputs)
        or handoff_present != len(handoff_outputs)
        or invalid_handoff_packets
        or not full_cad_boolean_passed
        or blockers
    ):
        summary = {
            "release_ready": False,
            "missing_release_evidence": len(missing_release_evidence),
            "missing_release_evidence_categories": count_by_field(
                release_evidence_blockers, "category"
            ),
            "supplier_families_blocked": supplier_blocked,
            "supplier_family_blocker_categories": count_by_field(
                supplier_blocker_inventory, "category"
            ),
            "supplier_required_geometry_input_count": sum(
                int(row.get("required_step_or_brep_input_count") or 0)
                for row in supplier_blocker_inventory
            ),
            "supplier_required_release_input_count": sum(
                int(row.get("required_before_release_count") or 0)
                for row in supplier_blocker_inventory
            ),
            "physical_interfaces_blocked": interface_blocked,
            "physical_interface_blocker_categories": count_by_field(
                physical_interface_blocker_inventory_rows, "category"
            ),
            "physical_interface_required_check_count": sum(
                int(row.get("required_release_check_count") or 0)
                for row in physical_interface_blocker_inventory_rows
            ),
            "physical_interface_required_evidence_count": sum(
                int(row.get("required_evidence_count") or 0)
                for row in physical_interface_blocker_inventory_rows
            ),
            "routed_step_files": len(production_step_files),
            "candidate_routed_step_files": present_count(candidate_step_paths),
            "repo_generatable_release_step_count": routed_step_generation_plan[
                "repo_generatable_release_step_count"
            ],
            "repo_generatable_missing_release_evidence_count": sum(
                1 for row in release_generation_plan if row["repo_generatable_now"]
            ),
            "blocked_missing_release_evidence_generation_count": sum(
                1 for row in release_generation_plan if not row["repo_generatable_now"]
            ),
            "clearance_results_complete": complete_clearance,
            "clearance_results_expected": expected_clearance,
            "candidate_clearance_cases_mapped": candidate_clearance_cases_mapped,
            "cad_connection_coverage_complete": (
                connection_coverage.get("passing_connection_count")
                == connection_coverage.get("required_connection_count")
            ),
            "cad_connection_release_credit": connection_coverage.get("release_credit"),
            "step_validation_status": step_validation.get("status"),
            "step_validation_validated_count": step_validation.get("validated_count"),
            "step_validation_release_blocked": not step_validation_passed,
            "step_validation_release_blocker_category": (
                "local_step_validation_tooling_unavailable"
                if not step_validation_passed
                else "none"
            ),
            "full_cad_boolean_status": full_cad_boolean.get("overall_status"),
            "full_cad_boolean_evidence_class": full_cad_boolean.get("evidence_class"),
            "full_cad_boolean_local_concept_passed": full_cad_boolean_passed,
            "full_cad_boolean_release_ready": False,
            "full_cad_boolean_release_blocked": True,
            "full_cad_boolean_release_blocker_category": (
                "routed_supplier_boolean_rerun_missing"
                if full_cad_boolean_passed
                else "local_boolean_interference_incomplete"
            ),
            "full_cad_boolean_unintentional_clash_count": len(
                full_cad_boolean.get("unintentional_clashes") or []
            ),
            "local_cad_validation_release_credit": False,
            "candidate_release_credit": bool(
                development_clearance_context.get("release_credit") is True
                or development_step_local_review.get("release_credit") is True
            ),
            "failed_clearance_cases": len(failed_clearance_cases),
            "clearance_result_blocker_categories": clearance_missing_counts,
            "first_article_outputs_present": first_article_present,
            "first_article_outputs_required": len(first_article_outputs),
            "handoff_outputs_present": handoff_present,
            "handoff_outputs_required": len(handoff_outputs),
            "handoff_packet_files_present": handoff_present,
            "handoff_packet_files_required": len(handoff_packet_maps),
            "handoff_external_deliverables_missing": len(handoff_external_items),
            "release_blockers": len(blockers),
            "candidate_routed_step_paths": present_candidate_step_paths,
            "missing_first_article_output_paths": missing_first_article_paths,
            "missing_handoff_output_paths": missing_handoff_paths,
            "missing_handoff_output_items": missing_handoff_items,
            "missing_handoff_repo_paths": missing_handoff_paths,
            "missing_handoff_external_items": handoff_external_items,
            "handoff_packet_count": len(handoff_packet_maps),
            "missing_handoff_packet_ids": missing_handoff_packet_ids,
            "handoff_packet_actions": handoff_packet_actions,
            "invalid_handoff_packet_evidence": invalid_handoff_packets,
            "failed_clearance_case_ids": failed_clearance_cases,
            "highest_risk_failed_clearance_case_ids": [
                row["case_id"]
                for row in sorted(
                    clearance_diagnostics,
                    key=lambda item: int(item.get("rerun_priority") or 999),
                )
                if row["case_id"] in failed_clearance_cases
            ][:4],
            "routed_clearance_release_action_count": len(clearance_release_actions),
            "first_article_physical_fit_action_count": len(
                first_article_physical_fit_actions
            ),
        }
        findings = [
            {
                "code": "enclosure_mechanical_release_blocked",
                "severity": "blocker",
                "message": f"{key}={value}",
                "evidence": rel(BURNDOWN),
            }
            for key, value in summary.items()
            if key
            not in {
                "release_ready",
                "candidate_routed_step_files",
                "candidate_clearance_cases_mapped",
                "candidate_release_credit",
                "candidate_routed_step_paths",
                "missing_first_article_output_paths",
                "missing_handoff_output_paths",
                "missing_handoff_repo_paths",
                "missing_handoff_external_items",
                "missing_handoff_packet_ids",
                "handoff_packet_actions",
                "invalid_handoff_packet_evidence",
                "failed_clearance_case_ids",
                "missing_release_evidence_categories",
                "supplier_family_blocker_categories",
                "physical_interface_blocker_categories",
                "clearance_result_blocker_categories",
            }
            and value
        ]
        diagnostic_findings = []
        if present_candidate_step_paths:
            diagnostic_findings.append(
                {
                    "code": "candidate_routed_step_present_no_release_credit",
                    "severity": "info",
                    "message": (
                        "local candidate routed STEP artifacts exist but cannot satisfy "
                        "production routed-board STEP release evidence"
                    ),
                    "evidence": present_candidate_step_paths,
                }
            )
        if missing_first_article_paths:
            diagnostic_findings.append(
                {
                    "code": "first_article_physical_fit_outputs_missing",
                    "severity": "blocker",
                    "message": (
                        f"{len(missing_first_article_paths)} first-article physical-fit "
                        "outputs are missing"
                    ),
                    "evidence": missing_first_article_paths,
                }
            )
        if missing_handoff_items:
            diagnostic_findings.append(
                {
                    "code": "production_enclosure_handoff_outputs_missing",
                    "severity": "blocker",
                    "message": (
                        f"{len(missing_handoff_items)} production enclosure handoff "
                        "outputs are missing"
                    ),
                    "evidence": missing_handoff_items,
                }
            )
        if invalid_handoff_packets:
            diagnostic_findings.append(
                {
                    "code": "production_enclosure_handoff_packets_not_executed",
                    "severity": "blocker",
                    "message": (
                        f"{len(invalid_handoff_packets)} production enclosure handoff "
                        "packet checks are missing or invalid"
                    ),
                    "evidence": invalid_handoff_packets,
                }
            )
        if failed_clearance_cases:
            diagnostic_findings.append(
                {
                    "code": "routed_clearance_cases_not_release_clean",
                    "severity": "blocker",
                    "message": (
                        f"{len(failed_clearance_cases)} routed clearance cases are "
                        "missing pass/reviewer/measurement/interference evidence"
                    ),
                    "evidence": failed_clearance_cases,
                }
            )
        findings.extend(diagnostic_findings)
        if not findings:
            findings.append(
                {
                    "code": "enclosure_mechanical_release_blocked",
                    "severity": "blocker",
                    "message": "mechanical release evidence is incomplete",
                    "evidence": rel(BURNDOWN),
                }
            )
        write_report(
            {
                "schema": "eliza.e1_phone_enclosure_mechanical_content_report.v1",
                "status": "blocked",
                "summary": summary,
                "findings": findings,
                "production_enclosure_handoff_unblock_actions": handoff_packet_actions,
                "routed_step_inventory": {
                    "production_release": production_step_inventory,
                    "candidate_no_release_credit": candidate_step_inventory,
                    "approved_release_count": len(production_step_files),
                    "candidate_present_count": len(present_candidate_step_paths),
                },
                "routed_step_generation_plan": routed_step_generation_plan,
                "missing_release_evidence_generation_plan": release_generation_plan,
                "local_cad_validation_context": {
                    "step_validation": {
                        "path": rel(STEP_VALIDATION),
                        "status": step_validation.get("status"),
                        "validated_count": step_validation.get("validated_count"),
                        "assembly_step": (
                            step_validation.get("assembly", {}).get("path")
                            or step_validation.get("assembly", {}).get("step")
                        )
                        if isinstance(step_validation.get("assembly"), dict)
                        else None,
                        "release_credit": False,
                    },
                    "full_cad_boolean_interference": {
                        "path": rel(FULL_CAD_BOOLEAN),
                        "status": full_cad_boolean.get("overall_status"),
                        "evidence_class": full_cad_boolean.get("evidence_class"),
                        "local_concept_passed": full_cad_boolean_passed,
                        "release_blocked": True,
                        "release_blocker_category": summary[
                            "full_cad_boolean_release_blocker_category"
                        ],
                        "required_release_evidence_class": (
                            "routed_full_cad_boolean_interference_report"
                        ),
                        "required_release_report": routed_inputs.get(
                            "next_artifacts", []
                        )[2],
                        "parts_loaded": full_cad_boolean.get("parts_loaded"),
                        "pair_count_brep_evaluated": full_cad_boolean.get(
                            "pair_count_brep_evaluated"
                        ),
                        "unintentional_clash_count": len(
                            full_cad_boolean.get("unintentional_clashes") or []
                        ),
                        "release_credit": False,
                    },
                },
                "missing_release_evidence_blockers": release_evidence_blockers,
                "supplier_family_blockers": supplier_blocker_inventory,
                "physical_interface_blockers": physical_interface_blocker_inventory_rows,
                "clearance_result_blocker_categories": clearance_missing_counts,
                "routed_board_release_intake_diagnostics": routed_intake_diagnostics,
                "routed_clearance_case_diagnostics": clearance_diagnostics,
                "routed_clearance_unblock_actions": [
                    {
                        "case_id": row["case_id"],
                        "risk_level": row.get("risk_level"),
                        "rerun_priority": row.get("rerun_priority"),
                        "required_release_report": row.get("required_release_report"),
                        "required_action": row.get("measurement_instruction"),
                        "required_evidence_class": "physical_routed_board_clearance_result",
                        "required_inputs": row.get("required_inputs", {}),
                        "supplier_geometry_families": row.get("supplier_geometry_families", []),
                        "next_artifacts": [
                            artifact
                            for artifact in row.get("next_artifacts", [])
                            if artifact
                        ],
                        "next_commands": CLEARANCE_NEXT_COMMANDS,
                        "missing": row.get("missing", []),
                    }
                    for row in clearance_diagnostics
                    if row.get("pass") is not True
                ],
                "routed_clearance_release_action_inventory": clearance_release_actions,
                "first_article_physical_fit_action_inventory": first_article_physical_fit_actions,
                "missing_production_enclosure_handoff_outputs": {
                    "repo_paths": missing_handoff_paths,
                    "external_items": handoff_external_items,
                    "all_items": missing_handoff_items,
                },
            },
            args.report,
        )
        print(
            "STATUS: BLOCKED E1 phone enclosure mechanical content evidence incomplete: "
            f"missing_release_evidence={len(missing_release_evidence)} "
            f"supplier_families_blocked={supplier_blocked} "
            f"physical_interfaces_blocked={interface_blocked} "
            f"routed_step_files={len(production_step_files)} "
            f"clearance_results_complete={complete_clearance}/{expected_clearance} "
            f"failed_clearance_cases={len(failed_clearance_cases)} "
            f"first_article_outputs_present={first_article_present}/{len(first_article_outputs)} "
            f"handoff_outputs_present={handoff_present}/{len(handoff_outputs)} "
            f"release_blockers={len(blockers)}"
        )
        return 2

    write_report(
        {
            "schema": "eliza.e1_phone_enclosure_mechanical_content_report.v1",
            "status": "pass",
            "summary": {"release_ready": True},
            "findings": [],
        },
        args.report,
    )
    print("STATUS: PASS E1 phone enclosure mechanical content")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
