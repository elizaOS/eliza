#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.bridge.backends.asimov_mujoco import AsimovMujocoBackend  # noqa: E402
from eliza_robot.bridge.backends.asimov_remote import AsimovRemoteBackend  # noqa: E402
from eliza_robot.rl.text_conditioned.inference_loop import (  # noqa: E402
    InferenceLoopConfig,
    run_inference,
)
from eliza_robot.rl.text_conditioned.train import _train_asimov_smoke  # noqa: E402


def write_validation_checkpoint(path: Path, seed: int = 0) -> None:
    _train_asimov_smoke(path, total_steps=2, seed=seed)


async def _exercise(backend, ckpt: Path, max_steps: int) -> dict:
    await backend.connect()
    try:
        result = await run_inference(
            backend,
            ckpt,
            "walk_forward",
            config=InferenceLoopConfig(hz=50.0, max_steps=max_steps, profile_id="asimov-1"),
        )
        events = await backend.poll_events()
        return {
            "ok": result["steps_completed"] == max_steps,
            "backend": backend.backend_name,
            "result": result,
            "events": len(events),
        }
    finally:
        await backend.shutdown()


async def _run(ckpt: Path, max_steps: int) -> dict:
    return {
        "ok": True,
        "backends": {
            "mock": await _exercise(AsimovRemoteBackend(mock=True), ckpt, max_steps),
            "mujoco": await _exercise(AsimovMujocoBackend(), ckpt, max_steps),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--max-steps", type=int, default=2)
    args = parser.parse_args()
    if args.checkpoint is None:
        with tempfile.TemporaryDirectory(prefix="asimov-policy-loop-") as tmp:
            ckpt = Path(tmp)
            write_validation_checkpoint(ckpt)
            report = asyncio.run(_run(ckpt, args.max_steps))
    else:
        report = asyncio.run(_run(args.checkpoint, args.max_steps))
    report["ok"] = all(row["ok"] for row in report["backends"].values())
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
