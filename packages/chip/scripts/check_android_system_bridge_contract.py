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
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
ELIZA_ROOT = ROOT.parents[1]
ANDROID_APP_GRADLE = WORKSPACE / "app/android/app/build.gradle"
LOCAL_MANIFEST = ROOT / "sw/aosp-device/local_manifests/eliza.xml"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_android_gradle_identity() -> dict[str, str] | None:
    if not ANDROID_APP_GRADLE.is_file():
        return None
    gradle = ANDROID_APP_GRADLE.read_text(encoding="utf-8", errors="replace")
    for key in ("applicationId", "namespace"):
        match = re.search(rf"\b{key}\s+[\"']([^\"']+)[\"']", gradle)
        if match:
            return {"appId": match.group(1)}
    return None


def infer_vendor_identity(package_name: str) -> dict[str, str]:
    defaults = {
        "appId": package_name,
        "appName": "Milady" if package_name == "ai.milady.milady" else "Eliza",
        "vendorDir": "milady" if package_name == "ai.milady.milady" else "eliza",
    }
    if not LOCAL_MANIFEST.is_file():
        return defaults
    text = LOCAL_MANIFEST.read_text(encoding="utf-8", errors="replace")
    vendor_match = re.search(
        rf'dest="vendor/([^/]+)/permissions/default-permissions-{re.escape(package_name)}\.xml"',
        text,
    )
    if vendor_match:
        defaults["vendorDir"] = vendor_match.group(1)
    app_match = re.search(
        rf'dest="vendor/{re.escape(defaults["vendorDir"])}/apps/([^/]+)/\1\.apk"',
        text,
    )
    if app_match:
        defaults["appName"] = app_match.group(1)
    return defaults


def package_name_to_path(package_name: str) -> Path:
    return Path(*package_name.split("."))


