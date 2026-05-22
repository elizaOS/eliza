#!/usr/bin/env python3
"""Generate a dependency-ranked closure plan for chip Linux/AOSP bring-up.

The objective evidence matrix says what is blocked. This report orders those
blocked requirements so prerequisite tooling, chip/AP boot, firmware, and ABI
work are not hidden behind downstream launcher or phone-runtime symptoms.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "build/reports"
MATRIX = REPORT_DIR / "chip-os-objective-evidence-matrix.json"
INVENTORY = REPORT_DIR / "chip-os-boot-gap-inventory.json"
REPORT = REPORT_DIR / "chip-os-closure-plan.json"

SCHEMA = "eliza.chip_os_closure_plan.v1"
CLAIM_BOUNDARY = "closure_plan_only_not_boot_or_launcher_evidence"


@dataclass(frozen=True)
class Phase:
    ident: str
    priority: str
    title: str
    requirement_ids: tuple[str, ...]
    rationale: str
    exit_criteria: str


PHASES: tuple[Phase, ...] = (
    Phase(
        "p0_workflow_evidence_plumbing",
        "P0",
        "Keep blocker evidence complete and runnable",
        (
            "environment_preflight",
            "aggregate_blocker_traceability",
            "os_rv64_qemu_tooling",
        ),
        "Without runnable tooling and complete structured reports, later boot claims cannot be reviewed or reproduced.",
        "All nonpassing gates remain covered by reports, and qemu-system-riscv64 plus required external paths are available to the OS/chip checks.",
    ),
    Phase(
        "p1_chip_ap_boot_base",
        "P1",
        "Make the selected chip/AP emulator boot Linux for real",
        (
            "chip_abi_dts_peripherals",
            "firmware_boot_chain",
            "linux_android_memory_platform",
            "generated_ap_linux_boot",
        ),
        "Linux and AOSP launcher work depends on a real AP target with firmware handoff, memory, interrupts, UART, and device ABI evidence.",
        "Generated AP smoke reaches accepted OpenSBI, kernel command line, initramfs/init, and PASS markers against an e1-compatible ABI.",
    ),
    Phase(
        "p2_linux_fork_agent",
        "P2",
        "Bind the Linux fork and Eliza agent to the chip/AP target",
        (
            "software_bsp_external_evidence",
            "linux_fork_chip_boot",
            "cross_fork_agent_payload_static_contract",
            "linux_agent_liveness",
        ),
        "The Debian/RV64 fork must stop being qemu-virt-only and must package and start the actual Eliza agent.",
        "Linux manifest includes chip-target boot and agent-live evidence, with active service and health/API smoke.",
    ),
    Phase(
        "p3_aosp_boot_launcher_agent",
        "P3",
        "Boot the selected AOSP product and prove launcher plus agent",
        (
            "aosp_chip_handoff",
            "aosp_full_virtual_device_boot",
            "android_app_riscv64_payload",
            "android_launcher_foreground",
            "android_agent_health",
        ),
        "AOSP build, boot, APK ABI, HOME role, foreground activity, and local-agent health must line up on one selected riscv64/chip-emulator product.",
        "AOSP report is full-evidence PASS and launcher runtime evidence proves HOME foreground, service process, /api/health ready, and clean logcat.",
    ),
    Phase(
        "p4_no_issues_phone_runtime",
        "P4",
        "Close phone runtime surfaces for no-issues operation",
        ("phone_runtime_surfaces",),
        "A booted launcher is not enough if display/HWC, media, radio, sensors, PMIC, power, and thermal surfaces are absent or placeholder-scoped.",
        "Phone runtime readiness report passes with real runtime evidence for every required surface.",
    ),
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def inventory_codes(inventory: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    by_report: dict[str, list[dict[str, Any]]] = {}
    for entry in inventory.get("detailed_blockers", []):
        if not isinstance(entry, dict):
            continue
        source = entry.get("source_report")
        if isinstance(source, str):
            by_report.setdefault(source, []).append(entry)
    return by_report


def requirement_rows(matrix: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = matrix.get("requirements", [])
    return {
        str(row.get("id")): row
        for row in rows
        if isinstance(row, dict) and isinstance(row.get("id"), str)
    }


def phase_row(
    phase: Phase,
    requirements: dict[str, dict[str, Any]],
    blockers_by_report: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    req_rows = [requirements[ident] for ident in phase.requirement_ids if ident in requirements]
    open_rows = [row for row in req_rows if row.get("proof_state") not in {"proven"}]
    source_reports = sorted(
        {str(row.get("source_report")) for row in req_rows if row.get("source_report")}
    )
    blocker_entries: list[dict[str, Any]] = []
    for source in source_reports:
        blocker_entries.extend(blockers_by_report.get(source, []))
    top_codes = []
    seen: set[str] = set()
    for entry in blocker_entries:
        code = entry.get("code")
        if not isinstance(code, str) or code in seen:
            continue
        seen.add(code)
        top_codes.append(
            {
                "code": code,
                "source_report": entry.get("source_report"),
                "message": entry.get("message"),
                "next_step": entry.get("next_step"),
            }
        )
        if len(top_codes) >= 12:
            break
    for row in req_rows:
        for code in row.get("source_finding_codes", []):
            if not isinstance(code, str) or code in seen:
                continue
            seen.add(code)
            top_codes.append(
                {
                    "code": code,
                    "source_report": row.get("source_report"),
                    "message": row.get("description"),
                    "next_step": row.get("closure_evidence"),
                }
            )
            if len(top_codes) >= 12:
                break
        if len(top_codes) >= 12:
            break
    state = "closed" if not open_rows else "blocked"
    return {
        "id": phase.ident,
        "priority": phase.priority,
        "title": phase.title,
        "state": state,
        "rationale": phase.rationale,
        "exit_criteria": phase.exit_criteria,
        "requirements": [
            {
                "id": row.get("id"),
                "proof_state": row.get("proof_state"),
                "source_report": row.get("source_report"),
                "current_status": row.get("current_status"),
                "description": row.get("description"),
            }
            for row in req_rows
        ],
        "open_requirement_count": len(open_rows),
        "source_reports": source_reports,
        "top_blocker_codes": top_codes,
    }


def build_plan(matrix_path: Path, inventory_path: Path) -> dict[str, Any]:
    matrix = read_json(matrix_path)
    inventory = read_json(inventory_path)
    requirements = requirement_rows(matrix)
    blockers = inventory_codes(inventory)
    phases = [phase_row(phase, requirements, blockers) for phase in PHASES]
    blocked_phases = [phase for phase in phases if phase["state"] != "closed"]
    first_blocked = blocked_phases[0]["id"] if blocked_phases else None
    return {
        "schema": SCHEMA,
        "status": "pass" if not blocked_phases else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "phases": len(phases),
            "closed_phases": len(phases) - len(blocked_phases),
            "blocked_phases": len(blocked_phases),
            "first_blocked_phase": first_blocked,
            "matrix_status": matrix.get("status"),
            "matrix_summary": matrix.get("summary"),
            "inventory_summary": inventory.get("summary"),
        },
        "sources": {
            "matrix": rel(matrix_path),
            "inventory": rel(inventory_path),
        },
        "phases": phases,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--matrix", default=str(MATRIX))
    parser.add_argument("--inventory", default=str(INVENTORY))
    parser.add_argument("--report", default=str(REPORT))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_plan(Path(args.matrix), Path(args.inventory))
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    summary = report["summary"]
    print(
        f"STATUS: {str(report['status']).upper()} chip_os_closure_plan "
        f"phases={summary['phases']} closed_phases={summary['closed_phases']} "
        f"blocked_phases={summary['blocked_phases']} "
        f"first_blocked_phase={summary['first_blocked_phase']} report={rel(output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
