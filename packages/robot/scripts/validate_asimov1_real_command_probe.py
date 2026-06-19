#!/usr/bin/env python3
"""Staged ASIMOV-1 hardware command probe.

Default behavior is telemetry-first and DAMP-only. STAND and zero-velocity are
available only behind explicit flags because they may move real hardware.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.livekit_transport import LiveKitAsimovTransport  # noqa: E402
from eliza_robot.asimov_1.real_command_probe import probe_real_command_sequence  # noqa: E402


async def _run(args: argparse.Namespace) -> dict:
    transport = LiveKitAsimovTransport(url=args.url, token=args.token)
    return await probe_real_command_sequence(
        transport,
        timeout_s=args.timeout,
        allow_stand=args.allow_stand,
        allow_zero_velocity=args.allow_zero_velocity,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("ASIMOV_LIVEKIT_URL", ""))
    parser.add_argument("--token", default=os.environ.get("ASIMOV_LIVEKIT_TOKEN", ""))
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--allow-stand", action="store_true")
    parser.add_argument("--allow-zero-velocity", action="store_true")
    args = parser.parse_args()
    try:
        report = asyncio.run(_run(args))
    except Exception as exc:
        report = {
            "ok": False,
            "profile_id": "asimov-1",
            "probe": "staged_real_command",
            "commands_sent": [],
            "error": f"{type(exc).__name__}: {exc}",
        }
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
