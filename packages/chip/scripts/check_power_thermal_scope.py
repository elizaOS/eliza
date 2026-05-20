#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]
SUSTAINED_TEMPLATE = ROOT / "benchmarks/power/manifests/e1-npu-sustained-capture.template.json"
POWER_MANIFEST = ROOT / "docs/manufacturing/evidence/power/e1-npu-power-capture-manifest.yaml"
THERMAL_PLAN = ROOT / "docs/manufacturing/evidence/thermal/e1-npu-thermal-capture-plan.md"
SUSTAINED_CHECKER = ROOT / "benchmarks/power/scripts/check_sustained_run_evidence.py"
OUT = ROOT / "build/reports/power_thermal_scope.json"

REQUIRED_CAPTURE_STATUSES = {
    "power_meter_calibrated",
    "thermal_sensor_calibrated",
    "frequency_source_recorded",
    "workload_transcript_recorded",
    "throttle_state_recorded",
    "same_window_alignment_checked",
}
REQUIRED_ARTIFACTS = {
    "power_trace",
    "thermal_trace",
    "frequency_trace",
    "workload_transcript",
    "calibration_record",
}
ZERO_SHA256 = "0" * 64


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def contains_all(text: str, tokens: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return all(token.lower() in lowered for token in tokens)


def mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def list_of_strings(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def number_at_least(value: Any, minimum: float) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and value >= minimum


def template_capture_statuses(template: dict[str, Any]) -> dict[str, Any]:
    return mapping(mapping(template.get("instrumentation")).get("capture_statuses"))


def build_report() -> dict[str, Any]:
    template = load_json_object(SUSTAINED_TEMPLATE)
    power_manifest = load_yaml_object(POWER_MANIFEST)
    thermal_plan = THERMAL_PLAN.read_text(encoding="utf-8")
    checker = SUSTAINED_CHECKER.read_text(encoding="utf-8")

    workload = mapping(template.get("workload"))
    capture_statuses = template_capture_statuses(template)
    artifacts = mapping(template.get("artifacts"))
    capture_requirements = mapping(power_manifest.get("capture_requirements"))
    power_text = json.dumps(power_manifest, sort_keys=True, default=str)
    checker_tokens = (
        "eliza-evidence: status=PASS",
        "NNAPI_ACCELERATOR=e1-npu",
        "CPU_FALLBACK_PERCENT=0",
        "UNSUPPORTED_OP_COUNT=0",
        "complete_measured_evidence",
        "prototype_silicon",
        "complete_phone",
    )
    checks = [
        {
            "id": "sustained_template_blocks_release_claim",
            "status": "pass"
            if template.get("schema") == "eliza.sustained_power_thermal_evidence.v1"
            and template.get("status") == "blocked"
            and "not_measured_silicon" in str(template.get("claim_boundary", ""))
            else "fail",
            "evidence": rel(SUSTAINED_TEMPLATE),
        },
        {
            "id": "sustained_window_is_release_sized",
            "status": "pass"
            if number_at_least(workload.get("duration_seconds"), 1800)
            and number_at_least(workload.get("warmup_seconds"), 120)
            else "fail",
            "evidence": rel(SUSTAINED_TEMPLATE),
        },
        {
            "id": "capture_statuses_are_all_blocked",
            "status": "pass"
            if set(capture_statuses) >= REQUIRED_CAPTURE_STATUSES
            and all(capture_statuses.get(name) == "blocked" for name in REQUIRED_CAPTURE_STATUSES)
            else "fail",
            "evidence": rel(SUSTAINED_TEMPLATE),
        },
        {
            "id": "artifact_slots_are_empty_placeholders",
            "status": "pass"
            if set(artifacts) >= REQUIRED_ARTIFACTS
            and all(
                mapping(artifacts.get(name)).get("sha256") == ZERO_SHA256
                and mapping(artifacts.get(name)).get("sample_count") == 0
                for name in REQUIRED_ARTIFACTS
            )
            else "fail",
            "evidence": rel(SUSTAINED_TEMPLATE),
        },
        {
            "id": "power_capture_manifest_blocks_release",
            "status": "pass"
            if power_manifest.get("schema") == "eliza.manufacturing_power_capture_manifest.v1"
            and power_manifest.get("status") == "blocked"
            and power_manifest.get("release_use")
            == "prohibited_until_measured_sustained_evidence_passes"
            and power_manifest.get("claim_boundary") == "no_silicon_power_or_thermal_claims"
            else "fail",
            "evidence": rel(POWER_MANIFEST),
        },
        {
            "id": "power_capture_requirements_are_measurable",
            "status": "pass"
            if number_at_least(capture_requirements.get("minimum_duration_seconds"), 1800)
            and number_at_least(capture_requirements.get("power_sample_hz_min"), 10)
            and capture_requirements.get("same_window_alignment_required") is True
            and {"VDDCORE", "VDDIO"} <= set(list_of_strings(capture_requirements.get("rails")))
            and {
                "reset_static",
                "android_idle_or_linux_idle",
                "e1_npu_sustained_nnapi",
                "cpu_fallback_control",
            }
            <= set(list_of_strings(capture_requirements.get("required_states")))
            else "fail",
            "evidence": rel(POWER_MANIFEST),
        },
        {
            "id": "thermal_plan_requires_aligned_calibrated_window",
            "status": "pass"
            if contains_all(
                thermal_plan,
                (
                    "30 minute workload",
                    "120 seconds of warmup",
                    "aligned to power",
                    "within 1 second",
                    "Throttle state recorded",
                    "Stop Conditions",
                    "No calibrated thermal sensor",
                    "Local OpenLane power is not a thermal source model",
                ),
            )
            else "fail",
            "evidence": rel(THERMAL_PLAN),
        },
        {
            "id": "measured_checker_enforces_transcript_and_substrate",
            "status": "pass" if contains_all(checker, checker_tokens) else "fail",
            "evidence": rel(SUSTAINED_CHECKER),
        },
        {
            "id": "power_manifest_links_sustained_gate",
            "status": "pass"
            if contains_all(
                power_text,
                (
                    "benchmarks/power/workload-plan.yaml",
                    "benchmarks/power/manifests/e1-npu-sustained-capture.template.json",
                    "benchmarks/power/scripts/check_sustained_run_evidence.py",
                    "calibrated_power_trace",
                    "npu_frequency_trace",
                    "workload_transcript",
                    "calibration_record",
                ),
            )
            else "fail",
            "evidence": rel(POWER_MANIFEST),
        },
    ]
    return {
        "schema": "eliza.power_thermal_scope.v1",
        "status": "power_thermal_scope_release_blocked",
        "claim_boundary": (
            "Power and thermal scope audit only; not measured silicon, not complete-phone "
            "evidence, not calibrated power trace evidence, not calibrated thermal trace "
            "evidence, not frequency trace evidence, not sustained TOPS/W evidence, "
            "not throttle evidence, and not thermal compliance."
        ),
        "current_scaffolds": {
            "sustained_template": rel(SUSTAINED_TEMPLATE),
            "power_capture_manifest": rel(POWER_MANIFEST),
            "thermal_capture_plan": rel(THERMAL_PLAN),
            "measured_manifest_checker": rel(SUSTAINED_CHECKER),
        },
        "blocked_until_real_evidence": [
            "measured prototype-silicon or complete-phone target identity, board serial, and SoC revision",
            "calibrated VDDCORE and VDDIO power trace covering the sustained workload window",
            "calibrated die/package/board/skin thermal traces aligned to the same window",
            "NPU frequency, voltage, throttle-state, and CPU-fallback traces aligned to the same window",
            "workload transcript proving e1-NPU NNAPI selection, zero unsupported ops, and zero CPU fallback",
            "calibration record for power, thermal, and frequency instruments with artifact hashes",
            "release reviewer approval that local OpenLane or architecture-model arithmetic is not used as measured TOPS/W evidence",
        ],
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "release_claim_allowed": False,
        },
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(data.get("schema") == "eliza.power_thermal_scope.v1", "schema mismatch", errors)
    require(
        data.get("status") == "power_thermal_scope_release_blocked",
        "status must remain power_thermal_scope_release_blocked",
        errors,
    )
    boundary = str(data.get("claim_boundary", ""))
    for token in (
        "not measured silicon",
        "not complete-phone",
        "not calibrated power trace",
        "not calibrated thermal trace",
        "not frequency trace",
        "not sustained TOPS/W",
        "not thermal compliance",
    ):
        require(token in boundary, f"claim boundary missing {token}", errors)
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
        return errors
    require(
        summary.get("release_claim_allowed") is False,
        "release_claim_allowed must stay false",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty list")
        return errors
    for check in checks:
        if not isinstance(check, dict):
            errors.append("checks entries must be mappings")
            continue
        if check.get("status") != "pass":
            errors.append(f"{check.get('id')}: must pass structural scope check")
    blocked = data.get("blocked_until_real_evidence")
    if not isinstance(blocked, list) or len(blocked) < 7:
        errors.append("power/thermal scope must enumerate blocked real-evidence items")
    scaffolds = data.get("current_scaffolds")
    if not isinstance(scaffolds, dict):
        errors.append("current_scaffolds must be a mapping")
    else:
        for key in (
            "sustained_template",
            "power_capture_manifest",
            "thermal_capture_plan",
            "measured_manifest_checker",
        ):
            require(isinstance(scaffolds.get(key), str), f"current_scaffolds missing {key}", errors)
    return errors


def main() -> int:
    report = build_report()
    errors = validate_report(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"Power/thermal scope check passed: {rel(OUT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