GRADLE_IDENTITY = read_android_gradle_identity()
APP_SOURCE_PACKAGE = GRADLE_IDENTITY["appId"] if GRADLE_IDENTITY else "app.eliza"
APP_PACKAGE = "ai.elizaos.app"
APP_NAME = "Eliza"
VENDOR_DIR_NAME = "eliza"
VENDOR_ROOT = WORKSPACE / "os/android/vendor" / VENDOR_DIR_NAME
SYSTEM_UI = WORKSPACE / "os/android/system-ui"
NATIVE = SYSTEM_UI / "native"
BRIDGE_KT = NATIVE / "src/main/java/ai/elizaos/system/bridge/SystemBridge.kt"
BRIDGE_SERVICE_KT = NATIVE / "src/main/java/ai/elizaos/system/bridge/SystemBridgeService.kt"
BRIDGE_MANIFEST = NATIVE / "src/main/AndroidManifest.xml"
BRIDGE_GRADLE = NATIVE / "build.gradle.kts"
ANDROID_PROVIDER = SYSTEM_UI / "src/providers/AndroidSystemProvider.tsx"
MOCK_PROVIDER = SYSTEM_UI / "src/providers/MockSystemProvider.tsx"
BRIDGE_CONTRACT = SYSTEM_UI / "src/bridge/bridge-contract.ts"
LAUNCHER_MAIN_ACTIVITY = (
    WORKSPACE
    / "app/android/app/src/main/java"
    / package_name_to_path(APP_SOURCE_PACKAGE)
    / "MainActivity.java"
)
OS_COMMON = VENDOR_ROOT / f"{VENDOR_DIR_NAME}_common.mk"
OS_PERMISSION_DIR = VENDOR_ROOT / "permissions"
REPORT = ROOT / "build/reports/android_system_bridge_contract.json"
RUNTIME_EVIDENCE = ROOT / "docs/evidence/android/system_bridge_runtime_evidence.json"
RUNTIME_CAPTURE = ROOT / "scripts/android/capture_system_bridge_runtime_evidence.py"
SCHEMA = "eliza.android_system_bridge_contract.v1"
CLAIM_BOUNDARY = "system_bridge_static_contract_and_runtime_evidence_not_full_launcher_claim"
RUNTIME_SCHEMA = "eliza.android_system_bridge_runtime_evidence.v1"
RUNTIME_CLAIM_BOUNDARY = "booted_android_system_bridge_runtime_evidence_only"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "full_launcher_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
    "cts_vts_claim_allowed": False,
    "gms_claim_allowed": False,
}
RUNTIME_CAPTURE_SCRIPT = "packages/chip/scripts/android/capture_system_bridge_runtime_evidence.py"
DEFAULT_RUNTIME_OUTPUT = "packages/chip/docs/evidence/android/system_bridge_runtime_evidence.json"
DEFAULT_RUNTIME_LOGCAT = "packages/chip/docs/evidence/android/system_bridge_runtime_logcat.log"
RUNTIME_CAPTURE_BASE_COMMAND = (
    f"python3 {RUNTIME_CAPTURE_SCRIPT} "
    f"--launcher-package {APP_PACKAGE} "
    f"--output {DEFAULT_RUNTIME_OUTPUT} "
    f"--logcat {DEFAULT_RUNTIME_LOGCAT}"
)
RECHECK_COMMAND = (
    "python3 packages/chip/scripts/check_android_system_bridge_contract.py --json-only"
)
ADB_CONNECT_CANDIDATES = ("127.0.0.1:6520", "127.0.0.1:5555")
ADB_HOSTPORT_SENTINEL = "$CHIP_ANDROID_ADB_HOSTPORT"
BRIDGE_PACKAGE = "ai.elizaos.system.bridge"
EXPECTED_BRIDGE_MODULES = {
    "ElizaSystemBridge",
    "privapp-permissions-ai.elizaos.system.bridge.xml",
}
REQUIRED_MATERIALIZED_LOCAL_MANIFEST_DESTS = {
    f"vendor/{VENDOR_DIR_NAME}/apps/{APP_NAME}/{APP_NAME}.apk",
    f"vendor/{VENDOR_DIR_NAME}/bootanimation/bootanimation.zip",
    f"vendor/{VENDOR_DIR_NAME}/init/init.{VENDOR_DIR_NAME}.rc",
    f"vendor/{VENDOR_DIR_NAME}/permissions/default-permissions-{APP_PACKAGE}.xml",
    f"vendor/{VENDOR_DIR_NAME}/permissions/privapp-permissions-{APP_PACKAGE}.xml",
    f"vendor/{VENDOR_DIR_NAME}/permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
}
REQUIRED_PRIV_PERMISSIONS = {
    "android.permission.REBOOT",
    "android.permission.DEVICE_POWER",
    "android.permission.WRITE_SECURE_SETTINGS",
}
ANDROID_TARGET_PREFIXES = (
    "/system/",
    "/vendor/",
    "/product/",
    "/system_ext/",
    "/odm/",
    "/apex/",
    "/data/",
)
EXPECTED_RUNTIME_PERMISSION_XMLS = {
    f"/system/etc/default-permissions/default-permissions-{APP_PACKAGE}.xml",
    f"/system/etc/permissions/privapp-permissions-{APP_PACKAGE}.xml",
    "/system/etc/permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
}


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str
    blocker_dependency: str = "live_device_validation"


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
    return set(local_manifest_file_projection_kinds(path))


def local_manifest_file_projection_kinds(path: Path) -> dict[str, str]:
    root = ElementTree.fromstring(read_text(path))
    projections: dict[str, str] = {}
    for tag in ("linkfile", "copyfile"):
        for element in root.findall(f".//{tag}"):
            dest = element.attrib.get("dest")
            if dest:
                projections[dest] = tag
    return projections


def bridge_channels(text: str) -> set[str]:
    return set(re.findall(r'"(eliza\.android\.[^"]+)"', text))


def contains_host_local_symlink(value: Any) -> bool:
    text = json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else str(value)
    for target in re.findall(r"->\s+(/[^\s\"']+)", text):
        if not target.startswith(ANDROID_TARGET_PREFIXES):
            return True
    return any(marker in text for marker in (" -> /home/", " -> /tmp/", " -> /Users/"))


