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
    BOARD_ROOT
    / "production/sourcing/readiness/"
    "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_ROUTED_MATRIX = (
    BOARD_ROOT
    / "production/readiness/routed-board-release-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_FIRST_ARTICLE_MATRIX = (
    BOARD_ROOT
    / "production/test/readiness/e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_PRODUCTION_PRESENCE = (
    BOARD_ROOT
    / "production/readiness/"
    "production-factory-required-output-presence-inventory-2026-05-22.yaml"
)
DEFAULT_MECHANICAL_CAD = (
    ROOT / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"
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
    return path.relative_to(ROOT).as_posix()


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
    return sorted(rows, key=lambda item: (item["category"], item["evidence_id"], str(item["path"])))


def build_contract_rows(
    supplier: dict[str, Any],
    routed: dict[str, Any],
    first_article: dict[str, Any],
    production_presence: dict[str, Any],
    mechanical_cad: dict[str, Any],
) -> list[dict[str, Any]]:
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
                "TBD",
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
    report_path: Path,
) -> dict[str, Any]:
    supplier = load_yaml(supplier_path)
    routed = load_yaml(routed_path)
    first_article = load_yaml(first_article_path)
    production_presence = load_yaml(production_presence_path)
    mechanical_cad = load_yaml(mechanical_cad_path)
    contracts = build_contract_rows(
        supplier, routed, first_article, production_presence, mechanical_cad
    )
    artifact_rows = artifact_content_requirements(
        supplier, routed, first_article, production_presence, mechanical_cad
    )
    template_rows = [row for row in artifact_rows if row["template_only"]]
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
            "production_factory_required_output_presence_inventory": rel(
                production_presence_path
            ),
            "mechanical_cad_evidence_inventory": rel(mechanical_cad_path),
            "report_path": rel(report_path),
        },
        "summary": {
            "contract_domain_count": len(contracts),
            "supplier_required_evidence_count": supplier["summary"][
                "required_supplier_return_evidence_count"
            ],
            "routed_required_output_path_count": routed["summary"][
                "required_output_path_count"
            ],
            "production_required_output_path_count": production_presence["summary"][
                "required_output_path_count"
            ],
            "first_article_required_non_template_row_count": first_article["summary"][
                "required_non_template_row_count"
            ],
            "mechanical_missing_release_ready_evidence_count": mechanical_cad[
                "release_readiness"
            ]["missing_required_evidence_count"],
            "artifact_content_requirement_count": len(artifact_rows),
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
        },
        "content_contracts": contracts,
        "artifact_content_requirements": artifact_rows,
        "next_unblock_actions": [
            "Collect the missing supplier return packs and bind every returned file to supplier revision and owner disposition.",
            "Route the KiCad board, close ERC/DRC/SI/PI/RF/fab outputs, and bind all reports to the routed PCB hash.",
            "Generate production/factory outputs from the routed board revision, including fixture, limits, calibration, and traceability records.",
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
