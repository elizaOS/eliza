#!/usr/bin/env python3
"""Audit cross-fork Android launcher/agent identity contracts.

This is a static survey gate. It checks whether the Android app, AOSP vendor
configuration, chip-side smoke scripts, and operator docs agree on the package
id, foreground service component, HOME role target, and agent health endpoint.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ROOT.parent
REPO = PACKAGES.parent
OUTER_WORKSPACE = ROOT.parents[2] if len(ROOT.parents) > 2 else REPO
REPORT = ROOT / "build/reports/chip-os-identity-contract.json"

SCHEMA = "eliza.chip_os_identity_contract.v1"
CLAIM_BOUNDARY = "static_identity_contract_only_not_android_boot_or_launcher_evidence"


def package_name_to_path(package_name: str) -> Path:
    return Path(*package_name.split("."))


def read_outer_app_config() -> dict[str, str] | None:
    config_path = OUTER_WORKSPACE / "apps/app/app.config.ts"
    if not config_path.is_file():
        return None
    config = config_path.read_text(encoding="utf-8")
    values: dict[str, str] = {}
    for key in ("appId", "vendorDir"):
        match = re.search(rf"\b{key}\s*:\s*[\"']([^\"']+)[\"']", config)
        if match:
            values[key] = match.group(1)
    return values if {"appId", "vendorDir"}.issubset(values) else None


BRAND_CONFIG = read_outer_app_config()
APP_PACKAGE = BRAND_CONFIG["appId"] if BRAND_CONFIG else "ai.elizaos.app"
VENDOR_DIR = BRAND_CONFIG["vendorDir"] if BRAND_CONFIG else "eliza"
APP_ANDROID_ROOT = PACKAGES / "app-core/platforms/android/app"
APP_JAVA_ROOT = APP_ANDROID_ROOT / "src/main/java" / package_name_to_path(APP_PACKAGE)
APP_GRADLE = APP_ANDROID_ROOT / "build.gradle"
APP_MANIFEST = APP_ANDROID_ROOT / "src/main/AndroidManifest.xml"
APP_STRINGS = APP_ANDROID_ROOT / "src/main/res/values/strings.xml"
APP_SHORTCUTS = APP_ANDROID_ROOT / "src/main/res/xml/shortcuts.xml"
APP_AGENT_SERVICE = APP_JAVA_ROOT / "ElizaAgentService.java"
APP_AGENT_PLUGIN = APP_JAVA_ROOT / "AgentPlugin.java"
OS_VENDOR_ROOT = (
    OUTER_WORKSPACE / "os/android/vendor" / VENDOR_DIR
    if BRAND_CONFIG
    else PACKAGES / "os/android/vendor/eliza"
)
OS_VENDOR_COMMON = OS_VENDOR_ROOT / f"{VENDOR_DIR}_common.mk"
OS_VENDOR_OVERLAY = OS_VENDOR_ROOT / "overlays/frameworks/base/core/res/res/values/config.xml"
OS_PERMISSION_XMLS = (
    OS_VENDOR_ROOT / "permissions" / f"default-permissions-{APP_PACKAGE}.xml",
    OS_VENDOR_ROOT / "permissions" / f"privapp-permissions-{APP_PACKAGE}.xml",
)
CHIP_SCRIPTS = (
    ROOT / "sw/aosp-device/agent-smoke-riscv64.sh",
    ROOT / "sw/aosp-device/capture-aosp-evidence.sh",
    ROOT / "sw/aosp-device/cuttlefish-boot-gate.sh",
    ROOT / "sw/aosp-device/install-eliza-apk-riscv64.sh",
    ROOT / "sw/aosp-device/start-eliza-agent-riscv64.sh",
    ROOT / "sw/aosp-device/scripts/cuttlefish_agent_smoke.py",
)
OPERATOR_DOCS = (
    ROOT / "docs/android/cuttlefish-agent-smoke-operator-recipe.md",
    ROOT / "docs/project/aosp-simulator-completion-gate.yaml",
)
ANDROID_RELEASE_MANIFESTS = (
    PACKAGES / "os/android/installer/manifests/android-release-manifest.example.json",
    PACKAGES / "os/release/beta-2026-05-16/android-release-manifest.json",
)
APP_AGENT_PLUGIN_MANIFEST = APP_ANDROID_ROOT / "src/main/assets/agent/plugins-manifest.json"


def rel(path: Path) -> str:
    try:
        return path.relative_to(REPO).as_posix()
    except ValueError:
        return str(path)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def json_file(path: Path) -> dict[str, Any]:
    return json.loads(read_text(path))


def xml_root(path: Path) -> ElementTree.Element:
    return ElementTree.fromstring(read_text(path))


def gradle_application_id(text: str) -> str | None:
    match = re.search(r"\bapplicationId\s+['\"]([^'\"]+)['\"]", text)
    return match.group(1) if match else None


def xml_string_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    root = xml_root(path)
    for element in root.findall("string"):
        name = element.attrib.get("name")
        if name and element.text:
            values[name] = element.text.strip()
    return values


def manifest_services(path: Path) -> set[str]:
    root = xml_root(path)
    android_name = "{http://schemas.android.com/apk/res/android}name"
    return {
        value
        for service in root.findall(".//service")
        if (value := service.attrib.get(android_name))
    }


def manifest_has_home_activity(path: Path) -> bool:
    root = xml_root(path)
    android_name = "{http://schemas.android.com/apk/res/android}name"
    for activity in root.findall(".//activity"):
        actions = {action.attrib.get(android_name) for action in activity.findall(".//action")}
        categories = {
            category.attrib.get(android_name) for category in activity.findall(".//category")
        }
        if "android.intent.action.MAIN" in actions and "android.intent.category.HOME" in categories:
            return True
    return False


def shortcut_target_packages(path: Path) -> set[str]:
    root = xml_root(path)
    android_target_package = "{http://schemas.android.com/apk/res/android}targetPackage"
    return {
        value for element in root.iter() if (value := element.attrib.get(android_target_package))
    }


def permission_packages(path: Path) -> set[str]:
    root = xml_root(path)
    return {value for element in root.iter() if (value := element.attrib.get("package"))}


def ro_home(text: str) -> str | None:
    match = re.search(r"\bro\.[A-Za-z0-9_.-]+\.home=([A-Za-z0-9_.]+)", text)
    return match.group(1) if match else None


def script_default(text: str, var_name: str) -> str | None:
    shell = re.search(r"\$\{" + re.escape(var_name) + r":-([^}]+)\}", text)
    if shell:
        return shell.group(1)
    py = re.search(
        r'env\(["\']' + re.escape(var_name) + r'["\'],\s*["\']([^"\']+)["\']\)',
        text,
    )
    if py:
        return py.group(1)
    assignment = re.search(rf"^{re.escape(var_name.lower())}=([A-Za-z0-9_./:-]+)", text, re.M)
    if assignment:
        return assignment.group(1)
    short_name = var_name.lower()
    for prefix in ("aosp_", ""):
        if short_name.startswith(prefix):
            candidate = short_name.removeprefix(prefix)
            direct_assignment = re.search(
                rf"^{re.escape(candidate)}=[\"']?([A-Za-z0-9_./:-]+)[\"']?",
                text,
                re.M,
            )
            if direct_assignment:
                return direct_assignment.group(1)
    return None


def endpoint_literals(text: str) -> set[str]:
    return {value.rstrip(".,;:") for value in re.findall(r"/api/[A-Za-z0-9_./{}-]+", text)}


def release_validation_tokens(path: Path) -> set[str]:
    data = json_file(path)
    validation = data.get("validation", {})
    return {
        token
        for token in json.dumps(validation, sort_keys=True).split('"')
        if token
        in {
            "pm path",
            "cmd role holders",
            "HOME",
            "foreground",
            "service",
            "/api/health",
            "logcat",
            "selinux",
            "avc",
        }
    }


def finding(
    code: str,
    message: str,
    evidence: str,
    next_step: str,
    severity: str = "blocker",
) -> dict[str, Any]:
    return {
        "code": code,
        "severity": severity,
        "message": message,
        "evidence": evidence,
        "next_step": next_step,
    }


def build_report() -> dict[str, Any]:
    required_paths = (
        APP_GRADLE,
        APP_MANIFEST,
        APP_STRINGS,
        APP_SHORTCUTS,
        APP_AGENT_SERVICE,
        APP_AGENT_PLUGIN,
        OS_VENDOR_COMMON,
        OS_VENDOR_OVERLAY,
        *OS_PERMISSION_XMLS,
        *CHIP_SCRIPTS,
        *OPERATOR_DOCS,
        *ANDROID_RELEASE_MANIFESTS,
        APP_AGENT_PLUGIN_MANIFEST,
    )
    findings: list[dict[str, Any]] = []
    missing = [path for path in required_paths if not path.is_file()]
    for path in missing:
        findings.append(
            finding(
                "identity_input_missing",
                "required identity contract input is missing",
                rel(path),
                "Restore the missing Android/app/OS/chip identity input before claiming launcher or agent readiness.",
            )
        )
    if missing:
        return report_payload(findings, {"missing_inputs": [rel(path) for path in missing]})

    app_id = gradle_application_id(read_text(APP_GRADLE))
    strings = xml_string_values(APP_STRINGS)
    capacitor_id = APP_PACKAGE
    shortcuts = shortcut_target_packages(APP_SHORTCUTS)
    services = manifest_services(APP_MANIFEST)
    home_activity = manifest_has_home_activity(APP_MANIFEST)
    vendor_overlay = xml_string_values(OS_VENDOR_OVERLAY)
    vendor_home = ro_home(read_text(OS_VENDOR_COMMON))
    permissions = {rel(path): permission_packages(path) for path in OS_PERMISSION_XMLS}
    script_packages = {
        rel(path): value
        for path in CHIP_SCRIPTS
        if (value := script_default(read_text(path), "AOSP_AGENT_PACKAGE"))
    }
    script_services = {
        rel(path): value
        for path in CHIP_SCRIPTS
        if (value := script_default(read_text(path), "AOSP_AGENT_SERVICE"))
    }
    app_endpoints = endpoint_literals(read_text(APP_AGENT_SERVICE)) | endpoint_literals(
        read_text(APP_AGENT_PLUGIN)
    )
    script_endpoints = {
        rel(path): endpoint_literals(read_text(path))
        for path in CHIP_SCRIPTS
        if endpoint_literals(read_text(path))
    }
    doc_packages = {
        rel(path): sorted(
            set(
                re.findall(
                    r"\b(?:app\.eliza|ai\.elizaos\.app|com\.elizaos\.agent)\b", read_text(path)
                )
            )
        )
        for path in OPERATOR_DOCS
    }
    release_validation = {
        rel(path): sorted(release_validation_tokens(path)) for path in ANDROID_RELEASE_MANIFESTS
    }
    plugin_manifest = json_file(APP_AGENT_PLUGIN_MANIFEST)
    externals_as_stubs = plugin_manifest.get("externalsAsStubs", [])
    unsupported_android_runtime_stubs = set(
        item
        for item in plugin_manifest.get("unsupportedAndroidRuntimeStubs", [])
        if isinstance(item, str)
    )

    declared_packages = {
        "gradle_application_id": app_id,
        "capacitor_app_id": capacitor_id,
        "strings_package_name": strings.get("package_name"),
        "vendor_ro_home": vendor_home,
        "vendor_default_home": vendor_overlay.get("config_defaultHome"),
        "vendor_default_assistant": vendor_overlay.get("config_defaultAssistant"),
    }
    package_values = {value for value in declared_packages.values() if isinstance(value, str)}
    permission_values = set().union(*permissions.values())
    script_package_values = set(script_packages.values())
    shortcut_values = set(shortcuts)

    if len(package_values) > 1 or app_id not in permission_values or app_id not in shortcut_values:
        findings.append(
            finding(
                "android_package_identity_mismatch",
                "Android app, OS vendor overlays/permissions, shortcuts, and chip scripts do not agree on one package id",
                json.dumps(
                    {
                        "declared_packages": declared_packages,
                        "permission_packages": sorted(permission_values),
                        "shortcut_target_packages": sorted(shortcut_values),
                        "script_package_defaults": script_packages,
                    },
                    sort_keys=True,
                ),
                "Choose one package id and regenerate Gradle, Capacitor, manifest/resources, vendor role/default-permission XML, ro.elizaos.home, shortcuts, and chip smoke defaults around it.",
            )
        )

    if script_package_values and script_package_values != {vendor_home}:
        findings.append(
            finding(
                "chip_script_package_defaults_mismatch",
                "chip-side AOSP scripts default to package ids that do not match the vendor HOME package",
                json.dumps(script_packages, sort_keys=True),
                "Set AOSP_AGENT_PACKAGE defaults to the same package installed as the AOSP HOME/assistant app.",
            )
        )

    expected_service = f"{vendor_home}/.ElizaAgentService" if vendor_home else None
    app_service_names = {
        ".ElizaAgentService",
        f"{APP_PACKAGE}.ElizaAgentService",
        "app.eliza.ElizaAgentService",
    }
    if not (services & app_service_names):
        findings.append(
            finding(
                "android_agent_service_missing",
                "AndroidManifest does not expose ElizaAgentService",
                json.dumps(sorted(services)),
                "Declare the Eliza foreground agent service in the app manifest.",
            )
        )
    if expected_service and set(script_services.values()) != {expected_service}:
        findings.append(
            finding(
                "chip_script_service_defaults_mismatch",
                "chip-side AOSP scripts default to service components that do not match the vendor package service",
                json.dumps(
                    {"expected": expected_service, "script_services": script_services},
                    sort_keys=True,
                ),
                "Set AOSP_AGENT_SERVICE defaults to the service component exported by the installed Eliza APK.",
            )
        )

    if not home_activity:
        findings.append(
            finding(
                "android_home_activity_missing",
                "Android app manifest does not declare a HOME activity",
                rel(APP_MANIFEST),
                "Declare a MAIN/HOME/DEFAULT activity before claiming launcher readiness.",
            )
        )

    if "/api/health" not in app_endpoints:
        findings.append(
            finding(
                "android_app_health_endpoint_missing",
                "Android app service/plugin code does not reference /api/health",
                json.dumps(sorted(app_endpoints)),
                "Keep the app watchdog and smoke scripts on the same health endpoint.",
            )
        )
    script_endpoint_union = set().union(*script_endpoints.values()) if script_endpoints else set()
    if "/api/health" not in script_endpoint_union:
        findings.append(
            finding(
                "chip_script_health_endpoint_missing",
                "chip smoke scripts do not probe /api/health",
                json.dumps(
                    {key: sorted(value) for key, value in script_endpoints.items()}, sort_keys=True
                ),
                "Probe /api/health through adb forward as the primary app watchdog readiness contract.",
            )
        )
    self_status_is_documented_secondary = any(
        "Deep capability detail" in read_text(path) and "/api/agent/self-status" in read_text(path)
        for path in CHIP_SCRIPTS
    )
    if (
        "/api/agent/self-status" in script_endpoint_union
        and not self_status_is_documented_secondary
    ):
        findings.append(
            finding(
                "legacy_self_status_endpoint_still_required",
                "chip smoke scripts still require /api/agent/self-status in addition to /api/health",
                json.dumps(
                    {key: sorted(value) for key, value in script_endpoints.items()}, sort_keys=True
                ),
                "Either make /api/agent/self-status a documented secondary check or remove it from required launcher/agent readiness.",
            )
        )

    stale_docs = {
        path: packages for path, packages in doc_packages.items() if "com.elizaos.agent" in packages
    }
    if stale_docs:
        findings.append(
            finding(
                "operator_docs_stale_agent_identity",
                "operator documentation still mentions legacy com.elizaos.agent identity",
                json.dumps(stale_docs, sort_keys=True),
                "Update operator docs so humans run the same package/service contract as the automated gates.",
            )
        )

    required_release_tokens = {
        "pm path",
        "cmd role holders",
        "foreground",
        "service",
        "/api/health",
        "logcat",
        "selinux",
    }
    weak_release_manifests = {
        path: sorted(required_release_tokens - set(tokens))
        for path, tokens in release_validation.items()
        if required_release_tokens - set(tokens)
    }
    if weak_release_manifests:
        findings.append(
            finding(
                "android_release_identity_validation_missing_launcher_agent_checks",
                "Android release manifests do not validate launcher package, HOME role, foreground state, service, health, logs, and SELinux",
                json.dumps(weak_release_manifests, sort_keys=True),
                "Extend Android release validation metadata so release/post-flash flows prove the same package, HOME, service, /api/health, logcat, and SELinux contract as the launcher evidence gate.",
            )
        )

    runtime_stub_externals = sorted(
        item
        for item in externals_as_stubs
        if isinstance(item, str)
        and item not in unsupported_android_runtime_stubs
        and (
            item in {"@elizaos/plugin-shell", "@elizaos/plugin-agent-orchestrator"}
            or "llama" in item
            or "onnxruntime" in item
            or item in {"sharp", "canvas", "pty-manager"}
        )
    )
    if runtime_stub_externals:
        findings.append(
            finding(
                "android_agent_plugin_manifest_runtime_stubs",
                "Android agent plugin manifest still replaces runtime-critical plugins or native libraries with stubs",
                json.dumps(runtime_stub_externals),
                "Classify these stubs as unsupported on Android or package real mobile-compatible implementations before claiming local-agent no-issues runtime.",
            )
        )

    evidence = {
        "declared_packages": declared_packages,
        "permission_packages": {key: sorted(value) for key, value in permissions.items()},
        "shortcut_target_packages": sorted(shortcuts),
        "script_package_defaults": script_packages,
        "script_service_defaults": script_services,
        "manifest_services": sorted(services),
        "home_activity_declared": home_activity,
        "app_endpoints": sorted(app_endpoints),
        "script_endpoints": {key: sorted(value) for key, value in script_endpoints.items()},
        "operator_doc_packages": doc_packages,
        "release_validation_tokens": release_validation,
        "agent_plugin_manifest": {
            "path": rel(APP_AGENT_PLUGIN_MANIFEST),
            "externals_as_stubs_count": len(externals_as_stubs)
            if isinstance(externals_as_stubs, list)
            else None,
            "unsupported_android_runtime_stubs": sorted(unsupported_android_runtime_stubs),
            "runtime_stub_externals": runtime_stub_externals,
        },
    }
    return report_payload(findings, evidence)


def report_payload(findings: list[dict[str, Any]], evidence: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "status": "blocked" if findings else "pass",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "findings": len(findings),
            "packages_observed": sorted(
                {
                    value
                    for value in json.dumps(evidence).replace('"', " ").split()
                    if value in {"app.eliza", "ai.elizaos.app", "com.elizaos.agent", APP_PACKAGE}
                }
            ),
        },
        "evidence": evidence,
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
    print(
        f"STATUS: {str(report['status']).upper()} chip_os_identity_contract "
        f"findings={report['summary']['findings']} report={rel(output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
