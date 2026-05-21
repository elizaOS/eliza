#!/usr/bin/env python3
"""Run the ASIMOV-1 text-conditioned agent against real hardware.

This entrypoint is deliberately gated. Without --allow-motion it only emits a
launch plan. With --allow-motion it requires a production checkpoint and a
validated hardware evidence report before connecting to LiveKit or sending
trajectory commands.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.bridge.backends.asimov_remote import AsimovRemoteBackend  # noqa: E402
from eliza_robot.rl.text_conditioned.inference_loop import (  # noqa: E402
    InferenceLoopConfig,
    run_inference,
)
from scripts.validate_asimov1_production_checkpoint import (  # noqa: E402
    validate_asimov1_production_checkpoint,
)
from scripts.validate_asimov1_real_hardware_evidence import (  # noqa: E402
    validate_asimov1_real_hardware_evidence,
)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _preflight(args: argparse.Namespace) -> dict[str, Any]:
    checkpoint = args.checkpoint.resolve() if args.checkpoint is not None else None
    hardware_evidence = (
        args.hardware_evidence.resolve() if args.hardware_evidence is not None else None
    )
    production_report = (
        validate_asimov1_production_checkpoint(
            checkpoint,
            min_steps=args.production_min_steps,
            require_inference=args.require_inference,
        )
        if checkpoint is not None
        else None
    )
    hardware_report = (
        validate_asimov1_real_hardware_evidence(_load_json(hardware_evidence))
        if hardware_evidence is not None
        else None
    )
    checks = {
        "checkpoint_provided": checkpoint is not None,
        "hardware_evidence_provided": hardware_evidence is not None,
        "production_checkpoint": production_report is not None and production_report["ok"],
        "hardware_evidence": hardware_report is not None and hardware_report["ok"],
        "livekit_url": bool(args.url),
        "livekit_token": bool(args.token),
        "allow_motion": bool(args.allow_motion),
    }
    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "task": args.task,
        "checkpoint": str(checkpoint) if checkpoint else None,
        "hardware_evidence": str(hardware_evidence) if hardware_evidence else None,
        "checks": checks,
        "production_report": production_report,
        "hardware_report": hardware_report,
    }


async def _run_motion(args: argparse.Namespace) -> dict[str, Any]:
    backend = AsimovRemoteBackend(
        mock=False,
        livekit_url=args.url,
        livekit_token=args.token,
    )
    await backend.connect()
    try:
        result = await run_inference(
            backend,
            args.checkpoint,
            args.task,
            config=InferenceLoopConfig(
                hz=args.hz,
                max_steps=args.max_steps,
                profile_id="asimov-1",
            ),
        )
        events = await backend.poll_events()
        return {
            "ok": result.get("steps_completed") == args.max_steps,
            "profile_id": "asimov-1",
            "motion_executed": True,
            "result": result,
            "events": len(events),
        }
    finally:
        await backend.shutdown()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--hardware-evidence", type=Path, default=None)
    parser.add_argument("--production-min-steps", type=int, default=1_000_000)
    parser.add_argument("--require-inference", action="store_true")
    parser.add_argument("--task", default="walk_forward")
    parser.add_argument("--max-steps", type=int, default=100)
    parser.add_argument("--hz", type=float, default=10.0)
    parser.add_argument("--url", default=os.environ.get("ASIMOV_LIVEKIT_URL", ""))
    parser.add_argument("--token", default=os.environ.get("ASIMOV_LIVEKIT_TOKEN", ""))
    parser.add_argument("--allow-motion", action="store_true")
    args = parser.parse_args()
    preflight = _preflight(args)
    if not args.allow_motion or not preflight["ok"]:
        report = {
            **preflight,
            "motion_executed": False,
            "launch_command_required": (
                "--allow-motion with valid checkpoint, hardware evidence, and LiveKit credentials"
            ),
        }
        print(json.dumps(report, indent=2))
        return 0 if (not args.allow_motion and preflight["checks"]["allow_motion"] is False) else 2
    motion = asyncio.run(_run_motion(args))
    report = {**preflight, "motion": motion, "motion_executed": motion["motion_executed"]}
    report["ok"] = preflight["ok"] and motion["ok"]
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
