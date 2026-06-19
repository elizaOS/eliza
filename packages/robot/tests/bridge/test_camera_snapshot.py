"""End-to-end tests for the `camera.snapshot` command.

The unified bridge protocol exposes a single camera surface that maps to:
  - DemoEnv.render_ego()        on the MuJoCo backend
  - the synthetic gradient      on the Mock backend
  - the latest v4l2/ROS frame   on a real backend (not exercised here)

These tests use the mock backend (cheap, no MuJoCo) and verify (a) the
response decodes back to a valid RGB image of the advertised size and (b)
the image shifts when the robot's state changes — which lets pixel-diff
tests prove that "the robot moved" instead of "the bridge replayed cache".
"""

from __future__ import annotations

import base64
import io
import json

import numpy as np
import pytest
from PIL import Image
from websockets.asyncio.client import connect

from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso


async def _request(ws, command: str, payload: dict, request_id: str | None = None) -> dict:
    rid = request_id or f"test-{command}"
    envelope = CommandEnvelope(
        request_id=rid,
        timestamp=utc_now_iso(),
        command=command,
        payload=payload,
    )
    await ws.send(json.dumps(envelope.to_json()))
    for _ in range(60):
        frame = json.loads(await ws.recv())
        if frame.get("type") == "response" and frame.get("request_id") == rid:
            return frame
    raise AssertionError(f"no response to {command} (rid={rid})")


def _decode_snapshot(response: dict) -> np.ndarray:
    data = response["data"]
    raw = base64.b64decode(data["frame_base64"])
    img = Image.open(io.BytesIO(raw))
    assert img.mode == "RGB"
    arr = np.array(img, dtype=np.uint8)
    assert arr.shape == (data["height"], data["width"], 3)
    return arr


@pytest.mark.asyncio
async def test_camera_snapshot_returns_valid_png(mock_server: str) -> None:
    """`camera.snapshot` returns a valid base64 PNG of the advertised size."""
    async with connect(mock_server) as ws:
        await ws.recv()  # session.hello
        response = await _request(ws, "camera.snapshot", {})
        assert response["ok"] is True, response.get("message")
        data = response["data"]
        assert data["format"] == "png"
        assert data["camera"] == "head"
        assert data["width"] > 0 and data["height"] > 0
        arr = _decode_snapshot(response)
        # Frame should not be uniformly flat.
        assert int(arr.max()) - int(arr.min()) > 100


@pytest.mark.asyncio
async def test_camera_snapshot_changes_with_robot_state(mock_server: str) -> None:
    """After a yaw-rotation `walk.set` the snapshot must differ pixel-wise from
    the baseline — proves the camera path responds to commanded motion.
    """
    async with connect(mock_server) as ws:
        await ws.recv()  # session.hello

        before = await _request(ws, "camera.snapshot", {}, request_id="snap-before")
        arr_before = _decode_snapshot(before)

        # Send a meaningful turn command (yaw=5, height=0.036, speed=3) and start.
        walk_set = await _request(
            ws,
            "walk.set",
            {"speed": 3, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": 5.0},
            request_id="walk-set",
        )
        assert walk_set["ok"]
        walk_start = await _request(
            ws,
            "walk.command",
            {"action": "start"},
            request_id="walk-start",
        )
        assert walk_start["ok"]

        after = await _request(ws, "camera.snapshot", {}, request_id="snap-after")
        arr_after = _decode_snapshot(after)

        assert arr_before.shape == arr_after.shape
        diff = np.abs(arr_before.astype(np.int16) - arr_after.astype(np.int16))
        mean_pixel_diff = float(diff.mean())
        # The mock backend hue/saturation shift on yaw produces a substantial
        # delta. Anything > 10 mean pixel diff is clearly "image moved".
        assert mean_pixel_diff > 10.0, (
            f"snapshot did not change after turn (mean diff={mean_pixel_diff:.2f})"
        )
