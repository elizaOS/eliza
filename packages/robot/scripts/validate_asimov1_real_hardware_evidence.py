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


REQUIRED_STAGE_NAMES = ("strict_preflight", "telemetry_only", "staged_real_command")


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


def _command_telemetry_widths_ok(report: dict[str, Any]) -> bool:
    before = report.get("telemetry_before")
    after = report.get("telemetry_after")
    return (
        isinstance(before, dict)
        and isinstance(after, dict)
        and _telemetry_widths_ok({"telemetry": before})
        and _telemetry_widths_ok({"telemetry": after})
    )


def validate_asimov1_real_hardware_evidence(report: dict[str, Any]) -> dict[str, Any]:
    stages = _stage_by_name(report)
    preflight = stages.get("strict_preflight", {}).get("report", {})
    telemetry = stages.get("telemetry_only", {}).get("report", {})
    command = stages.get("staged_real_command", {}).get("report", {})
    commands_sent = command.get("commands_sent", []) if isinstance(command, dict) else []
    checks = {
        "top_level_ok": report.get("ok") is True,
        "profile_id": report.get("profile_id") == "asimov-1",
        "evidence_type": report.get("evidence") == "real_hardware_livekit_control",
        "required_stages_present": all(name in stages for name in REQUIRED_STAGE_NAMES),
        "required_stages_ok": all(stages.get(name, {}).get("ok") is True for name in REQUIRED_STAGE_NAMES),
        "collector_checks": _checks_all_true(report),
        "strict_preflight_ok": isinstance(preflight, dict) and preflight.get("ok") is True,
        "strict_preflight_target": isinstance(preflight, dict)
        and preflight.get("target") == "asimov-real"
        and preflight.get("backend") == "asimov_remote",
        "telemetry_only_ok": isinstance(telemetry, dict)
        and telemetry.get("ok") is True
        and telemetry.get("probe") == "telemetry_only",
        "telemetry_only_publishes_no_commands": isinstance(telemetry, dict)
        and telemetry.get("command_messages_published") == 0,
        "telemetry_widths": isinstance(telemetry, dict) and _telemetry_widths_ok(telemetry),
        "command_probe_ok": isinstance(command, dict)
        and command.get("ok") is True
        and command.get("probe") == "staged_real_command",
        "command_probe_sent_damp": isinstance(commands_sent, list) and "mode:DAMP" in commands_sent,
        "command_probe_telemetry_widths": isinstance(command, dict)
        and _command_telemetry_widths_ok(command),
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
