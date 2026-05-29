#!/usr/bin/env python3
"""Fail-closed check for OpenLane top-level antenna metadata warnings."""

from __future__ import annotations

import json
import sys
from argparse import ArgumentParser
from datetime import UTC, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "pd/openlane/runs"
DERIVED_RUNS = ROOT / "build/evidence/openlane"
PADFRAME = ROOT / "pd/padframe/e1_demo_padframe.yaml"
REPORT = ROOT / "build/reports/antenna_metadata.json"
SCHEMA = "eliza.antenna_metadata.v1"
CLAIM_BOUNDARY = "antenna_metadata_validation_only_not_padframe_or_release_evidence"
FAIL_EXIT = 1
BLOCKED_EXIT = 2
ANTENNA_REPORT_GLOB = "*/*-odb-checkdesignantennaproperties/report.yaml"
DERIVED_ANTENNA_REPORT_GLOB = "*/*-odb-checkdesignantennaproperties/report.yaml"
RELEASE_PADFRAME_STEPS = (
    "select a foundry IO library with input, output, bidirectional, power, ground, ESD, corner, and filler cells",
    "instantiate those pad cells around e1_chip_top instead of using the padless core wrapper as the release top",
    "connect JTAG_TCK, JTAG_TDI, JTAG_TMS, TEST_MODE, DBG_READY, and JTAG_TDO either to real IO pads and tested internal logic or remove them from the release top",
    "archive padframe-inclusive KLayout/Magic DRC, LVS, antenna, and ESD evidence from one selected run",
)


class MissingTopCellError(ValueError):
    """Raised when an OpenLane antenna report is for another design."""


def write_report(
    status: str,
    report_path: Path | None,
    findings: list[str],
    release: bool,
    *,
    missing: dict[str, list[str]] | None = None,
    blocker_categories: dict[str, int] | None = None,
    release_blocked: bool | None = None,
    missing_top_cell: bool = False,
) -> None:
    evidence = ""
    if report_path is not None:
        try:
            evidence = report_path.relative_to(ROOT).as_posix()
        except ValueError:
            evidence = str(report_path)
    search_roots = []
    for root in (RUNS, DERIVED_RUNS):
        try:
            search_roots.append(root.relative_to(ROOT).as_posix())
        except ValueError:
            search_roots.append(str(root))
    missing = missing or {}
    blocker_categories = blocker_categories or {}
    payload = {
        "schema": SCHEMA,
        "status": status,
        "generated_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        "mode": "release" if release else "preflight",
        "source_report": evidence,
        "release_credit": False,
        "summary": {
            "release_ready": status == "pass" and release,
            "release_credit": False,
            "blockers": len(findings) if status == "blocked" else 0,
            "failures": len(findings) if status == "fail" else 0,
            "source_report_present": report_path is not None and report_path.is_file(),
            "source_report_missing_e1_chip_top": missing_top_cell,
            "missing_e1_chip_top_report_count": 1 if missing_top_cell else 0,
            "missing_pin_count": sum(len(pins) for pins in missing.values()),
            "missing_input_gate_metadata_count": len(missing.get("input", [])),
            "missing_output_diffusion_metadata_count": len(missing.get("output", [])),
            "missing_inout_diffusion_metadata_count": len(missing.get("inout", [])),
            "padframe_release_blocked": bool(release_blocked),
            "release_step_count": len(RELEASE_PADFRAME_STEPS),
        },
        "blocker_categories": blocker_categories,
        "report_search": {
            "roots": search_roots,
            "globs": [ANTENNA_REPORT_GLOB, DERIVED_ANTENNA_REPORT_GLOB],
        },
        "missing_metadata": missing,
        "release_padframe_steps": list(RELEASE_PADFRAME_STEPS),
        "findings": [
            {
                "code": f"antenna_metadata_{status}_{index}",
                "severity": "blocker" if status == "blocked" else "error",
                "message": finding,
                "evidence": evidence,
                "next_step": (
                    "Regenerate the OpenLane antenna metadata report for e1_chip_top, "
                    "then instantiate release IO/pad cells and archive padframe-inclusive antenna evidence."
                    if missing_top_cell
                    else "Instantiate release IO/pad cells and archive padframe-inclusive antenna evidence."
                ),
            }
            for index, finding in enumerate(findings, start=1)
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def latest_report() -> Path | None:
    reports = sorted(
        [*RUNS.glob(ANTENNA_REPORT_GLOB), *DERIVED_RUNS.glob(DERIVED_ANTENNA_REPORT_GLOB)],
        key=lambda path: path.stat().st_mtime,
    )
    return reports[-1] if reports else None


def display_path(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


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
        raise ValueError("OpenLane antenna report schema error: top-level payload is not a list")
    top_cell_seen = False
    for cell in payload:
        if not isinstance(cell, dict):
            raise ValueError("OpenLane antenna report schema error: cell entry is not a mapping")
        if cell.get("cell") != "e1_chip_top":
            continue
        top_cell_seen = True
        for direction in missing:
            pins = cell.get(direction, [])
            if isinstance(pins, list):
                missing[direction].extend(str(pin) for pin in pins)
    if not top_cell_seen:
        raise MissingTopCellError(
            "OpenLane antenna report does not include cell=e1_chip_top"
        )
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
            "blocked",
            report_path,
            [finding],
            args.release,
            blocker_categories={"missing_openlane_antenna_metadata_report": 1},
            release_blocked=padframe_release_blocked(),
        )
        print(f"STATUS: BLOCKED {finding}")
        return BLOCKED_EXIT

    try:
        missing = missing_metadata(report_path)
    except MissingTopCellError as exc:
        finding = f"antenna metadata blocker: {exc}"
        write_report(
            "blocked",
            report_path,
            [finding],
            args.release,
            blocker_categories={"missing_e1_chip_top_antenna_metadata_report": 1},
            release_blocked=padframe_release_blocked(),
            missing_top_cell=True,
        )
        print(f"STATUS: BLOCKED {finding}")
        return BLOCKED_EXIT
    except (OSError, ValueError, yaml.YAMLError) as exc:
        finding = f"antenna metadata schema error: {exc}"
        write_report(
            "fail",
            report_path,
            [finding],
            args.release,
            blocker_categories={"malformed_openlane_antenna_metadata_report": 1},
            release_blocked=padframe_release_blocked(),
        )
        print(f"STATUS: FAIL {finding}")
        return FAIL_EXIT
    rel_report = display_path(report_path)
    if not missing:
        write_report(
            "pass",
            report_path,
            [],
            args.release,
            release_blocked=padframe_release_blocked(),
        )
        print(f"antenna metadata check ok: {rel_report}")
        return 0

    findings = [
        f"{direction} pins without antenna {'gate' if direction == 'input' else 'diffusion'} information: {', '.join(pins)}"
        for direction, pins in missing.items()
    ]
    release_blocked = padframe_release_blocked()
    status = "blocked"
    blocker_categories = {
        f"missing_{direction}_{'gate' if direction == 'input' else 'diffusion'}_metadata": len(pins)
        for direction, pins in missing.items()
    }
    if release_blocked:
        blocker_categories["padframe_release_blocked"] = 1
    write_report(
        status,
        report_path,
        findings,
        args.release,
        missing=missing,
        blocker_categories=blocker_categories,
        release_blocked=release_blocked,
    )
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

    return BLOCKED_EXIT


if __name__ == "__main__":
    sys.exit(main())
