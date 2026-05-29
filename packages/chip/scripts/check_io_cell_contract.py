#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build/reports/io_cell_contract.json"
CONTRACT_PATH = ROOT / "docs/spec-db/io-cell-contract.yaml"
IO_CELL_ROOT = ROOT / "pd/io_cells"
PINOUTS = [
    ROOT / "package/e1-demo-pinout.yaml",
    ROOT / "package/e1-phone-bga-pinout.yaml",
]

IO_CELL_CLASSES = [
    "LVCMOS_3V3",
    "LVCMOS_3V3_OD",
    "LVCMOS_1V8",
    "LVCMOS_1V8_SCHMITT",
    "LVCMOS_1V8_CLK",
    "ANALOG_PASSTHROUGH",
    "POWER_PAD",
    "GROUND_PAD",
    "NC_PAD",
    "LPDDR5X_DQ",
    "LPDDR5X_DQS",
    "LPDDR5X_DM",
    "LPDDR5X_CA",
    "LPDDR5X_CK",
    "MIPI_DPHY",
    "USB2_PHY",
    "USB3_SS",
    "JTAG_TCK",
]

REQUIRED_ARTIFACTS = {
    "liberty": ("*.lib",),
    "lef": ("*.lef",),
    "gds": ("*.gds",),
    "spice": ("*.sp", "*.spi", "*.spice"),
    "ibis": ("*.ibs",),
    "esd_latchup_report": ("esd_latchup_report.pdf",),
    "corner_coverage_report": ("corner_coverage_report.pdf",),
}

