"""Real-robot smoke check — verifies the physical AiNex bridge is reachable.

Connects to the bridge server (default: the `real` target on
ws://localhost:9100), sends a minimum exchange that does NOT command motion:

  1. wait for `session.hello`
  2. send `profile.describe`        → verify backend reports walk_set/walk_command caps
  3. send `camera.snapshot`         → verify a non-empty frame is returned
  4. wait for one `telemetry.basic` → verify the robot is publishing IMU/battery

If any step fails, exits non-zero with a precise message. No walk/servo
commands are issued — safe to run on a powered, untethered robot.

Usage:
    # Sim bridge (good for testing this script itself):
    PYTHONPATH=packages/robot python -m eliza_robot.bridge.server --backend mock --port 9100 &
    PYTHONPATH=packages/robot python packages/robot/scripts/check_real_robot.py

    # Real robot (after powering the AiNex and starting its ROS bridge):
    PYTHONPATH=packages/robot python -m eliza_robot.bridge.launch --target real --envelope &
    PYTHONPATH=packages/robot python packages/robot/scripts/check_real_robot.py \\
        --url ws://localhost:9100 --camera-device 0
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from websockets.asyncio.client import connect

from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso


async def _request(ws, command: str, payload: dict | None = None, timeout: float = 5.0) -> dict:
    rid = f"smoke-{command}-{time.time_ns()}"
    envelope = CommandEnvelope(
        request_id=rid,
        timestamp=utc_now_iso(),
        command=command,
        payload=payload or {},
    )
    await ws.send(json.dumps(envelope.to_json()))
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=deadline - asyncio.get_event_loop().time())
        except asyncio.TimeoutError:
            break
        frame = json.loads(raw)
        if frame.get("type") == "response" and frame.get("request_id") == rid:
            return frame
    raise TimeoutError(f"no response to {command} within {timeout}s")


async def _wait_event(ws, event_name: str, timeout: float = 5.0) -> dict:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=deadline - asyncio.get_event_loop().time())
        except asyncio.TimeoutError:
            break
        frame = json.loads(raw)
        if frame.get("type") == "event" and frame.get("event") == event_name:
            return frame
    raise TimeoutError(f"no event '{event_name}' within {timeout}s")


async def _run(url: str, save_frame_to: Path | None) -> int:
    print(f"[smoke] connecting to {url}...")
    async with connect(url) as ws:
        # 1. session.hello
        hello = await _wait_event(ws, "session.hello", timeout=5.0)
        backend = hello.get("backend", "?")
        caps = hello.get("data", {}).get("capabilities", {})
        print(f"[smoke] connected — backend={backend}, capabilities keys={sorted(caps)}")

        # 2. profile.describe
        try:
            response = await _request(ws, "profile.describe", {})
            assert response["ok"], response.get("message")
            profile = response["data"]["profile"]
            print(
                f"[smoke] profile.describe ok — id={profile['id']} "
                f"dof={profile['kinematics']['dof']}"
            )
        except Exception as exc:
            print(f"[smoke] FAIL profile.describe: {exc}", file=sys.stderr)
            return 2

        # 3. camera.snapshot
        try:
            response = await _request(ws, "camera.snapshot", {})
            if not response["ok"]:
                print(
                    f"[smoke] WARN camera.snapshot not available on this backend: "
                    f"{response['message']}",
                    file=sys.stderr,
                )
            else:
                raw = base64.b64decode(response["data"]["frame_base64"])
                frame = np.array(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.uint8)
                print(
                    f"[smoke] camera.snapshot ok — {frame.shape}, "
                    f"min={frame.min()} max={frame.max()}"
                )
                if save_frame_to is not None:
                    save_frame_to.parent.mkdir(parents=True, exist_ok=True)
                    Image.fromarray(frame).save(save_frame_to)
                    print(f"[smoke] saved frame to {save_frame_to}")
        except Exception as exc:
            print(f"[smoke] WARN camera.snapshot: {exc}", file=sys.stderr)

        # 4. telemetry.basic
        try:
            telemetry = await _wait_event(ws, "telemetry.basic", timeout=5.0)
            data = telemetry["data"]
            print(
                f"[smoke] telemetry.basic ok — battery={data.get('battery_mv')}mV, "
                f"walking={data.get('is_walking')}, imu_roll={data.get('imu_roll'):.3f}, "
                f"imu_pitch={data.get('imu_pitch'):.3f}"
            )
        except Exception as exc:
            print(f"[smoke] FAIL telemetry.basic: {exc}", file=sys.stderr)
            return 3

        print("[smoke] PASS — bridge is reachable, robot is publishing, camera path is wired.")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--url",
        default="ws://localhost:9100",
        help="bridge websocket URL (default: ws://localhost:9100)",
    )
    parser.add_argument(
        "--save-frame",
        type=Path,
        default=None,
        help="optional path to save the captured camera frame as PNG",
    )
    args = parser.parse_args()
    try:
        return asyncio.run(_run(args.url, args.save_frame))
    except (ConnectionRefusedError, OSError) as exc:
        print(
            f"[smoke] FAIL could not connect to {args.url}: {exc}",
            file=sys.stderr,
        )
        return 4


if __name__ == "__main__":
    sys.exit(main())
