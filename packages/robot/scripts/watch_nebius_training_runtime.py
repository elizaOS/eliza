#!/usr/bin/env python3
"""Assess runtime and staleness for a Nebius robot training run."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return None


def watch_nebius_training_runtime(
    run_root: Path,
    *,
    instance_created_at: str | None,
    hard_cap_hours: float = 12.0,
    stale_after_hours: float = 6.0,
    now: datetime | None = None,
) -> dict[str, Any]:
    run_root = run_root.resolve()
    now = (now or datetime.now(UTC)).astimezone(UTC)
    created = _parse_time(instance_created_at)
    closeout = _load_json(run_root / "closeout_status.json")
    monitor = _load_json(run_root / "monitor_status.json")
    validation = _load_json(run_root / "validation_report.json")
    stage_checks = monitor.get("stage_checks") if isinstance(monitor.get("stage_checks"), dict) else {}
    completed_stages = [name for name, ok in stage_checks.items() if ok]
    pending_stages = [name for name, ok in stage_checks.items() if not ok]
    elapsed_hours = None
    hard_cap_at = None
    hours_until_hard_cap = None
    if created is not None:
        elapsed_hours = (now - created).total_seconds() / 3600.0
        hard_cap_at_dt = created + timedelta(hours=hard_cap_hours)
        hard_cap_at = hard_cap_at_dt.isoformat().replace("+00:00", "Z")
        hours_until_hard_cap = (hard_cap_at_dt - now).total_seconds() / 3600.0
    stale = (
        closeout.get("state") == "running"
        and elapsed_hours is not None
        and elapsed_hours >= stale_after_hours
        and len(completed_stages) <= 1
    )
    hard_cap_exceeded = hours_until_hard_cap is not None and hours_until_hard_cap <= 0
    closeout_state = closeout.get("state")
    if closeout.get("ok") is True:
        recommendation = "closeout_complete"
    elif closeout_state == "failed":
        recommendation = "inspect_failure_log"
    elif closeout_state == "invalid":
        recommendation = "inspect_failed_validation_gates"
    elif hard_cap_exceeded:
        recommendation = "inspect_or_terminate_cost_cap_exceeded"
    elif stale:
        recommendation = "inspect_runtime_staleness"
    else:
        recommendation = "continue_polling"
    report = {
        "schema": "robot-nebius-training-runtime-watch-v1",
        "ok": not hard_cap_exceeded,
        "run_root": str(run_root),
        "observed_at": now.isoformat().replace("+00:00", "Z"),
        "instance_created_at": created.isoformat().replace("+00:00", "Z") if created else None,
        "elapsed_hours": round(elapsed_hours, 4) if elapsed_hours is not None else None,
        "hard_cap_hours": float(hard_cap_hours),
        "hard_cap_at": hard_cap_at,
        "hours_until_hard_cap": round(hours_until_hard_cap, 4)
        if hours_until_hard_cap is not None
        else None,
        "stale_after_hours": float(stale_after_hours),
        "stale": bool(stale),
        "hard_cap_exceeded": bool(hard_cap_exceeded),
        "recommendation": recommendation,
        "closeout_state": closeout_state,
        "closeout_ok": closeout.get("ok"),
        "validation_ok": validation.get("ok"),
        "completed_stages": completed_stages,
        "pending_stages": pending_stages,
    }
    (run_root / "runtime_watch.json").write_text(json.dumps(report, indent=2) + "\n")
    append_history(run_root / "runtime_watch_history.jsonl", report)
    write_markdown(report, run_root / "runtime_watch.md")
    return report


def append_history(path: Path, report: dict[str, Any]) -> None:
    """Append a compact runtime snapshot, skipping duplicate timestamps."""
    entry = {
        "observed_at": report.get("observed_at"),
        "elapsed_hours": report.get("elapsed_hours"),
        "hours_until_hard_cap": report.get("hours_until_hard_cap"),
        "recommendation": report.get("recommendation"),
        "stale": report.get("stale"),
        "hard_cap_exceeded": report.get("hard_cap_exceeded"),
        "closeout_state": report.get("closeout_state"),
        "completed_stages": report.get("completed_stages", []),
        "pending_stages": report.get("pending_stages", []),
    }
    last_observed = None
    if path.is_file():
        try:
            lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
            if lines:
                last = json.loads(lines[-1])
                if isinstance(last, dict):
                    last_observed = last.get("observed_at")
        except (json.JSONDecodeError, OSError):
            last_observed = None
    if entry["observed_at"] == last_observed:
        return
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# Nebius Training Runtime Watch",
        "",
        f"Recommendation: `{report.get('recommendation')}`",
        f"Elapsed hours: `{report.get('elapsed_hours')}`",
        f"Hard cap at: `{report.get('hard_cap_at')}`",
        f"Hours until hard cap: `{report.get('hours_until_hard_cap')}`",
        f"Stale: `{report.get('stale')}`",
        f"Hard cap exceeded: `{report.get('hard_cap_exceeded')}`",
        f"History: `{path.with_name('runtime_watch_history.jsonl')}`",
        "",
        "## Completed Stages",
        "",
    ]
    completed = report.get("completed_stages") or []
    lines.extend(f"- `{stage}`" for stage in completed) if completed else lines.append("- none")
    lines += ["", "## Pending Stages", ""]
    pending = report.get("pending_stages") or []
    lines.extend(f"- `{stage}`" for stage in pending) if pending else lines.append("- none")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "run_root",
        type=Path,
        nargs="?",
        default=Path(__file__).resolve().parents[1]
        / "evidence"
        / "nebius_full_training"
        / "synced_run",
    )
    parser.add_argument("--instance-created-at")
    parser.add_argument("--hard-cap-hours", type=float, default=12.0)
    parser.add_argument("--stale-after-hours", type=float, default=6.0)
    args = parser.parse_args(argv)
    report = watch_nebius_training_runtime(
        args.run_root,
        instance_created_at=args.instance_created_at,
        hard_cap_hours=args.hard_cap_hours,
        stale_after_hours=args.stale_after_hours,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
