#!/usr/bin/env python3
"""Preflight host tools, env vars, and artifacts for chip OS bring-up evidence."""

from __future__ import annotations

import argparse
import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
REPORT = ROOT / "build/reports/chip-os-environment-preflight.json"

SCHEMA = "eliza.chip_os_environment_preflight.v1"
CLAIM_BOUNDARY = "environment_preflight_only_not_boot_or_launcher_evidence"


@dataclass(frozen=True)
class ToolSpec:
    name: str
    purpose: str
    required_for: tuple[str, ...]


@dataclass(frozen=True)
class EnvSpec:
    name: str
    purpose: str
    required_for: tuple[str, ...]


@dataclass(frozen=True)
class PathSpec:
    ident: str
    path: str
    purpose: str
    required_for: tuple[str, ...]
    glob: bool = False
    writable: bool = False


TOOLS = (
    ToolSpec("qemu-system-riscv64", "run Linux/AOSP riscv64 virtual-device smoke tests", ("os_rv64_qemu_tooling", "aosp_qemu_boot")),
    ToolSpec("renode", "run Renode-based AOSP/e1 SoC smoke evidence", ("aosp_renode_boot",)),
    ToolSpec("repo", "sync/import external AOSP checkout", ("aosp_checkout",)),
    ToolSpec("adb", "capture launcher foreground, package, service, and health evidence", ("android_launcher_runtime",)),
    ToolSpec("fastboot", "flash or validate Android release images where needed", ("android_release_validation",)),
    ToolSpec("verilator", "build/run generated Chipyard Verilator AP simulator", ("generated_ap_linux_boot",)),
    ToolSpec("java", "run AOSP/Android tooling and Tradefed style checks", ("aosp_build_and_cts_vts",)),
    ToolSpec("make", "run chip and OS bring-up targets", ("workflow",)),
)

ENVS = (
    EnvSpec("AOSP_DIR", "external AOSP checkout path", ("aosp_checkout", "aosp_build")),
    EnvSpec("AOSP_QEMU_SMOKE_COMMAND", "target-specific command that actually boots AOSP in QEMU", ("aosp_qemu_boot",)),
    EnvSpec("AOSP_RENODE_SMOKE_COMMAND", "target-specific command that actually boots AOSP in Renode", ("aosp_renode_boot",)),
    EnvSpec("ELIZA_LINUX_TREE", "external Linux tree for BSP build evidence", ("linux_bsp_external_evidence",)),
    EnvSpec("ELIZA_BUILDROOT_TREE", "external Buildroot tree for rootfs/image evidence", ("buildroot_external_evidence",)),
    EnvSpec("ELIZA_OPENSBI_TREE", "external OpenSBI tree for firmware handoff evidence", ("opensbi_external_evidence",)),
    EnvSpec("CHIPYARD_LINUX_BINARY", "payload used by Chipyard Verilator Linux smoke", ("generated_ap_linux_boot",)),
)

