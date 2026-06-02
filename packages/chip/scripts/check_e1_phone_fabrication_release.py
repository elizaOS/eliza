#!/usr/bin/env python3
"""Fail-closed release gate for E1 phone fabrication/enclosure/e2e readiness."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE_PATH = (
    ROOT / "board/kicad/e1-phone/production/readiness/"
    "fabrication-enclosure-e2e-release-gate-2026-05-22.yaml"
)
EXPECTED_SCHEMA = "eliza.e1_phone_fabrication_enclosure_e2e_release_gate.v1"
REPORT = ROOT / "build/reports/e1_phone_fabrication_release.json"
REPORT_SCHEMA = "eliza.e1_phone_fabrication_release.v1"
VALIDATION_COMMAND = "python3 scripts/check_e1_phone_fabrication_release.py"
CLAIM_BOUNDARY = "release_gate_blocker_report_only_not_release_evidence"
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "fabrication_release_claim_allowed": False,
    "enclosure_release_claim_allowed": False,
    "factory_first_article_claim_allowed": False,
    "end_to_end_release_claim_allowed": False,
    "board_fabrication_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
RELEASE_FLAGS = (
    "fabrication_release_allowed",
    "enclosure_release_allowed",
    "factory_first_article_allowed",
    "end_to_end_release_allowed",
)


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing release gate report: {path.relative_to(ROOT)}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must be a YAML mapping")
    return data


def validate_report(report: dict[str, Any]) -> tuple[bool, str | None, int, Any, Any]:
    if report.get("schema") != EXPECTED_SCHEMA:
        raise ValueError(f"unexpected schema: {report.get('schema')!r}")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        raise ValueError("summary must be a mapping")
    release_gates = report.get("release_gates")
    if not isinstance(release_gates, list) or not release_gates:
        raise ValueError("release_gates must be a non-empty list")
    local_progress = report.get("local_non_release_progress")
    if not isinstance(local_progress, dict):
        raise ValueError("local_non_release_progress must be a mapping")
    expected_routed_step_progress = {
        "routed_step_candidate_footprint_envelope_count": 89,
        "routed_step_candidate_pad_contact_visual_count": 1452,
        "routed_step_candidate_route_segment_visual_count": 306,
    }
    for key, expected in expected_routed_step_progress.items():
        if local_progress.get(key) != expected:
            raise ValueError(
                f"local_non_release_progress.{key} must be {expected}, "
                f"got {local_progress.get(key)!r}"
            )
    if local_progress.get("routed_step_candidate_release_credit") is not False:
        raise ValueError("local routed STEP candidate must not receive release credit")

    blocked_gate_count = summary.get("blocked_release_gate_count")
    total_blockers = summary.get("total_blocker_count")
    unique_blockers = summary.get("unique_blocker_count", total_blockers)
    release_state = summary.get("release_state")
    allowed = [summary.get(flag) is True for flag in RELEASE_FLAGS]
    gate_blockers = 0
    for index, gate in enumerate(release_gates):
        if not isinstance(gate, dict):
            raise ValueError(f"release_gates[{index}] must be a mapping")
        gate_id = gate.get("id", f"release_gates[{index}]")
        if gate.get("release_allowed") is True:
            if gate.get("status") not in {"pass", "release_ready", "approved"}:
                raise ValueError(
                    f"{gate_id} release_allowed=true but status is {gate.get('status')!r}"
                )
            if gate.get("blocker_count") not in {0, None}:
                raise ValueError(
                    f"{gate_id} release_allowed=true with blocker_count={gate.get('blocker_count')!r}"
                )
        else:
            gate_blockers += 1
        blockers = gate.get("blockers")
        if gate.get("release_allowed") is True and blockers:
            raise ValueError(f"{gate_id} release_allowed=true but blockers are present")
        if gate.get("status") == "blocked_fail_closed" and gate.get("release_allowed") is True:
            raise ValueError(f"{gate_id} blocked status contradicts release_allowed=true")
    if gate_blockers != blocked_gate_count:
        raise ValueError(
            "summary blocked_release_gate_count does not match release_gates: "
            f"summary={blocked_gate_count} gates={gate_blockers}"
        )
    return (
        all(allowed) and blocked_gate_count == 0 and total_blockers == 0,
        release_state,
        blocked_gate_count,
        total_blockers,
        unique_blockers,
    )


def blocked_gate_inventory(report: dict[str, Any]) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    for gate in report.get("release_gates", []):
        if not isinstance(gate, dict) or gate.get("release_allowed") is True:
            continue
        gate_id = str(gate.get("id") or "unknown_gate")
        owner = {
            "fabrication_release": "layout_fabrication",
            "enclosure_release": "mechanical",
            "factory_first_article": "manufacturing_validation",
            "end_to_end_release": "release_owner",
        }.get(gate_id, "release_owner")
        for blocker in gate.get("blockers") or []:
            if not isinstance(blocker, dict):
                continue
            inventory.append(
                {
                    "gate": gate_id,
                    "owner": owner,
                    "source": blocker.get("source"),
                    "evidence_path": blocker.get("source"),
                    "metric": blocker.get("metric"),
                    "current_value": blocker.get("current_value"),
                    "required_value": blocker.get("required_value"),
                    "reason": blocker.get("reason"),
                    "blocker_category": release_blocker_category(blocker),
                    "action": (
                        "Resolve the source report metric to its required value with real "
                        "approved evidence, then rerun the fabrication release gate."
                    ),
                    "validation_command": VALIDATION_COMMAND,
                }
            )
    return inventory


def release_blocker_category(blocker: dict[str, Any]) -> str:
    metric = str(blocker.get("metric") or "").lower()
    source = str(blocker.get("source") or "").lower()
    reason = str(blocker.get("reason") or "").lower()
    current = blocker.get("current_value")
    required = blocker.get("required_value")
    text = f"{metric} {source} {reason}"
    if "supplier" in text or "sourcing" in text:
        return "external_supplier_dependency"
    if metric.startswith("missing_required") and current != required:
        return "true_missing_artifact"
    if "validated_artifact_content_requirement_count" in metric or "blocked_row_count" in metric:
        return "missing_approval_metadata"
    if (
        "template" in metric
        or "candidate" in metric
        or "non_release_present" in metric
        or str(current).lower().startswith("blocked")
        or "placeholder" in text
        or "not release evidence" in text
    ):
        return "present_blocked_placeholder"
    if str(current).lower() in {"false", "none", "0"} and str(required).lower() == "true":
        return "external_supplier_dependency"
    return "present_blocked_placeholder"


def blocker_diagnostics(inventory: list[dict[str, Any]]) -> dict[str, Any]:
    by_gate = Counter(str(item.get("gate") or "unknown_gate") for item in inventory)
    by_owner = Counter(str(item.get("owner") or "release_owner") for item in inventory)
    by_source = Counter(str(item.get("source") or "unknown_source") for item in inventory)
    by_metric = Counter(str(item.get("metric") or "unknown_metric") for item in inventory)
    by_category = Counter(
        str(item.get("blocker_category") or "present_blocked_placeholder") for item in inventory
    )
    missing_sources_by_owner: dict[str, list[str]] = {}
    categorized_paths: dict[str, list[str]] = {}
    for item in inventory:
        owner = str(item.get("owner") or "release_owner")
        source = item.get("source")
        if isinstance(source, str) and source:
            missing_sources_by_owner.setdefault(owner, []).append(source)
            category = str(item.get("blocker_category") or "present_blocked_placeholder")
            categorized_paths.setdefault(category, []).append(source)
    return {
        "blocked_by_gate": dict(sorted(by_gate.items())),
        "blocked_by_owner": dict(sorted(by_owner.items())),
        "blocked_by_source": dict(sorted(by_source.items())),
        "blocked_by_metric": dict(sorted(by_metric.items())),
        "fabrication_release_blocker_categories": {
            "true_missing_artifacts": by_category.get("true_missing_artifact", 0),
            "present_blocked_placeholders": by_category.get("present_blocked_placeholder", 0),
            "missing_approval_metadata": by_category.get("missing_approval_metadata", 0),
            "external_supplier_dependencies": by_category.get("external_supplier_dependency", 0),
        },
        "categorized_source_inventory": {
            category: sorted(dict.fromkeys(paths))
            for category, paths in sorted(categorized_paths.items())
        },
        "missing_sources_by_owner": {
            owner: sorted(dict.fromkeys(sources))
            for owner, sources in sorted(missing_sources_by_owner.items())
        },
        "next_unblock_groups": [
            {
                "id": "fabrication_and_enclosure_release_evidence",
                "owner": "layout_fabrication",
                "blocked_rows": by_gate.get("fabrication_release", 0)
                + by_gate.get("enclosure_release", 0),
                "required_action": (
                    "collect approved routed PCB fabrication outputs, supplier geometry, "
                    "clearance, enclosure fit, and process validation evidence"
                ),
                "validation_command": VALIDATION_COMMAND,
            },
            {
                "id": "factory_first_article_release_evidence",
                "owner": "manufacturing_validation",
                "blocked_rows": by_gate.get("factory_first_article", 0),
                "required_action": (
                    "collect factory package outputs and executed first-article evidence "
                    "before enabling factory-test release"
                ),
                "validation_command": VALIDATION_COMMAND,
            },
            {
                "id": "approval_metadata_release_evidence",
                "owner": "release_owner",
                "blocked_rows": by_category.get("missing_approval_metadata", 0),
                "required_action": (
                    "replace dry-run/placeholder rows with approved, reviewed release "
                    "records and rerun approval-signature and fabrication release gates"
                ),
                "validation_command": "python3 scripts/check_e1_phone_release_approval_signatures.py && "
                + VALIDATION_COMMAND,
            },
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fail-closed release gate for E1 phone fabrication/enclosure/e2e readiness."
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=REPORT,
        help="JSON report path to write.",
    )
    return parser.parse_args()


def write_report(
    status: str,
    *,
    report_path: Path,
    release_state: str | None,
    blocked_gate_count: int,
    total_blockers: int,
    unique_blockers: int | None = None,
    finding: str | None = None,
    blocked_inventory: list[dict[str, Any]] | None = None,
) -> None:
    findings = []
    if finding:
        findings.append(
            {
                "code": "e1_phone_fabrication_release_blocked",
                "evidence": GATE_PATH.relative_to(ROOT).as_posix(),
                "message": finding,
                "next_step": "make e1-phone-fabrication-release-check",
                "severity": "blocker" if status == "blocked" else "info",
            }
        )
    diagnostics = blocker_diagnostics(blocked_inventory or [])
    category_counts = diagnostics["fabrication_release_blocker_categories"]
    report = {
        "schema": REPORT_SCHEMA,
        "status": status,
        "generated_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "summary": {
            "release_ready": status == "pass",
            "release_state": release_state,
            "blocked_release_gate_count": blocked_gate_count,
            "total_blocker_count": total_blockers,
            "blocker_instance_count": total_blockers,
            "unique_blocker_count": unique_blockers
            if unique_blockers is not None
            else total_blockers,
            "blockers": len(findings),
            "fabrication_release_blocker_categories": category_counts,
        },
        "findings": findings,
        "blocked_evidence_inventory": blocked_inventory or [],
        "blocker_dependency_counts": {
            "repo_artifact_generation": category_counts["true_missing_artifacts"],
            "live_device_validation": 0,
            "actionable_external_dependency": max(
                0,
                total_blockers - category_counts["true_missing_artifacts"],
            ),
        },
        "next_command_by_dependency": {
            "actionable_external_dependency": [VALIDATION_COMMAND],
            **(
                {"repo_artifact_generation": [VALIDATION_COMMAND]}
                if category_counts["true_missing_artifacts"] > 0
                else {}
            ),
        },
        "validation_commands": [VALIDATION_COMMAND],
        "primary_blocker": {
            "dependency": "actionable_external_dependency"
            if category_counts["true_missing_artifacts"] < total_blockers
            else "repo_artifact_generation",
            "blocked_rows": total_blockers,
            "required_action": (
                "Close the child fabrication, supplier, routed, factory, first-article, "
                "enclosure, and approval gates, then rerun the fabrication release gate."
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        "blocker_diagnostics": diagnostics,
        "next_unblock_groups": diagnostics["next_unblock_groups"],
        "next_unblock_actions": (blocked_inventory or [])[:20],
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    args = parse_args()
    try:
        report = load_yaml_mapping(GATE_PATH)
        (
            pass_state,
            release_state,
            blocked_gate_count,
            total_blockers,
            unique_blockers,
        ) = validate_report(report)
        blocked_inventory = blocked_gate_inventory(report)
        if pass_state:
            write_report(
                "pass",
                report_path=args.report,
                release_state=release_state,
                blocked_gate_count=blocked_gate_count,
                total_blockers=total_blockers,
                unique_blockers=unique_blockers,
                blocked_inventory=[],
            )
            print("STATUS: PASS E1 phone fabrication/enclosure/e2e release gate")
            return 0

        write_report(
            "blocked",
            report_path=args.report,
            release_state=release_state,
            blocked_gate_count=blocked_gate_count,
            total_blockers=total_blockers,
            unique_blockers=unique_blockers,
            blocked_inventory=blocked_inventory,
            finding=(
                "E1 phone fabrication/enclosure/end-to-end release remains blocked "
                "by missing release evidence."
            ),
        )
        print(
            "STATUS: BLOCKED E1 phone fabrication/enclosure/e2e release gate "
            f"state={release_state} blocked_gates={blocked_gate_count} "
            f"blockers={total_blockers} unique_blockers={unique_blockers}"
        )
        return 2
    except ValueError as exc:
        write_report(
            "fail",
            report_path=args.report,
            release_state=None,
            blocked_gate_count=0,
            total_blockers=1,
            unique_blockers=1,
            finding=f"E1 phone fabrication release gate invalid: {exc}",
        )
        print(f"FAIL: E1 phone fabrication release gate invalid: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
