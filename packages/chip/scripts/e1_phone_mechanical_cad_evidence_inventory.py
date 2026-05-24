#!/usr/bin/env python3
"""Inventory E1 phone mechanical CAD evidence without promoting it to release.

The inventory is intentionally fail-closed: generated concept STEP/mesh assets
are counted as existing CAD output, while routed-board, supplier-returned CAD,
and physical fit/process evidence must be present in the review gates before
the enclosure can be treated as release-ready.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
CHIP_ROOT = REPO_ROOT / "packages/chip"
MECH_DIR = CHIP_ROOT / "mechanical/e1-phone"
OUT_DIR = MECH_DIR / "out"
REVIEW_DIR = MECH_DIR / "review"
DEFAULT_REPORT = REVIEW_DIR / "mechanical-cad-evidence-inventory-2026-05-22.yaml"

REPORT_DATE = "2026-05-22"
SCRIPT_NAME = "e1_phone_mechanical_cad_evidence_inventory.py"

MANIFESTS = {
    "assembly": OUT_DIR / "assembly-manifest.json",
    "evt_fixtures": OUT_DIR / "evt-fixture-manifest.json",
    "tooling": OUT_DIR / "tooling-manifest.json",
}

REVIEW_GATES = {
    "routed_board_step_intake": REVIEW_DIR / "board-step-readiness.json",
    "routed_board_clearance": REVIEW_DIR / "routed-board-clearance.json",
    "supplier_evidence": REVIEW_DIR / "supplier-evidence-acceptance.json",
    "physical_process_validation": REVIEW_DIR / "physical-process-validation-acceptance.json",
    "concept_fit_check": REVIEW_DIR / "fit-check-report.json",
    "solid_cad_handoff": REVIEW_DIR / "solid-cad-handoff.json",
    "cad_connection_coverage": REVIEW_DIR / "cad-connection-coverage.json",
    "step_validation": REVIEW_DIR / "step-validation.json",
}

BLOCKED_STATUSES = {
    "blocked",
    "blocked_concept_pcb_no_routed_step",
    "blocked_no_physical_process_validation_results",
    "blocked_no_supplier_evidence",
    "blocked_waiting_for_routed_board_step",
}

REQUIRED_RELEASE_EVIDENCE = {
    "routed_board_step_intake": "physical routed-board release STEP with component height models",
    "routed_board_clearance": "measured enclosure clearance against routed board STEP",
    "supplier_evidence": "supplier-returned quote, 2D drawing, STEP, sample, and traceability artifacts",
    "physical_fit_evidence": "fabricated enclosure/board/display/battery/button/port fit-check results with reviewer identity",
    "physical_process_validation": "finished-phone lab, EVT, FAI, build, traceability, and process-control results",
}


def chip_rel(path: Path) -> str:
    return path.resolve().relative_to(CHIP_ROOT).as_posix()


def repo_rel(path: Path) -> str:
    return chip_rel(path)


def read_json(path: Path) -> Any | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def count_files(root: Path) -> dict[str, Any]:
    files = sorted(path for path in root.rglob("*") if path.is_file())
    top_level_files = sorted(path for path in root.glob("*") if path.is_file())
    recursive_by_extension = Counter(path.suffix.lower() or "<none>" for path in files)
    top_level_by_extension = Counter(path.suffix.lower() or "<none>" for path in top_level_files)
    return {
        "directory": repo_rel(root),
        "total_files_recursive": len(files),
        "top_level_files": len(top_level_files),
        "recursive_by_extension": dict(sorted(recursive_by_extension.items())),
        "top_level_by_extension": dict(sorted(top_level_by_extension.items())),
    }


def manifest_inventory() -> dict[str, Any]:
    rows: dict[str, Any] = {}
    for name, path in MANIFESTS.items():
        data = read_json(path)
        if not isinstance(data, list):
            rows[name] = {
                "path": repo_rel(path),
                "present": path.exists(),
                "item_count": 0,
                "role_counts": {},
            }
            continue
        roles = Counter(
            str(item.get("role", "<missing>")) for item in data if isinstance(item, dict)
        )
        rows[name] = {
            "path": repo_rel(path),
            "present": True,
            "item_count": len(data),
            "role_counts": dict(sorted(roles.items())),
        }
    return rows


def review_gate_inventory() -> dict[str, Any]:
    gates: dict[str, Any] = {}
    for name, path in REVIEW_GATES.items():
        data = read_json(path)
        if not isinstance(data, dict):
            gates[name] = {"path": repo_rel(path), "present": path.exists(), "status": "missing"}
            continue

        gate: dict[str, Any] = {
            "path": repo_rel(path),
            "present": True,
            "status": data.get("status", "unknown"),
            "claim_boundary": data.get("claim_boundary"),
        }
        for key in (
            "production_step_files",
            "approved_production_step_files",
            "blocked_candidate_step_files",
            "development_step_candidates",
            "detailed_routed_step_candidate",
            "demo_step_files_ignored",
            "required_routed_board_evidence_class",
            "routed_board_forbidden_evidence_classes",
            "expected_clearance_case_count",
            "complete_clearance_result_count",
            "expected_family_count",
            "complete_family_count",
            "missing_or_incomplete_families",
            "expected_gate_count",
            "complete_gate_count",
            "missing_or_incomplete_gates",
            "assembly_step",
            "assembly_step_bytes",
            "part_count",
            "validated_count",
            "required_connection_count",
            "passing_connection_count",
            "required_connection_terminal_marker_count",
            "passing_connection_terminal_pair_count",
            "required_connection_solid_step_part_count",
            "passing_connection_solid_step_part_set_count",
            "connection_solid_step_part_bytes_total",
            "represented_net_count_total",
            "visual_route_span_total_mm",
            "physical_medium_counts",
            "electrical_class_counts",
            "controlled_impedance_connection_count",
            "controlled_impedance_requirement_defined_count",
            "bend_radius_requirement_defined_count",
            "supplier_release_required_connection_count",
            "routed_development_net_count",
            "release_credit",
            "remaining_blockers",
            "ocp_terminal_step_fallback_count",
            "ocp_terminal_step_fallback_error",
            "release_rule",
        ):
            if key in data:
                gate[key] = data[key]
        if name == "cad_connection_coverage":
            connection_records = [
                item for item in data.get("connections", []) if isinstance(item, dict)
            ]
            gate["cad_connection_record_count"] = len(connection_records)
            gate["cad_connection_represented_net_list_total"] = sum(
                len(item.get("represented_nets", [])) for item in connection_records
            )
            gate["cad_connection_all_records_have_represented_nets"] = bool(
                connection_records
            ) and all(bool(item.get("represented_nets")) for item in connection_records)
            gate["cad_connection_all_represented_nets_match_routed_nets"] = bool(
                connection_records
            ) and all(
                item.get("represented_nets") == item.get("nets", [])
                and int(item.get("represented_net_count") or 0)
                == len(item.get("represented_nets", []))
                for item in connection_records
            )
        gates[name] = gate
    return gates


def missing_release_evidence(gates: dict[str, Any]) -> list[dict[str, Any]]:
    missing: list[dict[str, Any]] = []
    for gate_name, requirement in REQUIRED_RELEASE_EVIDENCE.items():
        if gate_name == "physical_fit_evidence":
            gate = gates.get("concept_fit_check", {})
            claim_boundary = str(gate.get("claim_boundary", "")).lower()
            source_status = gate.get("status", "missing")
            concept_only = (
                "not released" in claim_boundary
                or "not release" in claim_boundary
                or "not fabricated" in claim_boundary
                or "concept" in claim_boundary
            )
            if concept_only or source_status in BLOCKED_STATUSES:
                missing.append(
                    {
                        "gate": gate_name,
                        "required_evidence": requirement,
                        "status": "missing_release_physical_fit_evidence",
                        "path": gate.get("path"),
                        "source_status": source_status,
                        "source_claim_boundary": gate.get("claim_boundary"),
                    }
                )
            continue
        gate = gates.get(gate_name, {})
        status = gate.get("status", "missing")
        present = bool(gate.get("present"))
        blocked = status in BLOCKED_STATUSES or not present
        if blocked:
            row = {
                "gate": gate_name,
                "required_evidence": requirement,
                "status": status,
                "path": gate.get("path"),
            }
            for key in (
                "production_step_files",
                "approved_production_step_files",
                "blocked_candidate_step_files",
                "development_step_candidates",
                "detailed_routed_step_candidate",
                "complete_clearance_result_count",
                "expected_clearance_case_count",
                "complete_family_count",
                "expected_family_count",
                "missing_or_incomplete_families",
                "complete_gate_count",
                "expected_gate_count",
                "missing_or_incomplete_gates",
            ):
                if key in gate:
                    row[key] = gate[key]
            missing.append(row)
    return missing


def build_report() -> dict[str, Any]:
    output_counts = count_files(OUT_DIR)
    manifests = manifest_inventory()
    gates = review_gate_inventory()
    missing = missing_release_evidence(gates)

    assembly = manifests.get("assembly", {})
    solid_handoff = gates.get("solid_cad_handoff", {})
    connection_coverage = gates.get("cad_connection_coverage", {})
    step_validation = gates.get("step_validation", {})
    board_gate = gates.get("routed_board_step_intake", {})
    assembly_step_bytes = int(solid_handoff.get("assembly_step_bytes") or 0)
    assembly_manifest_part_count = int(assembly.get("item_count") or 0)
    ocp_terminal_step_fallback_count = int(
        solid_handoff.get("ocp_terminal_step_fallback_count") or 0
    )
    step_validation_validated_count = int(step_validation.get("validated_count") or 0)
    required_connection_count = int(connection_coverage.get("required_connection_count") or 0)
    passing_connection_count = int(connection_coverage.get("passing_connection_count") or 0)
    cad_connection_coverage_complete = (
        connection_coverage.get("status") == "cad_connection_markers_complete_not_release"
        and required_connection_count > 0
        and passing_connection_count == required_connection_count
        and connection_coverage.get("release_credit") is False
    )
    detailed_routed_step_candidate = board_gate.get("detailed_routed_step_candidate", {})
    if not isinstance(detailed_routed_step_candidate, dict):
        detailed_routed_step_candidate = {}
    blocked_candidate_step_files = board_gate.get("blocked_candidate_step_files", [])
    if not isinstance(blocked_candidate_step_files, list):
        blocked_candidate_step_files = []
    approved_production_step_files = board_gate.get("approved_production_step_files", [])
    if not isinstance(approved_production_step_files, list):
        approved_production_step_files = []
    detailed_candidate_present = detailed_routed_step_candidate.get("present") is True
    detailed_candidate_release_credit = detailed_routed_step_candidate.get("release_credit")
    local_routed_step_candidate_ready = (
        detailed_candidate_present
        and detailed_routed_step_candidate.get("blocked_metadata") is True
        and detailed_candidate_release_credit is False
        and int(detailed_routed_step_candidate.get("size_bytes") or 0) > 0
    )
    local_cad_ready = (
        assembly_manifest_part_count > 0
        and solid_handoff.get("status") == "generated"
        and bool(solid_handoff.get("assembly_step"))
        and assembly_step_bytes > 0
        and cad_connection_coverage_complete
        and step_validation.get("status") == "pass"
        and step_validation_validated_count > 0
    )
    release_enclosure_ready = {
        "ready": False,
        "fail_closed": True,
        "release_claim_allowed": False,
        "reason": (
            "Release-ready enclosure evidence is absent until required routed-board STEP, "
            "routed-board clearance, supplier-returned evidence, and physical process "
            "validation gates are all present and passing."
        ),
        "missing_required_evidence_count": len(missing),
        "required_blockers": [row["gate"] for row in missing],
    }

    return {
        "report": "E1 phone mechanical CAD evidence inventory",
        "date": REPORT_DATE,
        "script": f"packages/chip/scripts/{SCRIPT_NAME}",
        "scope": {
            "mode": "read_only_inventory",
            "cad_output_dir": repo_rel(OUT_DIR),
            "review_dir": repo_rel(REVIEW_DIR),
            "claim_boundary": (
                "Existing generated/concept CAD outputs are counted, but do not prove "
                "release-ready enclosure fit without routed-board, supplier, and physical evidence."
            ),
        },
        "cad_output_file_counts": output_counts,
        "concept_generated_assets": {
            "assembly_manifest_part_count": assembly_manifest_part_count,
            "solid_handoff_status": solid_handoff.get("status"),
            "solid_handoff_part_count": solid_handoff.get("part_count"),
            "solid_assembly_step": solid_handoff.get("assembly_step"),
            "solid_assembly_step_bytes": assembly_step_bytes,
            "solid_handoff_ocp_terminal_step_fallback_count": (
                ocp_terminal_step_fallback_count
            ),
            "solid_handoff_ocp_terminal_step_fallback_error": solid_handoff.get(
                "ocp_terminal_step_fallback_error"
            ),
            "cad_connection_coverage_status": connection_coverage.get("status"),
            "cad_connection_required_count": connection_coverage.get("required_connection_count"),
            "cad_connection_passing_count": connection_coverage.get("passing_connection_count"),
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
            "cad_connection_record_count": connection_coverage.get(
                "cad_connection_record_count"
            ),
            "cad_connection_represented_net_list_total": connection_coverage.get(
                "cad_connection_represented_net_list_total"
            ),
            "cad_connection_all_records_have_represented_nets": connection_coverage.get(
                "cad_connection_all_records_have_represented_nets"
            ),
            "cad_connection_all_represented_nets_match_routed_nets": connection_coverage.get(
                "cad_connection_all_represented_nets_match_routed_nets"
            ),
            "cad_connection_visual_route_span_total_mm": connection_coverage.get(
                "visual_route_span_total_mm"
            ),
            "cad_connection_physical_medium_counts": connection_coverage.get(
                "physical_medium_counts", {}
            ),
            "cad_connection_electrical_class_counts": connection_coverage.get(
                "electrical_class_counts", {}
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
            "step_validation_status": step_validation.get("status"),
            "step_validation_validated_count": step_validation_validated_count,
            "concept_demo_board_steps_ignored": board_gate.get("demo_step_files_ignored", []),
            "local_routed_step_candidates_blocked": blocked_candidate_step_files,
            "classification": "generated_concept_or_evt0_envelope_not_release_ready",
        },
        "local_routed_step_candidate_ready": {
            "ready": local_routed_step_candidate_ready,
            "scope": "local_routed_output_candidate_not_release_evidence",
            "approved_production_step_count": len(approved_production_step_files),
            "blocked_candidate_step_count": len(blocked_candidate_step_files),
            "detailed_routed_step_candidate_present": detailed_candidate_present,
            "detailed_routed_step_candidate_ready_for_local_review": (
                local_routed_step_candidate_ready
            ),
            "detailed_routed_step_candidate_path": detailed_routed_step_candidate.get("path"),
            "detailed_routed_step_candidate_bytes": int(
                detailed_routed_step_candidate.get("size_bytes") or 0
            ),
            "detailed_routed_step_candidate_route_count": detailed_routed_step_candidate.get(
                "route_count"
            ),
            "detailed_routed_step_candidate_segment_count": detailed_routed_step_candidate.get(
                "segment_count"
            ),
            "detailed_routed_step_candidate_release_credit": detailed_candidate_release_credit,
            "release_claim_allowed": False,
        },
        "local_enclosure_cad_ready": {
            "ready": local_cad_ready,
            "scope": "generated_evt0_concept_cad_only",
            "solid_handoff_generated": solid_handoff.get("status") == "generated",
            "solid_handoff_ocp_terminal_step_fallback_count": (
                ocp_terminal_step_fallback_count
            ),
            "solid_handoff_ocp_terminal_step_fallback_complete": (
                ocp_terminal_step_fallback_count
                == int(connection_coverage.get("required_connection_terminal_marker_count") or 0)
                and not solid_handoff.get("ocp_terminal_step_fallback_error")
            ),
            "cad_connection_coverage_complete": cad_connection_coverage_complete,
            "assembly_step_present": bool(solid_handoff.get("assembly_step")),
            "assembly_step_bytes": assembly_step_bytes,
            "assembly_manifest_part_count": assembly_manifest_part_count,
            "step_validation_passed": step_validation.get("status") == "pass",
            "step_validation_validated_count": step_validation_validated_count,
            "release_claim_allowed": False,
        },
        "manifest_inventory": manifests,
        "review_gate_inventory": gates,
        "missing_release_ready_evidence": missing,
        "release_enclosure_ready": release_enclosure_ready,
        "release_readiness": {
            "release_ready": release_enclosure_ready["ready"],
            "fail_closed": release_enclosure_ready["fail_closed"],
            "reason": release_enclosure_ready["reason"],
            "missing_required_evidence_count": release_enclosure_ready[
                "missing_required_evidence_count"
            ],
        },
    }


def yaml_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if text == "":
        return '""'
    return json.dumps(text)


def to_yaml(value: Any, indent: int = 0) -> list[str]:
    prefix = " " * indent
    if isinstance(value, dict):
        lines: list[str] = []
        for key, child in value.items():
            if isinstance(child, (dict, list)):
                lines.append(f"{prefix}{key}:")
                lines.extend(to_yaml(child, indent + 2))
            else:
                lines.append(f"{prefix}{key}: {yaml_scalar(child)}")
        return lines
    if isinstance(value, list):
        if not value:
            return [f"{prefix}[]"]
        lines = []
        for item in value:
            if isinstance(item, (dict, list)):
                lines.append(f"{prefix}-")
                lines.extend(to_yaml(item, indent + 2))
            else:
                lines.append(f"{prefix}- {yaml_scalar(item)}")
        return lines
    return [f"{prefix}{yaml_scalar(value)}"]


def render_yaml(report: dict[str, Any]) -> str:
    return "\n".join(to_yaml(report)) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write",
        action="store_true",
        help=f"write the inventory to {repo_rel(DEFAULT_REPORT)}",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_REPORT,
        help="report path used with --write",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report()
    text = render_yaml(report)
    if args.write:
        args.output.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
