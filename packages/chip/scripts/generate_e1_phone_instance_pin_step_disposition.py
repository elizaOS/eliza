#!/usr/bin/env python3
"""Generate per-instance pin, pattern, and STEP disposition for E1 phone CAD/KiCad."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
BOARD_ROOT = ROOT / "board/kicad/e1-phone"
OUT = BOARD_ROOT / "instance-pin-step-disposition-2026-06-02.yaml"
PAD_AUDIT = BOARD_ROOT / "development-pad-pin-coverage-audit-2026-05-22.yaml"
COMPONENT_MANIFEST = BOARD_ROOT / "production/step/component-3d-model-manifest.yaml"
TRACEABILITY = BOARD_ROOT / "kicad-cad-traceability-matrix-2026-05-22.yaml"
ROUTED_BOARD = BOARD_ROOT / "pcb/e1-phone-mainboard-routed.kicad_pcb"


def load_yaml(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def main() -> int:
    pad_audit = load_yaml(PAD_AUDIT)
    component_manifest = load_yaml(COMPONENT_MANIFEST)
    traceability = load_yaml(TRACEABILITY)
    routed_board_text = ROUTED_BOARD.read_text(encoding="utf-8")

    pad_records = {
        record["footprint"]: record
        for record in pad_audit.get("records", [])
        if isinstance(record, dict)
    }
    pending_footprints = {
        record["footprint"]
        for record in pad_audit.get("pending_supplier_pad_map_or_order_records", [])
        if isinstance(record, dict)
    }
    package_conflict_by_footprint = {
        record["footprint"]: record
        for record in pad_audit.get("public_candidate_package_conflict_records", [])
        if isinstance(record, dict)
    }
    trace_by_footprint = {
        record["footprint"]: record
        for record in traceability.get("footprint_traceability", [])
        if isinstance(record, dict)
    }
    models = [record for record in component_manifest.get("models", []) if isinstance(record, dict)]

    records: list[dict[str, Any]] = []
    local_failures: list[str] = []
    for model in models:
        footprint = str(model.get("footprint") or "")
        reference = str(model.get("reference") or "")
        pad_record = pad_records.get(footprint, {})
        trace_record = trace_by_footprint.get(footprint, {})
        step_text = str(model.get("local_discrete_step_file") or "")
        step_path = ROOT / step_text if step_text else None
        step_exists = bool(step_path and step_path.is_file())
        step_hash_matches = bool(
            step_path
            and step_exists
            and model.get("local_discrete_step_sha256") == file_sha256(step_path)
        )
        step_size_matches = bool(
            step_path
            and step_exists
            and int(model.get("local_discrete_step_bytes") or 0) == step_path.stat().st_size
        )
        pinout_bound = bool(model.get("pinout_file"))
        support_bound = model.get("support_pattern_has_explicit_provenance") is True
        electrical_pad_count = int(model.get("electrical_pad_count") or 0)
        terminal_contract_count = int(model.get("terminal_contract_count") or 0)
        pad_visual_count = int(model.get("pad_visual_count") or 0)
        pad_contract_covered_count = int(model.get("pad_contract_covered_count") or 0)
        local_contract_pass = bool(
            model.get("all_pad_visuals_have_contract") is True
            and pad_contract_covered_count == pad_visual_count
            and not model.get("uncovered_pad_visuals")
            and (electrical_pad_count == 0 or terminal_contract_count > 0)
        )
        local_step_pass = bool(
            step_exists
            and step_hash_matches
            and step_size_matches
            and model.get("local_discrete_step_imported_as_solid") is True
            and model.get("local_discrete_step_bbox_matches_envelope") is True
        )
        local_review_pass = bool(
            reference
            and footprint in pad_records
            and footprint in trace_by_footprint
            and model.get("pattern_bound") is True
            and local_contract_pass
            and local_step_pass
            and model.get("release_credit") is False
            and model.get("supplier_approved") is False
        )
        if not local_review_pass:
            local_failures.append(reference or footprint)
        records.append(
            {
                "reference": reference,
                "footprint": footprint,
                "visual_package_class": model.get("visual_package_class"),
                "board_side": model.get("side"),
                "pinout_file": model.get("pinout_file"),
                "pinout_bound": pinout_bound,
                "support_pattern_bound": support_bound,
                "pending_supplier_pad_map_or_order": footprint in pending_footprints,
                "public_candidate_package_conflict": footprint in package_conflict_by_footprint,
                "public_candidate_package_conflict_status": package_conflict_by_footprint.get(
                    footprint, {}
                ).get("status"),
                "pad_count": int(model.get("pad_count") or 0),
                "electrical_pad_count": electrical_pad_count,
                "mechanical_pad_count": int(model.get("mechanical_pad_count") or 0),
                "pad_visual_count": pad_visual_count,
                "terminal_contract_count": terminal_contract_count,
                "pad_contract_covered_count": pad_contract_covered_count,
                "local_contract_pass": local_contract_pass,
                "local_step_file": step_text,
                "local_step_exists": step_exists,
                "local_step_sha256": model.get("local_discrete_step_sha256"),
                "local_step_sha256_matches": step_hash_matches,
                "local_step_bytes": int(model.get("local_discrete_step_bytes") or 0),
                "local_step_size_matches": step_size_matches,
                "local_step_imported_as_solid": (
                    model.get("local_discrete_step_imported_as_solid") is True
                ),
                "local_step_bbox_matches_envelope": (
                    model.get("local_discrete_step_bbox_matches_envelope") is True
                ),
                "traceability_board_instance_count_for_footprint": int(
                    trace_record.get("board_instance_count") or 0
                ),
                "traceability_step_instance_count_for_footprint": int(
                    trace_record.get("step_instance_count") or 0
                ),
                "supplier_approved": model.get("supplier_approved") is True,
                "release_credit": model.get("release_credit") is True,
                "local_review_pass": local_review_pass,
                "release_blocker": (
                    "supplier_approved_land_pattern_step_and_release_intake_required"
                ),
            }
        )

    summary = {
        "component_instance_count": len(records),
        "routed_board_footprint_count": routed_board_text.count('(footprint "'),
        "pinout_bound_instance_count": sum(1 for record in records if record["pinout_bound"]),
        "support_pattern_instance_count": sum(
            1 for record in records if record["support_pattern_bound"]
        ),
        "pending_supplier_pad_map_or_order_instance_count": sum(
            1 for record in records if record["pending_supplier_pad_map_or_order"]
        ),
        "public_candidate_package_conflict_instance_count": sum(
            1 for record in records if record["public_candidate_package_conflict"]
        ),
        "local_step_instance_count": sum(1 for record in records if record["local_step_exists"]),
        "local_step_hash_match_count": sum(
            1 for record in records if record["local_step_sha256_matches"]
        ),
        "local_contract_pass_count": sum(1 for record in records if record["local_contract_pass"]),
        "local_review_pass_count": sum(1 for record in records if record["local_review_pass"]),
        "supplier_approved_instance_count": sum(
            1 for record in records if record["supplier_approved"]
        ),
        "release_credit_instance_count": sum(1 for record in records if record["release_credit"]),
        "local_failure_count": len(local_failures),
    }
    status = (
        "instance_pin_pattern_step_disposition_complete_not_release"
        if summary["component_instance_count"] == summary["routed_board_footprint_count"]
        and summary["component_instance_count"] == summary["local_review_pass_count"]
        and summary["supplier_approved_instance_count"] == 0
        and summary["release_credit_instance_count"] == 0
        else "blocked_instance_pin_pattern_step_disposition_gap"
    )
    report = {
        "schema": "eliza.e1_phone_instance_pin_step_disposition.v1",
        "date": "2026-06-02",
        "status": status,
        "claim_boundary": (
            "Per-board-instance local disposition for development footprints, pin/pad "
            "contracts, and local STEP envelope files. This is not supplier land-pattern "
            "approval, production DRC/ERC, physical clearance, or fabrication release."
        ),
        "source_artifacts": [rel(PAD_AUDIT), rel(COMPONENT_MANIFEST), rel(TRACEABILITY), rel(ROUTED_BOARD)],
        "summary": summary,
        "local_failures": local_failures,
        "records": records,
        "release_blockers_preserved": [
            "supplier-approved pinouts and land patterns",
            "supplier-approved component STEP/B-rep models",
            "clean or waived production DRC/ERC/SI/PI/RF evidence",
            "physical routed-board clearance and first-article release intake",
        ],
        "release_credit": False,
    }
    OUT.write_text(yaml.safe_dump(report, sort_keys=False, width=110), encoding="utf-8")
    print(f"wrote {rel(OUT)}: {status} ({len(records)} instances)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
