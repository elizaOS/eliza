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

from eliza_robot.asimov_1.livekit_transport import LiveKitAsimovTransport  # noqa: E402
from eliza_robot.asimov_1.real_command_probe import (  # noqa: E402
    telemetry_checks,
    telemetry_summary,
)


async def probe_asimov_real_telemetry(*, url: str, token: str, timeout_s: float) -> dict[str, Any]:
    transport = LiveKitAsimovTransport(url=url, token=token)
    start = time.time()
    connected = False
    try:
        await transport.connect()
        connected = True
        frame = await transport.wait_for_telemetry(timeout_s=timeout_s)
        frame_report = telemetry_summary(frame)
        checks = {
            "connected": connected,
            "telemetry_received": True,
            **telemetry_checks(frame_report),
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
