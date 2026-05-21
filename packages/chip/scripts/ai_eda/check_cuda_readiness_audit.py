#!/usr/bin/env python3
"""Validate CUDA handoff readiness audit reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
EXPECTED_SCHEMA = "eliza.ai_eda.cuda_readiness_audit.v1"
EXPECTED_CLAIM_BOUNDARY = "cuda_readiness_audit_only_no_training_inference_signoff_or_release_claim"
FORBIDDEN_TRUE_POLICY = {
    "runs_training",
    "runs_inference",
    "runs_openlane",
    "downloads_assets",
    "downloads_model_weights",
    "release_use_allowed",
    "signoff_claim_allowed",
    "optimization_claim_allowed",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must contain a JSON object")
    return data


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("status") not in {"READY_FOR_CUDA_EXECUTION", "PASS_WITH_BLOCKERS_RECORDED"}:
        errors.append("unexpected status")
    evidence_run_ids = report.get("evidence_run_ids")
    if not isinstance(evidence_run_ids, dict):
        errors.append("evidence_run_ids must be a mapping")
    else:
        for field in (
            "preflight",
            "payload",
            "run_plan_execution",
            "run_plan_safety_matrix",
            "full_training_matrix",
            "alphachip_checkpoint",
            "alphachip_successor_plan",
            "alphachip_successor_reproduction",
            "current_research_watchlist",
            "replay_preflight",
            "replay_prerequisites",
            "replay_execution",
            "replay_comparison",
            "setup_check",
            "training_handoff",
        ):
            if not isinstance(evidence_run_ids.get(field), str) or not evidence_run_ids[field]:
                errors.append(f"evidence_run_ids.{field} must be non-empty")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for key in FORBIDDEN_TRUE_POLICY:
            if policy.get(key) is not False:
                errors.append(f"policy.{key} must be false")
    capabilities = report.get("capabilities")
    if not isinstance(capabilities, dict):
        errors.append("capabilities must be a mapping")
    else:
        for field in (
            "payload_handoff_ready",
            "run_plan_dry_run_validated",
            "run_plan_safety_matrix_validated",
            "full_training_matrix_validated",
            "full_training_matrix_ready",
            "large_cuda_training_ready",
            "alphachip_checkpoint_available",
            "alphachip_successor_plan_validated",
            "alphachip_successor_cuda_scale_ready",
            "alphachip_successor_reproduction_validated",
            "alphachip_successor_reproduced",
            "current_research_watchlist_captured",
            "e1_openlane_replay_ready",
            "openlane_replay_execution_validated",
            "openlane_replay_comparison_validated",
            "setup_check_bootstrap_complete",
            "training_handoff_bootstrap_complete",
            "torch_training_validated",
            "torch_inference_validated",
            "full_replay_plan_validated",
            "replay_queue_validated",
            "openlane_replay_prerequisites_validated",
            "openlane_replay_host_ready",
            "training_handoff_payload_ready",
        ):
            if not isinstance(capabilities.get(field), bool):
                errors.append(f"capabilities.{field} must be boolean")
    artifacts = report.get("input_artifacts")
    if not isinstance(artifacts, list) or len(artifacts) < 5:
        errors.append("input_artifacts must include the core handoff reports")
    else:
        present = 0
        for index, artifact in enumerate(artifacts):
            if not isinstance(artifact, dict):
                errors.append(f"input_artifacts[{index}] must be a mapping")
                continue
            if artifact.get("status") not in {"PRESENT", "MISSING"}:
                errors.append(f"input_artifacts[{index}].status is invalid")
            if artifact.get("status") == "PRESENT":
                present += 1
                if not isinstance(artifact.get("sha256"), str) or len(artifact["sha256"]) != 64:
                    errors.append(f"input_artifacts[{index}] present artifact needs sha256")
        if present < 3:
            errors.append("at least three core handoff artifacts must be present")
    blockers = report.get("blockers")
    if report.get("status") == "PASS_WITH_BLOCKERS_RECORDED" and (  # noqa: SIM102
        not isinstance(blockers, list) or not blockers
    ):
        errors.append("blocked readiness audit must list blockers")
        if not isinstance(blockers, list) or not blockers:
            errors.append("blocked readiness audit must list blockers")
    if isinstance(blockers, list):
        for index, blocker in enumerate(blockers):
            if not isinstance(blocker, dict):
                errors.append(f"blockers[{index}] must be a mapping")
                continue
            if blocker.get("severity") not in {"hard", "soft"}:
                errors.append(f"blockers[{index}].severity must be hard or soft")
            if not isinstance(blocker.get("id"), str) or not blocker["id"]:
                errors.append(f"blockers[{index}].id must be non-empty")
            if not isinstance(blocker.get("detail"), str) or not blocker["detail"]:
                errors.append(f"blockers[{index}].detail must be non-empty")
    actions = report.get("next_required_actions")
    if not isinstance(actions, list) or len(actions) < 3:
        errors.append("next_required_actions must list concrete follow-up work")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.cuda_readiness_audit_check missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.cuda_readiness_audit_check {exc}")
        return 1
    errors = validate(report)
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.cuda_readiness_audit_check {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.cuda_readiness_audit_check "
        f"status={report['status']} blockers={len(report.get('blockers', []))} report={rel(args.report)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
