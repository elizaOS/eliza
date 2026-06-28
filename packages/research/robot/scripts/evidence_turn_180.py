"""Evidence script: command the AiNex to turn ~180° in MuJoCo and verify motion.

Boots the bridge with the MuJoCo backend, opens a websocket client, takes a
camera snapshot, drives the robot through `walk.set` + `walk.command:start`
(yaw command), polls telemetry for ground-truth yaw, stops, takes a second
snapshot, computes per-pixel diff, and saves:

  - before.png  (head-camera RGB before the turn)
  - after.png   (head-camera RGB after the turn)
  - diff.png    (absolute pixel diff, scaled up for visibility)
  - report.json (yaw delta, mean pixel diff, % pixels changed, durations)

Usage:
    JAX_PLATFORMS=cpu python -m eliza_robot.scripts.evidence_turn_180 \
        --out packages/robot/examples/robot-mujoco-demo/evidence/

This is the programmatic equivalent of: chat "turn around" → photograph
before/after → assert the photos differ. We run it against MuJoCo because
the real robot needs to be physically present; the run.sh script in the
example folder shows the matching real-robot path.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import math
import socket
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.bridge.server import RuntimeConfig, _handler


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


async def _request(ws, command: str, payload: dict | None = None, rid: str | None = None) -> dict:
    request_id = rid or f"evidence-{command}-{time.time_ns()}"
    envelope = CommandEnvelope(
        request_id=request_id,
        timestamp=utc_now_iso(),
        command=command,
        payload=payload or {},
    )
    await ws.send(json.dumps(envelope.to_json()))
    for _ in range(200):
        frame = json.loads(await ws.recv())
        if frame.get("type") == "response" and frame.get("request_id") == request_id:
            return frame
    raise RuntimeError(f"no response to {command}")


def _decode_frame(response: dict) -> np.ndarray:
    raw = base64.b64decode(response["data"]["frame_base64"])
    return np.array(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.uint8)


async def _gather_telemetry_yaw(ws, max_frames: int = 50) -> float | None:
    """Best-effort: pull frames for a short window to find the latest is_walking
    telemetry. Returns walk_yaw if reported; the script also reads ground-truth
    yaw directly from the MuJoCo env for the canonical measurement.
    """
    for _ in range(max_frames):
        try:
            frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.5))
        except asyncio.TimeoutError:
            return None
        if frame.get("type") == "event" and frame.get("event") == "telemetry.basic":
            return float(frame["data"].get("walk_yaw", 0.0))
    return None


async def _run(out_dir: Path, yaw_rate_rad_s: float, duration_s: float) -> int:
    from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
    from eliza_robot.sim.mujoco.demo_env import DemoEnv

    out_dir.mkdir(parents=True, exist_ok=True)
    port = _free_port()
    config = RuntimeConfig(
        queue_size=64,
        max_commands_per_sec=100,
        deadman_timeout_sec=60.0,
        trace_log_path=str(out_dir / "trace.jsonl"),
    )

    # Build the env once so we can read ground-truth yaw without going through ws.
    env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    backend = MuJocoBackend(env)

    def _factory() -> MuJocoBackend:
        return backend

    async def handler(ws) -> None:
        await _handler(ws, _factory, config)

    server = await serve(handler, "127.0.0.1", port)
    serve_task = asyncio.create_task(server.serve_forever())
    await asyncio.sleep(0.2)

    print(f"[evidence] bridge listening on ws://127.0.0.1:{port}")

    try:
        async with connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.recv()  # session.hello

            yaw_before = env.get_robot_yaw()
            print(f"[evidence] ground-truth yaw before: {math.degrees(yaw_before):+.2f}°")

            snap_before = await _request(ws, "camera.snapshot", {})
            arr_before = _decode_frame(snap_before)
            Image.fromarray(arr_before).save(out_dir / "before.png")
            print(f"[evidence] saved before.png ({arr_before.shape})")

            # Command the turn. `walk.yaw` is the per-cycle yaw bias; our
            # MuJoCo backend treats it as rad/s body yaw rate, so passing
            # yaw_rate_rad_s directly is meaningful.
            await _request(
                ws,
                "walk.set",
                {
                    "speed": 2,
                    "height": 0.036,
                    "x": 0.0,
                    "y": 0.0,
                    "yaw": yaw_rate_rad_s,
                },
            )
            await _request(ws, "walk.command", {"action": "start"})

            print(
                f"[evidence] walking for {duration_s:.2f}s at yaw rate {yaw_rate_rad_s:+.2f} rad/s..."
            )
            await asyncio.sleep(duration_s)

            await _request(ws, "walk.command", {"action": "stop"})
            # Give the gait loop a beat to settle.
            await asyncio.sleep(0.1)

            yaw_after = env.get_robot_yaw()
            yaw_delta = math.atan2(
                math.sin(yaw_after - yaw_before),
                math.cos(yaw_after - yaw_before),
            )
            print(
                f"[evidence] ground-truth yaw after: {math.degrees(yaw_after):+.2f}° "
                f"(Δ = {math.degrees(yaw_delta):+.2f}°)"
            )

            snap_after = await _request(ws, "camera.snapshot", {})
            arr_after = _decode_frame(snap_after)
            Image.fromarray(arr_after).save(out_dir / "after.png")
            print(f"[evidence] saved after.png ({arr_after.shape})")

            diff = np.abs(arr_before.astype(np.int16) - arr_after.astype(np.int16))
            mean_diff = float(diff.mean())
            changed_pct = float((diff.max(axis=2) > 8).mean() * 100.0)
            diff_vis = np.clip(diff * 4, 0, 255).astype(np.uint8)
            Image.fromarray(diff_vis).save(out_dir / "diff.png")
            print(
                f"[evidence] mean pixel diff: {mean_diff:.2f} | "
                f"% pixels changed (>8): {changed_pct:.2f}"
            )

            report = {
                "yaw_before_rad": float(yaw_before),
                "yaw_after_rad": float(yaw_after),
                "yaw_delta_deg": float(math.degrees(yaw_delta)),
                "mean_pixel_diff": mean_diff,
                "changed_pixel_pct": changed_pct,
                "yaw_rate_command_rad_s": yaw_rate_rad_s,
                "duration_s": duration_s,
                "image_shape": list(arr_before.shape),
            }
            (out_dir / "report.json").write_text(json.dumps(report, indent=2))
            print(f"[evidence] wrote {out_dir / 'report.json'}")

            # Verdict: report exit code 0 if the camera detected motion AND
            # the ground-truth yaw delta exceeds 30° (a reasonable lower bound
            # for "the robot turned").
            ok = mean_diff > 1.0 and abs(math.degrees(yaw_delta)) > 30.0
            print(
                f"[evidence] verdict: {'PASS' if ok else 'FAIL'} "
                f"(needs mean_diff > 1.0 and |yaw_delta| > 30°)"
            )
            return 0 if ok else 2
    finally:
        server.close()
        await server.wait_closed()
        serve_task.cancel()
        try:
            await serve_task
        except (asyncio.CancelledError, Exception):
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "examples"
        / "robot-mujoco-demo"
        / "evidence",
        help="output directory for before/after/diff PNGs and report.json",
    )
    parser.add_argument(
        "--yaw-rate",
        type=float,
        default=3.5,
        help="commanded yaw rate (rad/s). Sign sets turn direction.",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=1.0,
        help="how long to walk before stopping (seconds)",
    )
    args = parser.parse_args()

    return asyncio.run(_run(args.out, args.yaw_rate, args.duration))


if __name__ == "__main__":
    sys.exit(main())
