#!/usr/bin/env python3
"""Validate AI-EDA physical-design target-capture reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

EXPECTED_REPORTS = {
    "timing_closure": {
        "path": "build/ai_eda/timing_closure_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.timing_closure_targets.v1",
        "claim_boundary": "timing_closure_target_capture_only_no_constraint_or_eco_change",
        "artifact_fields": ("timing_report_artifacts",),
    },
    "routing_congestion": {
        "path": "build/ai_eda/routing_congestion_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.routing_congestion_targets.v1",
        "claim_boundary": "routing_congestion_target_capture_only_no_route_or_layout_change",
        "artifact_fields": ("routing_artifacts",),
    },
    "placement_legalization": {
        "path": "build/ai_eda/placement_legalization_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.placement_legalization_targets.v1",
        "claim_boundary": "placement_legalization_target_capture_only_no_placement_or_pd_change",
        "artifact_fields": ("placement_artifacts",),
    },
    "physical_verification": {
        "path": "build/ai_eda/physical_verification_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.physical_verification_targets.v1",
        "claim_boundary": "physical_verification_capture_only_no_drc_lvs_or_layout_claim",
        "artifact_fields": ("physical_verification_artifacts",),
    },
}


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


def validate_input_artifacts(report_id: str, report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    artifacts = report.get("input_artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        return [f"{report_id}: input_artifacts must be a non-empty list"]
    present = 0
    for index, artifact in enumerate(artifacts):
        label = f"{report_id}: input_artifacts[{index}]"
        if not isinstance(artifact, dict):
            errors.append(f"{label}: must be a mapping")
            continue
        path_value = artifact.get("path")
        status = artifact.get("status")
        if not isinstance(path_value, str) or not path_value:
            errors.append(f"{label}: path is required")
        if status == "PRESENT":
            present += 1
            sha = artifact.get("sha256")
            if not isinstance(sha, str) or len(sha) != 64:
                errors.append(f"{label}: PRESENT artifact requires a 64-character sha256")
            if isinstance(path_value, str) and not repo_path(path_value).is_file():
                errors.append(f"{label}: PRESENT artifact is missing on disk")
        elif status != "MISSING":
            errors.append(f"{label}: status must be PRESENT or MISSING")
    if present == 0:
        errors.append(f"{report_id}: at least one input artifact must be present")
    return errors


def validate_optional_commands(report_id: str, report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    commands = report.get("optional_commands")
    if not isinstance(commands, list) or not commands:
        return [f"{report_id}: optional_commands must be a non-empty list"]
    for index, command in enumerate(commands):
        label = f"{report_id}: optional_commands[{index}]"
        if not isinstance(command, dict):
            errors.append(f"{label}: must be a mapping")
            continue
        if not isinstance(command.get("command"), str) or not command["command"]:
            errors.append(f"{label}: command is required")
        status = command.get("status")
        if status not in {"PRESENT", "MISSING"}:
            errors.append(f"{label}: status must be PRESENT or MISSING")
        path = command.get("path")
        if status == "PRESENT" and not isinstance(path, str):
            errors.append(f"{label}: PRESENT command requires path")
    return errors


def validate_candidate_items(report_id: str, report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    items = report.get("candidate_tasks")
    if items is None:
        items = report.get("candidate_actions")
    if not isinstance(items, list) or not items:
        return [f"{report_id}: candidate_tasks/actions must be a non-empty list"]
    seen: set[str] = set()
    for index, item in enumerate(items):
        label = f"{report_id}: candidate[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label}: must be a mapping")
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            errors.append(f"{label}: id is required")
        elif item_id in seen:
            errors.append(f"{label}: duplicate id {item_id}")
        else:
            seen.add(item_id)
        status = str(item.get("status", ""))
        if not status.startswith("CAPTURED_"):
            errors.append(f"{label}: status must start with CAPTURED_")
        if not isinstance(item.get("target"), str) or not item["target"]:
            errors.append(f"{label}: target is required")
        gates = item.get("acceptance_gates")
        if not isinstance(gates, list) or not gates:
            errors.append(f"{label}: acceptance_gates must be non-empty")
    return errors


def validate_report_artifacts(
    report_id: str, report: dict[str, Any], expected: dict[str, Any]
) -> list[str]:
    errors: list[str] = []
    latest_run = report.get("latest_openlane_run")
    if latest_run is not None and (not isinstance(latest_run, str) or not latest_run):
        errors.append(f"{report_id}: latest_openlane_run must be null or non-empty string")
    for field in expected["artifact_fields"]:
        artifacts = report.get(field)
        if not isinstance(artifacts, list):
            errors.append(f"{report_id}: {field} must be a list")
            continue
        for index, artifact in enumerate(artifacts):
            label = f"{report_id}: {field}[{index}]"
            if not isinstance(artifact, dict):
                errors.append(f"{label}: must be a mapping")
                continue
            path_value = artifact.get("path")
            if not isinstance(path_value, str) or not path_value:
                errors.append(f"{label}: path is required")
            elif not repo_path(path_value).is_file():
                errors.append(f"{label}: artifact is missing on disk")
            sha = artifact.get("sha256")
            if not isinstance(sha, str) or len(sha) != 64:
                errors.append(f"{label}: sha256 must be a 64-character digest")
    return errors


def validate_policy(report_id: str, report: dict[str, Any]) -> list[str]:
    policy = report.get("policy")
    if not isinstance(policy, dict) or not policy:
        return [f"{report_id}: policy must be a non-empty mapping"]
    errors: list[str] = []
    for field, value in policy.items():
        if value is not False:
            errors.append(f"{report_id}: policy.{field} must be false")
    for required in (
        "prediction_generated",
        "release_use_allowed",
    ):
        if policy.get(required) is not False:
            errors.append(f"{report_id}: policy.{required} is required and must be false")
    if not any(
        str(field).endswith("claim_allowed") and value is False for field, value in policy.items()
    ):
        errors.append(f"{report_id}: policy must include at least one false *_claim_allowed field")
    return errors


def validate_report(report_id: str, report: dict[str, Any], expected: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != expected["schema"]:
        errors.append(f"{report_id}: schema mismatch")
    if report.get("claim_boundary") != expected["claim_boundary"]:
        errors.append(f"{report_id}: claim_boundary mismatch")
    if report.get("mode") != "dry-run":
        errors.append(f"{report_id}: mode must be dry-run")
    if "TARGET_CAPTURE_ONLY" not in str(report.get("status", "")):
        errors.append(f"{report_id}: status must be target-capture-only")
    if not isinstance(report.get("source_ids"), list) or not report.get("source_ids"):
        errors.append(f"{report_id}: source_ids must be non-empty")
    if not isinstance(report.get("blocked_by"), list) or not report.get("blocked_by"):
        errors.append(f"{report_id}: blocked_by must be non-empty")
    errors.extend(validate_policy(report_id, report))
    errors.extend(validate_input_artifacts(report_id, report))
    errors.extend(validate_optional_commands(report_id, report))
    errors.extend(validate_candidate_items(report_id, report))
    errors.extend(validate_report_artifacts(report_id, report, expected))
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--report", action="append", type=Path, default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    paths = args.report or [
        repo_path(item["path"].format(run_id=args.run_id)) for item in EXPECTED_REPORTS.values()
    ]
    expected_by_schema = {
        item["schema"]: (report_id, item) for report_id, item in EXPECTED_REPORTS.items()
    }
    errors: list[str] = []
    validated = 0
    for path in paths:
        if not path.exists():
            errors.append(f"missing report {rel(path)}")
            continue
        try:
            report = load_json(path)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{rel(path)}: {exc}")
            continue
        schema = str(report.get("schema", ""))
        if schema not in expected_by_schema:
            errors.append(f"{rel(path)}: unsupported schema {schema!r}")
            continue
        report_id, expected = expected_by_schema[schema]
        errors.extend(validate_report(report_id, report, expected))
        validated += 1
    if validated != len(paths):
        errors.append("not all requested physical-design target reports were validated")
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.physical_design_target_captures {error}")
        return 1
    print(
        f"STATUS: PASS ai_eda.physical_design_target_captures reports={validated} run_id={args.run_id}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
