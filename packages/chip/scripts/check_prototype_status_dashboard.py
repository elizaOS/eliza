#!/usr/bin/env python3
"""Validate the prototype status dashboard against current MVP gate output."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "docs/project/prototype-status-dashboard.md"
REPORT = ROOT / "build/reports/prototype_status_dashboard.json"


def write_report(status: str, findings: list[dict[str, str]]) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": "eliza.prototype_status_dashboard.v1",
        "status": status,
        "claim_boundary": "dashboard_consistency_only_not_boot_runtime_or_release_evidence",
        "summary": {"findings": len(findings)},
        "findings": findings,
        "evidence": {"dashboard": str(DASHBOARD.relative_to(ROOT))},
    }
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def blocker(code: str, message: str, evidence: str, next_step: str) -> dict[str, str]:
    return {
        "code": code,
        "severity": "blocker",
        "message": message,
        "evidence": evidence,
        "next_step": next_step,
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


def main() -> int:
    if not DASHBOARD.is_file():
        message = f"missing dashboard: {DASHBOARD.relative_to(ROOT)}"
        write_report(
            "fail",
            [blocker("prototype_dashboard_missing", message, str(DASHBOARD), "Restore the prototype status dashboard.")],
        )
        print(message)
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
        findings = [
            blocker(
                "prototype_dashboard_missing_required_term",
                "prototype status dashboard is missing a required claim-boundary term",
                term,
                "Update the dashboard claim-boundary text so it keeps scaffold/reference evidence scoped honestly.",
            )
            for term in missing_terms
        ]
        write_report("fail", findings)
        print("dashboard missing required terms:")
        for term in missing_terms:
            print(f"  - {term}")
        return 1

    dashboard_rows = parse_table_rows(text, "## MVP Gate Snapshot")
    if not dashboard_rows:
        write_report(
            "fail",
            [
                blocker(
                    "prototype_dashboard_missing_mvp_table",
                    "dashboard is missing a parseable MVP Gate Snapshot table",
                    "## MVP Gate Snapshot",
                    "Restore the MVP Gate Snapshot table with Subsystem, Status, Evidence class, and Next action columns.",
                )
            ],
        )
        print("dashboard missing parseable MVP Gate Snapshot table")
        return 1

    for status in run_mvp_json():
        subsystem = status["subsystem"]
        row = dashboard_rows.get(subsystem)
        if row is None:
            write_report(
                "fail",
                [
                    blocker(
                        "prototype_dashboard_missing_mvp_row",
                        "dashboard MVP row is missing",
                        subsystem,
                        "Regenerate or update the dashboard row from check_mvp_status.py --json.",
                    )
                ],
            )
            print(f"dashboard MVP row is missing: {subsystem}")
            return 1
        expected = {
            "Status": status["status"].upper(),
            "Evidence class": status["evidence_class"],
            "Next action": status["next_step"],
        }
        for column, expected_value in expected.items():
            observed = normalize_cell(row.get(column, ""))
            if observed != normalize_cell(expected_value):
                write_report(
                    "fail",
                    [
                        blocker(
                            "prototype_dashboard_stale_mvp_row",
                            "dashboard MVP row is stale against check_mvp_status.py",
                            f"{subsystem}: {column} is {observed!r}, expected {expected_value!r}",
                            "Update docs/project/prototype-status-dashboard.md from the current MVP gate output.",
                        )
                    ],
                )
                print(
                    f"dashboard MVP row is stale for {subsystem}: "
                    f"{column} is {observed!r}, expected {expected_value!r}"
                )
                return 1

    extra_rows = sorted(set(dashboard_rows) - {status["subsystem"] for status in run_mvp_json()})
    if extra_rows:
        write_report(
            "fail",
            [
                blocker(
                    "prototype_dashboard_extra_mvp_rows",
                    "dashboard has MVP rows not emitted by check_mvp_status.py",
                    ", ".join(extra_rows),
                    "Remove stale dashboard rows or teach check_mvp_status.py to emit them.",
                )
            ],
        )
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
            write_report(
                "fail",
                [
                    blocker(
                        "prototype_dashboard_missing_workstream_row",
                        "dashboard missing required workstream row",
                        workstream,
                        "Restore all required workstream rows so ownership of boot and runtime gaps remains visible.",
                    )
                ],
            )
            print(f"dashboard missing workstream row: {workstream}")
            return 1

    write_report("pass", [])
    print("prototype status dashboard matches current MVP gate statuses")
    return 0


if __name__ == "__main__":
    sys.exit(main())
