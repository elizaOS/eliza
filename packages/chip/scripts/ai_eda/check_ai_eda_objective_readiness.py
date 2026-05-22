#!/usr/bin/env python3
"""Validate AI-EDA objective readiness audit reports."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/objective_readiness/validation/objective_readiness.json"
EXPECTED_SCHEMA = "eliza.ai_eda.objective_readiness.v1"
EXPECTED_CLAIM_BOUNDARY = "objective_readiness_audit_only_no_completion_or_release_claim"
REQUIRED_REQUIREMENTS = {
    "research_doc",
    "current_research_watchlist",
    "training_data_handoff",
    "own_model_training_and_inference",
    "cuda_machine_ready_handoff",
    "large_cuda_training",
    "alphachip_or_successor_reproduction",
    "candidate_replay_queue",
    "openlane_openroad_replay_prerequisites",
    "meaningful_e1_optimization_demo",
    "verification_analysis_optimization_lanes",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def validate_artifact(item: dict[str, Any], label: str) -> list[str]:
    errors: list[str] = []
    path_value = item.get("path")
    status = item.get("status")
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}.path must be present"]
    if status not in {"PRESENT", "MISSING"}:
        errors.append(f"{label}.status is invalid")
    path = repo_path(path_value)
    if status == "PRESENT":
        if not path.is_file():
            errors.append(f"{label}.path missing on disk")
        elif item.get("sha256") != sha256_file(path):
            errors.append(f"{label}.sha256 is stale")
    return errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("status") not in {"COMPLETE_READY", "INCOMPLETE_WITH_BLOCKERS"}:
        errors.append("unsupported status")
    if (
        report.get("status") != "COMPLETE_READY"
        and report.get("completion_claim_allowed") is not False
    ):
        errors.append("completion_claim_allowed must be false unless status is COMPLETE_READY")

    evidence_run_ids = report.get("evidence_run_ids")
    if not isinstance(evidence_run_ids, dict):
        errors.append("evidence_run_ids must be a mapping")
    else:
        for field in (
            "readiness",
            "evidence_bundle",
            "training_handoff",
            "training_corpus",
            "research",
            "replay_prerequisites",
            "replay_preflight",
            "replay_handoff",
            "replay_execution",
            "replay_comparison",
            "alphachip",
            "alphachip_successor",
            "alphachip_successor_reproduction",
            "full_training_matrix",
        ):
            if not isinstance(evidence_run_ids.get(field), str) or not evidence_run_ids[field]:
                errors.append(f"evidence_run_ids.{field} must be non-empty")

    requirements = report.get("requirements")
    if not isinstance(requirements, list) or not requirements:
        return errors + ["requirements must be a non-empty list"]
    ids = {req.get("id") for req in requirements if isinstance(req, dict)}
    missing = sorted(REQUIRED_REQUIREMENTS - ids)
    if missing:
        errors.append(f"missing requirements: {', '.join(missing)}")
    if len(ids) != len(requirements):
        errors.append("requirement ids must be unique and present")
    proven_count = 0
    blocker_count = 0
    for index, req in enumerate(requirements):
        if not isinstance(req, dict):
            errors.append(f"requirements[{index}] must be a mapping")
            continue
        status = req.get("status")
        if status not in {"PROVEN", "INCOMPLETE", "BLOCKED"}:
            errors.append(f"{req.get('id')}: unsupported status {status!r}")
        if status == "PROVEN":
            proven_count += 1
        blockers = req.get("blockers")
        if status != "PROVEN" and (not isinstance(blockers, list) or not blockers):
            errors.append(f"{req.get('id')}: non-proven requirement must list blockers")
        if isinstance(blockers, list):
            blocker_count += len(blockers)
        evidence = req.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            errors.append(f"{req.get('id')}: evidence must be a non-empty list")
        else:
            for artifact_index, artifact in enumerate(evidence):
                if not isinstance(artifact, dict):
                    errors.append(f"{req.get('id')}.evidence[{artifact_index}] must be a mapping")
                    continue
                errors.extend(
                    validate_artifact(artifact, f"{req.get('id')}.evidence[{artifact_index}]")
                )
    summary = report.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
    else:
        if summary.get("requirement_count") != len(requirements):
            errors.append("summary.requirement_count mismatch")
        if summary.get("proven_count") != proven_count:
            errors.append("summary.proven_count mismatch")
        if summary.get("blocker_count") != blocker_count:
            errors.append("summary.blocker_count mismatch")
    blockers = report.get("blockers")
    if report.get("status") == "INCOMPLETE_WITH_BLOCKERS" and not blockers:
        errors.append("incomplete report must list blockers")
    if isinstance(blockers, list) and len(blockers) != blocker_count:
        errors.append("top-level blockers count must match requirement blockers")
    actions = report.get("next_required_actions")
    if not isinstance(actions, list) or len(actions) < 3:
        errors.append("next_required_actions must list concrete follow-up work")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.objective_readiness missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.objective_readiness {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.objective_readiness {error}")
        return 1
    status = "PASS" if report["status"] == "COMPLETE_READY" else "PASS_WITH_BLOCKERS"
    summary = report["summary"]
    print(
        "STATUS: "
        f"{status} ai_eda.objective_readiness "
        f"status={report['status']} proven={summary['proven_count']}/{summary['requirement_count']} "
        f"blockers={summary['blocker_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
