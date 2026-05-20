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
import json
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/android_launcher_runtime_evidence.json"
DEFAULT_EVIDENCE = ROOT / "docs/evidence/android/eliza_launcher_runtime_evidence.json"
SCHEMA = "eliza.android_launcher_runtime_evidence.v1"
CLAIM_BOUNDARY = "booted_android_launcher_agent_runtime_evidence_only"


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def nested(data: dict[str, object], *keys: str) -> object:
    current: object = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def text_contains(value: object, needle: str) -> bool:
    return isinstance(value, str) and needle in value


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


def existing_artifact(path_value: object) -> bool:
    if not isinstance(path_value, str) or not path_value:
        return False
    candidate = Path(path_value)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    return candidate.is_file()


def run_check(args: argparse.Namespace) -> dict[str, object]:
    evidence_path = Path(args.evidence) if args.evidence else DEFAULT_EVIDENCE
    findings: list[Finding] = []
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
    pm_path = nested(data, "app", "pm_path")
    service_pid = nested(data, "app", "service_pid")
    role_holders = nested(data, "app", "role_holders")
    health_url = nested(data, "agent", "health_url")
    logcat_path = nested(data, "logs", "logcat_path")
    transcript_path = nested(data, "artifacts", "transcript_path")

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
        nested(data, "device", "sys_boot_completed") != "1",
        "android_boot_not_completed",
        "evidence does not prove sys.boot_completed=1",
        f"sys_boot_completed={nested(data, 'device', 'sys_boot_completed')!r}",
        "Capture `adb shell getprop sys.boot_completed` after the selected Android product boots.",
    )
    add_if(
        findings,
        nested(data, "device", "cpu_abi") != "riscv64",
        "android_device_not_riscv64",
        "evidence is not from a riscv64 Android target",
        f"cpu_abi={nested(data, 'device', 'cpu_abi')!r}",
        "Capture runtime evidence from the riscv64 Cuttlefish/chip-emulator target.",
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
        not isinstance(pm_path, str) or not pm_path.startswith("package:"),
        "launcher_package_not_installed",
        "PackageManager path for the Eliza app is missing",
        f"pm_path={pm_path!r}",
        "Capture `adb shell pm path <package>` and require a package path.",
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
        not existing_artifact(logcat_path),
        "logcat_artifact_missing",
        "referenced logcat artifact is missing",
        f"logcat_path={logcat_path!r}",
        "Archive `adb logcat -d -b all` with the launcher runtime evidence.",
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
        "package_name": package_name,
        "service_component": service_component,
        "health_url": health_url,
        "logcat_path": logcat_path,
        "transcript_path": transcript_path,
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
    print(f"STATUS: {str(report['status']).upper()} android.launcher_runtime")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", help="launcher runtime evidence JSON")
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
