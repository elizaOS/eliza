"""Staged real ASIMOV hardware command probes."""

from __future__ import annotations

import time
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM
from eliza_robot.asimov_1.livekit_transport import LiveKitAsimovTransport


def telemetry_summary(frame: Any) -> dict[str, Any]:
    joint_positions = dict(getattr(frame, "joint_positions", {}) or {})
    joint_velocities = dict(getattr(frame, "joint_velocities", {}) or {})
    return {
        "mode": str(getattr(frame, "mode", "")),
        "sequence": int(getattr(frame, "sequence", 0)),
        "timestamp_us": int(getattr(frame, "timestamp_us", 0)),
        "fw_timestamp_us": int(getattr(frame, "fw_timestamp_us", 0)),
        "error_flags": int(getattr(frame, "error_flags", 0)),
        "fw_age_ms": int(getattr(frame, "fw_age_ms", 0)),
        "joint_position_count": len(joint_positions),
        "joint_velocity_count": len(joint_velocities),
        "imu_quat_count": len(list(getattr(frame, "imu_quat", []) or [])),
        "imu_gyro_count": len(list(getattr(frame, "imu_gyro", []) or [])),
        "imu_gravity_count": len(list(getattr(frame, "imu_gravity", []) or [])),
    }


def telemetry_checks(summary: dict[str, Any]) -> dict[str, bool]:
    return {
        "joint_position_width": summary["joint_position_count"] == ASIMOV1_FULL_ACTION_DIM,
        "joint_velocity_width": summary["joint_velocity_count"] == ASIMOV1_FULL_ACTION_DIM,
        "imu_quat_width": summary["imu_quat_count"] in {0, 4},
        "imu_gyro_width": summary["imu_gyro_count"] in {0, 3},
        "imu_gravity_width": summary["imu_gravity_count"] in {0, 3},
    }


async def probe_real_command_sequence(
    transport: LiveKitAsimovTransport,
    *,
    timeout_s: float,
    allow_stand: bool = False,
    allow_zero_velocity: bool = False,
) -> dict[str, Any]:
    """Run a staged real-hardware command probe.

    The probe always waits for telemetry before sending any command. By default
    it only sends DAMP. STAND and zero-velocity are opt-in because they may move
    hardware depending on firmware state and controller configuration.
    """
    if allow_zero_velocity and not allow_stand:
        raise ValueError("zero-velocity probe requires --allow-stand before velocity commands")
    start = time.time()
    await transport.connect()
    command_stages: list[str] = []
    try:
        before = await transport.wait_for_telemetry(timeout_s=timeout_s)
        before_summary = telemetry_summary(before)
        await transport.send_mode("DAMP")
        command_stages.append("mode:DAMP")
        if allow_stand:
            await transport.send_mode("STAND")
            command_stages.append("mode:STAND")
        if allow_zero_velocity:
            await transport.send_velocity(0.0, 0.0, 0.0)
            command_stages.append("velocity:zero")
        after = await transport.wait_for_telemetry(timeout_s=timeout_s)
        after_summary = telemetry_summary(after)
        before_checks = telemetry_checks(before_summary)
        after_checks = telemetry_checks(after_summary)
        checks = {
            "connected": transport.connected,
            "telemetry_before_commands": all(before_checks.values()),
            "telemetry_after_commands": all(after_checks.values()),
            "damp_command_sent": "mode:DAMP" in command_stages,
            "stand_requires_flag": allow_stand or "mode:STAND" not in command_stages,
            "zero_velocity_requires_flag": allow_zero_velocity or "velocity:zero" not in command_stages,
        }
        return {
            "ok": all(checks.values()),
            "profile_id": "asimov-1",
            "probe": "staged_real_command",
            "non_default_motion_stages_enabled": {
                "stand": allow_stand,
                "zero_velocity": allow_zero_velocity,
            },
            "elapsed_s": round(time.time() - start, 3),
            "commands_sent": command_stages,
            "checks": checks,
            "telemetry_before": before_summary,
            "telemetry_after": after_summary,
        }
    finally:
        await transport.close()
