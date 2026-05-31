#!/usr/bin/env python3
"""Gate booted Android launcher + local-agent runtime evidence.

Static APK/product checks are useful preflight, but the objective requires a
booted Android target where Eliza is actually the launcher and the local agent
is healthy. This gate validates a structured evidence JSON captured from ADB.
If the evidence is absent, the gate reports BLOCKED rather than inferring
runtime readiness from build artifacts.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/android_launcher_runtime_evidence.json"
DEFAULT_EVIDENCE = ROOT / "docs/evidence/android/eliza_launcher_runtime_evidence.json"
ANDROID_APK_PAYLOAD_REPORT = ROOT / "build/reports/android_system_apk_payload.json"
SCHEMA = "eliza.android_launcher_runtime_evidence.v1"
CLAIM_BOUNDARY = "booted_android_launcher_agent_runtime_evidence_only"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "cts_vts_claim_allowed": False,
    "gms_claim_allowed": False,
    "full_android_compatibility_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
RUNTIME_CAPTURE_SCRIPT = "packages/chip/scripts/android/capture_launcher_runtime_evidence.py"
DEFAULT_CAPTURE_EVIDENCE = "packages/chip/docs/evidence/android/eliza_launcher_runtime_evidence.json"
DEFAULT_CAPTURE_LOGCAT = "packages/chip/docs/evidence/android/eliza_launcher_runtime_logcat.txt"
DEFAULT_CAPTURE_TRANSCRIPT = (
    "packages/chip/docs/evidence/android/eliza_launcher_runtime_transcript.log"
)
RECHECK_COMMAND = "python3 packages/chip/scripts/check_android_launcher_runtime_evidence.py --json-only"
ADB_CONNECT_CANDIDATES = ("127.0.0.1:6520", "127.0.0.1:5555")
ANDROID_TARGET_PREFIXES = (
    "/system/",
    "/vendor/",
    "/product/",
    "/system_ext/",
    "/odm/",
    "/apex/",
    "/data/",
)
HOST_LOCAL_PATH = re.compile(r"^/(?:home|Users|tmp|var/folders)/")


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str
    blocker_dependency: str = "live_device_validation"


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_json_or_empty(path: Path) -> dict[str, Any]:
    try:
        value = load_json(path)
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def expected_android_payload_package() -> str:
    report = load_json_or_empty(ANDROID_APK_PAYLOAD_REPORT)
    evidence = report.get("evidence")
    if not isinstance(evidence, dict):
        return "ai.elizaos.app"
    for key in ("provenance_android_package", "vendor_ro_elizaos_home", "expected_package"):
        value = evidence.get(key)
        if isinstance(value, str) and value:
            return value
    return "ai.elizaos.app"


def nested(data: dict[str, object], *keys: str) -> object:
    current: object = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def text_contains(value: object, needle: str) -> bool:
    return isinstance(value, str) and needle in value


def contains_host_local_symlink(value: object) -> bool:
    text = json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else str(value)
    for target in re.findall(r"->\s+(/[^\s\"']+)", text):
        if not target.startswith(ANDROID_TARGET_PREFIXES):
            return True
    return any(marker in text for marker in (" -> /home/", " -> /tmp/", " -> /Users/"))


def provenance_safe_value(value: object) -> object:
    if isinstance(value, dict):
        sanitized: dict[str, object] = {}
        for key, item in value.items():
            if key in {"path", "product_out"} and isinstance(item, str) and HOST_LOCAL_PATH.match(item):
                sanitized[key] = Path(item).name
            else:
                sanitized[key] = provenance_safe_value(item)
        return sanitized
    if isinstance(value, list):
        return [provenance_safe_value(item) for item in value]
    return value


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
    """Return live-capture command batches without granting release credit."""

    if not findings:
        return []
    codes = {finding.code for finding in findings}
    plan: list[dict[str, object]] = []
    if any(
        code.startswith(
            (
                "missing_launcher_runtime_evidence",
                "android_",
                "launcher_",
                "home_",
                "foreground_",
                "role_",
                "agent_",
                "fatal_",
                "selinux_",
                "logcat_",
            )
        )
        for code in codes
    ):
        plan.append(
            {
                "id": "capture_android_launcher_runtime_evidence",
                "scope": "host_adb",
                "claim_boundary": "operator_live_capture_commands_only_not_runtime_evidence",
                "commands": [
                    "adb devices",
                    (
                        f"{RUNTIME_CAPTURE_SCRIPT} "
                        f"{' '.join(f'--adb-connect {address}' for address in ADB_CONNECT_CANDIDATES)} "
                        f"--output {DEFAULT_CAPTURE_EVIDENCE} "
                        f"--logcat {DEFAULT_CAPTURE_LOGCAT} "
                        f"--transcript {DEFAULT_CAPTURE_TRANSCRIPT}"
                    ),
                    RECHECK_COMMAND,
                ],
                "requires": [
                    "exactly one booted Android target or explicit adb serial",
                    "sys.boot_completed=1 on the selected Android release target",
                    "launcher APK installed as the current system HOME/foreground app",
                    "agent service process running with ready /api/health",
                ],
            }
        )
    return plan


def existing_artifact(path_value: object) -> bool:
    if not isinstance(path_value, str) or not path_value:
        return False
    candidate = Path(path_value)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    return candidate.is_file()


def is_host_local_absolute_artifact(path_value: object) -> bool:
    if not isinstance(path_value, str) or not path_value:
        return False
    candidate = Path(path_value)
    if not candidate.is_absolute():
        return False
    try:
        candidate.relative_to(ROOT)
        return False
    except ValueError:
        return True


def run_check(args: argparse.Namespace) -> dict[str, object]:
    evidence_path = Path(args.evidence) if args.evidence else DEFAULT_EVIDENCE
    findings: list[Finding] = []
    expected_cpu_abi = getattr(args, "expected_cpu_abi", "riscv64")
    expected_artifact_id = getattr(args, "expected_artifact_id", None)
    expected_target_label = getattr(args, "expected_target_label", None)
    expected_package = expected_android_payload_package()
    if not evidence_path.is_file():
        findings.append(
            Finding(
                "missing_launcher_runtime_evidence",
                "blocker",
                "booted Android launcher/runtime evidence JSON is missing",
                rel(evidence_path),
                "Capture ADB evidence after boot: sys.boot_completed, HOME resolve, role holders, pm path, foreground activity, service process, /api/health, and logcat scan.",
            )
        )
        return payload(findings, {})

    try:
        data = load_json(evidence_path)
    except json.JSONDecodeError as exc:
        findings.append(
            Finding(
                "invalid_launcher_runtime_evidence_json",
                "blocker",
                "launcher runtime evidence JSON is invalid",
                f"{rel(evidence_path)}: {exc}",
                "Regenerate the evidence JSON with the documented schema.",
            )
        )
        return payload(findings, {})

    package_name = nested(data, "app", "package_name")
    service_component = nested(data, "app", "service_component")
    home_resolve = nested(data, "app", "home_resolve_activity")
    foreground = nested(data, "app", "foreground_activity")
    system_apk_path = nested(data, "app", "system_apk_path")
    system_apk_present = nested(data, "app", "system_apk_present")
    system_apk_probe = nested(data, "app", "system_apk_probe")
    permission_file_probes = nested(data, "app", "permission_file_probes")
    permission_file_symlink_targets = nested(data, "app", "permission_file_symlink_targets")
    pm_path = nested(data, "app", "pm_path")
    service_pid = nested(data, "app", "service_pid")
    role_holders = nested(data, "app", "role_holders")
    health_url = nested(data, "agent", "health_url")
    logcat_path = nested(data, "logs", "logcat_path")
    transcript_path = nested(data, "artifacts", "transcript_path")
    host_runtime = nested(data, "observations", "host_runtime")
    aosp_artifact_inventory = (
        nested(data, "observations", "host_runtime", "aosp_build_only", "artifact_inventory")
        if isinstance(host_runtime, dict)
        else None
    )

    add_if(
        findings,
        data.get("schema") != SCHEMA,
        "launcher_evidence_schema_mismatch",
        "launcher runtime evidence schema is not the expected version",
        f"schema={data.get('schema')!r}",
        f"Emit schema={SCHEMA}.",
    )
    add_if(
        findings,
        data.get("claim_boundary") != CLAIM_BOUNDARY,
        "launcher_evidence_claim_boundary_mismatch",
        "launcher runtime evidence claim boundary is missing or unsafe",
        f"claim_boundary={data.get('claim_boundary')!r}",
        f"Emit claim_boundary={CLAIM_BOUNDARY}.",
    )
    add_if(
        findings,
        data.get("status") != "PASS",
        "launcher_evidence_status_not_pass",
        "launcher runtime evidence top-level status is not PASS",
        f"status={data.get('status')!r}",
        "Regenerate launcher runtime evidence after every capture command succeeds.",
    )
    add_if(
        findings,
        data.get("result") != 0,
        "launcher_evidence_result_nonzero",
        "launcher runtime evidence command result is nonzero or missing",
        f"result={data.get('result')!r}",
        "Regenerate launcher runtime evidence and require the capture script to exit 0.",
    )
    add_if(
        findings,
        nested(data, "device", "sys_boot_completed") != "1",
        "android_boot_not_completed",
        "evidence does not prove sys.boot_completed=1",
        f"sys_boot_completed={nested(data, 'device', 'sys_boot_completed')!r}",
        "Capture `adb shell getprop sys.boot_completed` after the selected Android product boots.",
    )
    add_if(
        findings,
        nested(data, "device", "cpu_abi") != expected_cpu_abi,
        "android_device_cpu_abi_mismatch",
        "evidence is not from the expected Android CPU ABI target",
        f"cpu_abi={nested(data, 'device', 'cpu_abi')!r} expected_cpu_abi={expected_cpu_abi!r}",
        "Capture runtime evidence from the selected Android release target.",
    )
    add_if(
        findings,
        isinstance(expected_artifact_id, str)
        and bool(expected_artifact_id)
        and data.get("artifact_id") != expected_artifact_id,
        "launcher_evidence_artifact_id_mismatch",
        "launcher runtime evidence was not captured for the expected release artifact",
        f"artifact_id={data.get('artifact_id')!r} expected_artifact_id={expected_artifact_id!r}",
        "Regenerate target-specific runtime evidence with --artifact-id set to the matching release manifest artifact id.",
    )
    add_if(
        findings,
        isinstance(expected_target_label, str)
        and bool(expected_target_label)
        and data.get("target_label") != expected_target_label,
        "launcher_evidence_target_label_mismatch",
        "launcher runtime evidence was not captured for the expected Android target label",
        f"target_label={data.get('target_label')!r} expected_target_label={expected_target_label!r}",
        "Regenerate target-specific runtime evidence with --target-label set to the matching release target label.",
    )
    add_if(
        findings,
        not isinstance(package_name, str) or not package_name,
        "launcher_package_missing",
        "evidence does not identify the Eliza Android package",
        f"package_name={package_name!r}",
        "Record the package under test from the installed APK metadata.",
    )
    add_if(
        findings,
        isinstance(package_name, str) and bool(package_name) and package_name != expected_package,
        "launcher_package_mismatch_with_staged_apk",
        "launcher runtime evidence package does not match the staged Android system APK payload",
        f"package_name={package_name!r} expected_package={expected_package!r} payload_report={rel(ANDROID_APK_PAYLOAD_REPORT)}",
        "Regenerate launcher runtime evidence from the AOSP image built with the current staged APK payload.",
    )
    add_if(
        findings,
        system_apk_present != "present",
        "launcher_system_privapp_apk_missing",
        "Eliza launcher APK presence is not proven at the expected system priv-app path",
        f"system_apk_path={system_apk_path!r} system_apk_probe={system_apk_probe!r}",
        "Rebuild the AOSP product image so /system/priv-app/Eliza/Eliza.apk is present before PackageManager scan.",
    )
    permission_evidence = {
        "permission_file_probes": permission_file_probes,
        "permission_file_symlink_targets": permission_file_symlink_targets,
    }
    permission_probe_text = json.dumps(permission_evidence, sort_keys=True)
    add_if(
        findings,
        contains_host_local_symlink(permission_evidence),
        "launcher_permission_xml_host_symlink",
        "Eliza permission XMLs in the Android image resolve to host-local symlinks",
        permission_probe_text,
        "Rebuild the AOSP product image after materializing vendor/eliza overlay files as regular files, not symlinks.",
    )
    add_if(
        findings,
        not isinstance(pm_path, str) or not pm_path.startswith("package:"),
        "launcher_package_not_installed",
        "PackageManager path for the Eliza app is missing",
        f"pm_path={pm_path!r} system_apk_present={system_apk_present!r}",
        "If the APK is present on disk, inspect PackageManager parse/scan logs and APK manifest/signature; otherwise rebuild the system image with the launcher priv-app.",
    )
    if isinstance(package_name, str) and package_name:
        add_if(
            findings,
            not text_contains(home_resolve, package_name),
            "home_resolve_not_eliza",
            "HOME intent resolution does not point at the Eliza package",
            f"home_resolve_activity={home_resolve!r} package={package_name!r}",
            "Capture `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME` and require Eliza.",
        )
        add_if(
            findings,
            not text_contains(foreground, package_name),
            "foreground_activity_not_eliza",
            "foreground activity evidence does not show Eliza",
            f"foreground_activity={foreground!r} package={package_name!r}",
            "Capture `dumpsys activity activities`/`dumpsys window` foreground activity after boot.",
        )
        role_blob = json.dumps(role_holders, sort_keys=True)
        add_if(
            findings,
            package_name not in role_blob,
            "role_holders_do_not_include_eliza",
            "role-holder evidence does not include the Eliza package",
            f"role_holders={role_blob}",
            "Capture assistant/dialer/SMS/browser role holders and require the selected Eliza package where applicable.",
        )
    add_if(
        findings,
        not isinstance(service_component, str) or not service_component,
        "agent_service_component_missing",
        "evidence does not record the Eliza foreground service component",
        f"service_component={service_component!r}",
        "Record the component passed to `am start-foreground-service`.",
    )
    add_if(
        findings,
        not isinstance(service_pid, int) or service_pid <= 0,
        "agent_service_not_running",
        "evidence does not prove the Eliza service process is running",
        f"service_pid={service_pid!r}",
        "Capture `pidof <package>` and `dumpsys activity services <package>` after service start.",
    )
    add_if(
        findings,
        not isinstance(health_url, str) or not health_url.endswith("/api/health"),
        "agent_health_url_not_app_contract",
        "evidence does not use the Android app watchdog /api/health endpoint",
        f"health_url={health_url!r}",
        "Probe the app watchdog endpoint at http://127.0.0.1:31337/api/health through adb forward.",
    )
    add_if(
        findings,
        nested(data, "agent", "health_http") != 200,
        "agent_health_http_not_200",
        "agent health endpoint did not return HTTP 200",
        f"health_http={nested(data, 'agent', 'health_http')!r}",
        "Capture a successful /api/health HTTP response.",
    )
    add_if(
        findings,
        nested(data, "agent", "health_ready") is not True,
        "agent_health_not_ready",
        "agent health response does not assert ready=true",
        f"health_ready={nested(data, 'agent', 'health_ready')!r}",
        "Require the /api/health JSON body to assert ready=true.",
    )
    add_if(
        findings,
        nested(data, "logs", "fatal_crash_count") != 0,
        "fatal_crashes_present",
        "logcat scan reports fatal Java/native crashes",
        f"fatal_crash_count={nested(data, 'logs', 'fatal_crash_count')!r}",
        "Fix or explicitly triage fatal crash markers before promoting launcher readiness.",
    )
    add_if(
        findings,
        nested(data, "logs", "avc_denial_count") != 0,
        "selinux_denials_present",
        "logcat scan reports SELinux AVC denials",
        f"avc_denial_count={nested(data, 'logs', 'avc_denial_count')!r}",
        "Fix or explicitly scope SELinux denials before promoting launcher readiness.",
    )
    add_if(
        findings,
        is_host_local_absolute_artifact(logcat_path),
        "logcat_artifact_host_local_absolute_path",
        "referenced logcat artifact uses a host-local absolute path outside this repository",
        f"logcat_path={logcat_path!r}",
        "Archive logcat under docs/evidence/android and reference it with a repo-relative path.",
    )
    add_if(
        findings,
        not existing_artifact(logcat_path),
        "logcat_artifact_missing",
        "referenced logcat artifact is missing",
        f"logcat_path={logcat_path!r}",
        "Archive `adb logcat -d -b all` with the launcher runtime evidence.",
    )
    add_if(
        findings,
        is_host_local_absolute_artifact(transcript_path),
        "launcher_transcript_host_local_absolute_path",
        "referenced launcher runtime transcript uses a host-local absolute path outside this repository",
        f"transcript_path={transcript_path!r}",
        "Archive the capture transcript under docs/evidence/android and reference it with a repo-relative path.",
    )
    add_if(
        findings,
        not existing_artifact(transcript_path),
        "launcher_transcript_artifact_missing",
        "referenced launcher runtime transcript is missing",
        f"transcript_path={transcript_path!r}",
        "Archive the command transcript used to produce the structured evidence JSON.",
    )

    evidence = {
        "evidence_json": rel(evidence_path),
        "artifact_id": data.get("artifact_id"),
        "expected_artifact_id": expected_artifact_id,
        "target_label": data.get("target_label"),
        "expected_target_label": expected_target_label,
        "package_name": package_name,
        "expected_package": expected_package,
        "android_apk_payload_report": rel(ANDROID_APK_PAYLOAD_REPORT),
        "system_apk_path": system_apk_path,
        "system_apk_present": system_apk_present,
        "permission_file_probes": permission_file_probes,
        "permission_file_symlink_targets": permission_file_symlink_targets,
        "service_component": service_component,
        "health_url": health_url,
        "logcat_path": logcat_path,
        "transcript_path": transcript_path,
        "runtime_adb_blocker": (
            host_runtime.get("adb_blocker") if isinstance(host_runtime, dict) else None
        ),
        "aosp_build_artifact_inventory": provenance_safe_value(aosp_artifact_inventory),
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
        "findings": [asdict(finding) for finding in findings],
        "next_command_plan": command_plan,
        "evidence": evidence,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} android.launcher_runtime")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", help="launcher runtime evidence JSON")
    parser.add_argument(
        "--expected-cpu-abi",
        default="riscv64",
        help="expected ro.product.cpu.abi for the evidence target",
    )
    parser.add_argument(
        "--expected-artifact-id",
        help="expected release manifest artifact id for target-specific runtime evidence",
    )
    parser.add_argument(
        "--expected-target-label",
        help="expected target label recorded by the capture script, e.g. cuttlefish-x86_64, pixel-arm64, or chip-riscv64",
    )
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
