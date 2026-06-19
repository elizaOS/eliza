#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs/arch/e1x-dft.md"
REPORT = ROOT / "build/reports/e1x_dft_strategy.json"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "production_claim_allowed": False,
    "silicon_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "phone_class_claim_allowed": False,
    "atpg_coverage_claim_allowed": False,
    "scan_signoff_claim_allowed": False,
}

REQUIRED_SECTIONS = (
    "## Scope and Fail-Closed Boundary",
    "## ECC Policy",
    "## MBIST Algorithm",
    "## MBIST Distribution Across the Mesh",
    "## Scan-Chain Stitching Plan",
    "## Repair Interaction with Wafer-Sort and the Repair-ROM Flow",
    "## Verification and Gates",
)

REQUIRED_PHRASES = (
    "SECDED",
    "March C-",
    "BLOCKED",
    "e1x_sram_ecc.sv",
    "e1x_mbist.sv",
    "repair ROM",
)

EVIDENCE_PATHS = [
    "docs/arch/e1x-dft.md",
    "rtl/e1x/e1x_sram_ecc.sv",
    "rtl/e1x/e1x_mbist.sv",
    "scripts/check_e1x_dft_strategy.py",
    "scripts/check_e1x_dft_cocotb.py",
    "verify/cocotb/e1x_dft/test_e1x_sram_ecc.py",
    "verify/cocotb/e1x_dft/test_e1x_mbist.py",
]


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def missing_items() -> list[str]:
    if not DOC.is_file():
        return [f"missing doc {DOC}"]
    text = DOC.read_text(encoding="utf-8")
    missing = [section for section in REQUIRED_SECTIONS if section not in text]
    missing += [f"phrase:{phrase}" for phrase in REQUIRED_PHRASES if phrase not in text]
    return missing


def main() -> int:
    doc_exists = DOC.is_file()
    text = DOC.read_text(encoding="utf-8") if doc_exists else ""
    missing_sections = [section for section in REQUIRED_SECTIONS if section not in text]
    missing_phrases = [phrase for phrase in REQUIRED_PHRASES if phrase not in text]
    missing_paths = [path for path in EVIDENCE_PATHS if not (ROOT / path).is_file()]
    blocked_markers = (
        text.count("BLOCKED"),
        text.count("foundry"),
        text.count("ATPG"),
        text.count("silicon"),
    )
    checks = []
    for check_id, condition, detail, fail_detail in [
        (
            "doc_present",
            doc_exists,
            f"{DOC.relative_to(ROOT)} present",
            f"missing doc {DOC.relative_to(ROOT)}",
        ),
        (
            "required_sections_present",
            not missing_sections,
            f"{len(REQUIRED_SECTIONS)} required DFT strategy sections present",
            "missing sections: " + ", ".join(missing_sections),
        ),
        (
            "required_phrases_present",
            not missing_phrases,
            f"{len(REQUIRED_PHRASES)} required DFT strategy phrases present",
            "missing phrases: " + ", ".join(missing_phrases),
        ),
        (
            "fail_closed_external_dependencies_named",
            all(count > 0 for count in blocked_markers),
            "strategy names BLOCKED foundry/ATPG/silicon dependencies",
            "missing fail-closed foundry/ATPG/silicon markers",
        ),
        (
            "evidence_paths_exist",
            not missing_paths,
            f"{len(EVIDENCE_PATHS)} DFT strategy evidence paths exist",
            "missing evidence paths: " + ", ".join(missing_paths),
        ),
    ]:
        status, resolved_detail = pass_fail(condition, detail, fail_detail)
        checks.append(
            {"id": f"e1x_dft_strategy_{check_id}", "status": status, "detail": resolved_detail}
        )

    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-dft-strategy",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "E1X DFT strategy document completeness gate only. It couples the SECDED ECC "
            "and March C- MBIST RTL/cocotb evidence to the fail-closed foundry scan/ATPG "
            "and silicon-test boundary; it is not scan insertion, ATPG coverage, foundry "
            "SRAM macro signoff, wafer-sort, or silicon DFT evidence."
        ),
        "evidence_paths": EVIDENCE_PATHS,
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "failing_check_count": len(failures),
            "required_section_count": len(REQUIRED_SECTIONS),
            "required_phrase_count": len(REQUIRED_PHRASES),
            "blocked_marker_count": blocked_markers[0],
            "evidence_path_count": len(EVIDENCE_PATHS),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: e1x-dft strategy doc incomplete: "
            + ", ".join(check["id"] for check in failures)
        )
        return 1
    print(
        f"PASS: e1x-dft strategy doc has all required sections; report {REPORT.relative_to(ROOT)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
