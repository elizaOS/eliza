#!/usr/bin/env python3
"""Static Android System UI bridge contract gate.

The launcher objective is not just "an activity is foreground"; the UI must be
backed by live Android system state and privileged controls. This check blocks
while the native bridge is a stub, the React provider can fall back to mock
state in production, or the AOSP product lacks bridge packaging/permissions.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
SYSTEM_UI = WORKSPACE / "os/android/system-ui"
NATIVE = SYSTEM_UI / "native"
BRIDGE_KT = NATIVE / "src/main/java/ai/elizaos/system/bridge/SystemBridge.kt"
BRIDGE_MANIFEST = NATIVE / "src/main/AndroidManifest.xml"
BRIDGE_GRADLE = NATIVE / "build.gradle.kts"
ANDROID_PROVIDER = SYSTEM_UI / "src/providers/AndroidSystemProvider.tsx"
MOCK_PROVIDER = SYSTEM_UI / "src/providers/MockSystemProvider.tsx"
BRIDGE_CONTRACT = SYSTEM_UI / "src/bridge/bridge-contract.ts"
OS_COMMON = WORKSPACE / "os/android/vendor/eliza/eliza_common.mk"
OS_PERMISSION_DIR = WORKSPACE / "os/android/vendor/eliza/permissions"
LOCAL_MANIFEST = ROOT / "sw/aosp-device/local_manifests/eliza.xml"
REPORT = ROOT / "build/reports/android_system_bridge_contract.json"
SCHEMA = "eliza.android_system_bridge_contract.v1"
CLAIM_BOUNDARY = "static_system_bridge_contract_only_not_runtime_system_control_evidence"
BRIDGE_PACKAGE = "ai.elizaos.system.bridge"
EXPECTED_BRIDGE_MODULES = {
    "ElizaSystemBridge",
    "privapp-permissions-ai.elizaos.system.bridge.xml",
}
REQUIRED_PRIV_PERMISSIONS = {
    "android.permission.REBOOT",
    "android.permission.DEVICE_POWER",
    "android.permission.WRITE_SECURE_SETTINGS",
}


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def rel(path: Path) -> str:
    try:
        return path.relative_to(WORKSPACE).as_posix()
    except ValueError:
        return str(path)


def package_name_from_manifest(path: Path) -> str | None:
    root = ElementTree.fromstring(read_text(path))
    return root.attrib.get("package")


def permissions_from_manifest(path: Path) -> set[str]:
    root = ElementTree.fromstring(read_text(path))
    android_name = "{http://schemas.android.com/apk/res/android}name"
    return {
        element.attrib[android_name]
        for element in root.findall("uses-permission")
        if android_name in element.attrib
    }


def product_packages(text: str) -> set[str]:
    packages: set[str] = set()
    active = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            active = False
            continue
        if "PRODUCT_PACKAGES" in line and "+=" in line:
            active = True
            rhs = line.split("+=", 1)[1]
        elif active:
            rhs = line
        else:
            continue
        continued = rhs.endswith("\\")
        rhs = rhs.rstrip("\\").strip()
        packages.update(part for part in rhs.split() if part)
        active = continued
    return packages


def local_manifest_dests(path: Path) -> set[str]:
    root = ElementTree.fromstring(read_text(path))
    return {
        element.attrib["dest"]
        for element in root.findall(".//linkfile")
        if "dest" in element.attrib
    }


def bridge_channels(text: str) -> set[str]:
    return set(re.findall(r'"(eliza\.android\.[^"]+)"', text))


def declared_privapp_permission_files() -> list[Path]:
    if not OS_PERMISSION_DIR.is_dir():
        return []
    return sorted(OS_PERMISSION_DIR.glob("*system.bridge*.xml"))


def privapp_permission_grants(path: Path) -> tuple[str | None, set[str]]:
    root = ElementTree.fromstring(read_text(path))
    package = None
    permissions: set[str] = set()
    for element in root.iter():
        if element.tag == "privapp-permissions":
            package = element.attrib.get("package")
        if element.tag == "permission":
            name = element.attrib.get("name")
            if name:
                permissions.add(name)
    return package, permissions


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


def run_check(args: argparse.Namespace) -> dict[str, object]:
    inputs = (
        BRIDGE_KT,
        BRIDGE_MANIFEST,
        BRIDGE_GRADLE,
        ANDROID_PROVIDER,
        MOCK_PROVIDER,
        BRIDGE_CONTRACT,
        OS_COMMON,
        LOCAL_MANIFEST,
    )
    findings: list[Finding] = []
    for path in inputs:
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required Android system bridge contract input is missing",
            rel(path),
            "Restore the missing bridge/product source before claiming live system UI integration.",
        )
    if findings:
        return payload(findings, {})

    bridge_text = read_text(BRIDGE_KT)
    provider_text = read_text(ANDROID_PROVIDER)
    mock_text = read_text(MOCK_PROVIDER)
    gradle_text = read_text(BRIDGE_GRADLE)
    contract_text = read_text(BRIDGE_CONTRACT)
    os_common_text = read_text(OS_COMMON)
    package = package_name_from_manifest(BRIDGE_MANIFEST)
    manifest_permissions = permissions_from_manifest(BRIDGE_MANIFEST)
    os_packages = product_packages(os_common_text)
    local_dests = local_manifest_dests(LOCAL_MANIFEST)
    channels = bridge_channels(contract_text)
    not_impl_count = bridge_text.count("NotImplementedError")
    throws_count = bridge_text.count("throw NotImplementedError")
    priv_files = declared_privapp_permission_files()
    priv_packages: dict[str, list[str]] = {}
    priv_grants: set[str] = set()
    for path in priv_files:
        priv_package, grants = privapp_permission_grants(path)
        if priv_package:
            priv_packages[rel(path)] = [priv_package]
        priv_grants.update(grants)

    add_if(
        findings,
        package != BRIDGE_PACKAGE,
        "system_bridge_package_mismatch",
        "native bridge manifest package is not the expected system bridge package",
        f"package={package!r}",
        f"Use package {BRIDGE_PACKAGE} consistently across manifest, product packages, and privapp allowlist.",
    )
    add_if(
        findings,
        not_impl_count > 0 or throws_count > 0,
        "system_bridge_native_methods_stubbed",
        "native SystemBridge methods still throw NotImplementedError",
        f"NotImplementedError={not_impl_count} throw_NotImplementedError={throws_count}",
        "Wire the bridge to Android managers/services and return live subscription/command results.",
    )
    add_if(
        findings,
        'id("com.android.library")' in gradle_text
        and 'id("com.android.application")' not in gradle_text,
        "system_bridge_not_packaged_as_app",
        "native bridge Gradle module is a library, not an installable privileged system app",
        rel(BRIDGE_GRADLE),
        "Add/build an installable system app or package the bridge inside the selected privileged launcher APK with verified wiring.",
    )
    add_if(
        findings,
        "MockSystemProvider" in provider_text,
        "android_provider_falls_back_to_mock",
        "AndroidSystemProvider silently falls back to MockSystemProvider when no native bridge transport exists",
        rel(ANDROID_PROVIDER),
        "Fail closed in production images when the native bridge is absent, or emit runtime evidence proving a real bridge transport is bound.",
    )
    add_if(
        findings,
        "DEFAULT_WIFI" in mock_text and "eliza-home" in mock_text,
        "mock_system_provider_has_realistic_fake_state",
        "MockSystemProvider includes plausible Wi-Fi/audio/battery/cell defaults",
        rel(MOCK_PROVIDER),
        "Ensure production launcher builds cannot use mock system state for readiness evidence.",
    )
    add_if(
        findings,
        not EXPECTED_BRIDGE_MODULES.issubset(os_packages),
        "system_bridge_not_in_eliza_product_packages",
        "Eliza OS product layer does not package the system bridge app and privapp allowlist",
        f"missing={sorted(EXPECTED_BRIDGE_MODULES - os_packages)}",
        "Add bridge APK and bridge privapp-permissions module to the selected AOSP product once implemented.",
    )
    add_if(
        findings,
        not priv_files,
        "system_bridge_privapp_allowlist_missing",
        "no privapp permission allowlist exists for ai.elizaos.system.bridge",
        rel(OS_PERMISSION_DIR),
        "Add privapp-permissions-ai.elizaos.system.bridge.xml with the required signature permissions.",
    )
    add_if(
        findings,
        bool(REQUIRED_PRIV_PERMISSIONS - manifest_permissions),
        "system_bridge_manifest_missing_signature_permissions",
        "bridge manifest does not declare every privileged control permission it needs",
        f"missing={sorted(REQUIRED_PRIV_PERMISSIONS - manifest_permissions)}",
        "Declare all required bridge permissions and grant signature-level ones through privapp allowlist.",
    )
    add_if(
        findings,
        bool(REQUIRED_PRIV_PERMISSIONS - priv_grants),
        "system_bridge_privapp_permissions_not_granted",
        "bridge privapp allowlist does not grant required signature permissions",
        f"missing={sorted(REQUIRED_PRIV_PERMISSIONS - priv_grants)} files={[rel(p) for p in priv_files]}",
        "Grant REBOOT, DEVICE_POWER, WRITE_SECURE_SETTINGS, and related bridge permissions to the bridge package.",
    )
    add_if(
        findings,
        not any(
            dest.startswith("vendor/eliza/system-ui")
            or dest.startswith("packages/os/android/system-ui")
            for dest in local_dests
        ),
        "chip_local_manifest_does_not_project_system_ui",
        "chip local manifest does not project the OS Android system-ui bridge sources into AOSP",
        f"projected_dest_count={len(local_dests)}",
        "Project the system-ui/native bridge sources or a built bridge APK into the selected AOSP product.",
    )
    add_if(
        findings,
        len(channels) < 10,
        "system_bridge_contract_channels_incomplete",
        "JS bridge contract does not expose the expected system-control channel surface",
        f"channel_count={len(channels)} channels={sorted(channels)}",
        "Keep Wi-Fi, cell, audio, battery, time, connectivity, power, settings, and lockscreen channels in the contract.",
    )

    evidence: dict[str, object] = {
        "bridge_package": package,
        "native_not_implemented_count": not_impl_count,
        "bridge_gradle": rel(BRIDGE_GRADLE),
        "channel_count": len(channels),
        "product_packages": sorted(os_packages),
        "privapp_permission_files": [rel(path) for path in priv_files],
        "manifest_permissions": sorted(manifest_permissions),
        "privapp_grants": sorted(priv_grants),
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
    print(f"STATUS: {str(report['status']).upper()} android.system_bridge_contract")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
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
