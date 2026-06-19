#!/usr/bin/env python3
"""Validate macro-placement replay preflight reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/macro_placement_replay_preflight/validation/replay_preflight_report.json"
)
CLAIM_BOUNDARY = "macro_placement_replay_preflight_only_no_ppa_signoff_or_release_claim"
ALLOWED_STATUS = {
    "READY_TO_EXECUTE",
    "BLOCKED_REPLAY_EXECUTION",
    "EXECUTED_OPENLANE_REPLAY_UNVERIFIED",
}
REQUIRED_FALSE_CLAIM_FLAGS = (
    "claim_allowed",
    "release_claim_allowed",
    "training_claim_allowed",
    "inference_claim_allowed",
    "e1_signoff_claim_allowed",
    "ppa_signoff_claim_allowed",
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def validate_false_claim_flags(report: dict[str, Any]) -> list[str]:
    return [
        f"{field} must be false"
        for field in REQUIRED_FALSE_CLAIM_FLAGS
        if report.get(field) is not False
    ]


def validate_artifacts(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    artifacts = report.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        return ["artifacts must be a non-empty list"]
    required = {
        "candidate_path",
        "placement_case_path",
        "tool_action_manifest",
        "bundle_dir",
        "macro_placement_cfg",
        "placement_overrides",
    }
    seen = {item.get("kind") for item in artifacts if isinstance(item, dict)}
    missing = sorted(required - seen)
    if missing:
        errors.append(f"missing artifact kinds: {', '.join(missing)}")
    for item in artifacts:
        if not isinstance(item, dict):
            errors.append("artifact entries must be mappings")
            continue
        path_value = item.get("path")
        if not isinstance(path_value, str) or not path_value:
            errors.append(f"{item.get('kind')}: missing path")
            continue
        if item.get("exists") is not True:
            errors.append(f"{item.get('kind')}: artifact is not present: {path_value}")
            continue
        path = repo_path(path_value)
        if not path.exists():
            errors.append(f"{item.get('kind')}: path missing on disk: {path_value}")
        if path.is_file() and not isinstance(item.get("sha256"), str):
            errors.append(f"{item.get('kind')}: file artifact missing sha256")
    return errors


def validate_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.macro_placement_replay_preflight.v1":
        errors.append("schema mismatch")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    errors.extend(validate_false_claim_flags(report))
    if report.get("status") not in ALLOWED_STATUS:
        errors.append(f"unsupported status {report.get('status')!r}")
    if not isinstance(report.get("candidate_id"), str) or not report["candidate_id"]:
        errors.append("candidate_id is required")
    if (
        not isinstance(report.get("source_replay_plan"), str)
        or not repo_path(report["source_replay_plan"]).exists()
    ):
        errors.append("source_replay_plan must point at an existing replay plan")
    errors.extend(validate_artifacts(report))
    tools = report.get("tool_status")
    if not isinstance(tools, dict):
        errors.append("tool_status must be a mapping")
    else:
        for field in ("openlane_available", "openroad_available", "openlane_config_exists"):
            if not isinstance(tools.get(field), bool):
                errors.append(f"tool_status.{field} must be boolean")
    execution = report.get("execution")
    if not isinstance(execution, dict):
        errors.append("execution must be a mapping")
    elif execution.get("attempted") is True and not isinstance(execution.get("returncode"), int):
        errors.append("attempted execution requires integer returncode")
    blockers = report.get("blockers")
    if report.get("status") == "BLOCKED_REPLAY_EXECUTION" and not blockers:
        errors.append("blocked replay preflight must list blockers")
    if report.get("status") == "READY_TO_EXECUTE" and blockers:
        errors.append("ready replay preflight must not list blockers")
    gates = report.get("next_required_gates")
    if not isinstance(gates, list) or len(gates) < 3:
        errors.append("next_required_gates must list replay/signoff follow-up gates")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.exists():
        print(f"STATUS: FAIL ai_eda.macro_placement_replay_preflight missing_report {args.report}")
        return 1
    try:
        report = load_json(args.report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.macro_placement_replay_preflight {rel(args.report)}: {exc}")
        return 1
    errors = validate_report(report)
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_placement_replay_preflight {error}")
        return 1
    status = "PASS_BLOCKED" if report["status"] == "BLOCKED_REPLAY_EXECUTION" else "PASS"
    print(
        f"STATUS: {status} ai_eda.macro_placement_replay_preflight "
        f"candidate={report['candidate_id']} status={report['status']} "
        f"claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