def stale_runtime_permission_paths(paths: Iterable[str]) -> list[str]:
    expected_suffixes = {
        f"default-permissions-{APP_PACKAGE}.xml",
        f"privapp-permissions-{APP_PACKAGE}.xml",
        "privapp-permissions-ai.elizaos.system.bridge.xml",
    }
    stale: list[str] = []
    for raw in paths:
        path = str(raw)
        name = Path(path).name
        if (
            name.startswith(("default-permissions-", "privapp-permissions-"))
            and name not in expected_suffixes
        ):
            stale.append(path)
    return sorted(stale)


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


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(read_text(path))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


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


def next_command_plan(findings: list[Finding]) -> list[dict[str, object]]:
    """Return concrete capture batches while keeping runtime proof fail-closed."""

    if not findings:
        return []
    codes = {finding.code for finding in findings}
    plan: list[dict[str, object]] = []
    if any(code.startswith("system_bridge_runtime") for code in codes):
        plan.append(
            {
                "id": "capture_android_system_bridge_runtime_evidence",
                "scope": "host_adb",
                "claim_boundary": "operator_live_capture_commands_only_not_runtime_evidence",
                "commands": [
                    'test -n "$CHIP_ANDROID_ADB_SERIAL" || test -n "$CHIP_ANDROID_ADB_HOSTPORT"',
                    (f'{RUNTIME_CAPTURE_BASE_COMMAND} --adb-connect "{ADB_HOSTPORT_SENTINEL}"'),
                    (
                        f"{RUNTIME_CAPTURE_BASE_COMMAND} "
                        + " ".join(f"--adb-connect {address}" for address in ADB_CONNECT_CANDIDATES)
                    ),
                    (f'{RUNTIME_CAPTURE_BASE_COMMAND} --adb-serial "$CHIP_ANDROID_ADB_SERIAL"'),
                    RECHECK_COMMAND,
                ],
                "requires": [
                    "set CHIP_ANDROID_ADB_SERIAL for lab targets or CHIP_ANDROID_ADB_HOSTPORT for emulator targets",
                    "exactly one selected booted Android release target",
                    "sys.boot_completed=1",
                    "installed privileged system bridge app and launcher package",
                    "bridge service/log markers and live-state UI consumption",
                ],
            }
        )
    if any(
        code
        in {
            "chip_local_manifest_image_prebuilts_not_materialized",
            "chip_local_manifest_does_not_project_system_ui",
            "chip_local_manifest_missing_system_bridge_service",
            "system_bridge_not_in_eliza_product_packages",
            "system_bridge_privapp_allowlist_missing",
            "system_bridge_privapp_permissions_not_granted",
        }
        for code in codes
    ):
        plan.append(
            {
                "id": "rebuild_android_product_after_bridge_packaging_fix",
                "scope": "host_aosp",
                "claim_boundary": "operator_build_commands_only_not_runtime_evidence",
                "commands": [
                    "source build/envsetup.sh && lunch eliza_openagent_ai_soc_phone-trunk_staging-userdebug",
                    "m ElizaSystemBridge privapp-permissions-ai.elizaos.system.bridge.xml",
                    RECHECK_COMMAND,
                ],
                "requires": ["AOSP checkout with the chip local manifest synced"],
            }
        )
    return plan


def command_plan_commands(command_plan: list[dict[str, object]]) -> list[str]:
    commands: list[str] = []
    for batch in command_plan:
        values = batch.get("commands")
        if isinstance(values, list):
            commands.extend(command for command in values if isinstance(command, str) and command)
        command = batch.get("command")
        if isinstance(command, str) and command:
            commands.append(command)
    return list(dict.fromkeys(commands))


def command_batches_for_finding(
    finding: Finding, command_plan: list[dict[str, object]]
) -> list[dict[str, object]]:
    if finding.code.startswith("system_bridge_runtime"):
        selected = [
            batch
            for batch in command_plan
            if batch.get("id") == "capture_android_system_bridge_runtime_evidence"
        ]
        if selected:
            return selected
    packaging_codes = {
        "chip_local_manifest_image_prebuilts_not_materialized",
        "chip_local_manifest_does_not_project_system_ui",
        "chip_local_manifest_missing_system_bridge_service",
        "system_bridge_not_in_eliza_product_packages",
        "system_bridge_privapp_allowlist_missing",
        "system_bridge_privapp_permissions_not_granted",
    }
    if finding.code in packaging_codes:
        selected = [
            batch
            for batch in command_plan
            if batch.get("id") == "rebuild_android_product_after_bridge_packaging_fix"
        ]
        if selected:
            return selected
    return command_plan


