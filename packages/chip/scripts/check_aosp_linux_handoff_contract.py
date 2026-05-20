#!/usr/bin/env python3
"""Static AOSP Linux handoff contract gate for the chip/OS objective.

The executable handoff path is split across the host preflight, device import,
Android simulator runner, and Android sim report checker. This gate keeps the
unified readiness view honest by treating missing AOSP checkout/tooling and
placeholder QEMU/Renode stages as BLOCKED for the objective.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import check_aosp_linux_preflight

ROOT = Path(__file__).resolve().parents[1]
BOOT_SCRIPT = ROOT / "scripts/boot_android_simulator.sh"
HANDOFF_SCRIPT = ROOT / "scripts/run_aosp_linux_handoff.sh"
ANDROID_SIM_CHECK = ROOT / "scripts/check_android_sim_boot.py"
REPORT = ROOT / "build/reports/aosp_linux_handoff_contract.json"

SCHEMA = "eliza.aosp_linux_handoff_contract.v1"
CLAIM_BOUNDARY = "static_aosp_linux_handoff_contract_only_not_aosp_runtime_evidence"
REQUIRED_HANDOFF_COMMANDS = (
    "scripts/check_aosp_linux_preflight.py --write-report",
    "scripts/run_aosp_linux_handoff.sh --build-only",
    "scripts/boot_android_simulator.sh --run-cuttlefish",
    "scripts/check_android_sim_boot.py",
    "scripts/check_software_bsp.py aosp --require-evidence",
)


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
) -> None:
    if condition:
        findings.append(Finding(code, "blocker", message, evidence, next_step))


def preflight_payload(aosp_dir: str | None) -> dict[str, Any]:
    namespace = argparse.Namespace(
        aosp_dir=aosp_dir,
        require_qemu=False,
        json=True,
        write_report=False,
    )
    _rc, report = check_aosp_linux_preflight.build_report(namespace)
    return report


def track_blockers(report: dict[str, Any], track: str) -> list[str]:
    tracks = report.get("execution_tracks", {})
    if not isinstance(tracks, dict):
        return []
    payload = tracks.get(track, {})
    blockers = payload.get("blockers", []) if isinstance(payload, dict) else []
    return [str(item) for item in blockers if isinstance(item, str)]


def all_track_blockers(report: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for track in ("import", "build", "cuttlefish", "compatibility_intake", "qemu", "renode"):
        out.extend(f"{track}: {item}" for item in track_blockers(report, track))
    return out


def run_check(args: argparse.Namespace) -> dict[str, Any]:
    findings: list[Finding] = []
    inputs = (BOOT_SCRIPT, HANDOFF_SCRIPT, ANDROID_SIM_CHECK)
    for path in inputs:
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required AOSP handoff input is missing",
            rel(path),
            "Restore the missing handoff script/checker before evaluating AOSP runtime readiness.",
        )
    if findings:
        return payload(findings, {})

    aosp_dir = args.aosp_dir if args.aosp_dir is not None else os.environ.get("AOSP_DIR", "")
    report = preflight_payload(aosp_dir or None)
    boot_text = read_text(BOOT_SCRIPT)
    handoff_text = read_text(HANDOFF_SCRIPT)
    sim_check_text = read_text(ANDROID_SIM_CHECK)
    blockers = [str(item) for item in report.get("blockers", []) if isinstance(item, str)]
    tracks = report.get("execution_tracks", {})
    handoff_commands = [
        str(item) for item in report.get("handoff_commands", []) if isinstance(item, str)
    ]

    add_if(
        findings,
        report.get("status") != "pass",
        "aosp_linux_preflight_blocked",
        "AOSP Linux handoff preflight is blocked in the current command environment",
        "; ".join(blockers or all_track_blockers(report)),
        "Set AOSP_DIR to a valid checkout and provide the required host tools before claiming AOSP handoff readiness.",
    )
    for track in ("import", "build", "cuttlefish", "compatibility_intake", "qemu", "renode"):
        track_payload = tracks.get(track, {}) if isinstance(tracks, dict) else {}
        add_if(
            findings,
            isinstance(track_payload, dict) and track_payload.get("status") != "ready",
            f"aosp_{track}_track_blocked",
            f"AOSP {track} execution track is not ready",
            "; ".join(track_blockers(report, track)),
            "Clear this preflight track with a real AOSP checkout, host tools, and target-specific evidence commands.",
        )
    add_if(
        findings,
        not os.environ.get("AOSP_QEMU_SMOKE_COMMAND"),
        "aosp_qemu_smoke_command_unset",
        "AOSP QEMU smoke command is unset",
        "AOSP_QEMU_SMOKE_COMMAND",
        "Define a target-specific QEMU command that boots the AOSP artifacts and records console/adb markers.",
    )
    add_if(
        findings,
        not os.environ.get("AOSP_RENODE_SMOKE_COMMAND"),
        "aosp_renode_smoke_command_unset",
        "AOSP Renode smoke command is unset",
        "AOSP_RENODE_SMOKE_COMMAND",
        "Define a target-specific Renode script that boots Android-capable firmware/kernel/userspace evidence.",
    )
    add_if(
        findings,
        "qemu-system-riscv64 --version" in boot_text
        and "requires kernel/system image wiring" in boot_text,
        "aosp_qemu_stage_is_version_placeholder",
        "AOSP QEMU stage checks tool/version context rather than booting Android artifacts",
        rel(BOOT_SCRIPT),
        "Replace the QEMU stage with a real AOSP riscv64 image boot and required boot/launcher/agent markers.",
    )
    add_if(
        findings,
        "renode --version" in boot_text
        and "requires a real Renode e1 SoC Android boot script" in boot_text,
        "aosp_renode_stage_is_version_placeholder",
        "AOSP Renode stage checks tool/version context rather than booting Android artifacts",
        rel(BOOT_SCRIPT),
        "Replace the Renode stage with a real e1 SoC Android boot script or remove it from required full evidence.",
    )
    for required in REQUIRED_HANDOFF_COMMANDS:
        add_if(
            findings,
            not any(required in command for command in handoff_commands),
            "aosp_preflight_missing_handoff_command",
            "AOSP preflight report omits a required handoff command",
            required,
            "Keep the preflight report aligned with the executable AOSP handoff workflow.",
        )
    add_if(
        findings,
        "check_aosp_linux_preflight.py" not in handoff_text
        or "boot_android_simulator.sh" not in handoff_text
        or "check_android_sim_boot.py" not in handoff_text,
        "aosp_handoff_script_missing_required_stage",
        "AOSP handoff script does not include every preflight/boot/report stage",
        rel(HANDOFF_SCRIPT),
        "Ensure run_aosp_linux_handoff.sh runs preflight, import, boot_android_simulator, android sim check, and strict BSP evidence checks.",
    )
    add_if(
        findings,
        "not e1-chip hardware ABI proof" not in sim_check_text,
        "android_sim_check_missing_chip_boundary",
        "Android simulator checker does not enforce the non-chip-hardware claim boundary",
        rel(ANDROID_SIM_CHECK),
        "Require the Android simulator report to distinguish reference virtual-device evidence from e1 chip ABI proof.",
    )

    evidence = {
        "preflight_status": report.get("status"),
        "preflight_blockers": blockers,
        "execution_tracks": {
            key: value.get("status") if isinstance(value, dict) else None
            for key, value in tracks.items()
        }
        if isinstance(tracks, dict)
        else {},
        "handoff_commands": handoff_commands,
        "aosp_dir": report.get("aosp_dir"),
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, Any]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {"blockers": len(blockers), "findings": len(findings)},
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} aosp.linux_handoff_contract")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aosp-dir", default=None)
    parser.add_argument(
        "--report",
        default=str(REPORT),
        help=f"report path (default: {REPORT.relative_to(ROOT)})",
    )
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(list(argv))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report = run_check(args)
    write_report(report, Path(args.report))
    if not args.json_only:
        print_summary(report)
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
