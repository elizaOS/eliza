#!/usr/bin/env python3
"""Check the staged Android system APK carries the E1/AOSP agent payload.

This is a static package inspection only. It proves the prebuilt APK contains
the expected local-agent runtime files, riscv64 payload entries, model-free
llama.cpp diagnostic script, and build provenance. It does not prove Android
boot, launcher foreground state, service liveness, or GUI emulator behavior.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import zipfile
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
DEFAULT_APK = WORKSPACE / "os/android/vendor/eliza/apps/Eliza/Eliza.apk"
REPORT = ROOT / "build/reports/android_system_apk_payload.json"

SCHEMA = "eliza.android_system_apk_payload.v1"
CLAIM_BOUNDARY = "staged_aosp_apk_payload_static_check_only_not_runtime_evidence"
EXPECTED_PACKAGE = "app.eliza"
PROVENANCE_ENTRY = "META-INF/eliza/aosp-build-provenance.json"
REQUIRED_ENTRIES = (
    "AndroidManifest.xml",
    "assets/agent/agent-bundle.js",
    "assets/agent/launch.sh",
    "assets/agent/llama-kernel-diagnostic.mjs",
    "assets/agent/riscv64/bun",
    "assets/agent/riscv64/ld-musl-riscv64.so.1",
    "assets/agent/riscv64/libgcc_s.so.1",
    "lib/riscv64/libeliza_bun.so",
    "lib/riscv64/libeliza_gcc_s.so",
    "lib/riscv64/libeliza_ld_musl_riscv64.so",
    "lib/riscv64/libeliza_stdcpp.so",
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
        return path.relative_to(WORKSPACE).as_posix()
    except ValueError:
        return str(path)


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


def read_zip_entries(apk: Path) -> set[str]:
    with zipfile.ZipFile(apk) as zf:
        return set(zf.namelist())


def package_name_from_aapt(apk: Path) -> str | None:
    aapt = subprocess.run(
        ["aapt", "dump", "badging", str(apk)],
        check=False,
        capture_output=True,
        text=True,
    )
    if aapt.returncode != 0:
        return None
    for line in aapt.stdout.splitlines():
        if line.startswith("package:"):
            for part in line.split():
                if part.startswith("name="):
                    return part.split("=", 1)[1].strip("'\"")
    return None


def run_check(args: argparse.Namespace) -> dict[str, Any]:
    apk = Path(args.apk).resolve()
    findings: list[Finding] = []
    add_if(
        findings,
        not apk.is_file(),
        "apk_missing",
        "staged Android system APK is missing",
        rel(apk),
        "Build the android-system target and stage Eliza.apk before claiming AOSP APK readiness.",
    )
    if findings:
        return payload(findings, {"apk": rel(apk)})

    entries = read_zip_entries(apk)
    missing = [entry for entry in REQUIRED_ENTRIES if entry not in entries]
    riscv_assets = sorted(entry for entry in entries if entry.startswith("assets/agent/riscv64/"))
    riscv_libs = sorted(entry for entry in entries if entry.startswith("lib/riscv64/"))
    package_name = None if args.allow_missing_aapt else package_name_from_aapt(apk)

    add_if(
        findings,
        bool(missing),
        "missing_required_apk_payload_entries",
        "staged APK lacks required local-agent payload entries",
        ", ".join(missing),
        "Build packages/app-core/scripts/bun-riscv64/build.sh, set MILADY_BUN_RISCV64_FILE/SHA256 or URL/SHA256, then rebuild android-system.",
    )
    add_if(
        findings,
        PROVENANCE_ENTRY not in entries,
        "aosp_build_provenance_missing",
        "staged APK lacks machine-readable AOSP build provenance",
        PROVENANCE_ENTRY,
        "Embed META-INF/eliza/aosp-build-provenance.json during Android system APK staging.",
    )
    add_if(
        findings,
        not args.allow_missing_aapt and package_name != EXPECTED_PACKAGE,
        "apk_package_name_mismatch",
        "staged APK package name does not match the expected Eliza package",
        f"expected={EXPECTED_PACKAGE!r} actual={package_name!r}",
        "Rebuild the android-system APK from the Eliza app config and verify the manifest package.",
    )

    evidence = {
        "apk": rel(apk),
        "entry_count": len(entries),
        "expected_package": EXPECTED_PACKAGE,
        "package_name": package_name,
        "provenance_entry": PROVENANCE_ENTRY,
        "provenance_present": PROVENANCE_ENTRY in entries,
        "required_entries": list(REQUIRED_ENTRIES),
        "missing_entries": missing,
        "assets_agent_riscv64_entries": riscv_assets,
        "lib_riscv64_entries": riscv_libs,
        "has_arm64_agent_runtime": "assets/agent/arm64-v8a/bun" in entries,
        "has_x86_64_agent_runtime": "assets/agent/x86_64/bun" in entries,
        "has_llama_kernel_diagnostic": "assets/agent/llama-kernel-diagnostic.mjs" in entries,
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
    print(f"STATUS: {str(report['status']).upper()} android_system.apk_payload")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apk", default=str(DEFAULT_APK), help=f"APK path (default: {rel(DEFAULT_APK)})"
    )
    parser.add_argument(
        "--report", default=str(REPORT), help=f"report path (default: {rel(REPORT)})"
    )
    parser.add_argument("--allow-missing-aapt", action="store_true")
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
