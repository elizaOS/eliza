#!/usr/bin/env python3
# ruff: noqa: E402,I001
"""Validate an ASIMOV-1 real-hardware evidence report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM  # noqa: E402


REPORT_SCHEMA = "asimov-1-real-hardware-evidence-v1"
REQUIRED_STAGE_NAMES = ("strict_preflight", "telemetry_only", "staged_real_command")
MAX_FIRMWARE_AGE_MS = 500


def _stage_by_name(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    stages = report.get("stages", [])
    if not isinstance(stages, list):
        return {}
    named = {}
    for stage in stages:
        if isinstance(stage, dict) and isinstance(stage.get("name"), str):
            named[stage["name"]] = stage
    return named


def _checks_all_true(report: dict[str, Any]) -> bool:
    checks = report.get("checks", {})
    return isinstance(checks, dict) and checks != {} and all(value is True for value in checks.values())


def _nested_checks_all_true(report: dict[str, Any]) -> bool:
    checks = report.get("checks")
    return isinstance(checks, dict) and bool(checks) and all(value is True for value in checks.values())


def _command_safety_flags_ok(command: dict[str, Any]) -> bool:
    commands = command.get("commands_sent", [])
    if not isinstance(commands, list) or not all(isinstance(item, str) for item in commands):
        return False
    enabled = command.get("non_default_motion_stages_enabled", {})
    enabled = enabled if isinstance(enabled, dict) else {}
    stand_sent = "mode:STAND" in commands
    velocity_sent = any(command_name.startswith("velocity:") for command_name in commands)
    stand_enabled = enabled.get("stand") is True
    velocity_enabled = enabled.get("zero_velocity") is True
    return (
        "mode:DAMP" in commands
        and (not stand_sent or stand_enabled)
        and (not velocity_sent or (velocity_enabled and stand_sent and stand_enabled))
    )


def _telemetry_widths_ok(report: dict[str, Any]) -> bool:
    telemetry = report.get("telemetry")
    if not isinstance(telemetry, dict):
        return False
    return (
        telemetry.get("joint_position_count") == ASIMOV1_FULL_ACTION_DIM
        and telemetry.get("joint_velocity_count") == ASIMOV1_FULL_ACTION_DIM
        and telemetry.get("imu_quat_count") in {0, 4}
        and telemetry.get("imu_gyro_count") in {0, 3}
        and telemetry.get("imu_gravity_count") in {0, 3}
    )


def _telemetry_status_ok(telemetry: dict[str, Any]) -> bool:
    try:
        error_flags = int(telemetry.get("error_flags", -1))
        fw_age_ms = int(telemetry.get("fw_age_ms", MAX_FIRMWARE_AGE_MS + 1))
        timestamp_us = int(telemetry.get("timestamp_us", 0))
        fw_timestamp_us = int(telemetry.get("fw_timestamp_us", 0))
    except Exception:
        return False
    mode = str(telemetry.get("mode", ""))
    return (
        error_flags == 0
        and 0 <= fw_age_ms <= MAX_FIRMWARE_AGE_MS
        and timestamp_us > 0
        and fw_timestamp_us > 0
        and fw_timestamp_us <= timestamp_us
        and mode in {"DAMP", "STAND", "MOVE", "TRAJECTORY"}
    )


def _telemetry_report_status_ok(report: dict[str, Any]) -> bool:
    telemetry = report.get("telemetry")
    return isinstance(telemetry, dict) and _telemetry_status_ok(telemetry)


def _command_telemetry_widths_ok(report: dict[str, Any]) -> bool:
    before = report.get("telemetry_before")
    after = report.get("telemetry_after")
    return (
        isinstance(before, dict)
        and isinstance(after, dict)
        and _telemetry_widths_ok({"telemetry": before})
        and _telemetry_widths_ok({"telemetry": after})
    )


def _command_telemetry_status_ok(report: dict[str, Any]) -> bool:
    before = report.get("telemetry_before")
    after = report.get("telemetry_after")
    return (
        isinstance(before, dict)
        and isinstance(after, dict)
        and _telemetry_status_ok(before)
        and _telemetry_status_ok(after)
    )


def _stage_reports_profile(*reports: dict[str, Any]) -> bool:
    return all(isinstance(report, dict) and report.get("profile_id") == "asimov-1" for report in reports)


def _command_telemetry_advanced(report: dict[str, Any]) -> bool:
    before = report.get("telemetry_before")
    after = report.get("telemetry_after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    before_sequence = int(before.get("sequence", 0))
    after_sequence = int(after.get("sequence", 0))
    before_timestamp = int(before.get("timestamp_us", 0))
    after_timestamp = int(after.get("timestamp_us", 0))
    return (
        before_sequence > 0
        and after_sequence >= before_sequence
        and before_timestamp > 0
        and after_timestamp >= before_timestamp
        and (after_sequence > before_sequence or after_timestamp > before_timestamp)
    )


def validate_asimov1_real_hardware_evidence(report: dict[str, Any]) -> dict[str, Any]:
    stages = _stage_by_name(report)
    preflight = stages.get("strict_preflight", {}).get("report", {})
    telemetry = stages.get("telemetry_only", {}).get("report", {})
    command = stages.get("staged_real_command", {}).get("report", {})
    commands_sent = command.get("commands_sent", []) if isinstance(command, dict) else []
    checks = {
        "schema": report.get("schema") == REPORT_SCHEMA,
        "top_level_ok": report.get("ok") is True,
        "profile_id": report.get("profile_id") == "asimov-1",
        "evidence_type": report.get("evidence") == "real_hardware_livekit_control",
        "required_stages_present": all(name in stages for name in REQUIRED_STAGE_NAMES),
        "required_stages_ordered": [
            stage.get("name") for stage in report.get("stages", []) if isinstance(stage, dict)
        ]
        == list(REQUIRED_STAGE_NAMES),
        "required_stages_ok": all(stages.get(name, {}).get("ok") is True for name in REQUIRED_STAGE_NAMES),
        "stage_reports_profile": _stage_reports_profile(preflight, telemetry, command),
        "collector_checks": _checks_all_true(report),
        "strict_preflight_ok": isinstance(preflight, dict) and preflight.get("ok") is True,
        "strict_preflight_target": isinstance(preflight, dict)
        and preflight.get("target") == "asimov-real"
        and preflight.get("backend") == "asimov_remote",
        "telemetry_only_ok": isinstance(telemetry, dict)
        and telemetry.get("ok") is True
        and telemetry.get("probe") == "telemetry_only",
        "telemetry_probe_checks": isinstance(telemetry, dict)
        and _nested_checks_all_true(telemetry),
        "telemetry_only_publishes_no_commands": isinstance(telemetry, dict)
        and telemetry.get("command_messages_published") == 0,
        "telemetry_widths": isinstance(telemetry, dict) and _telemetry_widths_ok(telemetry),
        "telemetry_status": isinstance(telemetry, dict)
        and _telemetry_report_status_ok(telemetry),
        "command_probe_ok": isinstance(command, dict)
        and command.get("ok") is True
        and command.get("probe") == "staged_real_command",
        "command_probe_checks": isinstance(command, dict) and _nested_checks_all_true(command),
        "command_probe_sent_damp": isinstance(commands_sent, list) and "mode:DAMP" in commands_sent,
        "command_probe_safety_flags": isinstance(command, dict)
        and _command_safety_flags_ok(command),
        "command_probe_telemetry_widths": isinstance(command, dict)
        and _command_telemetry_widths_ok(command),
        "command_probe_telemetry_status": isinstance(command, dict)
        and _command_telemetry_status_ok(command),
        "command_probe_telemetry_advanced": isinstance(command, dict)
        and _command_telemetry_advanced(command),
    }
    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "evidence": "real_hardware_livekit_control",
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    validation = validate_asimov1_real_hardware_evidence(report)
    validation["report_path"] = str(args.report)
    print(json.dumps(validation, indent=2))
    return 0 if validation["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
