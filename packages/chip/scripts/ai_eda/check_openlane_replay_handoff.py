#!/usr/bin/env python3
"""Validate OpenLane replay handoff manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/openlane_replay_handoff/validation/openlane_replay_handoff.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.openlane_replay_handoff.v1"
EXPECTED_CLAIM_BOUNDARY = "openlane_replay_handoff_only_no_openlane_execution_or_release_claim"
REQUIRED_ARTIFACTS = {
    "replay_plan",
    "replay_queue",
    "replay_preflight",
    "openlane_config",
    "pd_host_runbook",
    "pd_host_command_script",
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


def validate_artifact(label: str, entry: Any) -> list[str]:
    if not isinstance(entry, dict):
        return [f"{label} must be a mapping"]
    errors: list[str] = []
    path_value = entry.get("path")
    if entry.get("required") is True and entry.get("status") != "PRESENT":
        errors.append(f"{label} is required but missing")
    if entry.get("status") not in {"PRESENT", "MISSING"}:
        errors.append(f"{label}.status is invalid")
    if entry.get("status") == "PRESENT":
        if not isinstance(path_value, str) or not path_value:
            errors.append(f"{label}.path must be present")
        else:
            path = repo_path(path_value)
            if not path.is_file():
                errors.append(f"{label}.path missing on disk")
            elif entry.get("sha256") != sha256_file(path):
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
    if report.get("optimization_claim_allowed") is not False:
        errors.append("optimization_claim_allowed must remain false for handoff-only evidence")
    if report.get("status") not in {"HANDOFF_READY_FOR_PD_HOST", "BLOCKED_HANDOFF"}:
        errors.append("unsupported status")
    if report.get("status") == "HANDOFF_READY_FOR_PD_HOST" and report.get("blockers"):
        errors.append("ready handoff must not list blockers")
    if report.get("status") == "BLOCKED_HANDOFF" and not report.get("blockers"):
        errors.append("blocked handoff must list blockers")
    if (
        not isinstance(report.get("ready_candidate_count"), int)
        or report["ready_candidate_count"] < 1
    ):
        errors.append("ready_candidate_count must be at least one")
    for field in ("pd_host_runbook", "pd_host_command_script"):
        value = report.get(field)
        if not isinstance(value, str) or not value:
            errors.append(f"{field} must be present")
        elif not repo_path(value).is_file():
            errors.append(f"{field} missing on disk")
    baseline_openlane_command = report.get("baseline_openlane_command")
    if (
        not isinstance(baseline_openlane_command, str)
        or "openlane" not in baseline_openlane_command
        or "config.sky130.json" not in baseline_openlane_command
    ):
        errors.append("baseline_openlane_command must run the checked-in E1 OpenLane config")
    baseline_capture = report.get("baseline_capture_execution_command")
    if (
        not isinstance(baseline_capture, str)
        or "capture_openlane_replay_execution.py" not in baseline_capture
        or "--replay-role baseline" not in baseline_capture
    ):
        errors.append("baseline_capture_execution_command must capture baseline execution")
    elif "--replay-queue" in baseline_capture or "--replay-preflight" in baseline_capture:
        errors.append("baseline capture command must not require candidate replay queue/preflight")
    candidates = report.get("ready_candidates")
    if not isinstance(candidates, list) or len(candidates) != report.get("ready_candidate_count"):
        errors.append("ready_candidates count mismatch")
    else:
        for index, candidate in enumerate(candidates, start=1):
            if not isinstance(candidate, dict):
                errors.append(f"ready_candidates[{index}] must be a mapping")
                continue
            if not isinstance(candidate.get("candidate_id"), str) or not candidate["candidate_id"]:
                errors.append(f"ready_candidates[{index}].candidate_id missing")
            command = candidate.get("capture_execution_command")
            if (
                not isinstance(command, str)
                or "capture_openlane_replay_execution.py" not in command
            ):
                errors.append(f"ready_candidates[{index}] missing execution capture command")
            elif "--replay-handoff" not in command:
                errors.append(
                    f"ready_candidates[{index}] execution command must pass --replay-handoff"
                )
            openlane_command = candidate.get("openlane_replay_command")
            if not isinstance(openlane_command, str) or "openlane" not in openlane_command:
                errors.append(f"ready_candidates[{index}] missing OpenLane command template")
            if (
                not isinstance(candidate.get("macro_placement_cfg"), str)
                or not candidate["macro_placement_cfg"]
            ):
                errors.append(f"ready_candidates[{index}].macro_placement_cfg missing")
    artifacts = report.get("artifacts")
    if not isinstance(artifacts, dict) or not artifacts:
        errors.append("artifacts must be a non-empty mapping")
    else:
        missing_artifacts = sorted(REQUIRED_ARTIFACTS - set(artifacts))
        if missing_artifacts:
            errors.append(f"missing handoff artifacts: {', '.join(missing_artifacts)}")
        for label, entry in artifacts.items():
            errors.extend(validate_artifact(label, entry))
    package_path = report.get("package_path")
    if not isinstance(package_path, str):
        errors.append("package_path missing")
    else:
        path = repo_path(package_path)
        if not path.is_file():
            errors.append("package tarball missing on disk")
        elif report.get("package_sha256") != sha256_file(path):
            errors.append("package_sha256 is stale")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.openlane_replay_handoff missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.openlane_replay_handoff {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.openlane_replay_handoff {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.openlane_replay_handoff "
        f"status={report['status']} ready={report['ready_candidate_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
