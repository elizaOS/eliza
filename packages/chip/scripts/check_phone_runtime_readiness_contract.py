#!/usr/bin/env python3
"""Gate complete-phone runtime surfaces for the chip/OS boot objective.

Several existing checks intentionally pass when they prove a scope remains
release-blocked. That is useful for documentation hygiene, but for the current
objective (Linux/AOSP forks boot on the chip emulator, launcher starts, and
everything runs) those same honest non-claims are blockers. This gate consumes
the scope reports and reclassifies unresolved phone runtime surfaces as
BLOCKED in the aggregate readiness view.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import check_phone_media_pipeline_scope
import check_power_thermal_scope
import check_radio_sensor_pmic_scope
import check_security_lifecycle_scope

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/phone_runtime_readiness_contract.json"
SCHEMA = "eliza.phone_runtime_readiness_contract.v1"
CLAIM_BOUNDARY = "static_phone_runtime_readiness_contract_only_not_runtime_evidence"


@dataclass(frozen=True)
class ScopeSpec:
    name: str
    report_builder: Callable[[], dict[str, Any]]
    validator: Callable[[dict[str, Any]], list[str]]
    required_status: str
    runtime_surface: str
    required_runtime_evidence: tuple[str, ...]


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


SCOPES: tuple[ScopeSpec, ...] = (
    ScopeSpec(
        name="phone_media_pipeline",
        report_builder=check_phone_media_pipeline_scope.build_report,
        validator=check_phone_media_pipeline_scope.validate_report,
        required_status="phone_media_pipeline_runtime_ready",
        runtime_surface="display, graphics/HWC, camera/ISP, audio/media privacy",
        required_runtime_evidence=(
            "DRM/KMS or Android HWC foreground transcript",
            "panel/scanout under memory pressure",
            "Camera HAL/V4L2 capture",
            "camera privacy/permission evidence",
        ),
    ),
    ScopeSpec(
        name="security_lifecycle",
        report_builder=check_security_lifecycle_scope.build_report,
        validator=check_security_lifecycle_scope.validate_report,
        required_status="security_lifecycle_runtime_ready",
        runtime_surface="secure boot, verified boot, rollback, debug lock, production keys",
        required_runtime_evidence=(
            "signed boot acceptance",
            "unsigned/tampered image rejection",
            "rollback rejection",
            "debug-lock and key-provisioning transcript",
        ),
    ),
    ScopeSpec(
        name="radio_sensor_pmic",
        report_builder=check_radio_sensor_pmic_scope.build_report,
        validator=check_radio_sensor_pmic_scope.validate_report,
        required_status="radio_sensor_pmic_runtime_ready",
        runtime_surface="Wi-Fi, Bluetooth, GNSS/NFC, cellular, sensors, haptics, PMIC, charger",
        required_runtime_evidence=(
            "radio firmware load and association/pairing/lock transcripts",
            "Android Sensors/Input/Vibrator HAL evidence",
            "Health/Power/Thermal HAL evidence",
            "charger/fuel-gauge/brownout/suspend evidence",
        ),
    ),
    ScopeSpec(
        name="power_thermal",
        report_builder=check_power_thermal_scope.build_report,
        validator=check_power_thermal_scope.validate_report,
        required_status="power_thermal_runtime_ready",
        runtime_surface="sustained power, thermal, throttling, frequency, workload stability",
        required_runtime_evidence=(
            "calibrated VDDCORE/VDDIO power traces",
            "aligned thermal/frequency/throttle traces",
            "sustained NPU workload transcript",
            "instrument calibration records",
        ),
    ),
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def scope_report_summary(report: dict[str, Any]) -> str:
    status = report.get("status")
    summary = report.get("summary", {})
    allowed = summary.get("release_claim_allowed") if isinstance(summary, dict) else None
    return f"status={status!r} release_claim_allowed={allowed!r}"


def run_check(args: argparse.Namespace) -> dict[str, Any]:
    del args
    findings: list[Finding] = []
    evidence: dict[str, Any] = {"scopes": {}}
    for spec in SCOPES:
        report = spec.report_builder()
        errors = spec.validator(report)
        evidence["scopes"][spec.name] = {
            "status": report.get("status"),
            "summary": report.get("summary"),
            "claim_boundary": report.get("claim_boundary"),
            "required_runtime_evidence": list(spec.required_runtime_evidence),
        }
        if errors:
            findings.append(
                Finding(
                    f"{spec.name}_scope_report_invalid",
                    "failure",
                    "phone runtime scope report failed its structural validation",
                    "; ".join(errors),
                    "Fix the underlying scope report before using it as readiness evidence.",
                )
            )
            continue
        summary = report.get("summary", {})
        release_allowed = (
            summary.get("release_claim_allowed") if isinstance(summary, dict) else None
        )
        if report.get("status") != spec.required_status or release_allowed is not True:
            findings.append(
                Finding(
                    f"{spec.name}_runtime_surface_blocked",
                    "blocker",
                    f"{spec.runtime_surface} are not runtime-ready for the chip/OS objective",
                    scope_report_summary(report),
                    "Capture real runtime evidence: " + "; ".join(spec.required_runtime_evidence),
                )
            )
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, Any]) -> dict[str, Any]:
    failures = [finding for finding in findings if finding.severity == "failure"]
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    if failures:
        status = "fail"
    elif blockers:
        status = "blocked"
    else:
        status = "pass"
    return {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "failures": len(failures),
            "blockers": len(blockers),
            "findings": len(findings),
        },
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} phone.runtime_readiness_contract")
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
    if report["status"] == "pass":
        return 0
    if report["status"] == "blocked":
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
