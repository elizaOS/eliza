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
import hashlib
import json
import os
import sys
import time
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


def _sha256_file(path: Path | None) -> str | None:
    if path is None or not path.is_file():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _checkpoint_policy_artifact(checkpoint: Path | None) -> Path | None:
    if checkpoint is None:
        return None
    try:
        manifest = _load_json(checkpoint / "manifest.json")
    except Exception:
        return None
    artifact = manifest.get("ckpt", "policy_brax.pkl")
    if not isinstance(artifact, str) or not artifact:
        return None
    return (checkpoint / artifact).resolve()


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
            require_inference_check=True,
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


def _run_evidence(
    *,
    args: argparse.Namespace,
    preflight: dict[str, Any],
    motion: dict[str, Any] | None,
) -> dict[str, Any]:
    checkpoint_path = Path(str(preflight["checkpoint"])) if preflight.get("checkpoint") else None
    hardware_path = (
        Path(str(preflight["hardware_evidence"])) if preflight.get("hardware_evidence") else None
    )
    policy_path = _checkpoint_policy_artifact(checkpoint_path)
    production_report = preflight.get("production_report")
    production_report = production_report if isinstance(production_report, dict) else {}
    return {
        "schema": "asimov-1-real-agent-run-v1",
        "profile_id": "asimov-1",
        "created_at_unix": time.time(),
        "checkpoint": preflight.get("checkpoint"),
        "hardware_evidence": preflight.get("hardware_evidence"),
        "checkpoint_manifest_sha256": _sha256_file(
            checkpoint_path / "manifest.json" if checkpoint_path is not None else None
        ),
        "checkpoint_training_job_sha256": _sha256_file(
            checkpoint_path / "training_job.json" if checkpoint_path is not None else None
        ),
        "checkpoint_config_sha256": _sha256_file(
            checkpoint_path / "config.json" if checkpoint_path is not None else None
        ),
        "checkpoint_metrics_sha256": _sha256_file(
            checkpoint_path / "metrics.json" if checkpoint_path is not None else None
        ),
        "checkpoint_inference_check_sha256": _sha256_file(
            checkpoint_path / "inference_check.json" if checkpoint_path is not None else None
        ),
        "checkpoint_policy": str(policy_path) if policy_path is not None else None,
        "checkpoint_policy_sha256": _sha256_file(policy_path),
        "hardware_evidence_sha256": _sha256_file(hardware_path),
        "production_min_steps": int(args.production_min_steps),
        "require_inference": bool(args.require_inference),
        "task": args.task,
        "max_steps": int(args.max_steps),
        "hz": float(args.hz),
        "allow_motion": bool(args.allow_motion),
        "motion_executed": bool(motion and motion.get("motion_executed")),
        "livekit_url_configured": bool(args.url),
        "livekit_token_configured": bool(args.token),
        "checks": dict(preflight.get("checks", {})),
        "production_ok": bool((preflight.get("production_report") or {}).get("ok")),
        "production_validation": {
            "ok": bool(production_report.get("ok")),
            "production_regime": production_report.get("production_regime"),
            "max_metric_steps": production_report.get("max_metric_steps"),
            "checks": production_report.get("checks"),
        },
        "hardware_ok": bool((preflight.get("hardware_report") or {}).get("ok")),
        "motion_ok": None if motion is None else bool(motion.get("ok")),
        "result": None if motion is None else motion.get("result"),
        "events": None if motion is None else motion.get("events"),
    }


def _write_report(path: Path | None, report: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


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
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    preflight = _preflight(args)
    if not args.allow_motion or not preflight["ok"]:
        evidence = _run_evidence(args=args, preflight=preflight, motion=None)
        report = {
            **preflight,
            "motion_executed": False,
            "run_evidence": evidence,
            "launch_command_required": (
                "--allow-motion with valid checkpoint, hardware evidence, and LiveKit credentials"
            ),
        }
        _write_report(args.out, report)
        print(json.dumps(report, indent=2))
        return 0 if (not args.allow_motion and preflight["checks"]["allow_motion"] is False) else 2
    motion = asyncio.run(_run_motion(args))
    evidence = _run_evidence(args=args, preflight=preflight, motion=motion)
    report = {
        **preflight,
        "motion": motion,
        "motion_executed": motion["motion_executed"],
        "run_evidence": evidence,
    }
    report["ok"] = preflight["ok"] and motion["ok"]
    _write_report(args.out, report)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
