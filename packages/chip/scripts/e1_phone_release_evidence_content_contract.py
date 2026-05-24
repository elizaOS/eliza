#!/usr/bin/env python3
"""Generate the fail-closed E1 phone release evidence content contract."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
BOARD_ROOT = ROOT / "board/kicad/e1-phone"
REPORT_DATE = "2026-05-22"

DEFAULT_SUPPLIER_MATRIX = (
    BOARD_ROOT / "production/sourcing/readiness/"
    "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_ROUTED_MATRIX = (
    BOARD_ROOT / "production/readiness/routed-board-release-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_FIRST_ARTICLE_MATRIX = (
    BOARD_ROOT
    / "production/test/readiness/e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_PRODUCTION_PRESENCE = (
    BOARD_ROOT / "production/readiness/"
    "production-factory-required-output-presence-inventory-2026-05-22.yaml"
)
DEFAULT_MECHANICAL_CAD = (
    ROOT / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"
)
DEFAULT_KICAD_CAD_TRACEABILITY = BOARD_ROOT / "kicad-cad-traceability-matrix-2026-05-22.yaml"
DEFAULT_CANDIDATE_MANIFEST = (
    BOARD_ROOT / "production/routed-output-candidate-manifest-2026-05-22.yaml"
)
DEFAULT_FACTORY_CANDIDATE_MANIFEST = (
    BOARD_ROOT / "production/factory-output-candidate-manifest-2026-05-22.yaml"
)
DEFAULT_REPORT = (
    BOARD_ROOT / "production/readiness/release-evidence-content-contract-2026-05-22.yaml"
)


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected a YAML mapping")
    return data


def rel(path: Path) -> str:
    candidate = path if path.is_absolute() else ROOT / path
    return candidate.resolve().relative_to(ROOT).as_posix()


def resolve_repo_path(path_text: str | None) -> Path | None:
    if not path_text:
        return None
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return ROOT.parents[1] / path
    return ROOT / path


def artifact_kind(path: Path | None) -> str:
    if path is None or not path.exists():
        return "missing"
    if path.is_file():
        return "file"
    if path.is_dir():
        return "directory"
    return "other"


def sorted_unique(items: list[str]) -> list[str]:
    return sorted(dict.fromkeys(items))


def candidate_paths(candidate_manifest: dict[str, Any]) -> set[str]:
    paths: set[str] = set()
    for artifact in candidate_manifest.get("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        path = artifact.get("path")
        if isinstance(path, str) and path:
            paths.add(path)
        metadata = artifact.get("metadata")
        if isinstance(metadata, str) and metadata:
            paths.add(metadata)
    return paths


def candidate_artifact_paths(candidate_manifest: dict[str, Any]) -> set[str]:
    paths: set[str] = set()
    for artifact in candidate_manifest.get("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        path = artifact.get("path")
        if isinstance(path, str) and path:
            paths.add(path)
    return paths


def combined_candidate_manifest(paths: list[Path]) -> dict[str, Any]:
    artifacts: list[dict[str, Any]] = []
    manifests: list[str] = []
    for path in paths:
        if not path.is_file():
            continue
        manifest = load_yaml(path)
        manifests.append(rel(path))
        for artifact in manifest.get("artifacts", []):
            if isinstance(artifact, dict):
                artifacts.append(artifact)
    return {
        "schema": "eliza.e1_phone_combined_local_candidate_manifest.v1",
        "manifests": manifests,
        "artifacts": artifacts,
    }


def cad_connection_assembly_summary(candidate_manifest: dict[str, Any]) -> dict[str, Any]:
    coverage = candidate_manifest.get("cad_connection_coverage", {})
    if not isinstance(coverage, dict):
        coverage = {}
    return {
        "assembly_manifest": coverage.get("assembly_manifest"),
        "assembly_manifest_part_count": coverage.get("assembly_manifest_part_count"),
        "assembly_manifest_connection_terminal_marker_count": coverage.get(
            "assembly_manifest_connection_terminal_marker_count"
        ),
        "assembly_manifest_connection_solid_step_part_count": coverage.get(
            "assembly_manifest_connection_solid_step_part_count"
        ),
        "assembly_manifest_missing_connection_solid_step_part_count": coverage.get(
            "assembly_manifest_missing_connection_solid_step_part_count"
        ),
        "assembly_manifest_missing_connection_solid_step_part_names": coverage.get(
            "assembly_manifest_missing_connection_solid_step_part_names"
        ),
    }


def supplier_evidence_classes(matrix: dict[str, Any]) -> list[str]:
    classes: list[str] = []
    for row in matrix.get("acceptance_matrix", []):
        for evidence in row.get("required_supplier_return_evidence", []):
            evidence_class = evidence.get("evidence_class")
            if isinstance(evidence_class, str):
                classes.append(evidence_class)
    return sorted_unique(classes)


def routed_evidence_ids(matrix: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    for evidence in matrix.get("required_acceptance_evidence", []):
        evidence_id = evidence.get("id")
        if isinstance(evidence_id, str):
            ids.append(evidence_id)
    return sorted_unique(ids)


def first_article_kinds(matrix: dict[str, Any]) -> list[str]:
    kinds: list[str] = []
    for row in matrix.get("acceptance_matrix", []):
        kind = row.get("evidence_kind")
        if isinstance(kind, str):
            kinds.append(kind)
    return sorted_unique(kinds)


def content_requirement_row(
    category: str,
    evidence_id: str,
    path: str | None,
    source_matrix: str,
    *,
    template_only: bool = False,
    current_present: bool = False,
    current_artifact_kind: str = "missing",
    source_status: str = "blocked_or_missing",
) -> dict[str, Any]:
    return {
        "evidence_id": evidence_id,
        "category": category,
        "path": path,
        "source_matrix": source_matrix,
        "schema": "eliza.e1_phone_release_evidence_artifact_content_requirement.v1",
        "status": source_status,
        "release_allowed": False,
        "template_only": template_only,
        "presence_only": True,
        "validated": False,
        "approval_status": "missing_or_unvalidated",
        "reviewer": None,
        "owner": None,
        "captured_at": None,
        "revision_or_lot": None,
        "sha256": None,
        "traceability_ids": [],
        "current_presence": {
            "present": current_present,
            "artifact_kind": current_artifact_kind,
        },
        "required_before_release": [
            "non-template executed or supplier-returned artifact",
            "content hash bound to the source requirement",
            "revision, lot, serial, or tool version traceability",
            "owner and reviewer disposition",
            "explicit pass/fail or acceptance result where applicable",
        ],
        "forbidden_claims": [
            "fabrication_ready",
            "enclosure_ready",
            "factory_ready",
            "first_article_passed",
            "end_to_end_phone_ready",
        ],
    }


def artifact_content_requirements(
    supplier: dict[str, Any],
    routed: dict[str, Any],
    first_article: dict[str, Any],
    production_presence: dict[str, Any],
    mechanical_cad: dict[str, Any],
    candidate_manifest: dict[str, Any],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    supplier_source = rel(DEFAULT_SUPPLIER_MATRIX)
    for lane in supplier.get("acceptance_matrix", []):
        lane_id = str(lane.get("function") or lane.get("lane") or "unknown_supplier_lane")
        for evidence in lane.get("required_supplier_return_evidence", []):
            evidence_class = str(evidence.get("evidence_class", "unknown_evidence"))
            rows.append(
                content_requirement_row(
                    "supplier_return_evidence",
                    f"{lane_id}:{evidence_class}",
                    evidence.get("expected_local_intake_path"),
                    supplier_source,
                    current_present=bool(evidence.get("current_presence")),
                    current_artifact_kind=str(evidence.get("artifact_kind", "missing")),
                    source_status=str(evidence.get("acceptance_state", "blocked_or_missing")),
                )
            )

    routed_source = rel(DEFAULT_ROUTED_MATRIX)
    for output in routed.get("missing_production_outputs", []):
        rows.append(
            content_requirement_row(
                "routed_board_release_evidence",
                f"routed_output:{output['path']}",
                output["path"],
                routed_source,
                current_present=bool(output.get("present")),
                current_artifact_kind=str(output.get("artifact_kind", "missing")),
                source_status="blocked_fail_closed_missing_required_output",
            )
        )
    for evidence in routed.get("required_acceptance_evidence", []):
        evidence_id = str(evidence.get("id", "unknown_validation_evidence"))
        for artifact in evidence.get("required_artifacts", []):
            rows.append(
                content_requirement_row(
                    "routed_board_release_evidence",
                    f"{evidence_id}:{artifact['path']}",
                    artifact["path"],
                    routed_source,
                    current_present=bool(artifact.get("present")),
                    current_artifact_kind=str(artifact.get("artifact_kind", "missing")),
                    source_status="blocked_fail_closed_missing_validation_evidence",
                )
            )

    production_source = rel(DEFAULT_PRODUCTION_PRESENCE)
    for output in production_presence.get("required_output_presence", []):
        rows.append(
            content_requirement_row(
                "production_factory_outputs",
                f"production_output:{output['path']}",
                output["path"],
                production_source,
                current_present=bool(output.get("present")),
                current_artifact_kind=str(output.get("artifact_kind", "missing")),
                source_status="blocked_fail_closed_presence_only",
            )
        )

    first_article_source = rel(DEFAULT_FIRST_ARTICLE_MATRIX)
    for evidence in first_article.get("acceptance_matrix", []):
        path = evidence.get("path")
        if not isinstance(path, str):
            continue
        rows.append(
            content_requirement_row(
                "first_article_bench_evidence",
                f"{evidence.get('evidence_kind', 'evidence')}:{path}",
                path,
                first_article_source,
                template_only=bool(evidence.get("template_only")),
                current_present=bool(evidence.get("current_presence", {}).get("present")),
                current_artifact_kind=str(
                    evidence.get("current_presence", {}).get("artifact_kind", "missing")
                ),
                source_status=str(evidence.get("acceptance_state", "blocked_or_missing")),
            )
        )

    mechanical_source = rel(DEFAULT_MECHANICAL_CAD)
    for evidence in mechanical_cad.get("missing_release_ready_evidence", []):
        gate = str(evidence.get("gate", "unknown_mechanical_gate"))
        resolved = resolve_repo_path(evidence.get("path"))
        rows.append(
            content_requirement_row(
                "mechanical_enclosure_evidence",
                gate,
                evidence.get("path"),
                mechanical_source,
                current_present=bool(resolved and resolved.exists()),
                current_artifact_kind=artifact_kind(resolved),
                source_status=str(evidence.get("status", "blocked_or_missing")),
            )
        )
    blocked_candidate_paths = candidate_paths(candidate_manifest)
    release_rows = [
        row for row in rows if not row.get("path") or row["path"] not in blocked_candidate_paths
    ]
    return sorted(
        release_rows,
        key=lambda item: (item["category"], item["evidence_id"], str(item["path"])),
    )


def candidate_content_requirements(
    rows: list[dict[str, Any]],
    candidate_manifest: dict[str, Any],
) -> list[dict[str, Any]]:
    blocked_candidate_paths = candidate_paths(candidate_manifest)
    candidate_rows = [
        {
            **row,
            "artifact_origin": "local_generated_candidate",
            "approval_eligible": False,
            "release_credit": False,
            "status": "blocked_local_candidate_not_release_evidence",
        }
        for row in rows
        if row.get("path") in blocked_candidate_paths
    ]
    return sorted(
        candidate_rows,
        key=lambda item: (item["category"], item["evidence_id"], str(item["path"])),
    )


def all_content_requirement_rows(
    supplier: dict[str, Any],
    routed: dict[str, Any],
    first_article: dict[str, Any],
    production_presence: dict[str, Any],
    mechanical_cad: dict[str, Any],
) -> list[dict[str, Any]]:
    return artifact_content_requirements(
        supplier,
        routed,
        first_article,
        production_presence,
        mechanical_cad,
        {"artifacts": []},
    )


def build_contract_rows(
    supplier: dict[str, Any],
    routed: dict[str, Any],
    first_article: dict[str, Any],
    production_presence: dict[str, Any],
    mechanical_cad: dict[str, Any],
    kicad_cad_traceability: dict[str, Any],
    routed_candidate_manifest: dict[str, Any],
    factory_candidate_manifest: dict[str, Any],
) -> list[dict[str, Any]]:
    traceability_summary = kicad_cad_traceability["summary"]
    routed_cad_connection_assembly = cad_connection_assembly_summary(routed_candidate_manifest)
    factory_cad_connection_assembly = cad_connection_assembly_summary(factory_candidate_manifest)
    common_traceability = [
        "artifact_id",
        "source_requirement_id",
        "owner",
        "created_at",
        "tool_or_supplier_revision",
        "input_artifact_hashes",
        "reviewer",
        "reviewed_at",
        "disposition",
    ]
    return [
        {
            "id": "supplier_return_evidence",
            "source_report": rel(DEFAULT_SUPPLIER_MATRIX),
            "covered_evidence_classes": supplier_evidence_classes(supplier),
            "covered_path_count": supplier["summary"]["required_supplier_return_evidence_count"],
            "required_content_fields": common_traceability
            + [
                "supplier_name",
                "supplier_part_number",
                "manufacturer_part_number",
                "drawing_revision",
                "sample_lot_or_quote_id",
                "signed_supplier_response",
                "pinout_or_land_pattern_source",
                "mechanical_model_source",
            ],
            "acceptance_checks": [
                "every supplier lane has the signed response pack and all required return files",
                "drawing, pad map, land pattern, STEP/BREP, sample, lifecycle, and compliance evidence cite supplier revision",
                "KiCad pinout, symbol, footprint, 3D binding, ERC, DRC, routed, and functional release evidence has owner disposition",
            ],
            "placeholder_rejection_signals": [
                "template_empty_not_executed",
                "unresolved_to_be_defined_field",
                "unsigned",
                "missing supplier revision",
                "presence-only",
            ],
            "release_allowed_by_presence_only": False,
        },
        {
            "id": "routed_board_release_evidence",
            "source_report": rel(DEFAULT_ROUTED_MATRIX),
            "covered_route_domain_count": routed["summary"]["route_domain_count"],
            "covered_validation_evidence_ids": routed_evidence_ids(routed),
            "covered_required_output_path_count": routed["summary"]["required_output_path_count"],
            "required_content_fields": common_traceability
            + [
                "kicad_project_revision",
                "routed_pcb_hash",
                "erc_result",
                "drc_result",
                "stackup_revision",
                "impedance_coupon_reference",
                "si_pi_rf_report_references",
                "fab_output_manifest",
                "routed_step_reference",
            ],
            "acceptance_checks": [
                "all route domains have complete exact-net coverage and required outputs",
                "ERC, DRC, length/skew, SI/PI, RF, thermal, stackup, fabrication, and assembly outputs are present and pass",
                "routed STEP and clearance release match the routed PCB revision",
            ],
            "placeholder_rejection_signals": [
                "concept",
                "demo",
                "not_routed",
                "blocked",
                "missing_exact_nets",
                "unvalidated",
            ],
            "release_allowed_by_presence_only": False,
        },
        {
            "id": "production_factory_outputs",
            "source_report": rel(DEFAULT_PRODUCTION_PRESENCE),
            "covered_required_output_path_count": production_presence["summary"][
                "required_output_path_count"
            ],
            "manufacturing_closure_has_production_outputs": production_presence["summary"][
                "manufacturing_closure_has_production_outputs"
            ],
            "manufacturing_closure_release_output_count": production_presence["summary"][
                "manufacturing_closure_release_output_count"
            ],
            "manufacturing_closure_has_blocked_candidate_outputs": production_presence["summary"][
                "manufacturing_closure_has_blocked_candidate_outputs"
            ],
            "manufacturing_closure_blocked_candidate_output_file_count": production_presence[
                "summary"
            ]["manufacturing_closure_blocked_candidate_output_file_count"],
            "factory_candidate_cad_connection_assembly_manifest": (
                factory_cad_connection_assembly["assembly_manifest"]
            ),
            "factory_candidate_cad_connection_assembly_manifest_part_count": (
                factory_cad_connection_assembly["assembly_manifest_part_count"]
            ),
            "factory_candidate_cad_connection_assembly_manifest_terminal_marker_count": (
                factory_cad_connection_assembly[
                    "assembly_manifest_connection_terminal_marker_count"
                ]
            ),
            "factory_candidate_cad_connection_assembly_manifest_solid_step_part_count": (
                factory_cad_connection_assembly[
                    "assembly_manifest_connection_solid_step_part_count"
                ]
            ),
            "factory_candidate_cad_connection_assembly_manifest_missing_solid_step_part_count": (
                factory_cad_connection_assembly[
                    "assembly_manifest_missing_connection_solid_step_part_count"
                ]
            ),
            "required_content_fields": common_traceability
            + [
                "release_package_revision",
                "fab_vendor_or_assembler",
                "program_or_fixture_revision",
                "limits_revision",
                "calibration_state",
                "lot_or_serial_traceability",
            ],
            "acceptance_checks": [
                "fabrication, assembly, fixture, flying-probe, factory limits, RF calibration, and traceability outputs exist",
                "all output manifests bind to the same routed board revision",
                "factory and production owners sign the release disposition",
            ],
            "placeholder_rejection_signals": [
                "directory-only evidence",
                "empty report",
                "template",
                "presence-only",
                "unvalidated",
            ],
            "release_allowed_by_presence_only": False,
        },
        {
            "id": "local_kicad_cad_traceability",
            "source_report": rel(DEFAULT_KICAD_CAD_TRACEABILITY),
            "status": kicad_cad_traceability["status"],
            "claim_boundary": kicad_cad_traceability["claim_boundary"],
            "footprint_library_count": traceability_summary["footprint_library_count"],
            "pad_audit_record_count": traceability_summary["pad_audit_record_count"],
            "board_bound_instance_count": traceability_summary["board_bound_instance_count"],
            "step_footprint_instance_count": traceability_summary["step_footprint_instance_count"],
            "captured_pinout_file_count": traceability_summary["captured_pinout_file_count"],
            "captured_pinout_declared_pin_count_total": traceability_summary[
                "captured_pinout_declared_pin_count_total"
            ],
            "captured_pinout_public_source_count": traceability_summary[
                "captured_pinout_public_source_count"
            ],
            "cad_connection_count": traceability_summary["cad_connection_count"],
            "cad_connection_terminal_marker_count": traceability_summary[
                "cad_connection_terminal_marker_count"
            ],
            "cad_connection_solid_step_part_count": traceability_summary[
                "cad_connection_solid_step_part_count"
            ],
            "cad_connection_solid_step_part_set_count": traceability_summary[
                "cad_connection_solid_step_part_set_count"
            ],
            "cad_connection_assembly_manifest": (
                routed_cad_connection_assembly["assembly_manifest"]
            ),
            "cad_connection_assembly_manifest_part_count": (
                routed_cad_connection_assembly["assembly_manifest_part_count"]
            ),
            "cad_connection_assembly_manifest_terminal_marker_count": (
                routed_cad_connection_assembly["assembly_manifest_connection_terminal_marker_count"]
            ),
            "cad_connection_assembly_manifest_solid_step_part_count": (
                routed_cad_connection_assembly["assembly_manifest_connection_solid_step_part_count"]
            ),
            "cad_connection_assembly_manifest_missing_solid_step_part_count": (
                routed_cad_connection_assembly[
                    "assembly_manifest_missing_connection_solid_step_part_count"
                ]
            ),
            "cad_connection_assembly_manifest_missing_solid_step_part_names": (
                routed_cad_connection_assembly[
                    "assembly_manifest_missing_connection_solid_step_part_names"
                ]
            ),
            "incomplete_footprint_count": traceability_summary["incomplete_footprint_count"],
            "incomplete_cad_connection_count": traceability_summary[
                "incomplete_cad_connection_count"
            ],
            "missing_captured_pinout_file_count": traceability_summary[
                "missing_captured_pinout_file_count"
            ],
            "incomplete_captured_pinout_detail_count": traceability_summary[
                "incomplete_captured_pinout_detail_count"
            ],
            "release_credit": False,
            "required_content_fields": common_traceability
            + [
                "captured_supplier_pinout_file",
                "footprint_pad_count",
                "board_instance_reference",
                "assigned_pad_net_count",
                "step_envelope_reference",
                "cad_connection_marker_reference",
                "cad_connection_assembly_manifest",
                "release_blocker_preserved",
            ],
            "acceptance_checks": [
                "all development footprint patterns trace through pad/pin audit records, board-bound instances, and STEP visual envelopes",
                "all captured pinout files referenced by the local matrix are present",
                "all CAD connection markers pass the local connection coverage audit",
                "the matrix preserves release_credit=false for local development patterns and generated CAD markers",
            ],
            "placeholder_rejection_signals": [
                "incomplete_footprints",
                "incomplete_cad_connections",
                "missing_captured_pinout_file",
                "release_credit_true_on_local_development_artifact",
            ],
            "release_allowed_by_presence_only": False,
        },
        {
            "id": "first_article_bench_evidence",
            "source_report": rel(DEFAULT_FIRST_ARTICLE_MATRIX),
            "covered_evidence_kinds": first_article_kinds(first_article),
            "covered_matrix_row_count": first_article["summary"]["matrix_row_count"],
            "covered_required_non_template_row_count": first_article["summary"][
                "required_non_template_row_count"
            ],
            "required_content_fields": common_traceability
            + [
                "board_serial",
                "supplier_lot_ids",
                "fixture_id",
                "fixture_calibration_id",
                "test_software_revision",
                "operator",
                "limits_file",
                "measured_results",
                "pass_fail_disposition",
                "waivers",
            ],
            "acceptance_checks": [
                "executed logs replace templates and bind board serial, fixture, limits, operator, and software revision",
                "traveler, probe data, RF/calibration logs, clearance release, and enclosure evidence are signed",
                "any waiver is explicit, owned, and blocks release unless accepted by the release owner",
            ],
            "placeholder_rejection_signals": [
                "template_empty_not_executed",
                "not_run",
                "null board_serial",
                "missing fixture_id",
                "pass/fail omitted",
            ],
            "release_allowed_by_presence_only": False,
        },
        {
            "id": "mechanical_enclosure_evidence",
            "source_report": rel(DEFAULT_MECHANICAL_CAD),
            "covered_review_gates": sorted(mechanical_cad["review_gate_inventory"]),
            "missing_release_ready_evidence_count": mechanical_cad["release_readiness"][
                "missing_required_evidence_count"
            ],
            "cad_output_file_count": mechanical_cad["cad_output_file_counts"][
                "total_files_recursive"
            ],
            "required_content_fields": common_traceability
            + [
                "routed_board_step_revision",
                "supplier_model_revisions",
                "clearance_case_id",
                "measured_clearance_results",
                "fit_sample_serials",
                "process_validation_lot",
                "toolmaker_or_manufacturing_disposition",
            ],
            "acceptance_checks": [
                "routed-board STEP intake is generated from the routed PCB revision, not a concept/demo board",
                "clearance, supplier evidence, physical fit, process validation, solid CAD handoff, and STEP validation gates pass",
                "enclosure review evidence binds measured results to sample serials, supplier model revisions, and owner signoff",
            ],
            "placeholder_rejection_signals": [
                "generated_concept_or_evt0_envelope_not_release_ready",
                "concept",
                "demo",
                "blocked_no_supplier_evidence",
                "blocked_waiting_for_routed_board_step",
            ],
            "release_allowed_by_presence_only": False,
        },
    ]


def build_report(
    supplier_path: Path,
    routed_path: Path,
    first_article_path: Path,
    production_presence_path: Path,
    mechanical_cad_path: Path,
    kicad_cad_traceability_path: Path,
    candidate_manifest_path: Path,
    factory_candidate_manifest_path: Path,
    report_path: Path,
) -> dict[str, Any]:
    supplier = load_yaml(supplier_path)
    routed = load_yaml(routed_path)
    first_article = load_yaml(first_article_path)
    production_presence = load_yaml(production_presence_path)
    mechanical_cad = load_yaml(mechanical_cad_path)
    kicad_cad_traceability = load_yaml(kicad_cad_traceability_path)
    routed_candidate_manifest = load_yaml(candidate_manifest_path)
    factory_candidate_manifest = load_yaml(factory_candidate_manifest_path)
    candidate_manifest = combined_candidate_manifest(
        [candidate_manifest_path, factory_candidate_manifest_path]
    )
    contracts = build_contract_rows(
        supplier,
        routed,
        first_article,
        production_presence,
        mechanical_cad,
        kicad_cad_traceability,
        routed_candidate_manifest,
        factory_candidate_manifest,
    )
    all_rows = all_content_requirement_rows(
        supplier, routed, first_article, production_presence, mechanical_cad
    )
    artifact_rows = [
        row for row in all_rows if row.get("path") not in candidate_paths(candidate_manifest)
    ]
    candidate_rows = candidate_content_requirements(all_rows, candidate_manifest)
    candidate_manifest_paths = candidate_artifact_paths(candidate_manifest)
    all_requirement_paths = {str(row["path"]) for row in all_rows if row.get("path")}
    matched_candidate_manifest_paths = sorted(candidate_manifest_paths & all_requirement_paths)
    unmatched_candidate_manifest_paths = sorted(candidate_manifest_paths - all_requirement_paths)
    template_rows = [row for row in artifact_rows if row["template_only"]]
    routed_cad_connection_assembly = cad_connection_assembly_summary(routed_candidate_manifest)
    factory_cad_connection_assembly = cad_connection_assembly_summary(factory_candidate_manifest)
    return {
        "schema": "eliza.e1_phone_release_evidence_content_contract.v1",
        "status": "blocked_fail_closed_content_contract_only",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Content contract for future supplier, routed-board, production/factory, "
            "and first-article release evidence. This report defines minimum content "
            "requirements and placeholder rejection rules only; it is not evidence "
            "acceptance, not fabrication readiness, not enclosure readiness, and not "
            "end-to-end phone readiness."
        ),
        "inputs": {
            "supplier_return_evidence_acceptance_matrix": rel(supplier_path),
            "routed_board_release_acceptance_matrix": rel(routed_path),
            "first_article_bench_acceptance_matrix": rel(first_article_path),
            "production_factory_required_output_presence_inventory": rel(production_presence_path),
            "mechanical_cad_evidence_inventory": rel(mechanical_cad_path),
            "kicad_cad_traceability_matrix": rel(kicad_cad_traceability_path),
            "local_candidate_manifests": candidate_manifest["manifests"],
            "local_candidate_manifest": rel(candidate_manifest_path),
            "factory_candidate_manifest": rel(factory_candidate_manifest_path),
            "report_path": rel(report_path),
        },
        "summary": {
            "contract_domain_count": len(contracts),
            "supplier_required_evidence_count": supplier["summary"][
                "required_supplier_return_evidence_count"
            ],
            "routed_required_output_path_count": routed["summary"]["required_output_path_count"],
            "production_required_output_path_count": production_presence["summary"][
                "required_output_path_count"
            ],
            "production_manufacturing_closure_release_output_count": (
                production_presence["summary"]["manufacturing_closure_release_output_count"]
            ),
            "production_manufacturing_closure_blocked_candidate_output_file_count": (
                production_presence["summary"][
                    "manufacturing_closure_blocked_candidate_output_file_count"
                ]
            ),
            "production_manufacturing_closure_has_blocked_candidate_outputs": (
                production_presence["summary"][
                    "manufacturing_closure_has_blocked_candidate_outputs"
                ]
            ),
            "first_article_required_non_template_row_count": first_article["summary"][
                "required_non_template_row_count"
            ],
            "mechanical_missing_release_ready_evidence_count": mechanical_cad["release_readiness"][
                "missing_required_evidence_count"
            ],
            "local_kicad_cad_traceability_status": kicad_cad_traceability["status"],
            "local_kicad_cad_footprint_library_count": kicad_cad_traceability["summary"][
                "footprint_library_count"
            ],
            "local_kicad_cad_board_bound_instance_count": kicad_cad_traceability["summary"][
                "board_bound_instance_count"
            ],
            "local_kicad_cad_step_footprint_instance_count": kicad_cad_traceability["summary"][
                "step_footprint_instance_count"
            ],
            "local_kicad_cad_connection_count": kicad_cad_traceability["summary"][
                "cad_connection_count"
            ],
            "local_kicad_cad_connection_terminal_marker_count": kicad_cad_traceability["summary"][
                "cad_connection_terminal_marker_count"
            ],
            "local_kicad_cad_connection_solid_step_part_count": kicad_cad_traceability["summary"][
                "cad_connection_solid_step_part_count"
            ],
            "local_kicad_cad_connection_solid_step_part_set_count": (
                kicad_cad_traceability["summary"]["cad_connection_solid_step_part_set_count"]
            ),
            "local_kicad_cad_connection_assembly_manifest_part_count": (
                routed_cad_connection_assembly["assembly_manifest_part_count"]
            ),
            "local_kicad_cad_connection_assembly_manifest_terminal_marker_count": (
                routed_cad_connection_assembly["assembly_manifest_connection_terminal_marker_count"]
            ),
            "local_kicad_cad_connection_assembly_manifest_solid_step_part_count": (
                routed_cad_connection_assembly["assembly_manifest_connection_solid_step_part_count"]
            ),
            "local_kicad_cad_connection_assembly_manifest_missing_solid_step_part_count": (
                routed_cad_connection_assembly[
                    "assembly_manifest_missing_connection_solid_step_part_count"
                ]
            ),
            "factory_candidate_cad_connection_assembly_manifest_part_count": (
                factory_cad_connection_assembly["assembly_manifest_part_count"]
            ),
            "factory_candidate_cad_connection_assembly_manifest_terminal_marker_count": (
                factory_cad_connection_assembly[
                    "assembly_manifest_connection_terminal_marker_count"
                ]
            ),
            "factory_candidate_cad_connection_assembly_manifest_solid_step_part_count": (
                factory_cad_connection_assembly[
                    "assembly_manifest_connection_solid_step_part_count"
                ]
            ),
            "factory_candidate_cad_connection_assembly_manifest_missing_solid_step_part_count": (
                factory_cad_connection_assembly[
                    "assembly_manifest_missing_connection_solid_step_part_count"
                ]
            ),
            "local_kicad_cad_declared_pin_count_total": kicad_cad_traceability["summary"][
                "captured_pinout_declared_pin_count_total"
            ],
            "local_kicad_cad_pinout_public_source_count": kicad_cad_traceability["summary"][
                "captured_pinout_public_source_count"
            ],
            "local_kicad_cad_incomplete_footprint_count": kicad_cad_traceability["summary"][
                "incomplete_footprint_count"
            ],
            "local_kicad_cad_incomplete_connection_count": kicad_cad_traceability["summary"][
                "incomplete_cad_connection_count"
            ],
            "local_kicad_cad_incomplete_pinout_detail_count": kicad_cad_traceability["summary"][
                "incomplete_captured_pinout_detail_count"
            ],
            "local_kicad_cad_release_credit": bool(
                kicad_cad_traceability["summary"].get("release_credit")
            ),
            "artifact_content_requirement_count": len(artifact_rows),
            "local_candidate_content_requirement_count": len(candidate_rows),
            "local_candidate_manifest_artifact_path_count": len(candidate_manifest_paths),
            "local_candidate_matched_artifact_path_count": len(matched_candidate_manifest_paths),
            "local_candidate_unmatched_artifact_path_count": len(
                unmatched_candidate_manifest_paths
            ),
            "template_content_requirement_count": len(template_rows),
            "validated_artifact_content_requirement_count": 0,
            "content_contract_only": True,
            "release_state": "blocked_fail_closed",
        },
        "content_acceptance_policy": {
            "file_presence_is_sufficient": False,
            "directory_presence_is_sufficient": False,
            "templates_are_release_evidence": False,
            "placeholder_or_tbd_content_is_release_evidence": False,
            "unsigned_or_unreviewed_content_is_release_evidence": False,
            "all_content_contracts_must_pass_before_release": True,
            "supplier_release_allowed": False,
            "routed_board_release_allowed": False,
            "production_factory_release_allowed": False,
            "first_article_release_allowed": False,
            "fabrication_release_allowed": False,
            "enclosure_release_allowed": False,
            "end_to_end_phone_release_allowed": False,
            "local_generated_candidates_are_approval_eligible": False,
            "local_kicad_cad_traceability_is_release_evidence": False,
        },
        "content_contracts": contracts,
        "artifact_content_requirements": artifact_rows,
        "local_candidate_content_requirements": candidate_rows,
        "local_candidate_manifest_coverage": {
            "artifact_paths": sorted(candidate_manifest_paths),
            "matched_artifact_paths": matched_candidate_manifest_paths,
            "unmatched_artifact_paths": unmatched_candidate_manifest_paths,
        },
        "next_unblock_actions": [
            "Collect the missing supplier return packs and bind every returned file to supplier revision and owner disposition.",
            "Route the KiCad board, close ERC/DRC/SI/PI/RF/fab outputs, and bind all reports to the routed PCB hash.",
            "Generate production/factory outputs from the routed board revision, including fixture, limits, calibration, and traceability records.",
            "Replace local KiCad/CAD traceability with supplier-approved land patterns, package STEP, pinout signoff, and production-routed board STEP evidence.",
            "Execute first-article bench logs and traveler on serialized hardware with signed pass/fail disposition.",
            "Replace concept/demo mechanical CAD evidence with routed-board STEP, measured clearance, supplier geometry, and physical process validation.",
        ],
        "forbidden_claims": sorted(
            {
                "fabrication_ready",
                "enclosure_ready",
                "factory_ready",
                "first_article_passed",
                "supplier_pack_complete",
                "routed_pcb_ready",
                "production_ready",
                "end_to_end_phone_ready",
            }
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--supplier-matrix", type=Path, default=DEFAULT_SUPPLIER_MATRIX)
    parser.add_argument("--routed-matrix", type=Path, default=DEFAULT_ROUTED_MATRIX)
    parser.add_argument("--first-article-matrix", type=Path, default=DEFAULT_FIRST_ARTICLE_MATRIX)
    parser.add_argument("--production-presence", type=Path, default=DEFAULT_PRODUCTION_PRESENCE)
    parser.add_argument("--mechanical-cad", type=Path, default=DEFAULT_MECHANICAL_CAD)
    parser.add_argument(
        "--kicad-cad-traceability",
        type=Path,
        default=DEFAULT_KICAD_CAD_TRACEABILITY,
    )
    parser.add_argument("--candidate-manifest", type=Path, default=DEFAULT_CANDIDATE_MANIFEST)
    parser.add_argument(
        "--factory-candidate-manifest",
        type=Path,
        default=DEFAULT_FACTORY_CANDIDATE_MANIFEST,
    )
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--write-report", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(
        args.supplier_matrix,
        args.routed_matrix,
        args.first_article_matrix,
        args.production_presence,
        args.mechanical_cad,
        args.kicad_cad_traceability,
        args.candidate_manifest,
        args.factory_candidate_manifest,
        args.report,
    )
    output = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False, width=100)
    if args.write_report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output, encoding="utf-8")
    else:
        print(output, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
