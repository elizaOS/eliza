#!/usr/bin/env python3
"""Roll up Debian multiarch GUI/kiosk evidence for chip OS closure.

This report intentionally imports evidence from packages/os/linux/elizaos
instead of re-inspecting ISOs. It makes arm64/riscv64 GUI parity visible to the
chip objective matrix while preserving the OS reports' claim boundaries.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1] if len(ROOT.parents) > 1 else ROOT
OS_ROOT = REPO / "packages/os/linux/elizaos"
MATRIX = OS_ROOT / "evidence/multiarch_boot_matrix.json"
REPORTS = {
    "arm64": OS_ROOT / "evidence/arm64_gui_kiosk_iso_check.json",
    "riscv64": OS_ROOT / "evidence/riscv64_gui_kiosk_iso_check.json",
}
REPORT = ROOT / "build/reports/linux_multiarch_gui_parity.json"

SCHEMA = "eliza.linux_multiarch_gui_parity.v1"
CLAIM_BOUNDARY = "multiarch_gui_parity_rollup_only_not_runtime_screenshot_or_chip_boot_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "runtime_screenshot_claim_allowed": False,
    "chip_boot_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
REQUIRED_ARCHES = ("arm64", "riscv64")
REQUIRED_GUI_SCHEMA = "eliza.os.linux.gui_kiosk_iso_check.v1"
REQUIRED_MATRIX_SCHEMA = "eliza.os.linux.multiarch_boot_matrix.v1"


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    arch: str
    message: str
    evidence: str
    next_step: str


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        try:
            return path.relative_to(REPO).as_posix()
        except ValueError:
            return str(path)


def load_json(path: Path, findings: list[Finding], arch: str) -> dict[str, Any]:
    if not path.is_file():
        findings.append(
            Finding(
                f"linux_multiarch_gui_{arch}_report_missing",
                "blocker",
                arch,
                "GUI/kiosk ISO evidence report is missing",
                rel(path),
                f"Run make -C packages/os/linux/elizaos {arch}-gui-kiosk-iso-check after producing the {arch} ISO.",
            )
        )
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        findings.append(
            Finding(
                f"linux_multiarch_gui_{arch}_report_invalid_json",
                "blocker",
                arch,
                "GUI/kiosk ISO evidence report is invalid JSON",
                f"{rel(path)}: {exc}",
                "Regenerate the report from the OS-side checker.",
            )
        )
        return {}
    return data if isinstance(data, dict) else {}


def matrix_row(matrix: dict[str, Any], arch: str) -> dict[str, Any]:
    for row in matrix.get("architectures", []):
        if isinstance(row, dict) and row.get("arch") == arch:
            return row
    return {}


def build_report() -> dict[str, Any]:
    findings: list[Finding] = []
    matrix = load_json(MATRIX, findings, "multiarch")
    if matrix.get("schema") != REQUIRED_MATRIX_SCHEMA:
        findings.append(
            Finding(
                "linux_multiarch_gui_matrix_schema_mismatch",
                "blocker",
                "multiarch",
                "multiarch boot matrix schema mismatch",
                rel(MATRIX),
                "Regenerate packages/os/linux/elizaos/evidence/multiarch_boot_matrix.json with the OS-side updater/checker.",
            )
        )

    arches: dict[str, dict[str, Any]] = {}
    for arch, path in REPORTS.items():
        gui = load_json(path, findings, arch)
        row = matrix_row(matrix, arch)
        arch_findings: list[str] = []

        if gui.get("schema") != REQUIRED_GUI_SCHEMA:
            arch_findings.append("GUI/kiosk report schema mismatch")
        if gui.get("arch") != arch:
            arch_findings.append(f"GUI/kiosk report arch is {gui.get('arch')!r}")
        if gui.get("status") != "pass":
            arch_findings.append(f"GUI/kiosk report status is {gui.get('status')!r}")
        if row.get("status") != "candidate":
            arch_findings.append(f"multiarch row status is {row.get('status')!r}")
        if not row.get("iso"):
            arch_findings.append("multiarch row does not record an ISO")
        if not row.get("evidence"):
            arch_findings.append("multiarch row does not record boot evidence")

        for item in arch_findings:
            findings.append(
                Finding(
                    f"linux_multiarch_gui_{arch}_{''.join(c.lower() if c.isalnum() else '_' for c in item).strip('_')[:64]}",
                    "blocker",
                    arch,
                    item,
                    rel(path),
                    (
                        f"Build and boot the {arch} Debian ISO, run the OS-side GUI/kiosk "
                        "checker, then promote passing boot evidence into the multiarch matrix."
                    ),
                )
            )

        arches[arch] = {
            "gui_report": rel(path),
            "gui_status": gui.get("status"),
            "gui_payload_state": "proven" if gui.get("status") == "pass" else "blocked",
            "matrix_status": row.get("status"),
            "iso": row.get("iso"),
            "boot_evidence": row.get("evidence"),
            "proof_state": "proven" if not arch_findings else "blocked",
            "claim_boundary": gui.get("claim_boundary"),
        }

    status = "pass" if not findings else "blocked"
    return {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "sources": {
            "multiarch_boot_matrix": rel(MATRIX),
            "gui_reports": {arch: rel(path) for arch, path in REPORTS.items()},
        },
        "arches": arches,
        "findings": [asdict(item) for item in findings],
        "summary": {
            "required_arches": len(REQUIRED_ARCHES),
            "proven_arches": sum(
                1 for item in arches.values() if item.get("proof_state") == "proven"
            ),
            "gui_payload_proven_arches": sum(
                1 for item in arches.values() if item.get("gui_payload_state") == "proven"
            ),
            "blocked_arches": sum(
                1 for item in arches.values() if item.get("proof_state") != "proven"
            ),
            "release_claim_allowed": False,
        },
    }


def main() -> int:
    report = build_report()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    summary = report["summary"]
    print(
        f"STATUS: {str(report['status']).upper()} linux_multiarch_gui_parity "
        f"proven_arches={summary['proven_arches']} blocked_arches={summary['blocked_arches']} "
        f"report={rel(REPORT)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
