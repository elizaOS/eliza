#!/usr/bin/env python3
# ruff: noqa: E402,I001
"""Run the full Nebius robot training closeout chain.

This is the single repeatable command for the production run:

1. sync + monitor the object-storage prefix,
2. guarded finalization,
3. artifact-driven Alberta/PPO/SOTA report generation,
4. compact closeout status.

Exit codes match the monitor semantics: ``0`` complete, ``1`` still running,
``2`` failed/invalid/sync error.
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

from scripts.finalize_nebius_full_training_run import (  # noqa: E402
    finalize_nebius_full_training_run,
)
from scripts.generate_nebius_training_report import (  # noqa: E402
    generate_nebius_training_report,
    write_markdown as write_training_report_markdown,
)
from scripts.inventory_nebius_training_artifacts import (  # noqa: E402
    inventory_nebius_training_artifacts,
    write_markdown as write_inventory_markdown,
)
from scripts.audit_alberta_objective_completion import (  # noqa: E402
    audit_alberta_objective_completion,
    write_markdown as write_objective_audit_markdown,
)
from scripts.monitor_nebius_full_training_run import (  # noqa: E402
    monitor_nebius_full_training_run,
)
from scripts.validate_nebius_full_training_run import DEFAULT_TASKS  # noqa: E402


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _write_markdown(path: Path, status: dict[str, Any]) -> None:
    monitor = status.get("monitor", {})
    finalization = status.get("finalization", {})
    report = status.get("training_report", {})
    objective = status.get("objective_audit", {})
    missing = status.get("missing_gates") or []
    lines = [
        "# Nebius Full Training Closeout",
        "",
        f"Run: `{status.get('run_id')}`",
        f"State: `{status.get('state')}`",
        f"Closeout ok: `{status.get('ok')}`",
        f"Observed: `{status.get('observed_at')}`",
        "",
        "## Chain Results",
        "",
        f"- monitor: `{monitor.get('state')}` / ok=`{monitor.get('ok')}`",
        f"- finalization: ok=`{finalization.get('ok')}`",
        f"- training report: ok=`{report.get('ok')}`",
        f"- objective audit: ok=`{objective.get('ok')}`",
        "",
        "## Missing Gates",
        "",
    ]
    if missing:
        lines.extend(f"- `{gate}`" for gate in missing)
    else:
        lines.append("- none")
    lines += [
        "",
        "## Artifacts",
        "",
        f"- monitor: `{status.get('monitor_status')}`",
        f"- validation: `{status.get('validation_report')}`",
        f"- finalization: `{status.get('finalization_report')}`",
        f"- training report: `{status.get('training_comparison_report')}`",
        f"- artifact inventory: `{status.get('artifact_inventory')}`",
        f"- objective audit: `{status.get('objective_completion_audit')}`",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def closeout_nebius_full_training_run(
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
    monitor = monitor_nebius_full_training_run(
        run_id=run_id,
        bucket=bucket,
        endpoint=endpoint,
        dest=dest,
        aws_bin=aws_bin,
        profile_id=profile_id,
        tasks=tasks,
        min_alberta_steps=min_alberta_steps,
        min_backend_compare_steps=min_backend_compare_steps,
        min_benchmark_steps_per_task=min_benchmark_steps_per_task,
        min_benchmark_seeds=min_benchmark_seeds,
        run_deep_validators=run_deep_validators,
        skip_sync=skip_sync,
    )
    finalization = finalize_nebius_full_training_run(dest)
    training_report = generate_nebius_training_report(dest)
    training_json = dest / "training_comparison_report.json"
    training_md = dest / "training_comparison_report.md"
    _write_json(training_json, training_report)
    write_training_report_markdown(training_report, training_md)
    inventory = inventory_nebius_training_artifacts(dest)
    inventory_json = dest / "artifact_inventory.json"
    inventory_md = dest / "artifact_inventory.md"
    _write_json(inventory_json, inventory)
    write_inventory_markdown(inventory, inventory_md)
    objective_audit = audit_alberta_objective_completion(
        package_root=ROOT,
        nebius_run_root=dest,
    )
    objective_json = dest / "objective_completion_audit.json"
    objective_md = dest / "objective_completion_audit.md"
    _write_json(objective_json, objective_audit)
    write_objective_audit_markdown(objective_audit, objective_md)

    ok = (
        monitor.get("state") == "complete"
        and monitor.get("ok") is True
        and finalization.get("ok") is True
        and training_report.get("ok") is True
        and inventory.get("ok") is True
        and objective_audit.get("ok") is True
    )
    missing_gates = (
        finalization.get("missing_gates")
        or training_report.get("missing_gates")
        or inventory.get("missing")
        or objective_audit.get("failed")
        or monitor.get("summary", {}).get("missing_gates")
        or []
    )
    monitor_state = str(monitor.get("state") or "unknown")
    state = "complete" if ok else ("invalid" if monitor_state == "complete" else monitor_state)
    status = {
        "schema": "robot-nebius-full-training-closeout-v1",
        "ok": ok,
        "state": "complete" if ok else state,
        "run_id": run_id,
        "bucket": bucket,
        "dest": str(dest),
        "observed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "monitor": {
            "ok": monitor.get("ok"),
            "state": monitor.get("state"),
            "summary": monitor.get("summary"),
        },
        "finalization": {
            "ok": finalization.get("ok"),
            "missing_gates": finalization.get("missing_gates"),
        },
        "training_report": {
            "ok": training_report.get("ok"),
            "missing_gates": training_report.get("missing_gates"),
            "backend_comparison": training_report.get("backend_comparison"),
            "video_review": training_report.get("video_review"),
        },
        "artifact_inventory": {
            "ok": inventory.get("ok"),
            "present_count": inventory.get("present_count"),
            "required_count": inventory.get("required_count"),
            "missing": inventory.get("missing"),
        },
        "objective_audit": {
            "ok": objective_audit.get("ok"),
            "passed": objective_audit.get("passed"),
            "failed": objective_audit.get("failed"),
        },
        "missing_gates": missing_gates,
        "monitor_status": str(dest / "monitor_status.json"),
        "validation_report": str(dest / "validation_report.json"),
        "finalization_report": str(dest / "finalization_report.json"),
        "training_comparison_report": str(training_json),
        "artifact_inventory_report": str(inventory_json),
        "objective_completion_audit": str(objective_json),
    }
    _write_json(dest / "closeout_status.json", status)
    _write_markdown(dest / "closeout_summary.md", status)
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

    status = closeout_nebius_full_training_run(
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
    if status["ok"]:
        return 0
    if status["state"] == "running":
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
