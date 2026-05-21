#!/usr/bin/env python3
"""Validate stage selection and risky-stage blocking for a CUDA run plan."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PLAN = ROOT / "build/ai_eda/cuda_training_payloads/validation/cuda_training_run_plan.json"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/cuda_run_plan_safety_matrix"
EXECUTOR = ROOT / "scripts/ai_eda/execute_cuda_run_plan.py"
SCHEMA = "eliza.ai_eda.cuda_run_plan_safety_matrix.v1"
CLAIM_BOUNDARY = "cuda_run_plan_safety_matrix_no_command_execution_or_release_claim"
REQUIRED_STAGES = {
    "asset_intake",
    "bootstrap",
    "conversion",
    "inference",
    "preflight",
    "rag",
    "replay",
    "target_capture",
    "training",
}
RISKY_STAGES = {
    "asset_intake": "--allow-downloads",
    "training": "--allow-training",
    "inference": "--allow-inference",
    "replay": "--allow-replay",
    "alphachip": "--allow-alphachip",
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


def run_executor(
    plan: Path, run_id: str, out_root: Path, args: list[str]
) -> tuple[int, dict[str, Any], str, str]:
    command = [
        sys.executable,
        str(EXECUTOR),
        "--plan",
        str(plan),
        "--run-id",
        run_id,
        "--out-root",
        str(out_root),
        *args,
    ]
    result = subprocess.run(
        command,
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    report_path = out_root / run_id / "cuda_run_plan_execution.json"
    report = load_json(report_path) if report_path.is_file() else {}
    return result.returncode, report, result.stdout[-4000:], result.stderr[-4000:]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    plan = load_json(args.plan)
    commands = plan.get("required_remote_commands")
    if not isinstance(commands, list) or not all(isinstance(command, str) for command in commands):
        raise SystemExit("run plan required_remote_commands must be a list of strings")

    matrix_out_root = args.out_root / args.run_id / "executor_manifests"
    baseline_code, baseline, baseline_stdout, baseline_stderr = run_executor(
        args.plan,
        f"{args.run_id}-all-stage-dry-run",
        matrix_out_root,
        [],
    )
    stage_counts = baseline.get("stage_counts") if isinstance(baseline, dict) else None
    if not isinstance(stage_counts, dict):
        raise SystemExit("baseline dry-run did not produce stage_counts")
    stages = sorted(set(stage_counts) | REQUIRED_STAGES)

    checks: list[dict[str, Any]] = [
        {
            "kind": "all_stage_dry_run",
            "run_id": f"{args.run_id}-all-stage-dry-run",
            "returncode": baseline_code,
            "status": "PASS"
            if baseline_code == 0 and baseline.get("mode") == "dry-run"
            else "FAIL",
            "stdout_tail": baseline_stdout,
            "stderr_tail": baseline_stderr,
        }
    ]
    failures: list[str] = []
    if baseline_code != 0:
        failures.append("all-stage dry-run returned non-zero")
    missing = REQUIRED_STAGES - set(stage_counts)
    if missing:
        failures.append(f"all-stage dry-run missing stages: {', '.join(sorted(missing))}")

    for stage in stages:
        stage_run_id = f"{args.run_id}-stage-{stage}"
        code, report, stdout, stderr = run_executor(
            args.plan,
            stage_run_id,
            matrix_out_root,
            ["--stage", stage],
        )
        selected_stage_counts = report.get("selected_stage_counts")
        selected_count = (
            int(report.get("selected_command_count", -1))
            if isinstance(report.get("selected_command_count"), int)
            else -1
        )
        expected_selected = sum(
            1
            for item in report.get("commands", [])
            if isinstance(item, dict)
            and item.get("stage") == stage
            and item.get("selected") is True
            and item.get("template") is not True
            and item.get("orchestration_command") is not True
        )
        ok = (
            code == 0
            and report.get("mode") == "dry-run"
            and isinstance(selected_stage_counts, dict)
            and set(selected_stage_counts) <= {stage}
            and selected_count == expected_selected
        )
        if not ok:
            failures.append(f"stage dry-run selection failed for {stage}")
        checks.append(
            {
                "kind": "stage_dry_run",
                "stage": stage,
                "run_id": stage_run_id,
                "returncode": code,
                "expected_selected_command_count": expected_selected,
                "selected_command_count": selected_count,
                "selected_stage_counts": selected_stage_counts,
                "status": "PASS" if ok else "FAIL",
                "stdout_tail": stdout,
                "stderr_tail": stderr,
            }
        )

    for stage, allow_flag in sorted(RISKY_STAGES.items()):
        if stage not in stage_counts:
            failures.append(f"risky stage {stage} is missing from run plan")
            continue
        blocked_run_id = f"{args.run_id}-blocked-{stage}"
        code, report, stdout, stderr = run_executor(
            args.plan,
            blocked_run_id,
            matrix_out_root,
            ["--execute", "--stage", stage],
        )
        blocked_count = (
            int(report.get("blocked", -1)) if isinstance(report.get("blocked"), int) else -1
        )
        executed_count = (
            int(report.get("executed_command_count", -1))
            if isinstance(report.get("executed_command_count"), int)
            else -1
        )
        ok = (
            code != 0
            and report.get("mode") == "execute"
            and blocked_count > 0
            and executed_count == 0
        )
        if not ok:
            failures.append(f"risky stage {stage} was not blocked without {allow_flag}")
        checks.append(
            {
                "kind": "risky_stage_execute_without_allow",
                "stage": stage,
                "required_allow_flag": allow_flag,
                "run_id": blocked_run_id,
                "returncode": code,
                "blocked": blocked_count,
                "executed_command_count": executed_count,
                "status": "PASS" if ok else "FAIL",
                "stdout_tail": stdout,
                "stderr_tail": stderr,
            }
        )

    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "plan": rel(args.plan),
        "claim_boundary": CLAIM_BOUNDARY,
        "policy": {
            "runs_commands": False,
            "runs_training": False,
            "runs_inference": False,
            "runs_openlane": False,
            "downloads_assets": False,
            "release_use_allowed": False,
        },
        "required_stages": sorted(REQUIRED_STAGES),
        "risky_stages": RISKY_STAGES,
        "stage_counts": stage_counts,
        "checks": checks,
        "failures": failures,
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "cuda_run_plan_safety_matrix.json"
    out_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        for failure in failures:
            print(f"STATUS: FAIL ai_eda.cuda_run_plan_safety_matrix {failure}")
        return 1
    print(
        "STATUS: PASS ai_eda.cuda_run_plan_safety_matrix "
        f"stages={len(stages)} checks={len(checks)} report={rel(out_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
