#!/usr/bin/env python3
"""Validate the prototype status dashboard against current MVP gate output."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "docs/project/prototype-status-dashboard.md"
VOLATILE_BUILD_OUTPUT_SUBSYSTEMS = {
    "synthesis",
    "cocotb",
    "verilator",
    "formal",
    "qemu",
    "renode",
    "benchmarks",
    "release-pipeline",
}


def run_mvp_json() -> list[dict[str, str]]:
    result = subprocess.run(
        [sys.executable, "scripts/check_mvp_status.py", "--json"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(
            "check_mvp_status.py --json did not produce usable status:\n" + result.stdout
        )
    return json.loads(result.stdout)


def parse_table_rows(text: str, section: str) -> dict[str, dict[str, str]]:
    lines = text.splitlines()
    try:
        start = lines.index(section)
    except ValueError:
        return {}

    table_start = -1
    for index in range(start + 1, len(lines)):
        if lines[index].startswith("| Subsystem |"):
            table_start = index
            break
        if lines[index].startswith("## ") and index != start:
            return {}
    if table_start < 0 or table_start + 2 >= len(lines):
        return {}

    headers = [cell.strip() for cell in lines[table_start].strip().strip("|").split("|")]
    rows: dict[str, dict[str, str]] = {}
    for line in lines[table_start + 2 :]:
        stripped = line.strip()
        if not stripped.startswith("|"):
            break
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) != len(headers):
            continue
        row = dict(zip(headers, cells, strict=True))
        rows[row["Subsystem"]] = row
    return rows


def normalize_cell(value: str) -> str:
    value = value.strip()
    if value.startswith("`") and value.endswith("`"):
        value = value[1:-1]
    return " ".join(value.split())


def conservative_snapshot_allowed(
    subsystem: str,
    status: dict[str, str],
    row: dict[str, str],
) -> bool:
    """Allow source-tree docs to stay conservative after local CI emits artifacts."""

    if subsystem not in VOLATILE_BUILD_OUTPUT_SUBSYSTEMS:
        return False

    dashboard_status = normalize_cell(row.get("Status", ""))
    dashboard_evidence = normalize_cell(row.get("Evidence class", ""))
    current_status = str(status.get("status", "")).upper()
    current_evidence = str(status.get("evidence_class", ""))

    if (
        current_status == "PASS"
        and current_evidence == "generated_artifact"
        and dashboard_status == "BLOCK"
        and dashboard_evidence in {"tool_blocker", "regen_required"}
    ):
        return True

    if (
        current_status == "BLOCK"
        and dashboard_status == "BLOCK"
        and current_evidence in {"tool_blocker", "regen_required"}
        and dashboard_evidence in {"tool_blocker", "regen_required"}
    ):
        return True

    return (
        subsystem == "formal"
        and current_status == "BLOCK"
        and current_evidence == "formal_fallback"
        and dashboard_status == "BLOCK"
        and dashboard_evidence in {"tool_blocker", "regen_required"}
    )


def main() -> int:
    if not DASHBOARD.is_file():
        print(f"missing dashboard: {DASHBOARD.relative_to(ROOT)}")
        return 1

    text = DASHBOARD.read_text()
    required_terms = [
        "MVP Gate Snapshot",
        "Workstream Dashboard",
        "Claim Boundaries",
        "QEMU PASS is qemu-virt software-reference evidence",
        "PD contract PASS is preflight/scaffold evidence",
        "Product scaffold PASS means blockers are named and fail closed",
        "Benchmark BLOCK means reports are planning or dry-run evidence",
        "make benchmark-sim-metrics",
        "not performance evidence",
        "secure boot",
        "cellular",
        "Wi-Fi/BT/GNSS/NFC",
        "battery/PMIC/thermal",
        "Android CTS/VTS",
    ]
    missing_terms = [term for term in required_terms if term not in text]
    if missing_terms:
        print("dashboard missing required terms:")
        for term in missing_terms:
            print(f"  - {term}")
        return 1

    dashboard_rows = parse_table_rows(text, "## MVP Gate Snapshot")
    if not dashboard_rows:
        print("dashboard missing parseable MVP Gate Snapshot table")
        return 1

    for status in run_mvp_json():
        subsystem = status["subsystem"]
        row = dashboard_rows.get(subsystem)
        if row is None:
            print(f"dashboard MVP row is missing: {subsystem}")
            return 1
        expected = {
            "Status": status["status"].upper(),
            "Evidence class": status["evidence_class"],
            "Next action": status["next_step"],
        }
        if conservative_snapshot_allowed(subsystem, status, row):
            continue
        for column, expected_value in expected.items():
            observed = normalize_cell(row.get(column, ""))
            if observed != normalize_cell(expected_value):
                print(
                    f"dashboard MVP row is stale for {subsystem}: "
                    f"{column} is {observed!r}, expected {expected_value!r}"
                )
                return 1

    extra_rows = sorted(set(dashboard_rows) - {status["subsystem"] for status in run_mvp_json()})
    if extra_rows:
        print(
            "dashboard has MVP rows that are not emitted by check_mvp_status.py: "
            + ", ".join(extra_rows)
        )
        return 1

    for workstream in (
        "A: RTL and formal",
        "B: software, boot, OS, simulation",
        "C: PD, package, board, SI/PI",
        "D: ISP, display, real-world verification",
        "E: toolchain and upstreams",
        "F: product, security, radios, sensors, battery",
    ):
        if workstream not in text:
            print(f"dashboard missing workstream row: {workstream}")
            return 1

    print("prototype status dashboard matches current MVP gate statuses")
    return 0


if __name__ == "__main__":
    sys.exit(main())