PAD_TYPE_TO_CLASS = {
    "bidirectional": "LVCMOS_1V8",
    "clock": "LVCMOS_1V8_CLK",
    "digital_input": "LVCMOS_1V8",
    "digital_output": "LVCMOS_1V8",
    "ground": "GROUND_PAD",
    "lpddr_ca": "LPDDR5X_CA",
    "lpddr_ck": "LPDDR5X_CK",
    "lpddr_dm": "LPDDR5X_DM",
    "lpddr_dq": "LPDDR5X_DQ",
    "lpddr_dqs": "LPDDR5X_DQS",
    "mipi_dphy": "MIPI_DPHY",
    "no_connect": "NC_PAD",
    "open_drain": "LVCMOS_1V8",
    "power": "POWER_PAD",
    "schmitt_input": "LVCMOS_1V8_SCHMITT",
    "usb2_phy": "USB2_PHY",
    "usb3_phy": "USB3_SS",
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def code_from_text(text: str, fallback: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return code or fallback


def list_values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def pinout_pad_types(path: Path) -> list[str]:
    if not path.is_file():
        return []
    data = load_yaml_object(path)
    pad_types = {
        str(pin.get("pad_type"))
        for pin in list_values(data.get("pins"))
        if isinstance(pin, dict) and pin.get("pad_type")
    }
    return sorted(pad_types)


def present_artifacts(class_dir: Path) -> list[str]:
    present: list[str] = []
    for artifact, patterns in REQUIRED_ARTIFACTS.items():
        if any(list(class_dir.glob(pattern)) for pattern in patterns):
            present.append(artifact)
    return present


def class_statuses() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for class_name in IO_CELL_CLASSES:
        class_dir = IO_CELL_ROOT / class_name
        present = present_artifacts(class_dir) if class_dir.is_dir() else []
        missing = [artifact for artifact in REQUIRED_ARTIFACTS if artifact not in present]
        if not class_dir.is_dir():
            reason = (
                f"{rel(class_dir)}/ is missing; awaiting foundry deliverables: "
                "*.lib, *.lef, *.gds, *.sp, *.ibs, esd_latchup_report.pdf, "
                "corner_coverage_report.pdf"
            )
        elif missing:
            reason = (
                f"{rel(class_dir)}/ is incomplete; awaiting foundry deliverables: "
                + ", ".join(missing)
            )
        else:
            reason = ""
        rows.append(
            {
                "class": class_name,
                "status": "DELIVERED" if not missing else "BLOCKED",
                "directory_exists": class_dir.is_dir(),
                "artifacts_present": present,
                "artifacts_missing": missing,
                "blocked_reason": reason,
            }
        )
    return rows


def structured_findings(report: dict[str, Any]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    if not CONTRACT_PATH.is_file():
        findings.append(
            {
                "code": "io_cell_contract_source_missing",
                "severity": "blocker",
                "message": f"{rel(CONTRACT_PATH)} is missing",
                "evidence": rel(CONTRACT_PATH),
                "next_step": (
                    "Restore or regenerate the IO-cell source contract so pad "
                    "type coverage is reproducible instead of relying on a stale "
                    "generated report."
                ),
            }
        )
    for row in report.get("class_statuses", []):
        if not isinstance(row, dict) or row.get("status") == "DELIVERED":
            continue
        class_name = str(row.get("class", "io_cell"))
        findings.append(
            {
                "code": f"io_cell_class_blocked_{code_from_text(class_name, 'class')}",
                "severity": "blocker",
                "message": row.get("blocked_reason") or f"{class_name} is incomplete",
                "evidence": {
                    "class": class_name,
                    "missing": row.get("artifacts_missing", []),
                },
                "next_step": (
                    "Archive the foundry IO-cell Liberty, LEF, GDS, SPICE, IBIS, "
                    "ESD/latchup, and corner-coverage deliverables before using "
                    "this pad class for board, package, or tapeout readiness."
                ),
            }
        )
    for pad_type in report.get("pad_types_unmapped", []):
        findings.append(
            {
                "code": f"io_cell_pad_type_unmapped_{code_from_text(str(pad_type), 'pad')}",
                "severity": "blocker",
                "message": f"pinout pad_type {pad_type} has no IO-cell class mapping",
                "evidence": "pad_types_unmapped",
                "next_step": (
                    "Map the pad type to a released IO-cell class or remove it "
                    "from the package pinout before claiming padframe coverage."
                ),
            }
        )
    return findings


def build_report() -> dict[str, Any]:
    pinouts = {rel(path): pinout_pad_types(path) for path in PINOUTS}
    observed_pad_types = sorted({pad for pads in pinouts.values() for pad in pads})
    mapped = sorted(pad for pad in observed_pad_types if pad in PAD_TYPE_TO_CLASS)
    unmapped = sorted(set(observed_pad_types) - set(mapped))
    statuses = class_statuses()
    delivered = [row for row in statuses if row["status"] == "DELIVERED"]
    blocked = [row for row in statuses if row["status"] == "BLOCKED"]
    incomplete = [
        row
        for row in statuses
        if row["status"] == "BLOCKED" and row["directory_exists"] and row["artifacts_present"]
    ]
    report: dict[str, Any] = {
        "generated_utc": datetime.now(UTC).isoformat(),
        "contract_path": rel(CONTRACT_PATH),
        "contract_version": 1,
        "io_cell_classes_declared": IO_CELL_CLASSES,
        "alias_targets_unknown": [],
        "pinouts": pinouts,
        "pad_types_mapped": mapped,
        "pad_types_unmapped": unmapped,
        "class_statuses": statuses,
        "status": "PASS" if not blocked and not unmapped and CONTRACT_PATH.is_file() else "BLOCKED",
        "claim_boundary": (
            "IO-cell contract audit only; not foundry IO-cell release, not ESD "
            "or latchup signoff, not IBIS/SI proof, not padframe tapeout "
            "readiness, and not board/package release evidence."
        ),
        "summary": {
            "classes_total": len(statuses),
            "classes_delivered": len(delivered),
            "classes_incomplete": len(incomplete),
            "classes_blocked": len(blocked),
            "pad_types_total": len(observed_pad_types),
            "pad_types_mapped": len(mapped),
            "pad_types_unmapped": len(unmapped),
        },
    }
    report["findings"] = structured_findings(report)
    return report


def validate_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("status") not in {"PASS", "BLOCKED"}:
        errors.append("status must be PASS or BLOCKED")
    if report.get("status") == "PASS" and report.get("findings"):
        errors.append("PASS report must not have findings")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
    elif summary.get("classes_blocked", 0) > 0 and not report.get("findings"):
        errors.append("findings must list structured IO-cell blockers")
    for token in (
        "not foundry IO-cell release",
        "not ESD or latchup signoff",
        "not IBIS/SI proof",
        "not padframe tapeout readiness",
        "not board/package release evidence",
    ):
        if token not in str(report.get("claim_boundary", "")):
            errors.append(f"claim boundary missing {token}")
    return errors


def main() -> int:
    report = build_report()
    errors = validate_report(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(
        "STATUS: "
        f"{report['status']} io_cell_contract classes_blocked="
        f"{report['summary']['classes_blocked']} pad_types_unmapped="
        f"{report['summary']['pad_types_unmapped']} report={rel(OUT)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
