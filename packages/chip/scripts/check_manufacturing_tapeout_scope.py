#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]
RELEASE_MANIFEST = ROOT / "docs/manufacturing/release-manifest.yaml"
WORK_ORDER = ROOT / "docs/manufacturing/physical-closure-work-order.yaml"
PD_SIGNOFF_MANIFEST = ROOT / "pd/signoff/manifest.yaml"
TAPEOUT_AGGREGATOR = ROOT / "scripts/aggregate_tapeout_readiness.py"
MANUFACTURING_ARTIFACT_CHECKER = ROOT / "scripts/check_manufacturing_artifacts.py"
OUT = ROOT / "build/reports/manufacturing_tapeout_scope.json"

REQUIRED_BLOCKED_GATES = {"pd_release", "tapeout_release", "board_fabrication_release"}
REQUIRED_READINESS_SECTIONS = {
    "si_pi",
    "pdn_current_budget",
    "thermal_package_board",
    "padframe_package",
}
REQUIRED_CAPTURE_WORK_ORDERS = {
    "fpga_bitstream_evidence_capture",
    "kicad_fab_package_capture",
    "package_vendor_review_capture",
    "si_pi_current_thermal_capture",
}
REQUIRED_FORBIDDEN_CLAIMS = {
    "Tapeout ready.",
    "Board fabrication ready.",
    "Foundry padframe approved.",
    "Package vendor approved.",
    "SI/PI closed.",
    "IR-drop or EM closed.",
    "Thermal closed.",
}
REQUIRED_PD_ARTIFACTS = {
    "run_manifest",
    "gds",
    "def",
    "gate_netlist",
    "corner_manifest",
    "sdc",
    "spef",
    "sdf",
    "drc_report",
    "klayout_drc_report",
    "lvs_report",
    "antenna_report",
    "sta_report",
    "tool_versions",
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def contains_all(text: str, tokens: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return all(token.lower() in lowered for token in tokens)


def mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def list_values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def blocked_gate_names(manifest: dict[str, Any]) -> set[str]:
    gates = mapping(manifest.get("blocked_gates"))
    return {
        name
        for name, gate in gates.items()
        if isinstance(name, str) and isinstance(gate, dict) and gate.get("blocked") is True
    }


def readiness_blocked(manifest: dict[str, Any]) -> bool:
    return all(
        mapping(manifest.get(section)).get("status") == "blocked"
        and mapping(manifest.get(section)).get("release_blocking") is True
        for section in REQUIRED_READINESS_SECTIONS
    )


def work_order_capture_ids(work_order: dict[str, Any]) -> set[str]:
    return {
        str(order.get("id"))
        for order in list_values(work_order.get("evidence_capture_work_orders"))
        if isinstance(order, dict) and order.get("id")
    }


def code_from_text(text: str, fallback: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return code or fallback


def structured_findings(
    blocked_until_real_evidence: list[str], checks: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for item in blocked_until_real_evidence:
        findings.append(
            {
                "code": (
                    "manufacturing_tapeout_missing_real_evidence_"
                    f"{code_from_text(item, 'evidence')}"
                ),
                "severity": "blocker",
                "message": item,
                "evidence": "blocked_until_real_evidence",
                "next_step": (
                    "Archive the named production PDK, signoff, package, board, "
                    "lab, or first-article evidence before allowing tapeout, "
                    "board fabrication, or no-issues runtime claims."
                ),
            }
        )
    for check in checks:
        if check.get("status") == "pass":
            continue
        check_id = str(check.get("id", "scope_check"))
        findings.append(
            {
                "code": (
                    "manufacturing_tapeout_scope_check_failed_"
                    f"{code_from_text(check_id, 'scope_check')}"
                ),
                "severity": "blocker",
                "message": f"{check_id} structural scope check is {check.get('status')}",
                "evidence": check.get("evidence"),
                "next_step": (
                    "Repair the manufacturing/tapeout scope contract before "
                    "using it as release or runtime readiness evidence."
                ),
            }
        )
    return findings


def build_report() -> dict[str, Any]:
    release_manifest = load_yaml_object(RELEASE_MANIFEST)
    work_order = load_yaml_object(WORK_ORDER)
    pd_manifest = load_yaml_object(PD_SIGNOFF_MANIFEST)
    aggregator = TAPEOUT_AGGREGATOR.read_text(encoding="utf-8")
    artifact_checker = MANUFACTURING_ARTIFACT_CHECKER.read_text(encoding="utf-8")

    release_readiness = mapping(release_manifest.get("readiness"))
    work_order_policy = mapping(work_order.get("claim_policy"))
    forbidden_claims = set(
        str(claim)
        for claim in list_values(work_order_policy.get("forbidden_claims_until_evidence_archived"))
    )
    pd_required_artifacts = mapping(pd_manifest.get("required_artifacts"))
    checks = [
        {
            "id": "release_manifest_blocks_all_release_gates",
            "status": "pass"
            if release_manifest.get("status") == "pipeline_scaffold"
            and blocked_gate_names(release_manifest) == REQUIRED_BLOCKED_GATES
            else "fail",
            "evidence": rel(RELEASE_MANIFEST),
        },
        {
            "id": "release_manifest_readiness_sections_blocked",
            "status": "pass"
            if all(
                mapping(release_readiness.get(section)).get("status") == "blocked"
                for section in REQUIRED_READINESS_SECTIONS
            )
            else "fail",
            "evidence": rel(RELEASE_MANIFEST),
        },
        {
            "id": "release_manifest_unblock_requires_real_artifacts",
            "status": "pass"
            if contains_all(
                json.dumps(release_manifest, sort_keys=True, default=str),
                (
                    "Pass scripts/check_pd_closure.py",
                    "Replace antenna/STA waivers",
                    "vendor/foundry artifacts",
                    "SI/PI",
                    "thermal readiness",
                    "first-article evidence",
                ),
            )
            else "fail",
            "evidence": rel(RELEASE_MANIFEST),
        },
        {
            "id": "physical_closure_work_order_blocks_claims",
            "status": "pass"
            if work_order.get("status") == "release_blocked"
            and forbidden_claims >= REQUIRED_FORBIDDEN_CLAIMS
            and contains_all(
                " ".join(str(claim) for claim in work_order_policy.get("allowed_local_claims", [])),
                ("Machine checks prove only", "planning artifacts only"),
            )
            else "fail",
            "evidence": rel(WORK_ORDER),
        },
        {
            "id": "physical_capture_work_orders_cover_release_evidence",
            "status": "pass"
            if work_order_capture_ids(work_order) >= REQUIRED_CAPTURE_WORK_ORDERS
            and contains_all(
                json.dumps(work_order.get("evidence_capture_work_orders"), sort_keys=True),
                ("archived", "vendor", "SI", "PI", "thermal", "tool versions"),
            )
            else "fail",
            "evidence": rel(WORK_ORDER),
        },
        {
            "id": "pd_signoff_manifest_blocks_release_gates",
            "status": "pass"
            if pd_manifest.get("schema") == "eliza.pd_signoff_manifest.v1"
            and pd_manifest.get("status") == "required_for_pd_release"
            and blocked_gate_names(pd_manifest) == REQUIRED_BLOCKED_GATES
            else "fail",
            "evidence": rel(PD_SIGNOFF_MANIFEST),
        },
        {
            "id": "pd_signoff_readiness_sections_release_blocking",
            "status": "pass" if readiness_blocked(pd_manifest) else "fail",
            "evidence": rel(PD_SIGNOFF_MANIFEST),
        },
        {
            "id": "pd_signoff_artifact_classes_cover_layout_and_reports",
            "status": "pass" if set(pd_required_artifacts) >= REQUIRED_PD_ARTIFACTS else "fail",
            "evidence": rel(PD_SIGNOFF_MANIFEST),
        },
        {
            "id": "tapeout_aggregator_is_view_only_and_strict_blocks",
            "status": "pass"
            if contains_all(
                aggregator,
                (
                    "tapeout_readiness_aggregator_view_only_no_silicon_or_release_claim",
                    "strict",
                    "pd-signoff-manifest-check",
                    "physical-closure-work-order-check",
                    "manufacturing-artifacts-check",
                    "real-world-gates-check",
                ),
            )
            else "fail",
            "evidence": rel(TAPEOUT_AGGREGATOR),
        },
        {
            "id": "manufacturing_artifact_checker_release_mode_fails_closed",
            "status": "pass"
            if contains_all(
                artifact_checker,
                (
                    "release requires manifest status complete",
                    "release gate remains blocked",
                    "release requires status complete",
                    "release artifact files are missing",
                    "status complete but artifact files are missing",
                ),
            )
            else "fail",
            "evidence": rel(MANUFACTURING_ARTIFACT_CHECKER),
        },
    ]
    blocked_until_real_evidence = [
        "selected production PDK, standard-cell, SRAM, IO, ESD, and hard-IP release package",
        "complete routed GDS/DEF/netlist/SPEF/SDF/corner manifest and reproducible run manifest",
        "clean or formally waived DRC, KLayout DRC, LVS, antenna, STA, congestion, utilization, and density/fill reports",
        "IR-drop, EM, PDN/current budget, workload activity, voltage, temperature, and reliability signoff reports",
        "foundry padframe, package vendor drawing, land pattern, bond diagram, and package model approval",
        "board ERC/DRC/Gerber/drill/BOM/position/DFM/SI/PI/current-limit/thermal release package",
        "first-article lab bring-up, current, thermal, boot, and manufacturing evidence with source checksums",
    ]
    return {
        "schema": "eliza.manufacturing_tapeout_scope.v1",
        "status": "manufacturing_tapeout_scope_release_blocked",
        "claim_boundary": (
            "Manufacturing and tapeout scope audit only; not tapeout ready, "
            "not board-fabrication ready, not selected foundry PDK signoff, "
            "not DRC/LVS/antenna/STA closure, not IR/EM closure, not SI/PI "
            "closure, not package-vendor approval, not foundry padframe approval, "
            "not first-article evidence, and not silicon proof."
        ),
        "current_scaffolds": {
            "release_manifest": rel(RELEASE_MANIFEST),
            "physical_closure_work_order": rel(WORK_ORDER),
            "pd_signoff_manifest": rel(PD_SIGNOFF_MANIFEST),
            "tapeout_readiness_aggregator": rel(TAPEOUT_AGGREGATOR),
            "manufacturing_artifact_checker": rel(MANUFACTURING_ARTIFACT_CHECKER),
        },
        "blocked_until_real_evidence": blocked_until_real_evidence,
        "checks": checks,
        "findings": structured_findings(blocked_until_real_evidence, checks),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "release_claim_allowed": False,
        },
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(
        data.get("schema") == "eliza.manufacturing_tapeout_scope.v1",
        "schema mismatch",
        errors,
    )
    require(
        data.get("status") == "manufacturing_tapeout_scope_release_blocked",
        "status must remain manufacturing_tapeout_scope_release_blocked",
        errors,
    )
    boundary = str(data.get("claim_boundary", ""))
    for token in (
        "not tapeout ready",
        "not board-fabrication ready",
        "not selected foundry PDK signoff",
        "not DRC/LVS/antenna/STA closure",
        "not IR/EM closure",
        "not SI/PI closure",
        "not package-vendor approval",
        "not foundry padframe approval",
        "not first-article evidence",
        "not silicon proof",
    ):
        require(token in boundary, f"claim boundary missing {token}", errors)
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
        return errors
    require(
        summary.get("release_claim_allowed") is False,
        "release_claim_allowed must stay false",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty list")
        return errors
    for check in checks:
        if not isinstance(check, dict):
            errors.append("checks entries must be mappings")
            continue
        if check.get("status") != "pass":
            errors.append(f"{check.get('id')}: must pass structural scope check")
    blocked = data.get("blocked_until_real_evidence")
    if not isinstance(blocked, list) or len(blocked) < 7:
        errors.append("manufacturing/tapeout scope must enumerate blocked real-evidence items")
    findings = data.get("findings")
    if not isinstance(findings, list) or not findings:
        errors.append("findings must list structured manufacturing/tapeout blockers")
    scaffolds = data.get("current_scaffolds")
    if not isinstance(scaffolds, dict):
        errors.append("current_scaffolds must be a mapping")
    else:
        for key in (
            "release_manifest",
            "physical_closure_work_order",
            "pd_signoff_manifest",
            "tapeout_readiness_aggregator",
            "manufacturing_artifact_checker",
        ):
            require(isinstance(scaffolds.get(key), str), f"current_scaffolds missing {key}", errors)
    return errors


def main() -> int:
    report = build_report()
    errors = validate_report(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"Manufacturing/tapeout scope check passed: {rel(OUT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