PATHS = (
    PathSpec("chipyard_checkout", "packages/chip/external/chipyard", "external Chipyard checkout", ("generated_ap_linux_boot",)),
    PathSpec("os_rv64_iso", "packages/os/linux/elizaos/out/*riscv64*.iso", "built Linux RV64 live ISO", ("os_rv64_qemu_tooling",), glob=True),
    PathSpec("os_rv64_out_writable", "packages/os/linux/elizaos/out", "OS output directory must be writable by the current user", ("os_rv64_build_regeneration",), writable=True),
    PathSpec("chipyard_smoke_report", "packages/chip/build/reports/chipyard_verilator_linux_smoke.json", "generated AP Linux smoke report", ("generated_ap_linux_boot",)),
    PathSpec("qemu_virt_smoke_report", "packages/chip/build/reports/qemu_virt_smoke.json", "OS qemu-virt smoke report", ("os_rv64_qemu_tooling",)),
    PathSpec("android_launcher_runtime_evidence", "packages/chip/docs/evidence/android/eliza_launcher_runtime_evidence.json", "booted Android launcher/agent runtime evidence", ("android_launcher_runtime",)),
    PathSpec("aosp_evidence_manifest", "packages/chip/sw/aosp-device/evidence_manifest.json", "AOSP chip evidence manifest", ("aosp_evidence_capture",)),
    PathSpec("android_eliza_apk", "packages/os/android/vendor/eliza/apps/Eliza/Eliza.apk", "Android Eliza privileged APK prebuilt", ("android_launcher_runtime", "android_agent_health")),
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(REPO).as_posix()
    except ValueError:
        return str(path)


def finding(code: str, message: str, evidence: str, next_step: str) -> dict[str, Any]:
    return {
        "code": code,
        "severity": "blocker",
        "message": message,
        "evidence": evidence,
        "next_step": next_step,
    }


def check_tools(which: Callable[[str], str | None]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for spec in TOOLS:
        resolved = which(spec.name)
        present = bool(resolved)
        rows.append(
            {
                "name": spec.name,
                "present": present,
                "path": resolved or "",
                "purpose": spec.purpose,
                "required_for": list(spec.required_for),
            }
        )
        if not present:
            findings.append(
                finding(
                    f"missing_tool_{spec.name.replace('-', '_')}",
                    f"{spec.name} is not available on PATH",
                    spec.name,
                    f"Install or source the environment that provides {spec.name} before capturing {', '.join(spec.required_for)} evidence.",
                )
            )
    return rows, findings


def check_env(env: dict[str, str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for spec in ENVS:
        value = env.get(spec.name, "")
        present = bool(value)
        rows.append(
            {
                "name": spec.name,
                "present": present,
                "value": value,
                "purpose": spec.purpose,
                "required_for": list(spec.required_for),
            }
        )
        if not present:
            findings.append(
                finding(
                    f"missing_env_{spec.name.lower()}",
                    f"{spec.name} is not set",
                    spec.name,
                    f"Set {spec.name} to the concrete artifact, checkout, or smoke command required for {', '.join(spec.required_for)}.",
                )
            )
    return rows, findings


def matching_paths(spec: PathSpec) -> list[Path]:
    pattern = REPO / spec.path
    if spec.glob:
        return sorted(pattern.parent.glob(pattern.name))
    return [pattern] if pattern.exists() else []


def check_paths() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for spec in PATHS:
        matches = matching_paths(spec)
        present = bool(matches)
        writable_ok = True
        if spec.writable and matches:
            writable_ok = os.access(matches[0], os.W_OK)
        rows.append(
            {
                "id": spec.ident,
                "path": spec.path,
                "matches": [rel(path) for path in matches],
                "present": present,
                "writable": writable_ok if spec.writable else None,
                "purpose": spec.purpose,
                "required_for": list(spec.required_for),
            }
        )
        if not present:
            findings.append(
                finding(
                    f"missing_path_{spec.ident}",
                    f"{spec.purpose} is missing",
                    spec.path,
                    f"Create or capture {spec.path} before using it for {', '.join(spec.required_for)}.",
                )
            )
        elif spec.writable and not writable_ok:
            findings.append(
                finding(
                    f"unwritable_path_{spec.ident}",
                    f"{spec.path} is not writable by the current user",
                    rel(matches[0]),
                    "Fix ownership/permissions or use a writable output directory before regenerating OS artifacts.",
                )
            )
    return rows, findings


def build_report(
    *,
    env: dict[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> dict[str, Any]:
    env_rows, env_findings = check_env(dict(os.environ if env is None else env))
    tool_rows, tool_findings = check_tools(which)
    path_rows, path_findings = check_paths()
    findings = tool_findings + env_findings + path_findings
    return {
        "schema": SCHEMA,
        "status": "blocked" if findings else "pass",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "tools": len(tool_rows),
            "missing_tools": sum(1 for row in tool_rows if not row["present"]),
            "env_vars": len(env_rows),
            "missing_env_vars": sum(1 for row in env_rows if not row["present"]),
            "paths": len(path_rows),
            "missing_or_unwritable_paths": len(path_findings),
            "findings": len(findings),
        },
        "tools": tool_rows,
        "environment": env_rows,
        "paths": path_rows,
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
        f"STATUS: {str(report['status']).upper()} chip_os_environment_preflight "
        f"missing_tools={summary['missing_tools']} missing_env_vars={summary['missing_env_vars']} "
        f"missing_or_unwritable_paths={summary['missing_or_unwritable_paths']} "
        f"findings={summary['findings']} report={rel(output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