def preferred_next_command(finding: Finding, commands: list[str]) -> str:
    if finding.code.startswith("system_bridge_runtime"):
        for command in commands:
            if "capture_system_bridge_runtime_evidence.py" in command:
                return command
    if (
        "manifest" in finding.code
        or "privapp" in finding.code
        or "product_packages" in finding.code
    ):
        for command in commands:
            if command.startswith("m "):
                return command
    return commands[0]


def finding_payload(
    finding: Finding,
    command_plan: list[dict[str, object]],
) -> dict[str, Any]:
    row = asdict(finding)
    commands = command_plan_commands(command_batches_for_finding(finding, command_plan))
    if commands:
        row["next_command"] = preferred_next_command(finding, commands)
        row["next_commands"] = commands
    return row


def run_check(args: argparse.Namespace) -> dict[str, object]:
    inputs = (
        BRIDGE_KT,
        BRIDGE_MANIFEST,
        BRIDGE_GRADLE,
        ANDROID_PROVIDER,
        MOCK_PROVIDER,
        BRIDGE_CONTRACT,
        LAUNCHER_MAIN_ACTIVITY,
        OS_COMMON,
        LOCAL_MANIFEST,
        RUNTIME_CAPTURE,
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
    bridge_service_text = read_text(BRIDGE_SERVICE_KT) if BRIDGE_SERVICE_KT.is_file() else ""
    provider_text = read_text(ANDROID_PROVIDER)
    mock_text = read_text(MOCK_PROVIDER)
    gradle_text = read_text(BRIDGE_GRADLE)
    contract_text = read_text(BRIDGE_CONTRACT)
    launcher_text = read_text(LAUNCHER_MAIN_ACTIVITY)
    app_bridge_path = LAUNCHER_MAIN_ACTIVITY.parent / "ElizaAndroidSystemBridge.java"
    app_bridge_text = read_text(app_bridge_path) if app_bridge_path.is_file() else ""
    os_common_text = read_text(OS_COMMON)
    package = package_name_from_manifest(BRIDGE_MANIFEST)
    manifest_permissions = permissions_from_manifest(BRIDGE_MANIFEST)
    os_packages = product_packages(os_common_text)
    local_projection_kinds = local_manifest_file_projection_kinds(LOCAL_MANIFEST)
    local_dests = set(local_projection_kinds)
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
        not BRIDGE_SERVICE_KT.is_file()
        or "class SystemBridgeService" not in bridge_service_text
        or (
            "android.app.Service" not in bridge_service_text
            and ": Service" not in bridge_service_text
        )
        or "ElizaSystemBridge: bound" not in bridge_service_text,
        "system_bridge_service_class_missing_or_unbound",
        "SystemBridge manifest declares a service but the privileged APK lacks a concrete bound-service implementation",
        rel(BRIDGE_SERVICE_KT),
        "Add SystemBridgeService as a real android.app.Service, emit the bound runtime marker, and expose the bridge transport the launcher binds.",
    )
    add_if(
        findings,
        not (
            ("__elizaAndroidBridge" in launcher_text and "addJavascriptInterface" in launcher_text)
            or (
                "ElizaAndroidSystemBridge.install" in launcher_text
                and "__elizaAndroidBridge" in app_bridge_text
                and "addJavascriptInterface" in app_bridge_text
            )
        ),
        "launcher_webview_does_not_bind_system_bridge",
        "launcher WebView does not bind the native system bridge as window.__elizaAndroidBridge",
        rel(LAUNCHER_MAIN_ACTIVITY),
        "Bind the real SystemBridge transport into the launcher WebView under __elizaAndroidBridge before AndroidSystemProvider mounts.",
    )
    required_app_bridge_channels = {
        "eliza.android.wifi.state",
        "eliza.android.cell.state",
        "eliza.android.audio.state",
        "eliza.android.battery.state",
        "eliza.android.time.state",
        "eliza.android.connectivity.state",
        "eliza.android.lockscreen.state",
    }
    missing_app_bridge_channels = sorted(
        channel for channel in required_app_bridge_channels if channel not in app_bridge_text
    )
    app_bridge_live_state_incomplete = (
        not app_bridge_path.is_file()
        or bool(missing_app_bridge_channels)
        or "AndroidSystemProvider: live-state" not in app_bridge_text
        or "privileged_android_system_bridge_not_bound" not in app_bridge_text
    )
    add_if(
        findings,
        app_bridge_live_state_incomplete,
        "launcher_app_bridge_live_state_surface_incomplete",
        "launcher app-side bridge does not expose live Android state channels with a stable runtime marker and fail-closed unavailable path",
        (
            f"path={rel(app_bridge_path)} "
            f"missing_channels={missing_app_bridge_channels} "
            f"live_marker={'AndroidSystemProvider: live-state' in app_bridge_text} "
            f"fail_closed_marker={'privileged_android_system_bridge_not_bound' in app_bridge_text}"
        ),
        "Implement app-side Android manager snapshots for every SystemProvider state channel and emit the live-state marker only when the bridge is actively consumed.",
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
            dest.startswith(f"vendor/{VENDOR_DIR_NAME}/system-ui")
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
        f"vendor/{VENDOR_DIR_NAME}/system-ui/native/src/main/java/ai/elizaos/system/bridge/SystemBridgeService.kt"
        not in local_dests,
        "chip_local_manifest_missing_system_bridge_service",
        "chip local manifest does not project the concrete SystemBridgeService source into AOSP",
        rel(LOCAL_MANIFEST),
        "Project SystemBridgeService.kt with the rest of the native bridge sources so local-manifest builds package the same service as mirrored builds.",
    )
    non_materialized_dests = sorted(
        dest
        for dest in REQUIRED_MATERIALIZED_LOCAL_MANIFEST_DESTS
        if local_projection_kinds.get(dest) != "copyfile"
    )
    add_if(
        findings,
        bool(non_materialized_dests),
        "chip_local_manifest_image_prebuilts_not_materialized",
        "chip local manifest projects image-installed prebuilts as symlinks or omits them",
        f"non_copyfile_dests={non_materialized_dests}",
        "Use copyfile, not linkfile, for image-installed APK/XML/JSON/ZIP/RC prebuilts so builds do not miss artifacts and runtime probes do not see host-local symlinks.",
    )
    add_if(
        findings,
        len(channels) < 10,
        "system_bridge_contract_channels_incomplete",
        "JS bridge contract does not expose the expected system-control channel surface",
        f"channel_count={len(channels)} channels={sorted(channels)}",
        "Keep Wi-Fi, cell, audio, battery, time, connectivity, power, settings, and lockscreen channels in the contract.",
    )
    runtime_evidence = load_json(RUNTIME_EVIDENCE) if RUNTIME_EVIDENCE.is_file() else {}
    runtime_host = runtime_evidence.get("observations", {}).get("host_runtime", {})
    runtime_aosp_inventory = (
        runtime_host.get("aosp_build_only", {}).get("artifact_inventory", {})
        if isinstance(runtime_host, dict)
        else {}
    )
    add_if(
        findings,
        not RUNTIME_EVIDENCE.is_file(),
        "system_bridge_runtime_evidence_missing",
        "booted Android system bridge runtime evidence is missing",
        rel(RUNTIME_EVIDENCE),
        "Run scripts/android/capture_system_bridge_runtime_evidence.py against the selected AOSP/chip-emulator target to prove the bridge package is installed, service is registered, privapp permissions are granted, the JS bridge is bound, launcher consumes live state, and logs are clean.",
    )
    if runtime_evidence:
        add_if(
            findings,
            runtime_evidence.get("schema") != RUNTIME_SCHEMA,
            "system_bridge_runtime_schema_mismatch",
            "booted Android system bridge runtime evidence has the wrong schema",
            f"schema={runtime_evidence.get('schema')!r}",
            f"Regenerate runtime evidence with schema {RUNTIME_SCHEMA}.",
        )
        add_if(
            findings,
            runtime_evidence.get("claim_boundary") != RUNTIME_CLAIM_BOUNDARY,
            "system_bridge_runtime_claim_boundary_mismatch",
            "booted Android system bridge runtime evidence has the wrong claim boundary",
            f"claim_boundary={runtime_evidence.get('claim_boundary')!r}",
            f"Regenerate runtime evidence with claim_boundary {RUNTIME_CLAIM_BOUNDARY}.",
        )
        add_if(
            findings,
            runtime_evidence.get("status") != "PASS",
            "system_bridge_runtime_status_not_pass",
            "booted Android system bridge runtime evidence does not record status=PASS",
            f"status={runtime_evidence.get('status')!r}",
            "Regenerate runtime evidence from a booted target after every bridge runtime assertion passes.",
        )
        add_if(
            findings,
            runtime_evidence.get("result") not in (0, "0"),
            "system_bridge_runtime_result_not_zero",
            "booted Android system bridge runtime evidence does not record result=0",
            f"result={runtime_evidence.get('result')!r}",
            "Regenerate runtime evidence from a successful capture; blocked or failed captures must not satisfy this contract.",
        )
        add_if(
            findings,
            runtime_evidence.get("launcher_package") != APP_PACKAGE,
            "system_bridge_runtime_launcher_package_mismatch",
            "booted Android system bridge runtime evidence targets a different launcher package than the current Android build",
            f"expected={APP_PACKAGE!r} actual={runtime_evidence.get('launcher_package')!r}",
            f"Recapture with scripts/android/capture_system_bridge_runtime_evidence.py --launcher-package {APP_PACKAGE} after booting the current {APP_NAME}/{VENDOR_DIR_NAME} image.",
        )
        required_true = {
            "sys_boot_completed",
            "system_privapp_apk_present",
            "package_installed",
            "service_registered",
            "privapp_permissions_granted",
            "js_bridge_bound",
            "launcher_consumed_live_state",
            "production_mock_fallback_absent",
            "permission_xml_host_symlink_absent",
        }
        missing_true = sorted(key for key in required_true if runtime_evidence.get(key) is not True)
        add_if(
            findings,
            bool(missing_true),
            "system_bridge_runtime_evidence_incomplete",
            "booted Android system bridge runtime evidence does not prove every required live bridge marker",
            f"missing_or_false={missing_true}",
            "Regenerate system bridge runtime evidence with boot completion, package install path, service registration, permission grants, JS bridge binding, live-state UI consumption, and no production mock fallback.",
        )
        permission_evidence = {
            "permission_file_probes": runtime_evidence.get("observations", {}).get(
                "permission_file_probes", {}
            ),
            "permission_file_symlink_targets": runtime_evidence.get("observations", {}).get(
                "permission_file_symlink_targets", {}
            ),
        }
        permission_probe_text = json.dumps(permission_evidence, sort_keys=True)
        observed_permission_paths = set(
            runtime_evidence.get("observations", {}).get("permission_file_probes", {})
        ) | set(runtime_evidence.get("observations", {}).get("permission_file_symlink_targets", {}))
        missing_runtime_permission_paths = sorted(
            EXPECTED_RUNTIME_PERMISSION_XMLS - observed_permission_paths
        )
        stale_permission_paths = stale_runtime_permission_paths(observed_permission_paths)
        add_if(
            findings,
            bool(missing_runtime_permission_paths),
            "system_bridge_runtime_permission_xml_probe_missing_current_identity",
            "system bridge runtime evidence did not probe every permission XML for the current launcher package identity",
            f"missing={missing_runtime_permission_paths} expected_launcher_package={APP_PACKAGE}",
            f"Recapture with the current defaults or pass --launcher-package {APP_PACKAGE}; probes must include the {APP_PACKAGE} default and privapp XMLs plus the bridge privapp XML.",
        )
        add_if(
            findings,
            bool(stale_permission_paths),
            "system_bridge_runtime_permission_xml_probe_stale_identity",
            "system bridge runtime evidence includes permission XML probes for a stale launcher package identity",
            f"stale_paths={stale_permission_paths} expected_launcher_package={APP_PACKAGE}",
            "Delete stale evidence and recapture from the current image; do not reuse probes from an older Eliza/Milady package identity.",
        )
        add_if(
            findings,
            contains_host_local_symlink(permission_evidence),
            "system_bridge_runtime_permission_xml_host_symlink",
            "system bridge runtime evidence shows Android permission XMLs resolving to host-local symlinks",
            permission_probe_text,
            "Rebuild the AOSP product image after materializing vendor/eliza overlay files as regular files, not symlinks.",
        )
        add_if(
            findings,
            runtime_evidence.get("logcat_crash_count") not in (0, "0"),
            "system_bridge_runtime_logcat_crashes",
            "system bridge runtime evidence reports logcat crashes",
            f"logcat_crash_count={runtime_evidence.get('logcat_crash_count')!r}",
            "Fix bridge/launcher crashes and recapture a clean logcat summary.",
        )
        add_if(
            findings,
            runtime_evidence.get("selinux_denial_count") not in (0, "0"),
            "system_bridge_runtime_selinux_denials",
            "system bridge runtime evidence reports SELinux denials",
            f"selinux_denial_count={runtime_evidence.get('selinux_denial_count')!r}",
            "Fix bridge SELinux policy and recapture denial-free runtime evidence.",
        )

    evidence: dict[str, object] = {
        "bridge_package": package,
        "native_not_implemented_count": not_impl_count,
        "bridge_service": rel(BRIDGE_SERVICE_KT),
        "bridge_service_present": BRIDGE_SERVICE_KT.is_file(),
        "launcher_main_activity": rel(LAUNCHER_MAIN_ACTIVITY),
        "launcher_app_bridge": rel(app_bridge_path),
        "launcher_app_bridge_live_state_channels": sorted(
            channel for channel in required_app_bridge_channels if channel in app_bridge_text
        ),
        "launcher_app_bridge_live_state_marker": "AndroidSystemProvider: live-state"
        in app_bridge_text,
        "launcher_binds_system_bridge": (
            "__elizaAndroidBridge" in launcher_text and "addJavascriptInterface" in launcher_text
        )
        or (
            "ElizaAndroidSystemBridge.install" in launcher_text
            and "__elizaAndroidBridge" in app_bridge_text
            and "addJavascriptInterface" in app_bridge_text
        ),
        "bridge_gradle": rel(BRIDGE_GRADLE),
        "channel_count": len(channels),
        "product_packages": sorted(os_packages),
        "privapp_permission_files": [rel(path) for path in priv_files],
        "manifest_permissions": sorted(manifest_permissions),
        "privapp_grants": sorted(priv_grants),
        "runtime_evidence": rel(RUNTIME_EVIDENCE),
        "runtime_evidence_present": RUNTIME_EVIDENCE.is_file(),
        "runtime_capture": rel(RUNTIME_CAPTURE),
        "runtime_adb_blocker": (
            runtime_host.get("adb_blocker") if isinstance(runtime_host, dict) else None
        ),
        "runtime_aosp_build_artifact_inventory": runtime_aosp_inventory,
        "local_manifest_projection_kinds": local_projection_kinds,
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, Any]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    dependency_counts: dict[str, int] = {}
    for finding in blockers:
        dependency_counts[finding.blocker_dependency] = (
            dependency_counts.get(finding.blocker_dependency, 0) + 1
        )
    command_plan = next_command_plan(findings)
    return {
        "schema": SCHEMA,
        "generated_utc": utc_now(),
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "summary": {
            "blockers": len(blockers),
            "findings": len(findings),
            "blocker_dependency_counts": dependency_counts,
            "next_command_batch_count": len(command_plan),
        },
        "blocker_dependency_counts": dependency_counts,
        "findings": [finding_payload(finding, command_plan) for finding in findings],
        "next_command_plan": command_plan,
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
