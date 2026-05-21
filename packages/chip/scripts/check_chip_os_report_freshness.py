#!/usr/bin/env python3
"""Check freshness of chip OS bring-up survey reports against source scripts."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
REPORT = ROOT / "build/reports/chip-os-report-freshness.json"

SCHEMA = "eliza.chip_os_report_freshness.v1"
CLAIM_BOUNDARY = "report_freshness_only_not_boot_or_launcher_evidence"


@dataclass(frozen=True)
class ReportSpec:
    ident: str
    report: str
    sources: tuple[str, ...]
    purpose: str


REPORTS: tuple[ReportSpec, ...] = (
    ReportSpec(
        "bring_up_status",
        "packages/chip/build/reports/chip-os-bring-up-status.json",
        ("packages/chip/scripts/aggregate_tapeout_readiness.py",),
        "strict aggregate chip OS bring-up status",
    ),
    ReportSpec(
        "boot_gap_inventory",
        "packages/chip/build/reports/chip-os-boot-gap-inventory.json",
        (
            "packages/chip/scripts/check_chip_os_boot_gap_inventory.py",
            "packages/chip/scripts/aggregate_tapeout_readiness.py",
        ),
        "nonpassing aggregate gate to detailed blocker coverage",
    ),
    ReportSpec(
        "objective_matrix",
        "packages/chip/build/reports/chip-os-objective-evidence-matrix.json",
        ("packages/chip/scripts/check_chip_os_objective_evidence_matrix.py",),
        "requirement-by-requirement objective evidence matrix",
    ),
    ReportSpec(
        "closure_plan",
        "packages/chip/build/reports/chip-os-closure-plan.json",
        ("packages/chip/scripts/check_chip_os_closure_plan.py",),
        "dependency-ranked closure plan",
    ),
    ReportSpec(
        "environment_preflight",
        "packages/chip/build/reports/chip-os-environment-preflight.json",
        ("packages/chip/scripts/check_chip_os_environment_preflight.py",),
        "host tool, env var, and evidence path preflight",
    ),
    ReportSpec(
        "keyword_inventory",
        "packages/chip/build/reports/chip-os-gap-keyword-inventory.json",
        ("packages/chip/scripts/check_chip_os_gap_keyword_inventory.py",),
        "source-level unfinished marker inventory",
    ),
    ReportSpec(
        "chipyard_verilator_linux_smoke",
        "packages/chip/build/reports/chipyard_verilator_linux_smoke.json",
        ("packages/chip/scripts/check_chipyard_verilator_linux_smoke.py",),
        "generated AP Verilator Linux smoke report mirror",
    ),
    ReportSpec(
        "os_rv64_qemu_smoke",
        "packages/chip/build/reports/qemu_virt_smoke.json",
        ("packages/os/linux/elizaos/scripts/qemu_virt_smoke.py",),
        "OS RV64 qemu-virt smoke report mirror",
    ),
    ReportSpec(
        "android_launcher_runtime",
        "packages/chip/build/reports/android_launcher_runtime_evidence.json",
        ("packages/chip/scripts/check_android_launcher_runtime_evidence.py",),
        "booted Android launcher and local-agent runtime evidence check",
    ),
    ReportSpec(
        "android_app_runtime_contract",
        "packages/chip/build/reports/android_app_runtime_contract.json",
        ("packages/chip/scripts/check_android_app_runtime_contract.py",),
        "Android APK/package/service/runtime static contract check",
    ),
    ReportSpec(
        "android_sim_boot",
        "packages/chip/build/reports/android_sim_boot.json",
        ("packages/chip/scripts/check_android_sim_boot.py",),
        "Android simulator boot evidence check",
    ),
    ReportSpec(
        "software_bsp",
        "packages/chip/build/reports/software_bsp.json",
        ("packages/chip/scripts/check_software_bsp.py",),
        "software BSP scaffold and external evidence report",
    ),
    ReportSpec(
        "os_rv64_chip_boot_contract",
        "packages/chip/build/reports/os_rv64_chip_boot_contract.json",
        ("packages/chip/scripts/check_os_rv64_chip_boot_contract.py",),
        "Linux RV64 chip/emulator boot objective contract",
    ),
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(REPO).as_posix()
    except ValueError:
        return str(path)


def resolve(path: str) -> Path:
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate
    return REPO / candidate


def finding(code: str, message: str, evidence: str, next_step: str) -> dict[str, Any]:
    return {
        "code": code,
        "severity": "blocker",
        "message": message,
        "evidence": evidence,
        "next_step": next_step,
    }


def row_for_spec(spec: ReportSpec) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    report = resolve(spec.report)
    source_paths = [resolve(source) for source in spec.sources]
    findings: list[dict[str, Any]] = []
    missing_sources = [source for source in source_paths if not source.exists()]
    if not report.exists():
        findings.append(
            finding(
                f"missing_report_{spec.ident}",
                f"{spec.purpose} report is missing",
                spec.report,
                "Run the report-generating checker before relying on the chip OS survey.",
            )
        )
    for source in missing_sources:
        findings.append(
            finding(
                f"missing_report_source_{spec.ident}",
                f"{spec.purpose} source is missing",
                rel(source),
                "Restore the missing checker/source path or remove this report from the freshness watch list.",
            )
        )
    newest_source = max(
        (source.stat().st_mtime for source in source_paths if source.exists()),
        default=None,
    )
    report_mtime = report.stat().st_mtime if report.exists() else None
    stale = (
        report_mtime is not None
        and newest_source is not None
        and report_mtime < newest_source
    )
    if stale:
        findings.append(
            finding(
                f"stale_report_{spec.ident}",
                f"{spec.purpose} report is older than one of its source scripts",
                spec.report,
                "Regenerate this report after source edits before using it as current survey evidence.",
            )
        )
    return (
        {
            "id": spec.ident,
            "report": spec.report,
            "purpose": spec.purpose,
            "sources": spec.sources,
            "present": report.exists(),
            "stale": stale,
            "report_mtime": report_mtime,
            "newest_source_mtime": newest_source,
            "missing_sources": [rel(source) for source in missing_sources],
        },
        findings,
    )


def build_report() -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for spec in REPORTS:
        row, row_findings = row_for_spec(spec)
        rows.append(row)
        findings.extend(row_findings)
    return {
        "schema": SCHEMA,
        "status": "blocked" if findings else "pass",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "reports": len(rows),
            "missing_reports": sum(1 for row in rows if not row["present"]),
            "stale_reports": sum(1 for row in rows if row["stale"]),
            "missing_sources": sum(len(row["missing_sources"]) for row in rows),
            "findings": len(findings),
        },
        "reports": rows,
        "findings": findings,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default=str(REPORT))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_report()
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    summary = report["summary"]
    print(
        f"STATUS: {str(report['status']).upper()} chip_os_report_freshness "
        f"reports={summary['reports']} missing_reports={summary['missing_reports']} "
        f"stale_reports={summary['stale_reports']} missing_sources={summary['missing_sources']} "
        f"findings={summary['findings']} report={rel(output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
