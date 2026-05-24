#!/usr/bin/env python3
"""Static Android evidence-capture contract gate.

The Android/AOSP scripts must not make it possible to satisfy boot readiness
with generic virtual-device logs while the launcher, local agent, and runtime
health evidence are missing. This gate checks the capture scripts, evidence
manifest, and archived reference logs for that contract.
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

ROOT = Path(__file__).resolve().parents[1]
OUTER_WORKSPACE = ROOT.parents[2] if len(ROOT.parents) > 2 else ROOT.parent
MANIFEST = ROOT / "sw/aosp-device/evidence_manifest.json"
CAPTURE_SCRIPT = ROOT / "sw/aosp-device/capture-aosp-evidence.sh"
BOOT_GATE = ROOT / "sw/aosp-device/cuttlefish-boot-gate.sh"
ANDROID_SIM_BOOT = ROOT / "scripts/check_android_sim_boot.py"
COMPLETION_GATE = ROOT / "docs/project/aosp-simulator-completion-gate.yaml"
QEMU_SMOKE_LOG = ROOT / "docs/evidence/android/qemu_riscv64_smoke.log"
CTS_VTS_PLAN_LOG = ROOT / "docs/evidence/android/eliza_ai_soc_cts_vts_plan.log"
REPORT = ROOT / "build/reports/android_evidence_capture_contract.json"

SCHEMA = "eliza.android_evidence_capture_contract.v1"
CLAIM_BOUNDARY = "static_android_evidence_capture_contract_only_not_runtime_evidence"
LAUNCHER_EVIDENCE = "docs/evidence/android/eliza_launcher_runtime_evidence.json"


def read_outer_app_config() -> dict[str, str] | None:
    config_path = OUTER_WORKSPACE / "apps/app/app.config.ts"
    if not config_path.is_file():
        return None
    config = config_path.read_text(encoding="utf-8")
    values: dict[str, str] = {}
    for key in ("appId",):
        match = re.search(rf"\b{key}\s*:\s*[\"']([^\"']+)[\"']", config)
        if match:
            values[key] = match.group(1)
    return values if "appId" in values else None


BRAND_CONFIG = read_outer_app_config()
EXPECTED_AGENT_PACKAGE = BRAND_CONFIG["appId"] if BRAND_CONFIG else "ai.elizaos.app"
EXPECTED_AGENT_SERVICE = f"{EXPECTED_AGENT_PACKAGE}/.ElizaAgentService"
EXPECTED_LAUNCHER_SCHEMA = "eliza.android_launcher_runtime_evidence.v1"
EXPECTED_LAUNCHER_CLAIM_BOUNDARY = "booted_android_launcher_agent_runtime_evidence_only"
REQUIRED_BOOT_GATE_TOKENS = {
    "pm path": "adb PackageManager install proof",
    "resolve-activity": "HOME intent resolution proof",
    "role": "Android role-holder proof",
    "dumpsys activity": "foreground activity/service proof",
    "pidof": "running agent service process proof",
    "/api/health": "local agent health endpoint proof",
    "logcat": "fatal/AVC log scan proof",
    "avc": "SELinux denial scan proof",
}
REQUIRED_LAUNCHER_JSON_TOKENS = {
    '"device"': "device block",
    '"sys_boot_completed"': "boot-completed property",
    '"cpu_abi"': "runtime ABI",
    '"app"': "app block",
    '"package_name"': "package identity",
    '"pm_path"': "PackageManager path",
    '"role_holders"': "role-holder output",
    '"home_resolve_activity"': "HOME intent resolution",
    '"foreground_activity"': "foreground activity",
    '"service_component"': "foreground service component",
    '"service_pid"': "running service PID",
    '"agent"': "agent block",
    '"health_url"': "agent health URL",
    '"health_http"': "agent health HTTP status",
    '"health_ready"': "agent health readiness body",
    '"logs"': "log block",
    '"logcat_path"': "archived logcat artifact path",
    '"fatal_crash_count"': "fatal/crash count",
    '"avc_denial_count"': "SELinux AVC denial count",
    '"artifacts"': "artifact block",
    '"transcript_path"': "command transcript artifact path",
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
        return path.relative_to(ROOT).as_posix()
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


def shell_default(text: str, name: str) -> str | None:
    match = re.search(rf"^{re.escape(name)}=\$\{{[^:}}]+:-([^}}]*)\}}", text, re.MULTILINE)
    return match.group(1) if match else None


def manifest_required_paths(data: dict[str, Any]) -> list[str]:
    value = data.get("required_for_android_boot_claim", [])
    return value if isinstance(value, list) else []


def run_check(args: argparse.Namespace) -> dict[str, object]:
    del args
    findings: list[Finding] = []
    inputs = (
        MANIFEST,
        CAPTURE_SCRIPT,
        BOOT_GATE,
        ANDROID_SIM_BOOT,
        COMPLETION_GATE,
        QEMU_SMOKE_LOG,
        CTS_VTS_PLAN_LOG,
    )
    for path in inputs:
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required Android evidence-capture contract input is missing",
            rel(path),
            "Restore the missing manifest, script, or archived evidence before evaluating Android readiness.",
        )
    if findings:
        return payload(findings, {})

    try:
        manifest = json.loads(read_text(MANIFEST))
    except json.JSONDecodeError as exc:
        findings.append(
            Finding(
                "android_evidence_manifest_invalid_json",
                "blocker",
                "Android evidence manifest is invalid JSON",
                f"{rel(MANIFEST)}: {exc}",
                "Fix the evidence manifest so the required boot evidence set is machine-readable.",
            )
        )
        return payload(findings, {})

    capture_text = read_text(CAPTURE_SCRIPT)
    boot_gate_text = read_text(BOOT_GATE)
    sim_boot_text = read_text(ANDROID_SIM_BOOT)
    completion_text = read_text(COMPLETION_GATE)
    qemu_text = read_text(QEMU_SMOKE_LOG)
    cts_text = read_text(CTS_VTS_PLAN_LOG)
    required_paths = manifest_required_paths(manifest)
    agent_package = shell_default(capture_text, "aosp_agent_package")
    agent_service = shell_default(capture_text, "aosp_agent_service")
    missing_boot_tokens = sorted(
        token for token in REQUIRED_BOOT_GATE_TOKENS if token.lower() not in boot_gate_text.lower()
    )
    missing_launcher_json_tokens = sorted(
        token for token in REQUIRED_LAUNCHER_JSON_TOKENS if token not in boot_gate_text
    )

    add_if(
        findings,
        LAUNCHER_EVIDENCE not in required_paths,
        "android_evidence_manifest_missing_launcher_runtime_evidence",
        "Android boot claim evidence manifest does not require launcher runtime evidence",
        f"required_for_android_boot_claim missing {LAUNCHER_EVIDENCE}",
        "Add the structured launcher runtime evidence JSON to the required Android boot claim set.",
    )
    add_if(
        findings,
        not any(
            "/api/health" in str(item) or "agent_health" in str(item) for item in required_paths
        ),
        "android_evidence_manifest_missing_agent_health_requirement",
        "Android boot claim evidence manifest does not require agent health evidence",
        f"required_for_android_boot_claim={required_paths}",
        "Require evidence that probes the Android app watchdog endpoint at /api/health after boot.",
    )
    add_if(
        findings,
        agent_package != EXPECTED_AGENT_PACKAGE,
        "android_capture_defaults_agent_package_mismatch",
        "AOSP evidence capture defaults target a different package than the built Android app",
        f"aosp_agent_package={agent_package!r} expected={EXPECTED_AGENT_PACKAGE!r}",
        "Align AOSP_AGENT_PACKAGE defaults with the APK package identity or make the capture fail until explicitly set.",
    )
    add_if(
        findings,
        agent_service != EXPECTED_AGENT_SERVICE,
        "android_capture_defaults_agent_service_mismatch",
        "AOSP evidence capture defaults target a different service than the built Android app",
        f"aosp_agent_service={agent_service!r} expected={EXPECTED_AGENT_SERVICE!r}",
        "Align AOSP_AGENT_SERVICE defaults with the APK service component used by launcher/runtime evidence.",
    )
    add_if(
        findings,
        bool(missing_boot_tokens),
        "cuttlefish_boot_gate_missing_launcher_agent_checks",
        "Cuttlefish boot gate proves generic boot but not launcher, role, service, health, and log safety",
        f"missing_tokens={missing_boot_tokens}",
        "Extend the boot gate or add a companion gate that captures pm path, HOME resolution, role holders, foreground activity, service PID, /api/health, and fatal/AVC log scans.",
    )
    add_if(
        findings,
        EXPECTED_LAUNCHER_SCHEMA not in boot_gate_text
        or EXPECTED_LAUNCHER_CLAIM_BOUNDARY not in boot_gate_text,
        "cuttlefish_boot_gate_launcher_evidence_boundary_mismatch",
        "Cuttlefish boot gate writes launcher evidence with a schema or claim boundary the launcher-runtime checker will reject",
        (
            f"expected_schema={EXPECTED_LAUNCHER_SCHEMA} "
            f"expected_claim_boundary={EXPECTED_LAUNCHER_CLAIM_BOUNDARY}"
        ),
        "Emit the exact launcher runtime schema and booted launcher/agent claim boundary, or stop writing the launcher-runtime evidence artifact from this gate.",
    )
    add_if(
        findings,
        bool(missing_launcher_json_tokens),
        "cuttlefish_boot_gate_launcher_json_shape_mismatch",
        "Cuttlefish boot gate launcher evidence JSON does not match the checker schema",
        f"missing_tokens={missing_launcher_json_tokens}",
        "Write nested device/app/agent/logs/artifacts fields with boot, package, HOME, foreground, service, health, logcat, SELinux, and transcript values required by check_android_launcher_runtime_evidence.py.",
    )
    add_if(
        findings,
        LAUNCHER_EVIDENCE not in sim_boot_text,
        "android_sim_boot_gate_missing_launcher_evidence_check",
        "Android simulator boot checker does not require launcher runtime evidence before pass",
        rel(ANDROID_SIM_BOOT),
        "Require the structured launcher runtime evidence JSON when android_sim_boot status is pass.",
    )
    add_if(
        findings,
        LAUNCHER_EVIDENCE not in completion_text,
        "aosp_completion_gate_missing_launcher_runtime_evidence",
        "AOSP completion checklist omits the structured launcher runtime evidence artifact",
        rel(COMPLETION_GATE),
        "Add launcher runtime evidence to required_android_evidence and require its schema/claim boundary.",
    )
    add_if(
        findings,
        "SELF_STATUS_HTTP" in completion_text or "/api/agent/self-status" in completion_text,
        "aosp_completion_gate_uses_legacy_agent_markers",
        "AOSP completion checklist still accepts legacy self-status agent markers",
        rel(COMPLETION_GATE),
        "Replace SELF_STATUS markers with the Android app watchdog /api/health contract and service PID proof.",
    )
    qemu_claims_pass = "eliza-evidence: status=PASS" in qemu_text or "RESULT=0" in qemu_text
    cts_claims_pass = "eliza-evidence: status=PASS" in cts_text or "RESULT=0" in cts_text
    add_if(
        findings,
        qemu_claims_pass
        and ("--version" in qemu_text or "requires kernel/system image wiring" in qemu_text)
        and "sys.boot_completed=1" not in qemu_text,
        "qemu_smoke_log_is_version_only",
        "QEMU riscv64 smoke log is marked PASS but only proves tool availability/version context",
        rel(QEMU_SMOKE_LOG),
        "Replace the QEMU smoke with a transcript that boots the AOSP riscv64 image and records console or adb boot markers.",
    )
    add_if(
        findings,
        cts_claims_pass
        and ("SOURCE_SCAN=true" in cts_text or "source scan" in cts_text)
        and "Invocation finished" not in cts_text
        and "Test Result" not in cts_text,
        "cts_vts_plan_is_source_scan_only",
        "CTS/VTS plan log is a source/module scan rather than a Tradefed run result",
        rel(CTS_VTS_PLAN_LOG),
        "Archive actual CTS/VTS smoke run output or keep this artifact outside any readiness evidence path.",
    )

    evidence = {
        "required_for_android_boot_claim_count": len(required_paths),
        "launcher_evidence_required": LAUNCHER_EVIDENCE in required_paths,
        "capture_default_agent_package": agent_package,
        "capture_default_agent_service": agent_service,
        "missing_boot_gate_tokens": missing_boot_tokens,
        "missing_launcher_json_tokens": missing_launcher_json_tokens,
        "expected_launcher_schema": EXPECTED_LAUNCHER_SCHEMA,
        "expected_launcher_claim_boundary": EXPECTED_LAUNCHER_CLAIM_BOUNDARY,
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
    print(f"STATUS: {str(report['status']).upper()} android.evidence_capture_contract")
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
