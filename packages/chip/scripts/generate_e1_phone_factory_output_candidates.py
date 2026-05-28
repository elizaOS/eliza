#!/usr/bin/env python3
"""Generate fail-closed E1 phone production/factory output candidates.

These are local candidate files for output paths that can be represented from
current repo state without pretending supplier, factory, lab, quote, or
first-article evidence exists. Every artifact is blocked and unapproved.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DATE = "2026-05-22"
OUT_MANIFEST = (
    ROOT / "board/kicad/e1-phone/production/factory-output-candidate-manifest-2026-05-22.yaml"
)
ROUTED_OUTPUT_MANIFEST = (
    ROOT / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
)
ROUTED_BOARD = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
ROUTED_STEP = ROOT / "board/kicad/e1-phone/production/step/routed-board-with-components.step"
ROUTED_STEP_METADATA = ROUTED_STEP.with_suffix(ROUTED_STEP.suffix + ".metadata.yaml")

INPUTS = [
    ROUTED_BOARD,
    ROOT / "board/kicad/e1-phone/component-height-step-integration.yaml",
    ROOT / "board/kicad/e1-phone/production-factory-output-burndown-2026-05-22.yaml",
]

BOARD_REPORT_SOURCES = {
    "board/kicad/e1-phone/production/reports/board-optimization-scorecard.yaml": "board/kicad/e1-phone/board-optimization-scorecard.yaml",
    "board/kicad/e1-phone/production/reports/display-camera-oem-integration.yaml": "board/kicad/e1-phone/display-camera-oem-integration.yaml",
    "board/kicad/e1-phone/production/reports/external-interface-design-review.yaml": "board/kicad/e1-phone/external-interface-design-review.yaml",
    "board/kicad/e1-phone/production/reports/module-host-integration-closure.yaml": "board/kicad/e1-phone/module-host-integration-closure.yaml",
    "board/kicad/e1-phone/production/reports/power-sequence-bringup-closure.yaml": "board/kicad/e1-phone/power-sequence-bringup-closure.yaml",
    "board/kicad/e1-phone/production/reports/radio-module-integration.yaml": "board/kicad/e1-phone/radio-module-integration.yaml",
    "board/kicad/e1-phone/production/reports/rf-antenna-coexistence-closure.yaml": "board/kicad/e1-phone/rf-antenna-coexistence-closure.yaml",
    "board/kicad/e1-phone/production/reports/route-feasibility-density.yaml": "board/kicad/e1-phone/route-feasibility-density.yaml",
    "board/kicad/e1-phone/production/reports/schematic-symbol-footprint-closure.yaml": "board/kicad/e1-phone/schematic-symbol-footprint-closure.yaml",
    "board/kicad/e1-phone/production/reports/usb-sidekey-integration.yaml": "board/kicad/e1-phone/usb-sidekey-integration.yaml",
}


def chip_rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def input_hashes() -> dict[str, str]:
    return {chip_rel(path): sha256(path) if path.is_file() else "missing" for path in INPUTS}


def write_yaml(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(payload, sort_keys=False, width=100), encoding="utf-8")


def load_yaml_if_present(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def routed_release_provenance() -> dict[str, Any]:
    step_metadata = load_yaml_if_present(ROUTED_STEP_METADATA)
    return {
        "kicad_project_revision": "development_real_footprint_snapshot",
        "routed_pcb_hash": sha256(ROUTED_BOARD) if ROUTED_BOARD.is_file() else "missing",
        "erc_result": "not_run",
        "drc_result": "not_run",
        "stackup_revision": "not_fabricator_approved",
        "impedance_coupon_reference": "missing_fabricator_coupon",
        "si_pi_rf_report_references": [
            "board/kicad/e1-phone/production/reports/si-pi/release-manifest.yaml",
            "board/kicad/e1-phone/production/reports/rf/release-manifest.yaml",
        ],
        "fab_output_manifest": chip_rel(ROUTED_OUTPUT_MANIFEST),
        "routed_step_reference": chip_rel(ROUTED_STEP),
        "routed_step_sha256": sha256(ROUTED_STEP) if ROUTED_STEP.is_file() else "missing",
        "routed_step_metadata": chip_rel(ROUTED_STEP_METADATA),
        "routed_step_visual_detail": step_metadata.get("routed_step_visual_detail", {}),
        "cad_connection_coverage": step_metadata.get("cad_connection_coverage", {}),
    }


def blocked_record(
    artifact_id: str,
    source_requirement_id: str,
    *,
    source_artifact: str | None = None,
    source_hash: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema": "eliza.e1_phone_factory_output_candidate.v1",
        "artifact_id": artifact_id,
        "source_requirement_id": source_requirement_id,
        "owner": "local-factory-output-candidate-generator",
        "created_at": DATE,
        "tool_or_supplier_revision": "generate_e1_phone_factory_output_candidates.py",
        "input_artifact_hashes": input_hashes(),
        "reviewer": "unreviewed",
        "reviewed_at": "unreviewed_local_candidate_2026-05-22",
        "disposition": "blocked_candidate_not_approved",
        "release_package_revision": "local_candidate_not_release",
        "fab_vendor_or_assembler": "missing_external_supplier_or_factory",
        "program_or_fixture_revision": "not_run",
        "limits_revision": "not_approved",
        "calibration_state": "not_calibrated",
        "lot_or_serial_traceability": "missing",
        "release_allowed": False,
        "claim_boundary": (
            "Local candidate artifact only. Not supplier, factory, lab, first-article, "
            "quote, fabrication, enclosure, or end-to-end release evidence."
        ),
    }
    payload.update(routed_release_provenance())
    if source_artifact:
        payload["source_artifact"] = source_artifact
    if source_hash:
        payload["source_artifact_sha256"] = source_hash
    return payload


def write_pdf_candidate(path_text: str, artifact_id: str) -> dict[str, str]:
    path = ROOT / path_text
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        (
            "%PDF-1.4\n"
            "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
            "2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n"
            "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] >> endobj\n"
            f"% {artifact_id}: blocked local factory candidate, not release evidence\n"
            "%%EOF\n"
        ).encode()
    )
    metadata = blocked_record(artifact_id, path_text)
    metadata.update(
        {
            "external_review_authority": "missing_external_review_authority",
            "signature_or_approval_record": "missing_signature_or_approval_record",
            "artifact_sha256": sha256(path),
        }
    )
    write_yaml(path.with_suffix(path.suffix + ".metadata.yaml"), metadata)
    return {
        "path": path_text,
        "kind": "pdf",
        "metadata": chip_rel(path.with_suffix(path.suffix + ".metadata.yaml")),
    }


def write_dir_candidate(path_text: str, artifact_id: str) -> dict[str, str]:
    path = ROOT / path_text
    path.mkdir(parents=True, exist_ok=True)
    child = path / "candidate-placeholder.txt"
    child.write_text(
        "blocked local production/factory output candidate; release children and approvals are missing\n",
        encoding="utf-8",
    )
    manifest = blocked_record(artifact_id, path_text)
    manifest["candidate_children"] = [child.name]
    manifest["release_children_complete"] = False
    write_yaml(path / "release-manifest.yaml", manifest)
    return {
        "path": chip_rel(path),
        "kind": "directory",
        "metadata": chip_rel(path / "release-manifest.yaml"),
    }


def write_yaml_candidate(
    path_text: str, artifact_id: str, source_text: str | None
) -> dict[str, str]:
    source_path = ROOT / source_text if source_text else None
    source_payload: Any = None
    source_hash: str | None = None
    if source_path and source_path.is_file():
        source_hash = sha256(source_path)
        source_payload = yaml.safe_load(source_path.read_text(encoding="utf-8"))
    payload = blocked_record(
        artifact_id,
        path_text,
        source_artifact=source_text,
        source_hash=source_hash,
    )
    payload["source_snapshot"] = source_payload
    write_yaml(ROOT / path_text, payload)
    return {"path": path_text, "kind": "yaml", "metadata": ""}


def write_json_candidate(path_text: str, artifact_id: str) -> dict[str, str]:
    path = ROOT / path_text
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(blocked_record(artifact_id, path_text), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {"path": path_text, "kind": "json", "metadata": ""}


def write_csv_candidate(path_text: str, artifact_id: str) -> dict[str, str]:
    path = ROOT / path_text
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "fixture_revision,limit,result\nnot_run,not_approved,blocked_candidate_not_release\n",
        encoding="utf-8",
    )
    return {"path": path_text, "kind": "csv", "metadata": ""}


def write_program_dir_candidate(path_text: str, artifact_id: str) -> dict[str, str]:
    return write_dir_candidate(path_text, artifact_id)


def generate() -> dict[str, Any]:
    artifacts: list[dict[str, str]] = []
    provenance = routed_release_provenance()

    for path_text, artifact_id in [
        ("board/kicad/e1-phone/production/bom", "production_bom_directory_candidate"),
        ("board/kicad/e1-phone/production/first-article", "first_article_directory_candidate"),
        ("board/kicad/e1-phone/production/gerbers", "gerber_directory_candidate"),
        ("board/kicad/e1-phone/production/gerbers/nc-drill-and-slots", "drill_directory_candidate"),
        ("board/kicad/e1-phone/production/ipc-2581", "ipc2581_directory_candidate"),
        ("board/kicad/e1-phone/production/pos", "position_file_directory_candidate"),
    ]:
        artifacts.append(write_dir_candidate(path_text, artifact_id))

    for path_text, source_text in BOARD_REPORT_SOURCES.items():
        artifact_id = Path(path_text).stem.replace("-", "_") + "_candidate"
        artifacts.append(write_yaml_candidate(path_text, artifact_id, source_text))

    for path_text, artifact_id in [
        ("board/kicad/e1-phone/production/reports/drc.json", "drc_report_candidate"),
        ("board/kicad/e1-phone/production/reports/erc.json", "erc_report_candidate"),
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
            "board/kicad/e1-phone/production/reports/power-thermal/rail-efficiency-and-soak.json",
            "power_thermal_rail_efficiency_soak_candidate",
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
            "board/kicad/e1-phone/production/reports/usb-c-pd-attach-log.json",
            "usb_c_pd_attach_log_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/usb2-adb-fastboot-attach-log.json",
            "usb2_adb_fastboot_attach_log_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/wifi-bt-firmware-identity-log.json",
            "wifi_bt_firmware_identity_log_candidate",
        ),
        (
            "board/kicad/e1-phone/production/test/first-article-test-transcript.json",
            "first_article_test_transcript_candidate",
        ),
        (
            "board/kicad/e1-phone/production/reports/routed-board-clearance-release.yaml",
            "routed_board_clearance_release_candidate",
        ),
    ]:
        if path_text.endswith(".json"):
            artifacts.append(write_json_candidate(path_text, artifact_id))
        else:
            artifacts.append(write_yaml_candidate(path_text, artifact_id, None))

    for path_text, artifact_id in [
        (
            "board/kicad/e1-phone/production/dfm/assembler-dfa-report.pdf",
            "assembler_dfa_report_candidate",
        ),
        (
            "board/kicad/e1-phone/production/dfm/stencil-aperture-review.pdf",
            "stencil_aperture_review_candidate",
        ),
        (
            "board/kicad/e1-phone/production/fab-quote/assembler-commercial-quote.pdf",
            "assembler_commercial_quote_candidate",
        ),
        (
            "board/kicad/e1-phone/production/fab-quote/fabricator-commercial-quote.pdf",
            "fabricator_commercial_quote_candidate",
        ),
        (
            "board/kicad/e1-phone/production/pdf/aoi-xray-cleaning-inspection-notes.pdf",
            "aoi_xray_cleaning_inspection_notes_candidate",
        ),
        (
            "board/kicad/e1-phone/production/stackup/coupon-geometry.pdf",
            "coupon_geometry_candidate",
        ),
        (
            "board/kicad/e1-phone/production/stackup/fabricator-stackup.pdf",
            "fabricator_stackup_candidate",
        ),
        (
            "board/kicad/e1-phone/production/test/fixture-quote/ict-or-flying-probe-quote.pdf",
            "ict_or_flying_probe_quote_candidate",
        ),
        (
            "board/kicad/e1-phone/production/test/fixture-quote/rf-shield-box-calibration-quote.pdf",
            "rf_shield_box_calibration_quote_candidate",
        ),
        (
            "board/kicad/e1-phone/production/test/fixture-quote/traceability-and-programming-flow.pdf",
            "traceability_and_programming_flow_candidate",
        ),
        (
            "board/kicad/e1-phone/production/test/rf-calibration-procedure.pdf",
            "rf_calibration_procedure_candidate",
        ),
    ]:
        artifacts.append(write_pdf_candidate(path_text, artifact_id))

    artifacts.append(
        write_csv_candidate(
            "board/kicad/e1-phone/production/stackup/field-solved-impedance-table.csv",
            "field_solved_impedance_table_candidate",
        )
    )
    artifacts.append(
        write_yaml_candidate(
            "board/kicad/e1-phone/production/test/factory-test-limits.yaml",
            "factory_test_limits_candidate",
            None,
        )
    )
    artifacts.append(
        write_program_dir_candidate(
            "board/kicad/e1-phone/production/test/ict-or-flying-probe-program",
            "ict_or_flying_probe_program_candidate",
        )
    )

    manifest = {
        "schema": "eliza.e1_phone_factory_output_candidate_manifest.v1",
        "date": DATE,
        "status": "blocked_local_factory_output_candidates_not_release",
        "claim_boundary": (
            "Generated local production/factory output candidates. These reduce "
            "missing-file inventory only and do not prove fabrication, assembly, "
            "factory, first-article, enclosure, or end-to-end readiness."
        ),
        "artifact_count": len(artifacts),
        "release_credit": False,
        "routed_release_provenance": provenance,
        "cad_connection_coverage": provenance["cad_connection_coverage"],
        "artifacts": artifacts,
        "intentionally_not_generated": [
            "commercial fabricator or assembler quotes",
            "assembler DFM/DFA/stencil/AOI/X-ray PDFs",
            "first-article travelers and functional transcripts",
            "factory test limits",
            "fixture quotes, calibration procedures, and RF calibration procedures",
            "conducted RF lab logs and power/thermal measured logs",
            "fabricator stackup, coupon geometry, and field-solved impedance evidence",
        ],
    }
    write_yaml(OUT_MANIFEST, manifest)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    manifest = generate()
    print(
        "STATUS: BLOCKED E1 phone factory-output candidates "
        f"generated={manifest['artifact_count']} release_credit=false"
    )
    print(chip_rel(OUT_MANIFEST))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
