#!/usr/bin/env python3
"""Static Android app runtime contract gate for chip/AOSP bring-up.

This check does not boot Android and does not prove launcher foreground
readiness. It verifies that the repo's app package, prebuilt APK, vendor role
configuration, chip smoke defaults, service component, and local-agent HTTP
contract agree closely enough for a riscv64 Android boot test to be meaningful.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
ELIZA_ROOT = ROOT.parents[1]
REPORT = ROOT / "build/reports/android_app_runtime_contract.json"
SCHEMA = "eliza.android_app_runtime_contract.v1"
CLAIM_BOUNDARY = "static_app_runtime_contract_only_not_android_boot_or_launcher_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "launcher_runtime_claim_allowed": False,
    "android_runtime_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "cts_vts_claim_allowed": False,
    "gms_claim_allowed": False,
}


def package_name_to_path(package_name: str) -> Path:
    return Path(*package_name.split("."))


def read_repo_app_config() -> dict[str, str] | None:
    config_path = WORKSPACE / "app/app.config.ts"
    if not config_path.is_file():
        return None
    config = config_path.read_text(encoding="utf-8")
    values: dict[str, str] = {}
    for key in ("appId",):
        match = re.search(rf"\b{key}\s*:\s*[\"']([^\"']+)[\"']", config)
        if match:
            values[key] = match.group(1)
    return values if "appId" in values else None


APP_CONFIG = read_repo_app_config()
APP_SOURCE_PACKAGE = APP_CONFIG["appId"] if APP_CONFIG else "app.eliza"
APP_PACKAGE = "ai.elizaos.app"
APP_NAME = "Eliza"
VENDOR_DIR_NAME = "eliza"
VENDOR_ROOT = WORKSPACE / "os/android/vendor/eliza"

APP_GRADLE = WORKSPACE / "app/android/app/build.gradle"
APP_MANIFEST = WORKSPACE / "app/android/app/src/main/AndroidManifest.xml"
APP_JAVA_DIR = (
    WORKSPACE / "app/android/app/src/main/java" / package_name_to_path(APP_SOURCE_PACKAGE)
)
AGENT_SERVICE_JAVA = APP_JAVA_DIR / "ElizaAgentService.java"
NATIVE_BRIDGE_JAVA = APP_JAVA_DIR / "ElizaNativeBridge.java"
PREBUILT_APK = VENDOR_ROOT / "apps" / APP_NAME / f"{APP_NAME}.apk"
VENDOR_PERMISSION_XMLS = (
    VENDOR_ROOT / "permissions" / f"default-permissions-{APP_PACKAGE}.xml",
    VENDOR_ROOT / "permissions" / f"privapp-permissions-{APP_PACKAGE}.xml",
)
VENDOR_OVERLAY = VENDOR_ROOT / "overlays/frameworks/base/core/res/res/values/config.xml"
VENDOR_COMMON_MK = VENDOR_ROOT / f"{VENDOR_DIR_NAME}_common.mk"
CHIP_AOSP_SCRIPTS = (
    ROOT / "sw/aosp-device/start-eliza-agent-riscv64.sh",
    ROOT / "sw/aosp-device/agent-smoke-riscv64.sh",
    ROOT / "sw/aosp-device/scripts/cuttlefish_agent_smoke.py",
    ROOT / "sw/aosp-device/capture-aosp-evidence.sh",
    ROOT / "sw/aosp-device/install-eliza-apk-riscv64.sh",
)

KNOWN_ABIS = {"arm64-v8a", "armeabi-v7a", "x86", "x86_64", "riscv64"}
REQUIRED_RISCV64_JNI_LIBS = (
    "lib/riscv64/libeliza_bun.so",
    "lib/riscv64/libeliza_ld_musl_riscv64.so",
    "lib/riscv64/libeliza_stdcpp.so",
    "lib/riscv64/libeliza_gcc_s.so",
)
REQUIRED_RISCV64_AGENT_ASSETS = (
    "assets/agent/riscv64/bun",
    "assets/agent/riscv64/ld-musl-riscv64.so.1",
    "assets/agent/riscv64/libstdc++.so.6.0.33",
    "assets/agent/riscv64/libgcc_s.so.1",
)


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def rel(path: Path) -> str:
    try:
        return path.relative_to(WORKSPACE).as_posix()
    except ValueError:
        return str(path)


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def tool_source(value: str) -> str:
    path = Path(value)
    if path.is_absolute():
        return path.name
    return value


def extract_gradle_application_id(text: str) -> str | None:
    match = re.search(r"\bapplicationId\s+['\"]([^'\"]+)['\"]", text)
    return match.group(1) if match else None


def extract_manifest_services(text: str) -> set[str]:
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        return set(re.findall(r'android:name="([^"]+Service)"', text))
    android_name = "{http://schemas.android.com/apk/res/android}name"
    services: set[str] = set()
    for service in root.findall(".//service"):
        name = service.attrib.get(android_name)
        if name:
            services.add(name)
    return services


def extract_manifest_service_attrs(text: str) -> dict[str, dict[str, str | None]]:
    android = "{http://schemas.android.com/apk/res/android}"
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        return {}
    services: dict[str, dict[str, str | None]] = {}
    for service in root.findall(".//service"):
        name = service.attrib.get(f"{android}name")
        if not name:
            continue
        services[name] = {
            "exported": service.attrib.get(f"{android}exported"),
            "foregroundServiceType": service.attrib.get(f"{android}foregroundServiceType"),
            "permission": service.attrib.get(f"{android}permission"),
        }
    return services


def extract_permission_packages(path: Path) -> set[str]:
    root = ElementTree.fromstring(read_text(path))
    packages: set[str] = set()
    for element in root.iter():
        package_name = element.attrib.get("package")
        if package_name:
            packages.add(package_name)
    return packages


def extract_overlay_defaults(path: Path) -> set[str]:
    root = ElementTree.fromstring(read_text(path))
    packages: set[str] = set()
    for element in root.findall("string"):
        name = element.attrib.get("name", "")
        if name.startswith("config_default") and element.text:
            packages.add(element.text.strip())
    return packages


def extract_makefile_home(path: Path) -> str | None:
    text = read_text(path)
    match = re.search(r"\bro\.elizaos\.home=([A-Za-z0-9_.]+)", text)
    if not match:
        match = re.search(r"\bro\.[A-Za-z0-9_.]+\.home=([A-Za-z0-9_.]+)", text)
    return match.group(1) if match else None


def extract_script_default(text: str, var_name: str) -> str | None:
    # Handles shell ${VAR:-default} and Python env("VAR", "default") forms.
    shell = re.search(r"\$\{" + re.escape(var_name) + r":-([^}]+)\}", text)
    if shell:
        return shell.group(1)
    py = re.search(r'env\(["\']' + re.escape(var_name) + r'["\'],\s*["\']([^"\']+)["\']\)', text)
    if py:
        return py.group(1)
    return None


def collect_script_defaults(paths: Iterable[Path], var_name: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for path in paths:
        if not path.is_file():
            continue
        value = extract_script_default(read_text(path), var_name)
        if value:
            values[rel(path)] = value
    return values


def find_apkanalyzer(explicit: str | None = None) -> str | None:
    if explicit:
        return explicit if Path(explicit).is_file() else None
    for candidate in (
        os.environ.get("APKANALYZER"),
        str(Path.home() / "Android/Sdk/cmdline-tools/latest/bin/apkanalyzer"),
        shutil.which("apkanalyzer"),
    ):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def apk_application_id(
    apk: Path, apkanalyzer: str | None, override: str | None
) -> tuple[str | None, str]:
    if override:
        return override, "override"
    analyzer = find_apkanalyzer(apkanalyzer)
    if not analyzer:
        return None, "apkanalyzer not found"
    completed = subprocess.run(
        [analyzer, "manifest", "application-id", str(apk)],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        return None, f"apkanalyzer failed: {detail[:160]}"
    return completed.stdout.strip(), analyzer


def apk_entries(apk: Path) -> list[str]:
    with zipfile.ZipFile(apk) as archive:
        return archive.namelist()


def apk_native_abis(entries: Iterable[str]) -> set[str]:
    abis: set[str] = set()
    for entry in entries:
        parts = entry.split("/")
        if len(parts) >= 3 and parts[0] == "lib" and parts[1] in KNOWN_ABIS:
            abis.add(parts[1])
    return abis


def apk_agent_abis(entries: Iterable[str]) -> set[str]:
    abis: set[str] = set()
    for entry in entries:
        parts = entry.split("/")
        if (
            len(parts) >= 4
            and parts[0] == "assets"
            and parts[1] == "agent"
            and parts[2] in KNOWN_ABIS
        ):
            abis.add(parts[2])
    return abis


def missing_entries(entries: Iterable[str], required: Iterable[str]) -> list[str]:
    present = set(entries)
    return [entry for entry in required if entry not in present]


def java_endpoint_literals(text: str) -> set[str]:
    endpoints = set(re.findall(r'["\'](/api/[A-Za-z0-9_./{}-]+)["\']', text))
    endpoints.update(re.findall(r"https?://[^\"']+(/api/[A-Za-z0-9_./{}-]+)", text))
    return {endpoint.rstrip(".,;:") for endpoint in endpoints}


def script_endpoint_literals(paths: Iterable[Path]) -> dict[str, set[str]]:
    endpoints: dict[str, set[str]] = {}
    for path in paths:
        if not path.is_file():
            continue
        found = {
            endpoint.rstrip(".,;:")
            for endpoint in re.findall(r"/api/[A-Za-z0-9_./{}-]+", read_text(path))
        }
        if found:
            endpoints[rel(path)] = found
    return endpoints


def scripts_use_adb_foreground_service(paths: Iterable[Path]) -> dict[str, bool]:
    matches: dict[str, bool] = {}
    for path in paths:
        if not path.is_file():
            continue
        text = read_text(path)
        if "am start-foreground-service" in text:
            matches[rel(path)] = True
    return matches


def service_exported_for_name(
    service_attrs: dict[str, dict[str, str | None]], expected_names: set[str]
) -> str | None:
    for name in expected_names:
        attrs = service_attrs.get(name)
        if attrs is not None:
            return attrs.get("exported")
    return None


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
    severity: str = "blocker",
) -> None:
    if condition:
        findings.append(Finding(code, severity, message, evidence, next_step))


def run_check(args: argparse.Namespace) -> dict[str, object]:
    findings: list[Finding] = []
    required_paths = (
        APP_GRADLE,
        APP_MANIFEST,
        AGENT_SERVICE_JAVA,
        APP_JAVA_DIR,
        NATIVE_BRIDGE_JAVA,
        PREBUILT_APK if args.apk is None else Path(args.apk),
        *VENDOR_PERMISSION_XMLS,
        VENDOR_OVERLAY,
        VENDOR_COMMON_MK,
        *CHIP_AOSP_SCRIPTS,
    )
    missing = [
        path
        for path in required_paths
        if not (path.is_dir() if path == APP_JAVA_DIR else path.is_file())
    ]
    for path in missing:
        findings.append(
            Finding(
                "missing_input",
                "blocker",
                "required Android runtime contract input is missing",
                rel(path),
                "Restore or generate the missing input before claiming app runtime readiness.",
            )
        )

    if missing:
        return report_payload(findings, {})

    apk_path = Path(args.apk) if args.apk else PREBUILT_APK
    gradle_id = extract_gradle_application_id(read_text(APP_GRADLE))
    apk_id, raw_apk_id_source = apk_application_id(
        apk_path, args.apkanalyzer, args.apk_package_id
    )
    apk_id_source = tool_source(raw_apk_id_source)
    permission_packages: dict[str, set[str]] = {
        rel(path): extract_permission_packages(path) for path in VENDOR_PERMISSION_XMLS
    }
    overlay_packages = extract_overlay_defaults(VENDOR_OVERLAY)
    makefile_home = extract_makefile_home(VENDOR_COMMON_MK)
    script_packages = collect_script_defaults(CHIP_AOSP_SCRIPTS, "AOSP_AGENT_PACKAGE")
    script_services = collect_script_defaults(CHIP_AOSP_SCRIPTS, "AOSP_AGENT_SERVICE")
    manifest_text = read_text(APP_MANIFEST)
    services = extract_manifest_services(manifest_text)
    service_attrs = extract_manifest_service_attrs(manifest_text)
    app_endpoints: set[str] = set()
    for java_file in sorted(APP_JAVA_DIR.glob("*.java")):
        app_endpoints.update(java_endpoint_literals(read_text(java_file)))
    script_endpoints = script_endpoint_literals(CHIP_AOSP_SCRIPTS)
    adb_service_starters = scripts_use_adb_foreground_service(CHIP_AOSP_SCRIPTS)

    entries = apk_entries(apk_path)
    native_abis = apk_native_abis(entries)
    agent_abis = apk_agent_abis(entries)
    missing_riscv64_jni = missing_entries(entries, REQUIRED_RISCV64_JNI_LIBS)
    missing_riscv64_agent_assets = missing_entries(entries, REQUIRED_RISCV64_AGENT_ASSETS)

    identity_sources = {
        "gradle_application_id": gradle_id,
        "apk_application_id": apk_id,
        "permission_packages": {k: sorted(v) for k, v in permission_packages.items()},
        "overlay_default_packages": sorted(overlay_packages),
        "makefile_ro_elizaos_home": makefile_home,
        "script_package_defaults": script_packages,
    }
    identity_values = {value for value in (gradle_id, apk_id, makefile_home) if value}
    for packages in permission_packages.values():
        identity_values.update(packages)
    identity_values.update(overlay_packages)
    identity_values.update(script_packages.values())

    add_if(
        findings,
        apk_id is None,
        "apk_application_id_unknown",
        "prebuilt APK package id could not be read",
        apk_id_source,
        "Install Android cmdline-tools apkanalyzer or pass --apk-package-id from trusted build metadata.",
    )
    add_if(
        findings,
        len(identity_values) > 1,
        "android_package_identity_mismatch",
        "app, APK, vendor role/permission config, and chip smoke defaults target different packages",
        json.dumps(identity_sources, sort_keys=True),
        "Choose one Android package id and use it across Gradle, prebuilt APK, vendor XML/overlays, ro.elizaos.home, and chip smoke scripts.",
    )
    add_if(
        findings,
        "riscv64" not in native_abis,
        "apk_missing_riscv64_native_libs",
        "prebuilt APK does not contain native libraries for riscv64",
        f"native_abis={sorted(native_abis)} apk={rel(apk_path)}",
        "Build/import a riscv64 APK that includes lib/riscv64 entries required by the local runtime.",
    )
    add_if(
        findings,
        bool(missing_riscv64_jni),
        "apk_missing_riscv64_runtime_jni_payload",
        "prebuilt APK does not contain the complete packaged riscv64 local-agent JNI runtime payload",
        f"missing={missing_riscv64_jni} apk={rel(apk_path)}",
        "Build/import the APK with a verified riscv64 Bun artifact so lib/riscv64 contains bun, musl loader, libstdc++, and libgcc runtime entries.",
    )
    add_if(
        findings,
        "riscv64" not in agent_abis,
        "apk_missing_riscv64_agent_assets",
        "prebuilt APK does not contain assets/agent/riscv64",
        f"agent_asset_abis={sorted(agent_abis)} apk={rel(apk_path)}",
        "Package the riscv64 Bun/local-agent payload under assets/agent/riscv64 and prove ElizaAgentService can extract it.",
    )
    add_if(
        findings,
        bool(missing_riscv64_agent_assets),
        "apk_missing_riscv64_runtime_agent_payload",
        "prebuilt APK does not contain the complete extractable riscv64 local-agent runtime payload",
        f"missing={missing_riscv64_agent_assets} apk={rel(apk_path)}",
        "Build/import the APK with a verified riscv64 Bun artifact so assets/agent/riscv64 contains bun, musl loader, libstdc++, and libgcc runtime entries.",
    )

    expected_service = f"{gradle_id}.ElizaAgentService" if gradle_id else "ElizaAgentService"
    expected_service_names = {
        ".ElizaAgentService",
        expected_service,
    }
    expected_service_components = {
        f"{gradle_id}/.ElizaAgentService" if gradle_id else ".ElizaAgentService",
        f"{gradle_id}/{expected_service}" if gradle_id else expected_service,
    }
    missing_service_defaults = {
        path: value
        for path, value in script_services.items()
        if value not in expected_service_components
    }
    add_if(
        findings,
        expected_service not in services and ".ElizaAgentService" not in services,
        "app_manifest_missing_agent_service",
        "AndroidManifest.xml does not expose the expected ElizaAgentService",
        f"services={sorted(services)}",
        "Declare the foreground service component used by chip and AOSP smoke scripts.",
    )
    add_if(
        findings,
        bool(missing_service_defaults),
        "android_service_identity_mismatch",
        "chip smoke scripts default to service components that do not match the app manifest",
        json.dumps(missing_service_defaults, sort_keys=True),
        "Align AOSP_AGENT_SERVICE defaults with the actual foreground service component in AndroidManifest.xml.",
    )
    service_exported = service_exported_for_name(service_attrs, expected_service_names)
    add_if(
        findings,
        bool(adb_service_starters) and service_exported == "false",
        "android_agent_service_not_exported_for_adb_smoke",
        'chip smoke starts ElizaAgentService directly through adb, but the manifest marks that service android:exported="false"',
        json.dumps(
            {
                "adb_service_starters": sorted(adb_service_starters),
                "expected_service_names": sorted(expected_service_names),
                "service_exported": service_exported,
            },
            sort_keys=True,
        ),
        "Either start the agent through a boot/launcher/in-app path that can reach the private service, or add a guarded test-only exported entrypoint and prove the smoke can start the service on-device.",
    )

    script_endpoint_union: set[str] = set()
    for endpoints in script_endpoints.values():
        script_endpoint_union.update(endpoints)
    app_health_ok = "/api/health" in app_endpoints
    scripts_use_app_health = "/api/health" in script_endpoint_union
    scripts_use_legacy_self_status = "/api/agent/self-status" in script_endpoint_union
    add_if(
        findings,
        app_health_ok and scripts_use_legacy_self_status and not scripts_use_app_health,
        "android_agent_health_contract_mismatch",
        "chip smoke scripts check /api/agent/self-status while the Android service watchdog uses /api/health",
        json.dumps(
            {
                "app_endpoints": sorted(app_endpoints),
                "script_endpoints": {k: sorted(v) for k, v in script_endpoints.items()},
            },
            sort_keys=True,
        ),
        "Define one versioned readiness endpoint or update the chip smokes to also assert the app watchdog /api/health contract.",
    )

    evidence = {
        "apk": rel(apk_path),
        "apk_application_id_source": apk_id_source,
        "identity_sources": identity_sources,
        "manifest_services": sorted(services),
        "manifest_service_attrs": service_attrs,
        "script_service_defaults": script_services,
        "adb_foreground_service_starters": sorted(adb_service_starters),
        "apk_native_abis": sorted(native_abis),
        "apk_agent_asset_abis": sorted(agent_abis),
        "missing_riscv64_jni_payload": missing_riscv64_jni,
        "missing_riscv64_agent_payload": missing_riscv64_agent_assets,
        "required_riscv64_jni_payload": list(REQUIRED_RISCV64_JNI_LIBS),
        "required_riscv64_agent_payload": list(REQUIRED_RISCV64_AGENT_ASSETS),
        "app_endpoints": sorted(app_endpoints),
        "script_endpoints": {k: sorted(v) for k, v in script_endpoints.items()},
    }
    return report_payload(findings, evidence)


def report_payload(findings: list[Finding], evidence: dict[str, Any]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    status = "pass" if not blockers else "blocked"
    return {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "generated_utc": utc_now(),
        **FALSE_CLAIM_FLAGS,
        "summary": {
            "blockers": len(blockers),
            "findings": len(findings),
        },
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(payload: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(payload: dict[str, Any]) -> None:
    status = str(payload["status"]).upper()
    print(f"STATUS: {status} android_app.runtime_contract")
    for finding in payload["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", help="APK to inspect instead of the vendor prebuilt")
    parser.add_argument(
        "--apk-package-id",
        help="trusted APK package id override, useful for hermetic unit fixtures",
    )
    parser.add_argument("--apkanalyzer", help="path to Android apkanalyzer")
    parser.add_argument(
        "--report",
        default=str(REPORT),
        help=f"report path (default: {REPORT.relative_to(ROOT)})",
    )
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    payload = run_check(args)
    write_report(payload, Path(args.report))
    if not args.json_only:
        print_summary(payload)
    return 0 if payload["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
