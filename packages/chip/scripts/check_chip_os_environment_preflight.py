#!/usr/bin/env python3
"""Preflight host tools, env vars, and artifacts for chip OS bring-up evidence."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
class CommandEnvHint:
    mode: str
    placeholder: str
    evidence_log: str
    purpose: str


@dataclass(frozen=True)
class PathSpec:
    ident: str
    path: str
    purpose: str
    required_for: tuple[str, ...]
    glob: bool = False
    writable: bool = False


TOOLS = (
    ToolSpec(
        "qemu-system-riscv64",
        "run Linux/AOSP riscv64 virtual-device smoke tests",
        ("os_rv64_qemu_tooling", "aosp_qemu_boot"),
    ),
    ToolSpec("renode", "run Renode-based AOSP/e1 SoC smoke evidence", ("aosp_renode_boot",)),
    ToolSpec("repo", "sync/import external AOSP checkout", ("aosp_checkout",)),
    ToolSpec(
        "adb",
        "capture launcher foreground, package, service, and health evidence",
        ("android_launcher_runtime",),
    ),
    ToolSpec(
        "fastboot",
        "flash or validate Android release images where needed",
        ("android_release_validation",),
    ),
    ToolSpec(
        "verilator",
        "build/run generated Chipyard Verilator AP simulator",
        ("generated_ap_linux_boot",),
    ),
    ToolSpec(
        "java", "run AOSP/Android tooling and Tradefed style checks", ("aosp_build_and_cts_vts",)
    ),
    ToolSpec(
        "aapt",
        "inspect Android APK package/assets for release validation",
        ("android_agent_payload",),
    ),
    ToolSpec(
        "apkanalyzer",
        "inspect Android APK manifest and native payloads",
        ("android_agent_payload",),
    ),
    ToolSpec(
        "curl",
        "capture agent /api/health evidence",
        ("android_agent_health", "linux_agent_liveness"),
    ),
    ToolSpec("jq", "inspect structured evidence payloads in shell capture flows", ("workflow",)),
    ToolSpec("node", "run Android/release manifest validators", ("android_release_validation",)),
    ToolSpec("bun", "build/package the shared Eliza agent payload", ("agent_payload_build",)),
    ToolSpec("make", "run chip and OS bring-up targets", ("workflow",)),
)

ENVS = (
    EnvSpec("AOSP_DIR", "external AOSP checkout path", ("aosp_checkout", "aosp_build")),
    EnvSpec(
        "AOSP_QEMU_SMOKE_COMMAND",
        "target-specific command that actually boots AOSP in QEMU",
        ("aosp_qemu_boot",),
    ),
    EnvSpec(
        "AOSP_RENODE_SMOKE_COMMAND",
        "target-specific command that actually boots AOSP in Renode",
        ("aosp_renode_boot",),
    ),
    EnvSpec(
        "ELIZA_LINUX_TREE",
        "external Linux tree for BSP build evidence",
        ("linux_bsp_external_evidence",),
    ),
    EnvSpec(
        "ELIZA_BUILDROOT_TREE",
        "external Buildroot tree for rootfs/image evidence",
        ("buildroot_external_evidence",),
    ),
    EnvSpec(
        "ELIZA_OPENSBI_TREE",
        "external OpenSBI tree for firmware handoff evidence",
        ("opensbi_external_evidence",),
    ),
    EnvSpec(
        "CHIPYARD_LINUX_BINARY",
        "payload used by Chipyard Verilator Linux smoke",
        ("generated_ap_linux_boot",),
    ),
)

COMMAND_ENV_HINTS = {
    "AOSP_QEMU_SMOKE_COMMAND": CommandEnvHint(
        mode="qemu-smoke",
        placeholder="/exact/qemu-system-riscv64 smoke command for this checkout",
        evidence_log="packages/chip/docs/evidence/android/qemu_riscv64_smoke.log",
        purpose=(
            "capture-aosp-evidence.sh qemu-smoke evals this command inside the AOSP "
            "checkout and records the bounded virtual-device transcript"
        ),
    ),
    "AOSP_RENODE_SMOKE_COMMAND": CommandEnvHint(
        mode="renode-smoke",
        placeholder="/exact/renode smoke command for this checkout",
        evidence_log="packages/chip/docs/evidence/android/renode_e1_soc_smoke.log",
        purpose=(
            "capture-aosp-evidence.sh renode-smoke evals this command inside the AOSP "
            "checkout and records the bounded virtual-device transcript"
        ),
    ),
}

ENV_DEFAULT_PATHS = {
    "AOSP_DIR": (Path("/home/shaw/aosp"),),
    "ELIZA_LINUX_TREE": (ROOT / "external/linux",),
    "ELIZA_BUILDROOT_TREE": (
        ROOT / "external/buildroot-2024.11",
        ROOT / "external/buildroot-rv64-src",
    ),
    "ELIZA_OPENSBI_TREE": (ROOT / "external/opensbi", ROOT / "external/opensbi/opensbi"),
    "CHIPYARD_LINUX_BINARY": (
        ROOT
        / "external/chipyard/software/firemarshal/images/firechip/eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk",
    ),
}

TOOL_DEFAULT_PATHS = {
    "qemu-system-riscv64": (
        ROOT / "tools/bin/qemu-system-riscv64",
        ROOT / "external/qemu-build/bin/qemu-system-riscv64",
    ),
    "aapt": (
        Path("/home/shaw/Android/Sdk/build-tools/36.0.0/aapt"),
        Path("/home/shaw/Android/Sdk/build-tools/35.0.0/aapt"),
        Path("/home/shaw/Android/Sdk/build-tools/34.0.0/aapt"),
    ),
    "apkanalyzer": (Path("/home/shaw/Android/Sdk/cmdline-tools/latest/bin/apkanalyzer"),),
    "verilator": (ROOT / "external/oss-cad-suite/bin/verilator",),
    "renode": (ROOT / "external/renode_1.16.1-dotnet_portable/renode",),
}

PATHS = (
    PathSpec(
        "chipyard_checkout",
        "packages/chip/external/chipyard",
        "external Chipyard checkout",
        ("generated_ap_linux_boot",),
    ),
    PathSpec(
        "os_rv64_iso",
        "packages/os/linux/elizaos/out/*riscv64*.iso",
        "built Linux RV64 live ISO",
        ("os_rv64_qemu_tooling",),
        glob=True,
    ),
    PathSpec(
        "os_rv64_out_writable",
        "packages/os/linux/elizaos/out",
        "OS output directory must be writable by the current user",
        ("os_rv64_build_regeneration",),
        writable=True,
    ),
    PathSpec(
        "chipyard_smoke_report",
        "packages/chip/build/reports/chipyard_verilator_linux_smoke.json",
        "generated AP Linux smoke report",
        ("generated_ap_linux_boot",),
    ),
    PathSpec(
        "qemu_virt_smoke_report",
        "packages/chip/build/reports/qemu_virt_smoke.json",
        "OS qemu-virt smoke report",
        ("os_rv64_qemu_tooling",),
    ),
    PathSpec(
        "android_launcher_runtime_evidence",
        "packages/chip/docs/evidence/android/eliza_launcher_runtime_evidence.json",
        "booted Android launcher/agent runtime evidence",
        ("android_launcher_runtime",),
    ),
    PathSpec(
        "aosp_evidence_manifest",
        "packages/chip/sw/aosp-device/evidence_manifest.json",
        "AOSP chip evidence manifest",
        ("aosp_evidence_capture",),
    ),
    PathSpec(
        "android_eliza_apk",
        "packages/os/android/vendor/eliza/apps/Eliza/Eliza.apk",
        "Android Eliza privileged APK prebuilt",
        ("android_launcher_runtime", "android_agent_health"),
    ),
    PathSpec(
        "android_app_agent_plugin_manifest",
        "packages/app-core/platforms/electrobun/remotes/runtime/plugin.json",
        "Android app bundled agent/runtime plugin manifest",
        ("android_agent_payload",),
    ),
    PathSpec(
        "android_release_manifest",
        "packages/os/release/beta-2026-05-16/android-release-manifest.json",
        "Android release manifest",
        ("android_release_validation",),
    ),
    PathSpec(
        "android_post_flash_validator",
        "packages/os/android/installer/scripts/validate-post-flash.sh",
        "Android post-flash launcher/agent validator",
        ("android_release_validation", "android_launcher_runtime"),
    ),
    PathSpec(
        "android_release_manifest_validator",
        "packages/os/android/installer/scripts/validate-release-manifest.mjs",
        "Android release manifest validator",
        ("android_release_validation",),
    ),
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(REPO).as_posix()
    except ValueError:
        return str(path)


def finding(code: str, message: str, evidence: str, next_step: str, **extra: Any) -> dict[str, Any]:
    row = {
        "code": code,
        "severity": "blocker",
        "message": message,
        "evidence": evidence,
        "next_step": next_step,
    }
    row.update(extra)
    return row


def check_tools(
    which: Callable[[str], str | None],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for spec in TOOLS:
        resolved = which(spec.name)
        source = "path" if resolved else "missing"
        if not resolved:
            for candidate in TOOL_DEFAULT_PATHS.get(spec.name, ()):
                if candidate.is_file() and os.access(candidate, os.X_OK):
                    resolved = str(candidate)
                    source = "repo-default"
                    break
        present = bool(resolved)
        rows.append(
            {
                "name": spec.name,
                "present": present,
                "path": resolved or "",
                "source": source,
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


def default_env_value(name: str) -> str:
    for candidate in ENV_DEFAULT_PATHS.get(name, ()):
        if candidate.exists():
            return str(candidate)
    return ""


def aosp_dir_for_hints(env: dict[str, str]) -> str:
    return env.get("AOSP_DIR", "") or default_env_value("AOSP_DIR") or "/path/to/aosp"


def command_env_hint(name: str, value: str, aosp_dir: str) -> dict[str, Any]:
    hint = COMMAND_ENV_HINTS[name]
    script = ROOT / "sw/aosp-device/capture-aosp-evidence.sh"
    command_value = value or hint.placeholder
    quoted_value = shlex.quote(command_value)
    quoted_aosp = shlex.quote(aosp_dir)
    script_path = rel(script)
    capture_command = f"{name}={quoted_value} {script_path} {quoted_aosp} {hint.mode}"
    return {
        "capture_mode": hint.mode,
        "capture_command": capture_command,
        "suggested_export": f"export {name}={quoted_value}",
        "evidence_log": hint.evidence_log,
        "hint_purpose": hint.purpose,
    }


def check_env(env: dict[str, str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    aosp_dir = aosp_dir_for_hints(env)
    for spec in ENVS:
        explicit_value = env.get(spec.name, "")
        inferred_value = "" if explicit_value else default_env_value(spec.name)
        value = explicit_value or inferred_value
        present = bool(value)
        row = {
            "name": spec.name,
            "present": present,
            "value": value,
            "source": "env"
            if explicit_value
            else ("repo-default" if inferred_value else "missing"),
            "purpose": spec.purpose,
            "required_for": list(spec.required_for),
        }
        if spec.name in COMMAND_ENV_HINTS:
            row["command_hint"] = command_env_hint(spec.name, value, aosp_dir)
        rows.append(row)
        if not present:
            extra = {}
            if spec.name in COMMAND_ENV_HINTS:
                extra = command_env_hint(spec.name, value, aosp_dir)
            findings.append(
                finding(
                    f"missing_env_{spec.name.lower()}",
                    f"{spec.name} is not set",
                    spec.name,
                    f"Set {spec.name} to the concrete artifact, checkout, or smoke command required for {', '.join(spec.required_for)}.",
                    **extra,
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
