#!/usr/bin/env python3
"""Validate dry-run RTL model evaluation manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/rtl_model_eval/validation/eval_report.json"
EXPECTED_SCHEMA = "eliza.ai_eda.rtl_model_eval.report.v1"
EXPECTED_CLAIM_BOUNDARY = "generated_rtl_artifact_only_not_source_or_release_evidence"
REQUIRED_MODELS = {
    "rtl-coder",
    "openllm-rtl",
    "verigen-codegen-verilog",
    "origen-verilog",
    "verireason-rtl-grpo",
    "deepv-verilog-rag",
    "chipcraftx-rtlgen-7b",
    "chipseek",
    "circuitmind-tcbench",
    "rtlseek",
    "qimeng-codev-r1",
    "qimeng-crux",
    "qimeng-salv",
    "evolve-verilog",
    "veriagent",
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


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("mode") != "dry-run":
        errors.append("mode must remain dry-run")
    if report.get("status") != "DRY_RUN_NO_MODEL_EXECUTION":
        errors.append("status must be DRY_RUN_NO_MODEL_EXECUTION")
    plan_value = report.get("plan")
    if not isinstance(plan_value, str) or not plan_value:
        errors.append("plan must be present")
    else:
        plan_path = repo_path(plan_value)
        if not plan_path.is_file():
            errors.append("plan missing on disk")
        elif report.get("plan_sha256") != sha256_file(plan_path):
            errors.append("plan_sha256 is stale")
    policy = report.get("evaluation_policy")
    if not isinstance(policy, dict):
        errors.append("evaluation_policy must be a mapping")
    else:
        expected_false = {
            "generated_rtl_committed",
            "generated_rtl_enters_source",
            "model_quality_claim_allowed",
        }
        for key in expected_false:
            if policy.get(key) is not False:
                errors.append(f"evaluation_policy.{key} must be false")
        expected_true = {
            "release_use_blocked",
            "requires_human_review",
            "requires_deterministic_gates",
        }
        for key in expected_true:
            if policy.get(key) is not True:
                errors.append(f"evaluation_policy.{key} must be true")
    models = report.get("models")
    if not isinstance(models, list) or not models:
        errors.append("models must be a non-empty list")
    else:
        ids = {item.get("id") for item in models if isinstance(item, dict)}
        missing = sorted(REQUIRED_MODELS - ids)
        if missing:
            errors.append(f"missing required RTL model entries: {', '.join(missing)}")
        for index, item in enumerate(models):
            if not isinstance(item, dict):
                errors.append(f"models[{index}] must be a mapping")
                continue
            if item.get("backend_status") != "not_configured":
                errors.append(f"models[{index}].backend_status must be not_configured")
            if item.get("release_use") != "blocked":
                errors.append(f"models[{index}].release_use must be blocked")
            if not isinstance(item.get("source_id"), str) or not item["source_id"]:
                errors.append(f"models[{index}].source_id must be present")
    tasks = report.get("tasks")
    if not isinstance(tasks, list) or len(tasks) < 3:
        errors.append("tasks must include the held-out E1-style task suite")
    else:
        for index, task in enumerate(tasks):
            if not isinstance(task, dict):
                errors.append(f"tasks[{index}] must be a mapping")
                continue
            if task.get("status") != "DRY_RUN_NOT_GENERATED":
                errors.append(f"tasks[{index}].status must be DRY_RUN_NOT_GENERATED")
            if task.get("generated_rtl_path") is not None:
                errors.append(f"tasks[{index}].generated_rtl_path must be null")
            if task.get("generated_rtl_sha256") is not None:
                errors.append(f"tasks[{index}].generated_rtl_sha256 must be null")
            gates = task.get("required_gates")
            if not isinstance(gates, list) or "make rtl-check" not in gates:
                errors.append(f"tasks[{index}].required_gates must include make rtl-check")
            if not isinstance(task.get("prompt_sha256"), str) or len(task["prompt_sha256"]) != 64:
                errors.append(f"tasks[{index}].prompt_sha256 must be sha256")
            if task.get("human_review_status") != "not_started":
                errors.append(f"tasks[{index}].human_review_status must be not_started")
    blockers = report.get("blocked_by")
    if not isinstance(blockers, list) or len(blockers) < 4:
        errors.append("blocked_by must list concrete missing execution gates")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.rtl_model_eval missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.rtl_model_eval {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.rtl_model_eval {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.rtl_model_eval "
        f"models={len(report.get('models', []))} tasks={len(report.get('tasks', []))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
