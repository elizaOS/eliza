#!/usr/bin/env python3
"""Collect ASIMOV-1 real-hardware validation evidence.

This script is intended for a hardware host. It records one durable JSON report
covering strict preflight, telemetry-only LiveKit access, and the staged command
probe. The default command probe sends only DAMP after telemetry is healthy.
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

from scripts.check_asimov1_real_prereqs import check_asimov1_real_prereqs  # noqa: E402
from scripts.validate_asimov1_real_command_probe import (  # noqa: E402
    _run as run_command_probe,
)
from scripts.validate_asimov1_real_telemetry_probe import (  # noqa: E402
    probe_asimov_real_telemetry,
)


def _report_path(out: Path) -> Path:
    if out.suffix.lower() == ".json":
        return out
    return out / "asimov1_real_hardware_evidence.json"


def _write_report(report: dict[str, Any], out: Path | None) -> None:
    if out is None:
        return
    path = _report_path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    report["report_path"] = str(path)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


async def collect_asimov1_real_hardware_evidence(args: argparse.Namespace) -> dict[str, Any]:
    start = time.time()
    strict_preflight = check_asimov1_real_prereqs(
        require_credentials=True,
        require_modules=args.require_modules,
    )
    stages: list[dict[str, Any]] = [
        {
            "name": "strict_preflight",
            "ok": bool(strict_preflight["ok"]),
            "report": strict_preflight,
        }
    ]
    telemetry_report: dict[str, Any] | None = None
    command_report: dict[str, Any] | None = None

    if strict_preflight["ok"]:
        try:
            telemetry_report = await probe_asimov_real_telemetry(
                url=args.url,
                token=args.token,
                timeout_s=args.timeout,
            )
        except Exception as exc:
            telemetry_report = {
                "ok": False,
                "profile_id": "asimov-1",
                "probe": "telemetry_only",
                "command_messages_published": 0,
                "error": f"{type(exc).__name__}: {exc}",
            }
        stages.append(
            {
                "name": "telemetry_only",
                "ok": bool(telemetry_report["ok"]),
                "report": telemetry_report,
            }
        )

    if telemetry_report is not None and telemetry_report["ok"]:
        try:
            command_report = await run_command_probe(args)
        except Exception as exc:
            command_report = {
                "ok": False,
                "profile_id": "asimov-1",
                "probe": "staged_real_command",
                "commands_sent": [],
                "error": f"{type(exc).__name__}: {exc}",
            }
        stages.append(
            {
                "name": "staged_real_command",
                "ok": bool(command_report["ok"]),
                "report": command_report,
            }
        )

    checks = {
        "strict_preflight": stages[0]["ok"],
        "telemetry_probe_completed": telemetry_report is not None,
        "telemetry_probe_ok": telemetry_report is not None and bool(telemetry_report["ok"]),
        "command_probe_completed": command_report is not None,
        "command_probe_ok": command_report is not None and bool(command_report["ok"]),
        "non_default_motion_requires_flags": (
            args.allow_stand
            or args.allow_zero_velocity
            or (
                command_report is None
                or command_report.get("commands_sent", []) == ["mode:DAMP"]
            )
        ),
    }
    report = {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "evidence": "real_hardware_livekit_control",
        "elapsed_s": round(time.time() - start, 3),
        "safety_flags": {
            "allow_stand": args.allow_stand,
            "allow_zero_velocity": args.allow_zero_velocity,
        },
        "checks": checks,
        "stages": stages,
    }
    _write_report(report, args.out)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("ASIMOV_LIVEKIT_URL", ""))
    parser.add_argument("--token", default=os.environ.get("ASIMOV_LIVEKIT_TOKEN", ""))
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--require-modules", action="store_true")
    parser.add_argument("--allow-stand", action="store_true")
    parser.add_argument("--allow-zero-velocity", action="store_true")
    args = parser.parse_args()
    report = asyncio.run(collect_asimov1_real_hardware_evidence(args))
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
