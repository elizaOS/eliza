#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]
SUSTAINED_TEMPLATE = ROOT / "benchmarks/power/manifests/e1-npu-sustained-capture.template.json"
POWER_MANIFEST = ROOT / "docs/manufacturing/evidence/power/e1-npu-power-capture-manifest.yaml"
THERMAL_PLAN = ROOT / "docs/manufacturing/evidence/thermal/e1-npu-thermal-capture-plan.md"
SUSTAINED_CHECKER = ROOT / "benchmarks/power/scripts/check_sustained_run_evidence.py"
OUT = ROOT / "build/reports/power_thermal_scope.json"
MEASURED_SUSTAINED_MANIFEST = (
    "benchmarks/power/manifests/e1-npu-sustained-capture.measured.json"
)
POWER_THERMAL_CAPTURE_COMMANDS = (
    'test -n "$ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND"',
    (
        'sh -c "$ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND '
        f'--output {MEASURED_SUSTAINED_MANIFEST}"'
    ),
    (
        "python3 benchmarks/power/scripts/check_sustained_run_evidence.py "
        f"{MEASURED_SUSTAINED_MANIFEST}"
    ),
    "python3 scripts/check_power_thermal_scope.py",
)
POWER_THERMAL_COMMAND_PLAN_CLAIM_BOUNDARY = (
    "operator_commands_only_not_sustained_power_thermal_evidence_until_measured_manifest_validates"
)
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "measured_silicon_claim_allowed": False,
    "complete_phone_claim_allowed": False,
    "calibrated_power_claim_allowed": False,
    "calibrated_thermal_claim_allowed": False,
    "frequency_trace_claim_allowed": False,
    "sustained_tops_w_claim_allowed": False,
    "throttle_claim_allowed": False,
    "thermal_compliance_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}

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


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def contains_all(text: str, tokens: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return all(token.lower() in lowered for token in tokens)


def code_from_text(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback


def structured_findings(
    blocked_until_real_evidence: list[str], checks: list[dict[str, Any]]
) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for item in blocked_until_real_evidence:
        findings.append(
            {
                "code": f"power_thermal_missing_real_evidence_{code_from_text(item, 'evidence')}",
                "severity": "blocker",
                "message": item,
                "evidence": "blocked_until_real_evidence",
                "next_step": "Capture calibrated same-window power, thermal, frequency, workload, and throttle evidence before allowing sustained TOPS/W or thermal-compliance claims.",
            }
        )
    for check in checks:
        if check.get("status") == "pass":
            continue
        ident = str(check.get("id", "scope_check"))
        findings.append(
            {
                "code": f"power_thermal_scope_check_failed_{code_from_text(ident, 'scope_check')}",
                "severity": "blocker",
                "message": f"{ident} structural scope check is {check.get('status')}",
                "evidence": str(check.get("evidence", "")),
                "next_step": "Repair the power/thermal scope contract before using this report as runtime or optimization evidence.",
            }
        )
    return findings


def power_thermal_command_plan() -> list[dict[str, Any]]:
    return [
        {
            "id": "capture_e1_npu_sustained_power_thermal_manifest",
            "source": rel(POWER_MANIFEST),
            "claim_boundary": POWER_THERMAL_COMMAND_PLAN_CLAIM_BOUNDARY,
            "commands": list(POWER_THERMAL_CAPTURE_COMMANDS),
            "requires": [
                "calibrated VDDCORE/VDDIO power traces and calibrated thermal sensors",
                "same-window frequency, throttle-state, CPU-fallback, and workload transcript capture",
                "measured manifest on prototype_silicon or complete_phone substrate that passes sustained-run validation",
            ],
            "outputs": [MEASURED_SUSTAINED_MANIFEST],
        }
    ]


def finding_payload(finding: dict[str, str], command_plan: list[dict[str, Any]]) -> dict[str, Any]:
    row: dict[str, Any] = dict(finding)
    commands = [
        command
        for batch in command_plan
        for command in list_of_strings(batch.get("commands"))
        if command
    ]
    if commands:
        row["next_command"] = next(
            (
                command
                for command in commands
                if "ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND" in command
                and not command.startswith("test -n ")
            ),
            commands[0],
        )
        row["next_commands"] = commands
    return row


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
    blocked_until_real_evidence = [
        "measured prototype-silicon or complete-phone target identity, board serial, and SoC revision",
        "calibrated VDDCORE and VDDIO power trace covering the sustained workload window",
        "calibrated die/package/board/skin thermal traces aligned to the same window",
        "NPU frequency, voltage, throttle-state, and CPU-fallback traces aligned to the same window",
        "workload transcript proving e1-NPU NNAPI selection, zero unsupported ops, and zero CPU fallback",
        "calibration record for power, thermal, and frequency instruments with artifact hashes",
        "release reviewer approval that local OpenLane or architecture-model arithmetic is not used as measured TOPS/W evidence",
    ]
    findings = structured_findings(blocked_until_real_evidence, checks)
    command_plan = power_thermal_command_plan()
    return {
        "schema": "eliza.power_thermal_scope.v1",
        "status": "power_thermal_scope_release_blocked",
        "generated_utc": utc_now(),
        "claim_boundary": (
            "Power and thermal scope audit only; not measured silicon, not complete-phone "
            "evidence, not calibrated power trace evidence, not calibrated thermal trace "
            "evidence, not frequency trace evidence, not sustained TOPS/W evidence, "
            "not throttle evidence, and not thermal compliance."
        ),
        **FALSE_CLAIM_FLAGS,
        "current_scaffolds": {
            "sustained_template": rel(SUSTAINED_TEMPLATE),
            "power_capture_manifest": rel(POWER_MANIFEST),
            "thermal_capture_plan": rel(THERMAL_PLAN),
            "measured_manifest_checker": rel(SUSTAINED_CHECKER),
        },
        "blocked_until_real_evidence": blocked_until_real_evidence,
        "next_capture_commands": {
            "sustained_power_thermal_manifest": POWER_THERMAL_CAPTURE_COMMANDS[1],
            "sustained_power_thermal_validation": POWER_THERMAL_CAPTURE_COMMANDS[2],
        },
        "next_command_plan": command_plan,
        "findings": [finding_payload(finding, command_plan) for finding in findings],
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "release_claim_allowed": False,
            "next_command_batch_count": len(command_plan),
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
    for key, expected in FALSE_CLAIM_FLAGS.items():
        require(data.get(key) is expected, f"{key} must stay false", errors)
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
    findings = data.get("findings")
    if not isinstance(findings, list) or not findings:
        errors.append("findings must list structured power/thermal blockers")
    else:
        for finding in findings:
            if not isinstance(finding, dict):
                errors.append("findings entries must be mappings")
                continue
            require(
                isinstance(finding.get("next_command"), str) and bool(finding["next_command"]),
                "findings must include next_command",
                errors,
            )
            require(
                isinstance(finding.get("next_commands"), list) and bool(finding["next_commands"]),
                "findings must include next_commands",
                errors,
            )
    commands = data.get("next_capture_commands")
    if not isinstance(commands, dict):
        errors.append("next_capture_commands must be a mapping")
    else:
        require(
            commands.get("sustained_power_thermal_manifest")
            == POWER_THERMAL_CAPTURE_COMMANDS[1],
            "next_capture_commands missing sustained power/thermal manifest capture",
            errors,
        )
        require(
            commands.get("sustained_power_thermal_validation")
            == POWER_THERMAL_CAPTURE_COMMANDS[2],
            "next_capture_commands missing sustained power/thermal validation",
            errors,
        )
    command_plan = data.get("next_command_plan")
    if not isinstance(command_plan, list) or not command_plan:
        errors.append("next_command_plan must list calibrated power/thermal capture commands")
    else:
        first = command_plan[0]
        if not isinstance(first, dict):
            errors.append("next_command_plan entries must be mappings")
        else:
            require(
                first.get("claim_boundary") == POWER_THERMAL_COMMAND_PLAN_CLAIM_BOUNDARY,
                "power/thermal command plan claim boundary drifted",
                errors,
            )
            command_text = "\n".join(list_of_strings(first.get("commands")))
            for token in (
                "ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND",
                MEASURED_SUSTAINED_MANIFEST,
                "check_sustained_run_evidence.py",
                "check_power_thermal_scope.py",
            ):
                require(token in command_text, f"power/thermal command plan missing {token}", errors)
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
