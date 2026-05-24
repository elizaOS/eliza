#!/usr/bin/env python3
"""Add fail-closed release-evidence metadata to local E1 phone placeholders."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]

FIRST_ARTICLE_FILES = [
    "mechanical/e1-phone/review/enclosure-fit-first-article.yaml",
    "board/kicad/e1-phone/production/test/charger-cc-cv-cycle.template.json",
    "board/kicad/e1-phone/production/test/first-article-test-transcript.template.json",
    "board/kicad/e1-phone/production/test/first-article-traveler.template.yaml",
    "board/kicad/e1-phone/production/test/side-key-force-travel-wake-log.template.json",
    "board/kicad/e1-phone/production/test/usb-c-pd-attach-log.template.json",
    "board/kicad/e1-phone/production/test/usb2-adb-fastboot-attach-log.template.json",
]

MECHANICAL_FILES = [
    "mechanical/e1-phone/review/fit-check-report.json",
    "mechanical/e1-phone/review/physical-process-validation-acceptance.json",
    "mechanical/e1-phone/review/routed-board-clearance.json",
    "mechanical/e1-phone/review/board-step-readiness.json",
    "mechanical/e1-phone/review/supplier-evidence-acceptance.json",
]

ROUTED_RELEASE_FILES = [
    "mechanical/e1-phone/review/routed-board-clearance.json",
]


def load_mapping(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        data = json.loads(text)
    else:
        data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected mapping")
    return data


def write_mapping(path: Path, data: dict[str, Any]) -> None:
    if path.suffix.lower() == ".json":
        path.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    else:
        path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


def source_requirement_id(path: str) -> str:
    return Path(path).stem.replace(".template", "").replace("-", "_")


def add_defaults(data: dict[str, Any], defaults: dict[str, Any]) -> bool:
    changed = False
    for key, value in defaults.items():
        if key not in data:
            data[key] = value
            changed = True
    return changed


def first_article_defaults(path: str) -> dict[str, Any]:
    requirement_id = source_requirement_id(path)
    return {
        "artifact_id": requirement_id,
        "source_requirement_id": requirement_id,
        "owner": "first_article_validation",
        "created_at": "blocked_not_executed",
        "tool_or_supplier_revision": "blocked_not_executed",
        "input_artifact_hashes": ["blocked_not_executed"],
        "reviewer": "blocked_not_reviewed",
        "reviewed_at": "blocked_not_reviewed",
        "disposition": "blocked_not_executed",
        "board_serial": "blocked_not_executed",
        "supplier_lot_ids": ["blocked_not_executed"],
        "fixture_id": "blocked_not_executed",
        "fixture_calibration_id": "blocked_not_executed",
        "test_software_revision": "blocked_not_executed",
        "operator": "blocked_not_executed",
        "limits_file": "blocked_not_executed",
        "measured_results": [],
        "pass_fail_disposition": "blocked_not_executed",
        "waivers": [],
    }


def mechanical_defaults(path: str) -> dict[str, Any]:
    requirement_id = source_requirement_id(path)
    return {
        "artifact_id": requirement_id,
        "source_requirement_id": requirement_id,
        "owner": "mechanical_release_validation",
        "created_at": "blocked_not_executed",
        "tool_or_supplier_revision": "blocked_not_executed",
        "input_artifact_hashes": ["blocked_not_executed"],
        "reviewer": "blocked_not_reviewed",
        "reviewed_at": "blocked_not_reviewed",
        "disposition": "blocked_not_release_evidence",
        "routed_board_step_revision": "blocked_missing_physical_routed_board_release",
        "supplier_model_revisions": ["blocked_missing_supplier_models"],
        "clearance_case_id": "blocked_missing_measured_clearance",
        "measured_clearance_results": [],
        "fit_sample_serials": ["blocked_missing_serialized_hardware"],
        "process_validation_lot": "blocked_missing_process_validation_lot",
        "toolmaker_or_manufacturing_disposition": "blocked_missing_toolmaker_disposition",
    }


def routed_release_defaults(path: str) -> dict[str, Any]:
    requirement_id = source_requirement_id(path)
    return {
        "artifact_id": f"{requirement_id}_routed_release",
        "source_requirement_id": "routed_board_release_evidence",
        "owner": "routed_board_release_validation",
        "created_at": "blocked_not_executed",
        "tool_or_supplier_revision": "blocked_not_executed",
        "input_artifact_hashes": ["blocked_not_executed"],
        "reviewer": "blocked_not_reviewed",
        "reviewed_at": "blocked_not_reviewed",
        "disposition": "blocked_not_release_evidence",
        "kicad_project_revision": "blocked_missing_release_kicad_revision",
        "routed_pcb_hash": "blocked_missing_release_routed_pcb_hash",
        "erc_result": "blocked_not_run",
        "drc_result": "blocked_not_run",
        "stackup_revision": "blocked_missing_fabricator_stackup",
        "impedance_coupon_reference": "blocked_missing_impedance_coupon",
        "si_pi_rf_report_references": ["blocked_missing_validation_reports"],
        "fab_output_manifest": "blocked_missing_fab_output_manifest",
        "routed_step_reference": "blocked_missing_release_routed_step",
    }


def normalize_one(path_text: str, defaults: dict[str, Any]) -> bool:
    path = ROOT / path_text
    data = load_mapping(path)
    changed = add_defaults(data, defaults)
    if changed:
        write_mapping(path, data)
    return changed


def main() -> int:
    changed: list[str] = []
    for path in FIRST_ARTICLE_FILES:
        if normalize_one(path, first_article_defaults(path)):
            changed.append(path)
    for path in MECHANICAL_FILES:
        if normalize_one(path, mechanical_defaults(path)):
            changed.append(path)
    for path in ROUTED_RELEASE_FILES:
        if normalize_one(path, routed_release_defaults(path)):
            changed.append(path)
    print(
        "STATUS: normalized E1 phone release evidence metadata "
        f"changed={len(changed)} checked={len(FIRST_ARTICLE_FILES) + len(MECHANICAL_FILES)}"
    )
    for path in changed:
        print(f"  - {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
