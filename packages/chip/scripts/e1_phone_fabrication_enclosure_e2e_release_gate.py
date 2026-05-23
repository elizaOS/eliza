#!/usr/bin/env python3
"""Generate the fail-closed E1 phone fabrication/enclosure/e2e release gate."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
BOARD_ROOT = ROOT / "board/kicad/e1-phone"
MECH_REVIEW = ROOT / "mechanical/e1-phone/review"
REPORT_DATE = "2026-05-22"

DEFAULT_CONTENT_CONTRACT = (
    BOARD_ROOT / "production/readiness/release-evidence-content-contract-2026-05-22.yaml"
)
DEFAULT_VALIDATION_DRY_RUN = (
    BOARD_ROOT / "production/readiness/release-evidence-validation-dry-run-2026-05-22.yaml"
)
DEFAULT_ROUTED_MATRIX = (
    BOARD_ROOT / "production/readiness/routed-board-release-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_FIRST_ARTICLE_MATRIX = (
    BOARD_ROOT
    / "production/test/readiness/e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_PRODUCTION_PRESENCE = (
    BOARD_ROOT
    / "production/readiness/production-factory-required-output-presence-inventory-2026-05-22.yaml"
)
DEFAULT_MECHANICAL_CAD = MECH_REVIEW / "mechanical-cad-evidence-inventory-2026-05-22.yaml"
DEFAULT_END_TO_END = BOARD_ROOT / "end-to-end-readiness.yaml"
DEFAULT_OBJECTIVE_AUDIT = BOARD_ROOT / "e1-phone-objective-completion-audit-2026-05-22.yaml"
DEFAULT_BOARD_STEP = MECH_REVIEW / "board-step-readiness.json"
DEFAULT_ROUTED_CLEARANCE = MECH_REVIEW / "routed-board-clearance.json"
DEFAULT_REPORT = (
    BOARD_ROOT / "production/readiness/fabrication-enclosure-e2e-release-gate-2026-05-22.yaml"
)


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected YAML mapping")
    return data


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected JSON object")
    return data


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def blocked_source(status: str | None) -> bool:
    return str(status or "").startswith("blocked")


def gate_row(
    gate_id: str,
    allowed_flag: str,
    source_reports: list[str],
    blockers: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "id": gate_id,
        allowed_flag: False,
        "release_allowed": False,
        "status": "blocked_fail_closed",
        "source_reports": source_reports,
        "blocker_count": len(blockers),
        "blockers": blockers,
        "required_clearance": [
            "all source reports are non-blocked",
            "all required artifacts are present",
            "all content rows are validated, non-template, non-presence-only, and approved",
            "routed PCB, routed STEP, mechanical clearance, factory outputs, first article, and end-to-end decision agree",
        ],
    }


def source_blocker(source: str, metric: str, value: Any, required: Any, reason: str) -> dict[str, Any]:
    return {
        "source": source,
        "metric": metric,
        "current_value": value,
        "required_value": required,
        "reason": reason,
    }


def build_report(
    content_path: Path,
    validation_path: Path,
    routed_path: Path,
    first_article_path: Path,
    production_path: Path,
    mechanical_path: Path,
    end_to_end_path: Path,
    objective_path: Path,
    board_step_path: Path,
    routed_clearance_path: Path,
    report_path: Path,
) -> dict[str, Any]:
    content = load_yaml(content_path)
    validation = load_yaml(validation_path)
    routed = load_yaml(routed_path)
    first_article = load_yaml(first_article_path)
    production = load_yaml(production_path)
    mechanical = load_yaml(mechanical_path)
    end_to_end = load_yaml(end_to_end_path)
    objective = load_yaml(objective_path)
    board_step = load_json(board_step_path)
    routed_clearance = load_json(routed_clearance_path)

    content_summary = content["summary"]
    validation_summary = validation["summary"]
    routed_summary = routed["summary"]
    first_summary = first_article["summary"]
    production_summary = production["summary"]
    mechanical_release = mechanical["release_readiness"]
    e2e_decision = end_to_end["release_decision"]
    objective_summary = objective["summary"]

    content_blockers = [
        source_blocker(
            rel(content_path),
            "validated_artifact_content_requirement_count",
            content_summary["validated_artifact_content_requirement_count"],
            content_summary["artifact_content_requirement_count"],
            "no release evidence row is validated and approved yet",
        ),
        source_blocker(
            rel(content_path),
            "template_content_requirement_count",
            content_summary["template_content_requirement_count"],
            0,
            "template artifacts still appear in the required evidence surface",
        ),
        source_blocker(
            rel(validation_path),
            "blocked_row_count",
            validation_summary["blocked_row_count"],
            0,
            "dry-run validator rejects all missing, template, presence-only, unapproved, or placeholder evidence rows",
        ),
    ]

    fabrication_blockers = content_blockers + [
        source_blocker(
            rel(routed_path),
            "missing_required_output_path_count",
            routed_summary["missing_required_output_path_count"],
            0,
            "routed board, ERC/DRC, SI/PI/RF, fab, assembly, and STEP outputs are not complete",
        ),
        source_blocker(
            rel(routed_path),
            "missing_validation_evidence_category_count",
            routed_summary["missing_validation_evidence_category_count"],
            0,
            "routed validation evidence categories are still missing",
        ),
        source_blocker(
            rel(production_path),
            "missing_required_output_path_count",
            production_summary["missing_required_output_path_count"],
            0,
            "production/factory output package is absent",
        ),
        source_blocker(
            rel(end_to_end_path),
            "ready_to_fabricate",
            e2e_decision["ready_to_fabricate"],
            True,
            "end-to-end readiness still forbids fabrication release",
        ),
        source_blocker(
            rel(objective_path),
            "fabrication_ready",
            objective_summary["fabrication_ready"],
            True,
            "objective audit records fabrication readiness as incomplete",
        ),
    ]

    enclosure_blockers = content_blockers + [
        source_blocker(
            rel(mechanical_path),
            "missing_required_evidence_count",
            mechanical_release["missing_required_evidence_count"],
            0,
            "routed-board STEP, supplier geometry, clearance, physical fit, and process evidence are missing",
        ),
        source_blocker(
            rel(board_step_path),
            "status",
            board_step["status"],
            "pass",
            "mechanical review has no routed-board STEP intake",
        ),
        source_blocker(
            rel(routed_clearance_path),
            "status",
            routed_clearance["status"],
            "pass",
            "mechanical review has no routed-board clearance rerun",
        ),
        source_blocker(
            rel(end_to_end_path),
            "ready_for_enclosure",
            e2e_decision["ready_for_enclosure"],
            True,
            "end-to-end readiness still forbids enclosure release",
        ),
        source_blocker(
            rel(objective_path),
            "enclosure_ready",
            objective_summary["enclosure_ready"],
            True,
            "objective audit records enclosure readiness as incomplete",
        ),
    ]

    factory_first_article_blockers = content_blockers + [
        source_blocker(
            rel(production_path),
            "missing_required_output_path_count",
            production_summary["missing_required_output_path_count"],
            0,
            "factory outputs, fixture, limits, calibration, and traceability are absent",
        ),
        source_blocker(
            rel(first_article_path),
            "missing_required_non_template_row_count",
            first_summary["missing_required_non_template_row_count"],
            0,
            "executed bench logs and first-article traveler are missing",
        ),
        source_blocker(
            rel(first_article_path),
            "template_row_count",
            first_summary["template_row_count"],
            0,
            "template-only first-article records cannot unlock release",
        ),
        source_blocker(
            rel(end_to_end_path),
            "ready_for_factory_test",
            e2e_decision["ready_for_factory_test"],
            True,
            "end-to-end readiness still forbids factory-test release",
        ),
    ]

    end_to_end_blockers = content_blockers + [
        source_blocker(
            rel(objective_path),
            "blocked_requirement_count",
            objective_summary["blocked_requirement_count"],
            0,
            "objective audit still has blocked fabrication, enclosure, and end-to-end requirements",
        ),
        source_blocker(
            rel(end_to_end_path),
            "end_to_end_phone_ready",
            e2e_decision["end_to_end_phone_ready"],
            True,
            "end-to-end readiness decision remains false",
        ),
    ]

    gates = [
        gate_row(
            "fabrication_release",
            "fabrication_release_allowed",
            [
                rel(content_path),
                rel(validation_path),
                rel(routed_path),
                rel(production_path),
                rel(end_to_end_path),
                rel(objective_path),
            ],
            fabrication_blockers,
        ),
        gate_row(
            "enclosure_release",
            "enclosure_release_allowed",
            [
                rel(content_path),
                rel(validation_path),
                rel(mechanical_path),
                rel(board_step_path),
                rel(routed_clearance_path),
                rel(end_to_end_path),
                rel(objective_path),
            ],
            enclosure_blockers,
        ),
        gate_row(
            "factory_first_article",
            "factory_first_article_allowed",
            [
                rel(content_path),
                rel(validation_path),
                rel(production_path),
                rel(first_article_path),
                rel(end_to_end_path),
            ],
            factory_first_article_blockers,
        ),
        gate_row(
            "end_to_end_phone_release",
            "end_to_end_release_allowed",
            [rel(content_path), rel(validation_path), rel(end_to_end_path), rel(objective_path)],
            end_to_end_blockers,
        ),
    ]

    return {
        "schema": "eliza.e1_phone_fabrication_enclosure_e2e_release_gate.v1",
        "status": "blocked_fail_closed",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Top-level release gate for E1 phone fabrication, enclosure, factory first-article, "
            "and end-to-end phone readiness. This report only aggregates existing fail-closed "
            "evidence and cannot create supplier, routed PCB, mechanical, factory, bench, or "
            "release approval evidence."
        ),
        "inputs": {
            "release_evidence_content_contract": rel(content_path),
            "release_evidence_validation_dry_run": rel(validation_path),
            "routed_board_release_acceptance_matrix": rel(routed_path),
            "first_article_bench_acceptance_matrix": rel(first_article_path),
            "production_factory_required_output_presence_inventory": rel(production_path),
            "mechanical_cad_evidence_inventory": rel(mechanical_path),
            "end_to_end_readiness": rel(end_to_end_path),
            "objective_completion_audit": rel(objective_path),
            "board_step_readiness": rel(board_step_path),
            "routed_board_clearance": rel(routed_clearance_path),
            "report_path": rel(report_path),
        },
        "summary": {
            "release_gate_count": len(gates),
            "open_release_gate_count": 0,
            "blocked_release_gate_count": len(gates),
            "fabrication_release_allowed": False,
            "enclosure_release_allowed": False,
            "factory_first_article_allowed": False,
            "end_to_end_release_allowed": False,
            "total_blocker_count": sum(gate["blocker_count"] for gate in gates),
            "release_state": "blocked_fail_closed",
        },
        "release_gates": gates,
        "hard_stop_conditions": [
            "source status starts with blocked",
            "missing required routed or factory output count is nonzero",
            "required artifact content is template-only, presence-only, unvalidated, or unapproved",
            "board STEP intake uses concept/demo evidence instead of routed-board evidence",
            "routed-board clearance rerun is missing",
            "first-article transcript or traveler is missing",
            "supplier-returned geometry, drawings, and traceability are absent or unvalidated",
        ],
        "forbidden_claims": [
            "fabrication_ready",
            "enclosure_ready",
            "factory_ready",
            "first_article_passed",
            "end_to_end_phone_ready",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--content-contract", type=Path, default=DEFAULT_CONTENT_CONTRACT)
    parser.add_argument("--validation-dry-run", type=Path, default=DEFAULT_VALIDATION_DRY_RUN)
    parser.add_argument("--routed-matrix", type=Path, default=DEFAULT_ROUTED_MATRIX)
    parser.add_argument("--first-article-matrix", type=Path, default=DEFAULT_FIRST_ARTICLE_MATRIX)
    parser.add_argument("--production-presence", type=Path, default=DEFAULT_PRODUCTION_PRESENCE)
    parser.add_argument("--mechanical-cad", type=Path, default=DEFAULT_MECHANICAL_CAD)
    parser.add_argument("--end-to-end", type=Path, default=DEFAULT_END_TO_END)
    parser.add_argument("--objective-audit", type=Path, default=DEFAULT_OBJECTIVE_AUDIT)
    parser.add_argument("--board-step", type=Path, default=DEFAULT_BOARD_STEP)
    parser.add_argument("--routed-clearance", type=Path, default=DEFAULT_ROUTED_CLEARANCE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--write-report", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(
        args.content_contract,
        args.validation_dry_run,
        args.routed_matrix,
        args.first_article_matrix,
        args.production_presence,
        args.mechanical_cad,
        args.end_to_end,
        args.objective_audit,
        args.board_step,
        args.routed_clearance,
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
