#!/usr/bin/env python3
"""One-shot monitor for the Nebius full robot training run.

This command is meant to be safe for repeated polling. It syncs the run prefix,
runs the production bundle validator, and writes a compact monitor status with a
terminal-state classification:

- ``running``: no success/failure marker yet.
- ``failed``: the remote run uploaded ``status/failure.txt``.
- ``invalid``: success marker exists, but production validation failed.
- ``complete``: success marker exists and all production gates passed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.validate_nebius_full_training_run import (  # noqa: E402
    DEFAULT_TASKS,
    sync_from_s3,
    validate_nebius_full_training_run,
)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def summarize_validation(validation: dict[str, Any]) -> dict[str, Any]:
    checks = validation.get("checks", {})
    stage_checks = validation.get("reports", {}).get("stages", {}).get("checks", {})
    completed_stages = [name for name, ok in stage_checks.items() if ok]
    pending_stages = [name for name, ok in stage_checks.items() if not ok]
    missing_gates = [name for name, ok in checks.items() if not ok]
    passed_gates = [name for name, ok in checks.items() if ok]
    next_action = "continue_polling"
    if checks.get("failure_marker_absent") is False:
        next_action = "inspect_failure_log"
    elif checks.get("success_marker") and missing_gates:
        next_action = "inspect_failed_validation_gates"
    elif validation.get("ok") is True:
        next_action = "archive_and_cleanup"
    return {
        "completed_stage_count": len(completed_stages),
        "total_stage_count": len(stage_checks),
        "completed_stages": completed_stages,
        "pending_stages": pending_stages,
        "passed_gates": passed_gates,
        "missing_gates": missing_gates,
        "next_action": next_action,
    }


def _write_monitor_markdown(path: Path, status: dict[str, Any]) -> None:
    summary = status.get("summary", {})
    lines = [
        "# Nebius Full Training Monitor",
        "",
        f"Run: `{status.get('run_id')}`",
        f"State: `{status.get('state')}`",
        f"Observed: `{status.get('observed_at')}`",
        f"Next action: `{summary.get('next_action', 'unknown')}`",
        "",
        "## Stage Progress",
        "",
        f"Completed: `{summary.get('completed_stage_count', 0)}` / "
        f"`{summary.get('total_stage_count', 0)}`",
        "",
        "| stage | status |",
        "|---|---:|",
    ]
    stage_checks = status.get("stage_checks", {})
    for name, ok in stage_checks.items():
        lines.append(f"| `{name}` | `{'done' if ok else 'pending'}` |")
    lines += [
        "",
        "## Missing Gates",
        "",
    ]
    missing = summary.get("missing_gates", [])
    if missing:
        lines.extend(f"- `{name}`" for name in missing)
    else:
        lines.append("- none")
    lines += [
        "",
        "## Passed Gates",
        "",
    ]
    passed = summary.get("passed_gates", [])
    if passed:
        lines.extend(f"- `{name}`" for name in passed)
    else:
        lines.append("- none")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def classify_run(run_root: Path, validation: dict[str, Any]) -> str:
    """Return the terminal monitor state for a synced run tree."""
    status_dir = run_root / "status"
    if (status_dir / "failure.txt").is_file():
        return "failed"
    if not (status_dir / "success.txt").is_file():
        return "running"
    if validation.get("ok") is True:
        return "complete"
    return "invalid"


def monitor_nebius_full_training_run(
    *,
    run_id: str,
    bucket: str,
    endpoint: str,
    dest: Path,
    aws_bin: str = "aws",
    profile_id: str = "asimov-1",
    tasks: tuple[str, ...] = DEFAULT_TASKS,
    min_alberta_steps: int = 150_000_000,
    min_backend_compare_steps: int = 30_000,
    min_benchmark_steps_per_task: int = 16_000,
    min_benchmark_seeds: int = 3,
    run_deep_validators: bool = True,
    skip_sync: bool = False,
) -> dict[str, Any]:
    sync_report = (
        {
            "ok": True,
            "skipped": True,
            "dest": str(dest),
        }
        if skip_sync
        else sync_from_s3(
            run_id=run_id,
            bucket=bucket,
            endpoint=endpoint,
            dest=dest,
            aws_bin=aws_bin,
        )
    )
    if not sync_report.get("ok"):
        status = {
            "schema": "robot-nebius-full-training-monitor-v1",
            "ok": False,
            "state": "sync-error",
            "run_id": run_id,
            "bucket": bucket,
            "dest": str(dest),
            "observed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "sync": sync_report,
            "summary": {
                "next_action": "fix_sync",
                "missing_gates": ["sync"],
                "passed_gates": [],
                "completed_stages": [],
                "pending_stages": [],
                "completed_stage_count": 0,
                "total_stage_count": 0,
            },
        }
        _write_json(dest / "monitor_status.json", status)
        _write_monitor_markdown(dest / "monitor_summary.md", status)
        return status

    validation = validate_nebius_full_training_run(
        dest,
        run_id=run_id,
        profile_id=profile_id,
        tasks=tasks,
        min_alberta_steps=min_alberta_steps,
        min_backend_compare_steps=min_backend_compare_steps,
        min_benchmark_steps_per_task=min_benchmark_steps_per_task,
        min_benchmark_seeds=min_benchmark_seeds,
        require_success=True,
        run_deep_validators=run_deep_validators,
    )
    state = classify_run(dest, validation)
    summary = summarize_validation(validation)
    status = {
        "schema": "robot-nebius-full-training-monitor-v1",
        "ok": state == "complete",
        "state": state,
        "run_id": run_id,
        "bucket": bucket,
        "dest": str(dest),
        "observed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "sync": sync_report,
        "validation_report": str(dest / "validation_report.json"),
        "validation_summary": str(dest / "validation_summary.md"),
        "checks": validation.get("checks", {}),
        "stage_checks": validation.get("reports", {})
        .get("stages", {})
        .get("checks", {}),
        "summary": summary,
        "monitor_summary": str(dest / "monitor_summary.md"),
    }
    _write_json(dest / "monitor_status.json", status)
    _write_monitor_markdown(dest / "monitor_summary.md", status)
    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument(
        "--endpoint",
        default=os.environ.get(
            "NEBIUS_S3_ENDPOINT", "https://storage.eu-north1.nebius.cloud"
        ),
    )
    parser.add_argument(
        "--dest",
        type=Path,
        default=ROOT / "evidence" / "nebius_full_training" / "synced_run",
    )
    parser.add_argument("--aws-bin", default="aws")
    parser.add_argument("--profile", default="asimov-1")
    parser.add_argument("--tasks", nargs="+", default=list(DEFAULT_TASKS))
    parser.add_argument("--min-alberta-steps", type=int, default=150_000_000)
    parser.add_argument("--min-backend-compare-steps", type=int, default=30_000)
    parser.add_argument("--min-benchmark-steps-per-task", type=int, default=16_000)
    parser.add_argument("--min-benchmark-seeds", type=int, default=3)
    parser.add_argument("--no-deep-validators", action="store_true")
    parser.add_argument("--skip-sync", action="store_true")
    args = parser.parse_args(argv)

    status = monitor_nebius_full_training_run(
        run_id=args.run_id,
        bucket=args.bucket,
        endpoint=args.endpoint,
        dest=args.dest,
        aws_bin=args.aws_bin,
        profile_id=args.profile,
        tasks=tuple(args.tasks),
        min_alberta_steps=args.min_alberta_steps,
        min_backend_compare_steps=args.min_backend_compare_steps,
        min_benchmark_steps_per_task=args.min_benchmark_steps_per_task,
        min_benchmark_seeds=args.min_benchmark_seeds,
        run_deep_validators=not args.no_deep_validators,
        skip_sync=args.skip_sync,
    )
    print(json.dumps(status, indent=2))
    if status["state"] == "complete":
        return 0
    if status["state"] == "running":
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
