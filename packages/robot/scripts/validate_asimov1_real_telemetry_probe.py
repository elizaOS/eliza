#!/usr/bin/env python3
"""Telemetry-only ASIMOV-1 LiveKit hardware probe.

This connects to the Menlo LiveKit room and waits for an `EdgeTelemetry` frame.
It does not publish `CloudCommand` messages and does not command robot motion.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM  # noqa: E402
from eliza_robot.asimov_1.livekit_transport import LiveKitAsimovTransport  # noqa: E402


def _frame_report(frame: Any) -> dict[str, Any]:
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


async def probe_asimov_real_telemetry(*, url: str, token: str, timeout_s: float) -> dict[str, Any]:
    transport = LiveKitAsimovTransport(url=url, token=token)
    start = time.time()
    connected = False
    try:
        await transport.connect()
        connected = True
        frame = await transport.wait_for_telemetry(timeout_s=timeout_s)
        frame_report = _frame_report(frame)
        checks = {
            "connected": connected,
            "telemetry_received": True,
            "joint_position_width": frame_report["joint_position_count"] == ASIMOV1_FULL_ACTION_DIM,
            "joint_velocity_width": frame_report["joint_velocity_count"] == ASIMOV1_FULL_ACTION_DIM,
            "imu_quat_width": frame_report["imu_quat_count"] in {0, 4},
            "imu_gyro_width": frame_report["imu_gyro_count"] in {0, 3},
            "imu_gravity_width": frame_report["imu_gravity_count"] in {0, 3},
        }
        return {
            "ok": all(checks.values()),
            "profile_id": "asimov-1",
            "probe": "telemetry_only",
            "command_messages_published": 0,
            "timeout_s": timeout_s,
            "elapsed_s": round(time.time() - start, 3),
            "checks": checks,
            "telemetry": frame_report,
        }
    finally:
        if connected:
            await transport.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("ASIMOV_LIVEKIT_URL", ""))
    parser.add_argument("--token", default=os.environ.get("ASIMOV_LIVEKIT_TOKEN", ""))
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()
    try:
        report = asyncio.run(
            probe_asimov_real_telemetry(url=args.url, token=args.token, timeout_s=args.timeout)
        )
    except Exception as exc:
        report = {
            "ok": False,
            "profile_id": "asimov-1",
            "probe": "telemetry_only",
            "command_messages_published": 0,
            "timeout_s": args.timeout,
            "error": f"{type(exc).__name__}: {exc}",
        }
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
