#!/usr/bin/env python3
"""Fail-closed check for OpenLane top-level antenna metadata warnings."""

from __future__ import annotations

import json
import sys
from argparse import ArgumentParser
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "pd/openlane/runs"
PADFRAME = ROOT / "pd/padframe/e1_demo_padframe.yaml"
REPORT = ROOT / "build/reports/antenna_metadata.json"
SCHEMA = "eliza.antenna_metadata.v1"
CLAIM_BOUNDARY = "antenna_metadata_validation_only_not_padframe_or_release_evidence"
RELEASE_PADFRAME_STEPS = (
    "select a foundry IO library with input, output, bidirectional, power, ground, ESD, corner, and filler cells",
    "instantiate those pad cells around e1_chip_top instead of using the padless core wrapper as the release top",
    "connect JTAG_TCK, JTAG_TDI, JTAG_TMS, TEST_MODE, DBG_READY, and JTAG_TDO either to real IO pads and tested internal logic or remove them from the release top",
    "archive padframe-inclusive KLayout/Magic DRC, LVS, antenna, and ESD evidence from one selected run",
)


def write_report(
    status: str,
    report_path: Path | None,
    findings: list[str],
    release: bool,
) -> None:
    evidence = ""
    if report_path is not None:
        try:
            evidence = report_path.relative_to(ROOT).as_posix()
        except ValueError:
            evidence = str(report_path)
    payload = {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "mode": "release" if release else "preflight",
        "source_report": evidence,
        "summary": {
            "release_ready": status == "pass" and release,
            "blockers": len(findings) if status == "blocked" else 0,
            "failures": len(findings) if status == "fail" else 0,
        },
        "findings": [
            {
                "code": f"antenna_metadata_{status}_{index}",
                "severity": "blocker" if status == "blocked" else "error",
                "message": finding,
                "evidence": evidence,
                "next_step": "Instantiate release IO/pad cells and archive padframe-inclusive antenna evidence.",
            }
            for index, finding in enumerate(findings, start=1)
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def latest_report() -> Path | None:
    reports = sorted(
        RUNS.glob("*/61-odb-checkdesignantennaproperties/report.yaml"),
        key=lambda path: path.stat().st_mtime,
    )
    return reports[-1] if reports else None


def padframe_release_blocked() -> bool:
    if not PADFRAME.is_file():
        return True
    data = yaml.safe_load(PADFRAME.read_text()) or {}
    gates = data.get("release_gates", {})
    gate = gates.get("padframe_release", {}) if isinstance(gates, dict) else {}
    return gate.get("blocked") is True


def missing_metadata(report_path: Path) -> dict[str, list[str]]:
    payload = yaml.safe_load(report_path.read_text()) or []
    missing: dict[str, list[str]] = {"input": [], "output": [], "inout": []}
    if not isinstance(payload, list):
        return missing
    for cell in payload:
        if not isinstance(cell, dict) or cell.get("cell") != "e1_chip_top":
            continue
        for direction in missing:
            pins = cell.get(direction, [])
            if isinstance(pins, list):
                missing[direction].extend(str(pin) for pin in pins)
    return {direction: sorted(set(pins)) for direction, pins in missing.items() if pins}


def main() -> int:
    parser = ArgumentParser(
        description="Check e1_chip_top top-level antenna metadata from OpenLane output."
    )
    parser.add_argument(
        "--release",
        action="store_true",
        help="fail if any top-level pin lacks antenna metadata",
    )
    parser.add_argument(
        "--report",
        type=Path,
        help="specific Odb.CheckDesignAntennaProperties report.yaml to inspect",
    )
    args = parser.parse_args()

    report_path = args.report if args.report else latest_report()
    if report_path is not None and not report_path.is_absolute():
        report_path = ROOT / report_path
    if report_path is None or not report_path.is_file():
        finding = "antenna metadata blocker: no OpenLane design antenna report found"
        write_report(
            "blocked" if args.release else "pass",
            report_path,
            [finding] if args.release else [],
            args.release,
        )
        if args.release:
            print(f"STATUS: BLOCKED {finding}")
        else:
            print(finding)
        return 1 if args.release else 0

    missing = missing_metadata(report_path)
    rel_report = report_path.relative_to(ROOT)
    if not missing:
        write_report("pass", report_path, [], args.release)
        print(f"antenna metadata check ok: {rel_report}")
        return 0

    findings = [
        f"{direction} pins without antenna {'gate' if direction == 'input' else 'diffusion'} information: {', '.join(pins)}"
        for direction, pins in missing.items()
    ]
    release_blocked = padframe_release_blocked()
    status = "blocked" if args.release or not release_blocked else "pass"
    write_report(status, report_path, findings if status == "blocked" else [], args.release)
    if status == "blocked":
        print(f"STATUS: BLOCKED antenna metadata check: {rel_report}")
    print(f"antenna metadata blockers in {rel_report}:")
    for direction, pins in missing.items():
        label = "gate" if direction == "input" else "diffusion"
        print(f"  - {direction} pins without antenna {label} information: {', '.join(pins)}")

    if release_blocked:
        print(
            "  - padframe release remains blocked, so this is documented as a "
            "non-release core-wrapper limitation until real IO/pad cells are instantiated"
        )
        print("  - release requires real padcell integration steps:")
        for step in RELEASE_PADFRAME_STEPS:
            print(f"    * {step}")

    return 1 if args.release or not release_blocked else 0


if __name__ == "__main__":
    sys.exit(main())
