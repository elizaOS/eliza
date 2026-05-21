#!/usr/bin/env python3
"""Validate AI-EDA verification/formal target-capture reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]

EXPECTED_REPORTS = {
    "logic_synthesis": {
        "path": "build/ai_eda/logic_synthesis_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.logic_synthesis_targets.v1",
        "claim_boundary": "logic_synthesis_capture_only_no_netlist_or_qor_claim",
        "false_policy": (
            "changes_rtl",
            "changes_synthesis_script",
            "changes_constraints",
            "changes_netlist",
            "runs_synthesis",
            "runs_abc",
            "runs_formal",
            "runs_openlane",
            "prediction_generated",
            "area_timing_power_claim_allowed",
            "equivalence_claim_allowed",
            "signoff_claim_allowed",
            "release_use_allowed",
        ),
    },
    "rtl_rewrite": {
        "path": "build/ai_eda/rtl_rewrite_equivalence_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.rtl_rewrite_equivalence_targets.v1",
        "claim_boundary": "rtl_rewrite_equivalence_target_capture_only_no_rewrite_or_ppa_claim",
        "false_policy": (
            "changes_rtl",
            "generates_rewrite",
            "runs_llm",
            "runs_equivalence",
            "runs_synthesis",
            "runs_simulation",
            "prediction_generated",
            "equivalence_claim_allowed",
            "ppa_claim_allowed",
            "release_use_allowed",
        ),
    },
    "netlist_equivalence": {
        "path": "build/ai_eda/netlist_equivalence_targets/{run_id}/targets_report.json",
        "schema": "eliza.ai_eda.netlist_equivalence_targets.v1",
        "claim_boundary": "netlist_equivalence_target_capture_only_no_lec_or_equivalence_claim",
        "false_policy": (
            "changes_rtl",
            "changes_netlist",
            "changes_synthesis_script",
            "changes_formal_script",
            "runs_yosys",
            "runs_eqy",
            "runs_abc",
            "runs_circt_lec",
            "runs_formal",
            "runs_openlane",
            "generates_miter",
            "generates_equivalence_script",
            "generates_proof",
            "generates_waiver",
            "prediction_generated",
            "equivalence_claim_allowed",
            "timing_claim_allowed",
            "qor_claim_allowed",
            "signoff_claim_allowed",
            "release_use_allowed",
        ),
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


def validate_artifacts(report_id: str, report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    artifacts = report.get("input_artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        return [f"{report_id}: input_artifacts must be a non-empty list"]
    present_count = 0
    for index, artifact in enumerate(artifacts):
        label = f"{report_id}: input_artifacts[{index}]"
        if not isinstance(artifact, dict):
            errors.append(f"{label}: must be a mapping")
            continue
        status = artifact.get("status")
        if status == "PRESENT":
            present_count += 1
            sha = artifact.get("sha256")
            if not isinstance(sha, str) or len(sha) != 64:
                errors.append(f"{label}: PRESENT artifact requires a 64-character sha256")
            path_value = artifact.get("path")
            if isinstance(path_value, str) and not repo_path(path_value).is_file():
                errors.append(f"{label}: PRESENT artifact is missing on disk")
        elif status != "MISSING":
            errors.append(f"{label}: status must be PRESENT or MISSING")
    if present_count == 0:
        errors.append(f"{report_id}: at least one input artifact must be present")
    return errors


def validate_tasks(report_id: str, report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    tasks = report.get("candidate_tasks")
    if not isinstance(tasks, list) or not tasks:
        return [f"{report_id}: candidate_tasks must be a non-empty list"]
    seen_ids: set[str] = set()
    for index, task in enumerate(tasks):
        label = f"{report_id}: candidate_tasks[{index}]"
        if not isinstance(task, dict):
            errors.append(f"{label}: must be a mapping")
            continue
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id:
            errors.append(f"{label}: id is required")
        elif task_id in seen_ids:
            errors.append(f"{label}: duplicate id {task_id}")
        else:
            seen_ids.add(task_id)
        if not str(task.get("status", "")).startswith("CAPTURED_"):
            errors.append(f"{label}: status must start with CAPTURED_")
        gates = task.get("acceptance_gates")
        if not isinstance(gates, list) or not gates:
            errors.append(f"{label}: acceptance_gates must be non-empty")
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
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append(f"{report_id}: policy must be a mapping")
    else:
        for field in expected["false_policy"]:
            if policy.get(field) is not False:
                errors.append(f"{report_id}: policy.{field} must be false")
    if not isinstance(report.get("source_ids"), list) or not report.get("source_ids"):
        errors.append(f"{report_id}: source_ids must be non-empty")
    if not isinstance(report.get("blocked_by"), list) or not report.get("blocked_by"):
        errors.append(f"{report_id}: blocked_by must be non-empty")
    errors.extend(validate_artifacts(report_id, report))
    errors.extend(validate_tasks(report_id, report))
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--report", action="append", type=Path, default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    paths = args.report or [
        repo_path(item["path"].format(run_id=args.run_id))
        for item in EXPECTED_REPORTS.values()
    ]
    expected_by_schema = {
        item["schema"]: (report_id, item)
        for report_id, item in EXPECTED_REPORTS.items()
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
        errors.append("not all requested verification target reports were validated")
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.verification_target_captures {error}")
        return 1
    print(f"STATUS: PASS ai_eda.verification_target_captures reports={validated} run_id={args.run_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
