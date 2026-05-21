#!/usr/bin/env python3
"""Validate a CUDA run-plan execution manifest."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/cuda_run_plan_execution/validation/cuda_run_plan_execution.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.cuda_run_plan_execution.v1"
EXPECTED_CLAIM_BOUNDARY = (
    "cuda_run_plan_execution_manifest_no_unreviewed_training_inference_or_eda_claim"
)
REQUIRED_STAGES = {
    "asset_intake",
    "audit",
    "bootstrap",
    "conversion",
    "corpus_manifest",
    "inference",
    "preflight",
    "rag",
    "replay",
    "target_capture",
    "training",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} root must be a mapping")
    return data


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("mode") not in {"dry-run", "execute"}:
        errors.append("mode must be dry-run or execute")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        if policy.get("dry_run_default") is not True:
            errors.append("policy.dry_run_default must be true")
        if report.get("mode") == "dry-run" and policy.get("runs_commands") is not False:
            errors.append("dry-run manifest must not run commands")
        if report.get("mode") == "dry-run" and policy.get("downloads_assets") is not False:
            errors.append("dry-run manifest must not download assets")
        for field in ("runs_openlane", "release_use_allowed"):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        for field in ("runs_training", "runs_inference", "downloads_assets"):
            if not isinstance(policy.get(field), bool):
                errors.append(f"policy.{field} must be boolean")
    safety = report.get("execution_safety")
    if not isinstance(safety, dict):
        errors.append("execution_safety must be a mapping")
    else:
        if safety.get("execute_requires_stage_selection") is not True:
            errors.append("execution_safety.execute_requires_stage_selection must be true")
        if not isinstance(safety.get("selected_stages"), list):
            errors.append("execution_safety.selected_stages must be a list")
        for field in (
            "allow_downloads",
            "allow_training",
            "allow_inference",
            "allow_replay",
            "allow_alphachip",
        ):
            if not isinstance(safety.get(field), bool):
                errors.append(f"execution_safety.{field} must be boolean")
        if not isinstance(safety.get("orchestration_commands_skipped"), int):
            errors.append("execution_safety.orchestration_commands_skipped must be an integer")
        if not isinstance(safety.get("blocked_command_count"), int):
            errors.append("execution_safety.blocked_command_count must be an integer")
    commands = report.get("commands")
    if not isinstance(commands, list) or not commands:
        return errors + ["commands must be a non-empty list"]
    if report.get("command_count") != len(commands):
        errors.append("command_count mismatch")
    stage_counts = report.get("stage_counts")
    if not isinstance(stage_counts, dict):
        errors.append("stage_counts must be a mapping")
    else:
        missing = REQUIRED_STAGES - set(stage_counts)
        if missing:
            errors.append(f"missing required stages: {', '.join(sorted(missing))}")
        if sum(int(count) for count in stage_counts.values()) != len(commands):
            errors.append("stage_counts must sum to command_count")
    template_count = 0
    selected_count = 0
    orchestration_count = 0
    executed_count = 0
    blocked_count = 0
    for index, item in enumerate(commands):
        if not isinstance(item, dict):
            errors.append(f"commands[{index}] must be a mapping")
            continue
        if item.get("index") != index:
            errors.append(f"commands[{index}].index mismatch")
        for field in ("stage", "original", "expanded", "status"):
            if not isinstance(item.get(field), str) or not item[field]:
                errors.append(f"commands[{index}].{field} must be non-empty")
        if "<cuda-host>" in str(item.get("expanded")) or "<run-id>" in str(item.get("expanded")):
            errors.append(f"commands[{index}] has unresolved run-id placeholder")
        if item.get("template") is True:
            template_count += 1
            if item.get("status") != "SKIPPED_TEMPLATE_COMMAND":
                errors.append(f"commands[{index}] template command must be skipped")
        if item.get("orchestration_command") is True:
            orchestration_count += 1
            if item.get("status") != "SKIPPED_ORCHESTRATION_COMMAND":
                errors.append(f"commands[{index}] orchestration command must be skipped")
        if (
            item.get("selected") is True
            and item.get("template") is not True
            and item.get("orchestration_command") is not True
        ):
            selected_count += 1
        if item.get("status") == "EXECUTED":
            executed_count += 1
            if "execution" not in item:
                errors.append(f"commands[{index}] executed command must include execution result")
        if item.get("status") == "BLOCKED_REQUIRES_EXPLICIT_ALLOW":
            blocked_count += 1
            if not isinstance(item.get("blocked_reason"), str) or not item["blocked_reason"]:
                errors.append(f"commands[{index}] blocked command must include blocked_reason")
        if report.get("mode") == "dry-run" and "execution" in item:
            errors.append(f"commands[{index}] dry-run command must not include execution result")
    if report.get("template_command_count") != template_count:
        errors.append("template_command_count mismatch")
    if report.get("selected_command_count") != selected_count:
        errors.append("selected_command_count mismatch")
    if report.get("executed_command_count") != executed_count:
        errors.append("executed_command_count mismatch")
    if (
        isinstance(safety, dict)
        and safety.get("orchestration_commands_skipped") != orchestration_count
    ):
        errors.append("execution_safety.orchestration_commands_skipped mismatch")
    if isinstance(safety, dict) and safety.get("blocked_command_count") != blocked_count:
        errors.append("execution_safety.blocked_command_count mismatch")
    outputs = report.get("expected_outputs")
    if not isinstance(outputs, list) or not outputs:
        errors.append("expected_outputs must be non-empty")
    elif any("<run-id>" in str(output) or "<cuda-host>" in str(output) for output in outputs):
        errors.append("expected_outputs contain unresolved placeholders")
    if report.get("failures") != 0:
        errors.append("failures must be zero")
    if report.get("blocked") != 0:
        errors.append("blocked must be zero")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.cuda_run_plan_execution missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.cuda_run_plan_execution {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.cuda_run_plan_execution {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.cuda_run_plan_execution "
        f"mode={report['mode']} commands={report['command_count']} selected={report['selected_command_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
