#!/usr/bin/env python3
"""Fail-closed content gate for E1 phone enclosure/mechanical release evidence."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
BURNDOWN = ROOT / "board/kicad/e1-phone/enclosure-mechanical-release-burndown-2026-05-22.yaml"
MECH_REVIEW = ROOT / "mechanical/e1-phone/review"
MECH_INVENTORY = MECH_REVIEW / "mechanical-cad-evidence-inventory-2026-05-22.yaml"
BOARD_STEP = MECH_REVIEW / "board-step-readiness.json"
ROUTED_CLEARANCE = MECH_REVIEW / "routed-board-clearance.json"
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


def present_count(paths: list[str]) -> int:
    return sum(1 for path in paths if repo_path(path).exists())


def main() -> int:
    try:
        burndown = load_yaml_mapping(BURNDOWN)
        if burndown.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {burndown.get('schema')!r}")
        mechanical = load_yaml_mapping(MECH_INVENTORY)
        board_step = load_json_mapping(BOARD_STEP)
        routed_clearance = load_json_mapping(ROUTED_CLEARANCE)

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
        supplier_families = burndown.get("required_supplier_geometry_inputs")
        if not isinstance(supplier_families, list):
            raise ValueError("required_supplier_geometry_inputs must be a list")
        physical_interfaces = burndown.get("physical_interface_burndown")
        if not isinstance(physical_interfaces, list):
            raise ValueError("physical_interface_burndown must be a list")

        first_article = burndown.get("first_article_physical_fit_evidence")
        if not isinstance(first_article, dict):
            raise ValueError("first_article_physical_fit_evidence must be a mapping")
        handoff = burndown.get("production_enclosure_handoff_evidence")
        if not isinstance(handoff, dict):
            raise ValueError("production_enclosure_handoff_evidence must be a mapping")

        first_article_outputs = first_article.get("required_common_outputs")
        if not isinstance(first_article_outputs, list):
            raise ValueError("first_article required_common_outputs must be a list")
        first_article_present = present_count([str(path) for path in first_article_outputs])
        handoff_outputs = handoff.get("required_handoff_outputs")
        if not isinstance(handoff_outputs, list):
            raise ValueError("handoff required_handoff_outputs must be a list")
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
        clearance_results = routed_clearance.get("result_cases")
        if not isinstance(clearance_results, list):
            raise ValueError("routed clearance result_cases must be a list")
        complete_clearance = int(routed_clearance.get("complete_clearance_result_count") or 0)
        expected_clearance = int(routed_clearance.get("expected_clearance_case_count") or 0)
        failed_clearance_cases = [
            str(row.get("case_id") or index)
            for index, row in enumerate(clearance_results)
            if not isinstance(row, dict)
            or row.get("pass") is not True
            or row.get("reviewer_present") is not True
            or row.get("measurement_artifact_present") is not True
            or row.get("interference_count") not in (0, "0")
        ]

        supplier_blocked = sum(
            1 for row in supplier_families if row.get("release_allowed") is not True
        )
        interface_blocked = sum(
            1 for row in physical_interfaces if row.get("release_allowed") is not True
        )
        blockers = burndown.get("release_blockers")
        if not isinstance(blockers, list):
            raise ValueError("release_blockers must be a list")
    except ValueError as exc:
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
        or blockers
    ):
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

    print("STATUS: PASS E1 phone enclosure mechanical content")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
