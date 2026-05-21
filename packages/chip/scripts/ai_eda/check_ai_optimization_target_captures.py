#!/usr/bin/env python3
"""Validate broad AI-EDA optimization target-capture reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

EXPECTED_REPORTS = {
    "current_research_watchlist": {
        "path": "build/ai_eda/current_research_watchlist/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.current_research_watchlist.v1",
        "claim_boundary": "current_research_watchlist_capture_only_no_import_training_inference_or_e1_claim",
        "status_prefix": "TARGET_CAPTURE_ONLY_",
    },
    "circuit_foundation_model": {
        "path": "build/ai_eda/circuit_foundation_model_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.circuit_foundation_model_targets.v1",
        "claim_boundary": "circuit_foundation_model_target_capture_only_no_training_embedding_or_claim",
        "status_prefix": "TARGET_CAPTURE_ONLY_",
    },
    "eda_tool_agent_interop": {
        "path": "build/ai_eda/eda_tool_agent_interop_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.eda_tool_agent_interop_targets.v1",
        "claim_boundary": "eda_tool_agent_interop_capture_only_no_tool_invocation_or_source_change",
        "status_prefix": "TARGET_CAPTURE_ONLY_",
    },
    "dfm_yield_lithography": {
        "path": "build/ai_eda/dfm_yield_lithography_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.dfm_yield_lithography_targets.v1",
        "claim_boundary": "dfm_yield_lithography_target_capture_only_no_mask_yield_or_release_claim",
        "status_prefix": "TARGET_CAPTURE_ONLY_",
    },
    "low_power_intent": {
        "path": "build/ai_eda/low_power_intent_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.low_power_intent_targets.v1",
        "claim_boundary": "low_power_intent_target_capture_only_no_power_intent_or_rtl_change",
        "status_prefix": "TARGET_CAPTURE_ONLY_",
    },
    "post_silicon_validation": {
        "path": "build/ai_eda/post_silicon_validation_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.post_silicon_validation_targets.v1",
        "claim_boundary": "post_silicon_validation_target_capture_only_no_silicon_or_lab_claim",
        "status_prefix": "TARGET_CAPTURE_ONLY_",
    },
    "hardware_security": {
        "path": "build/ai_eda/hardware_security_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.hardware_security_targets.v1",
        "claim_boundary": "hardware_security_target_capture_only_no_vulnerability_or_trojan_claim",
        "status_prefix": "TARGET_CAPTURE_ONLY_",
    },
}

FORBIDDEN_POLICY_TRUE_KEYS = {
    "changes_rtl",
    "changes_source",
    "changes_constraints",
    "changes_pd_config",
    "changes_layout",
    "changes_masks",
    "changes_opc",
    "changes_pdk_rules",
    "changes_training_data",
    "generates_embeddings",
    "generates_layout",
    "generates_mask",
    "generates_rtl",
    "generates_shell",
    "generates_tcl",
    "generates_testbench",
    "generates_constraints",
    "generates_waivers",
    "runs_inference",
    "runs_llm",
    "runs_ml_model",
    "runs_synthesis",
    "runs_place_and_route",
    "runs_signoff",
    "runs_simulation",
    "runs_drc",
    "runs_lvs",
    "runs_lithography_sim",
    "runs_opc",
    "trains_model",
    "finetunes_model",
    "downloads_external_assets",
    "downloads_model_weights",
    "calls_external_api",
    "starts_mcp_server",
    "executes_agent",
    "invokes_open_source_eda",
    "invokes_commercial_eda",
    "imports_external_corpus",
    "imports_foundry_data",
    "prediction_generated",
    "release_use_allowed",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def report_path(name: str, run_id: str) -> Path:
    return ROOT / EXPECTED_REPORTS[name]["path"].format(run_id=run_id)


def validate_policy(name: str, data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    policy = data.get("policy")
    if not isinstance(policy, dict) or not policy:
        return [f"{name}: policy must be a non-empty mapping"]
    for key, value in policy.items():
        if key.endswith("_allowed") and value is not False:
            errors.append(f"{name}: policy.{key} must be false")
        if key in FORBIDDEN_POLICY_TRUE_KEYS and value is not False:
            errors.append(f"{name}: policy.{key} must be false")
    if policy.get("release_use_allowed") is not False:
        errors.append(f"{name}: policy.release_use_allowed must be false")
    return errors


def validate_artifacts(name: str, data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    artifacts = data.get("input_artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        return [f"{name}: input_artifacts must be a non-empty list"]
    present = 0
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            errors.append(f"{name}: input_artifacts[{index}] must be a mapping")
            continue
        path = artifact.get("path")
        status = artifact.get("status")
        if not isinstance(path, str) or not path:
            errors.append(f"{name}: input_artifacts[{index}].path must be non-empty")
        if status not in {"PRESENT", "MISSING"}:
            errors.append(f"{name}: input_artifacts[{index}].status must be PRESENT or MISSING")
        if status == "PRESENT":
            present += 1
            if not isinstance(artifact.get("sha256"), str) or len(artifact["sha256"]) != 64:
                errors.append(f"{name}: input_artifacts[{index}] present artifact needs sha256")
    if present == 0:
        errors.append(f"{name}: at least one input artifact must be present")
    return errors


def validate_candidate_tasks(name: str, data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    tasks = data.get("candidate_tasks")
    if not isinstance(tasks, list) or not tasks:
        return [f"{name}: candidate_tasks must be a non-empty list"]
    seen: set[str] = set()
    for index, task in enumerate(tasks):
        if not isinstance(task, dict):
            errors.append(f"{name}: candidate_tasks[{index}] must be a mapping")
            continue
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id:
            errors.append(f"{name}: candidate_tasks[{index}].id must be non-empty")
        elif task_id in seen:
            errors.append(f"{name}: duplicate candidate task id {task_id}")
        else:
            seen.add(task_id)
        status = task.get("status")
        if not isinstance(status, str) or not status.startswith("CAPTURED_"):
            errors.append(f"{name}: candidate_tasks[{index}].status must start with CAPTURED_")
        if not isinstance(task.get("target"), str) or not task["target"]:
            errors.append(f"{name}: candidate_tasks[{index}].target must be non-empty")
        gates = task.get("acceptance_gates")
        if (
            not isinstance(gates, list)
            or not gates
            or not all(isinstance(gate, str) and gate for gate in gates)
        ):
            errors.append(
                f"{name}: candidate_tasks[{index}].acceptance_gates must be non-empty strings"
            )
    return errors


def validate_optional_backends(name: str, data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    backends = data.get("optional_backends")
    if not isinstance(backends, dict):
        return [f"{name}: optional_backends must be a mapping"]
    for field in ("commands", "python_modules"):
        entries = backends.get(field)
        if not isinstance(entries, list) or not entries:
            errors.append(f"{name}: optional_backends.{field} must be a non-empty list")
            continue
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                errors.append(f"{name}: optional_backends.{field}[{index}] must be a mapping")
                continue
            if entry.get("status") not in {"PRESENT", "MISSING"}:
                errors.append(
                    f"{name}: optional_backends.{field}[{index}].status must be PRESENT or MISSING"
                )
    return errors


def validate_report(name: str, data: dict[str, Any]) -> list[str]:
    expected = EXPECTED_REPORTS[name]
    errors: list[str] = []
    if data.get("schema") != expected["schema"]:
        errors.append(f"{name}: schema mismatch")
    if data.get("claim_boundary") != expected["claim_boundary"]:
        errors.append(f"{name}: claim_boundary mismatch")
    if data.get("mode") != "dry-run":
        errors.append(f"{name}: mode must be dry-run")
    status = data.get("status")
    if not isinstance(status, str) or not status.startswith(expected["status_prefix"]):
        errors.append(f"{name}: status must start with {expected['status_prefix']}")
    if not isinstance(data.get("source_ids"), list) or not data["source_ids"]:
        errors.append(f"{name}: source_ids must be non-empty")
    blocked_by = data.get("blocked_by")
    if not isinstance(blocked_by, list) or not blocked_by:
        errors.append(f"{name}: blocked_by must be non-empty")
    errors.extend(validate_policy(name, data))
    errors.extend(validate_artifacts(name, data))
    errors.extend(validate_candidate_tasks(name, data))
    errors.extend(validate_optional_backends(name, data))
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--report", action="append", choices=sorted(EXPECTED_REPORTS), default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    names = args.report or sorted(EXPECTED_REPORTS)
    errors: list[str] = []
    validated = 0
    total_tasks = 0
    for name in names:
        path = report_path(name, args.run_id)
        if not path.is_file():
            errors.append(f"{name}: missing report {rel(path)}")
            continue
        try:
            data = load_json(path)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
            continue
        report_errors = validate_report(name, data)
        if report_errors:
            errors.extend(report_errors)
            continue
        validated += 1
        total_tasks += len(data.get("candidate_tasks", []))
        print(f"STATUS: PASS ai_eda.ai_optimization_target {name} {rel(path)}")
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.ai_optimization_target_captures {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.ai_optimization_target_captures "
        f"reports={validated} candidate_tasks={total_tasks} run_id={args.run_id}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
