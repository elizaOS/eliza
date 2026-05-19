"""End-to-end camera.snapshot test against the real MuJoCo backend.

Renders the AiNex DemoEnv's head camera, sends it through the bridge, and
asserts a baseline image is non-trivial. A second test mutates the head pan
joint via the bridge `head.set` command, takes a second snapshot, and
asserts the rendered pixels differ — proving the bridge → backend → MuJoCo
→ render → ws path is fully connected.

This test is skipped when MuJoCo is not installed (CI runners without GPU
or headless rendering may also fail; we only require import success).
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import socket
from collections.abc import AsyncIterator

import numpy as np
import pytest
import pytest_asyncio
from PIL import Image
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.bridge.server import RuntimeConfig, _handler

mujoco = pytest.importorskip("mujoco")


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest_asyncio.fixture
async def mujoco_bridge() -> AsyncIterator[str]:
    """Boot the bridge with a fresh MuJocoBackend (DemoEnv) on a random port."""
    from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
    from eliza_robot.sim.mujoco.demo_env import DemoEnv

    port = _free_port()
    config = RuntimeConfig(
        queue_size=32,
        max_commands_per_sec=200,
        deadman_timeout_sec=30.0,
        trace_log_path="",
    )

    def _factory() -> MuJocoBackend:
        env = DemoEnv(target_position=(2.0, 0.0, 0.05))
        return MuJocoBackend(env)

    async def handler(ws) -> None:
        await _handler(ws, _factory, config)

    server = await serve(handler, "127.0.0.1", port)
    serve_task = asyncio.create_task(server.serve_forever())
    await asyncio.sleep(0.1)
    try:
        yield f"ws://127.0.0.1:{port}"
    finally:
        server.close()
        await server.wait_closed()
        serve_task.cancel()
        try:
            await serve_task
        except (asyncio.CancelledError, Exception):
            pass


async def _request(ws, command: str, payload: dict, request_id: str | None = None) -> dict:
    rid = request_id or f"test-{command}"
    envelope = CommandEnvelope(
        request_id=rid,
        timestamp=utc_now_iso(),
        command=command,
        payload=payload,
    )
    await ws.send(json.dumps(envelope.to_json()))
    for _ in range(120):
        frame = json.loads(await ws.recv())
        if frame.get("type") == "response" and frame.get("request_id") == rid:
            return frame
    raise AssertionError(f"no response to {command} (rid={rid})")


def _decode(response: dict) -> np.ndarray:
    data = response["data"]
    raw = base64.b64decode(data["frame_base64"])
    return np.array(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.uint8)


@pytest.mark.asyncio
async def test_mujoco_camera_snapshot_returns_real_render(mujoco_bridge: str) -> None:
    """A snapshot from the MuJoCo backend is a valid non-trivial RGB image."""
    async with connect(mujoco_bridge) as ws:
        await ws.recv()  # session.hello
        response = await _request(ws, "camera.snapshot", {})
        assert response["ok"], response.get("message")
        data = response["data"]
        assert data["format"] == "png"
        assert data["width"] == 640
        assert data["height"] == 480

        arr = _decode(response)
        assert arr.shape == (480, 640, 3)
        # Real renders should have pixel variation across rows/cols.
        std = float(arr.std())
        assert std > 5.0, f"render too flat (std={std:.2f})"


@pytest.mark.asyncio
async def test_mujoco_camera_snapshot_changes_after_head_pan(mujoco_bridge: str) -> None:
    """Move the head pan ~50° via bridge `head.set` and verify the rendered
    pixels change materially. This is the smallest end-to-end proof that
    Eliza → bridge → MuJoCo → render → wire moves bits when the agent
    issues a motion command.
    """
    async with connect(mujoco_bridge) as ws:
        await ws.recv()  # session.hello

        before = _decode(await _request(ws, "camera.snapshot", {}, request_id="snap-1"))

        # head.set: pan +0.9 rad ≈ 51° to the left.
        pan_response = await _request(
            ws,
            "head.set",
            {"pan": 0.9, "tilt": 0.0, "duration": 0.5},
            request_id="head-1",
        )
        assert pan_response["ok"], pan_response.get("message")

        # Give MuJoCo a few ticks to settle the head joint (step is already
        # advanced inside MuJocoBackend.handle_command for head.set).
        await asyncio.sleep(0.05)

        after = _decode(await _request(ws, "camera.snapshot", {}, request_id="snap-2"))
        diff = np.abs(before.astype(np.int16) - after.astype(np.int16))
        mean_diff = float(diff.mean())
        assert mean_diff > 1.5, (
            f"head-pan did not perceptibly change the rendered view (mean diff={mean_diff:.3f})"
        )
