#!/usr/bin/env python3
"""Diagnose incomplete OpenLane run directories without promoting signoff."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RUN_ROOT = ROOT / "pd/openlane/runs"
LOCK_DIR = ROOT / ".openlane-run.lock"
STEP_RE = re.compile(r"^(?P<index>\d+)-(?P<name>.+)$")
RUN_TAG_RE = re.compile(r"^RUN_(?P<stamp>\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})$")


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def newest_run(run_root: Path) -> Path | None:
    if not run_root.is_dir():
        return None
    runs = [path for path in run_root.iterdir() if path.is_dir()]
    if not runs:
        return None

    def sort_key(path: Path) -> tuple[int, str, float]:
        match = RUN_TAG_RE.match(path.name)
        if match:
            return (1, match.group("stamp"), path.stat().st_mtime)
        return (0, "", path.stat().st_mtime)

    return max(runs, key=sort_key)


def step_dirs(run_dir: Path) -> list[Path]:
    steps = [path for path in run_dir.iterdir() if path.is_dir() and STEP_RE.match(path.name)]
    return sorted(steps, key=lambda path: int(STEP_RE.match(path.name).group("index")))  # type: ignore[union-attr]


def file_status(path: Path) -> str:
    if not path.exists():
        return "missing"
    if not path.is_file():
        return "not a file"
    return f"{path.stat().st_size} bytes"


def tail(path: Path, lines: int) -> list[str]:
    if not path.is_file():
        return []
    return path.read_text(errors="ignore").splitlines()[-lines:]


def load_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return {"_error": "invalid json"}
    return payload if isinstance(payload, dict) else {"_error": "json root is not an object"}


def pid_is_running(pid_path: Path) -> bool:
    if not pid_path.is_file():
        return False
    try:
        pid = int(pid_path.read_text().strip())
    except ValueError:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def active_lock_summary() -> list[str]:
    if not LOCK_DIR.is_dir():
        return []
    running = pid_is_running(LOCK_DIR / "pid")
    lines = [f"- launcher_lock: `{'active' if running else 'stale'}`"]
    for name in ("pid", "started_at", "config", "image", "docker.cid"):
        path = LOCK_DIR / name
        if path.is_file():
            lines.append(f"- lock_{name.replace('.', '_')}: `{path.read_text().strip()}`")
    return lines


def seconds_since_mtime(path: Path) -> int | None:
    if not path.exists():
        return None
    return int(datetime.now(UTC).timestamp() - path.stat().st_mtime)


def klayout_drc_steps(run_dir: Path) -> list[Path]:
    return [step for step in step_dirs(run_dir) if "klayout-drc" in step.name.lower()]


def report_klayout_status(run_dir: Path, tail_lines: int) -> list[str]:
    lines = ["", "## KLayout DRC Status"]
    steps = klayout_drc_steps(run_dir)
    if not steps:
        lines.append("- status: not_started")
        lines.append("- interpretation: KLayout DRC has not reached this run yet.")
        return lines
    for step in steps:
        complete = (step / "state_out.json").is_file()
        reports_dir = step / "reports"
        xml_reports = sorted(reports_dir.glob("*.xml")) if reports_dir.is_dir() else []
        json_reports = sorted(reports_dir.glob("*.json")) if reports_dir.is_dir() else []
        log_files = sorted(step.glob("*klayout*.log"))
        lines.append(f"- step: `{step.name}`")
        lines.append(f"  - status: {'complete' if complete else 'incomplete'}")
        lines.append(f"  - state_out: `{file_status(step / 'state_out.json')}`")
        lines.append(f"  - runtime: `{file_status(step / 'runtime.txt')}`")
        lines.append(f"  - report_xml_count: {len(xml_reports)}")
        lines.append(f"  - report_json_count: {len(json_reports)}")
        for path in sorted(step.glob("*.process_stats.json")):
            payload = load_json(path)
            runtime = payload.get("time", {}) if isinstance(payload, dict) else {}
            peak = payload.get("peak_resources", {}) if isinstance(payload, dict) else {}
            lines.append(f"  - `{path.name}`: {file_status(path)}")
            if runtime:
                lines.append(f"    - runtime: {runtime}")
            if peak:
                lines.append(f"    - peak_resources: {peak}")
        if not complete and log_files:
            lines.append(f"  - latest_log_tail: `{log_files[-1].name}`")
            lines.append("```text")
            lines.extend(tail(log_files[-1], tail_lines))
            lines.append("```")
    return lines


def diagnose(run_dir: Path, tail_lines: int) -> tuple[int, str]:
    lines: list[str] = []
    lines.append(f"# OpenLane Run Diagnosis: {run_dir.name}")
    lines.append("")
    lines.append(f"- generated_at: {datetime.now(UTC).isoformat()}")
    lines.append(f"- run_dir: `{rel(run_dir)}`")
    lock_lines = active_lock_summary()
    if lock_lines:
        lines.extend(lock_lines)

    steps = step_dirs(run_dir)
    if not steps:
        lines.append("- status: blocked")
        lines.append("- blocker: no numbered OpenLane step directories found")
        return 1, "\n".join(lines) + "\n"

    last_step = steps[-1]
    last_complete = next(
        (step for step in reversed(steps) if (step / "state_out.json").is_file()), None
    )
    incomplete_steps = [step for step in steps if not (step / "state_out.json").is_file()]
    incomplete_klayout_drc = [
        step for step in incomplete_steps if "klayout-drc" in step.name.lower()
    ]
    active_run = (
        bool(lock_lines) and pid_is_running(LOCK_DIR / "pid") and not (run_dir / "final").is_dir()
    )
    blocking_step = incomplete_klayout_drc[0] if incomplete_klayout_drc else None
    if blocking_step is None and incomplete_steps and not active_run:
        blocking_step = incomplete_steps[0]
    earlier_without_state = [
        step for step in incomplete_steps if blocking_step is None or step != blocking_step
    ]

    if active_run and blocking_step is None:
        lines.append("- status: in_progress")
        lines.append("- blocker: none yet; active OpenLane job is still writing this run")
    elif blocking_step is None and (run_dir / "final").is_dir():
        lines.append("- status: complete_by_state_out")
    elif blocking_step is None:
        lines.append("- status: blocked")
        lines.append("- blocker: all discovered steps wrote state_out.json, but final/ is missing")
    else:
        lines.append("- status: blocked")
        lines.append(f"- blocker_step: `{blocking_step.name}`")
        lines.append("- blocker: step directory exists without `state_out.json`")
    lines.append(f"- last_discovered_step: `{last_step.name}`")
    age = seconds_since_mtime(last_step)
    if age is not None:
        lines.append(f"- last_step_mtime_age_seconds: {age}")
    if last_complete is not None:
        lines.append(f"- last_completed_step: `{last_complete.name}`")
    if earlier_without_state:
        lines.append(
            "- earlier_steps_without_state_out: "
            + ", ".join(f"`{step.name}`" for step in earlier_without_state[:20])
        )

    if blocking_step is not None:
        lines.append("")
        lines.append("## Blocking Step Evidence")
        for name in ("state_in.json", "state_out.json", "runtime.txt", "COMMANDS", "config.json"):
            path = blocking_step / name
            lines.append(f"- `{name}`: {file_status(path)}")
        process_stats = sorted(blocking_step.glob("*.process_stats.json"))
        for path in process_stats:
            payload = load_json(path)
            lines.append(f"- `{path.name}`: {file_status(path)}")
            peak = payload.get("peak_resources", {}) if isinstance(payload, dict) else {}
            runtime = payload.get("time", {}) if isinstance(payload, dict) else {}
            if peak or runtime:
                lines.append(f"  - runtime: {runtime}")
                lines.append(f"  - peak_resources: {peak}")
        log_files = sorted(blocking_step.glob("*.log"))
        for path in log_files:
            lines.append(f"- `{path.name}`: {file_status(path)}")
        reports_dir = blocking_step / "reports"
        report_files = sorted(reports_dir.glob("*")) if reports_dir.is_dir() else []
        if report_files:
            lines.append("- reports:")
            for path in report_files:
                lines.append(f"  - `{path.name}`: {file_status(path)}")
        elif reports_dir.is_dir():
            lines.append("- reports: directory exists but contains no report files")

        command_path = blocking_step / "COMMANDS"
        if command_path.is_file():
            lines.append("")
            lines.append("## Command")
            lines.append("```text")
            lines.extend(command_path.read_text(errors="ignore").splitlines()[:20])
            lines.append("```")

        for path in log_files:
            lines.append("")
            lines.append(f"## Tail: {path.name}")
            lines.append("```text")
            lines.extend(tail(path, tail_lines))
            lines.append("```")

        if "klayout-drc" in blocking_step.name.lower():
            lines.append("")
            lines.append("## KLayout DRC Interpretation")
            lines.append(
                "- The KLayout DRC subprocess started and emitted rule-progress logs, "
                "but did not write the expected DRC report XML or OpenLane `state_out.json`."
            )
            lines.append(
                "- Treat this as an interrupted/incomplete signoff step, not as clean DRC."
            )
            lines.append(
                "- Likely local causes to verify are wall-clock timeout, host/container kill, "
                "or memory pressure during the BEOL/mcon rules."
            )

    lines.extend(report_klayout_status(run_dir, tail_lines))
    lines.append("")
    lines.append("## Release Status")
    lines.append(
        "- Do not use this run as tapeout/signoff evidence until `final/` exists and release checks pass."
    )
    return (1 if blocking_step is not None or not (run_dir / "final").is_dir() else 0), "\n".join(
        lines
    ) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--run-root", type=Path, default=DEFAULT_RUN_ROOT)
    parser.add_argument("--write-report", type=Path)
    parser.add_argument("--tail-lines", type=int, default=60)
    args = parser.parse_args()

    run_dir = args.run_dir
    if run_dir is None:
        run_dir = newest_run(args.run_root)
        if run_dir is None:
            print(f"no OpenLane runs found under {rel(args.run_root)}", file=sys.stderr)
            return 1
    if not run_dir.is_absolute():
        run_dir = ROOT / run_dir
    if not run_dir.is_dir():
        print(f"OpenLane run directory not found: {rel(run_dir)}", file=sys.stderr)
        return 1

    status, report = diagnose(run_dir, args.tail_lines)
    if args.write_report:
        report_path = args.write_report
        if not report_path.is_absolute():
            report_path = ROOT / report_path
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report)
        print(f"wrote OpenLane diagnosis: {rel(report_path)}")
    else:
        print(report, end="")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
