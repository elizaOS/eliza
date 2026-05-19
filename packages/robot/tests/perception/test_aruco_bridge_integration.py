"""ArUco localization end-to-end through the bridge.

Captures a real MuJoCo render via the unified `camera.snapshot` bridge
command, composites an ArUco marker into the frame at a known pixel
location, runs the ArucoDetector, and asserts the marker's 6-DOF pose
recovers within tolerance.

This is the integration counterpart to test_aruco_e2e.py (which uses pure
synthetic frames). It proves the path:

    DemoEnv.render_ego() → MuJocoBackend.snapshot_camera()
        → bridge protocol → ws → client decode → ArucoDetector → 6-DOF pose

is real and consumable for downstream localization.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import socket
from pathlib import Path

import numpy as np
import pytest
import pytest_asyncio
from PIL import Image
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.bridge.server import RuntimeConfig, _handler

cv2 = pytest.importorskip("cv2")
mujoco = pytest.importorskip("mujoco")


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest_asyncio.fixture
async def mujoco_bridge():
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
        return MuJocoBackend(DemoEnv(target_position=(2.0, 0.0, 0.05)))

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


async def _request(ws, command: str, payload: dict | None = None) -> dict:
    rid = f"aruco-int-{command}"
    envelope = CommandEnvelope(
        request_id=rid,
        timestamp=utc_now_iso(),
        command=command,
        payload=payload or {},
    )
    await ws.send(json.dumps(envelope.to_json()))
    for _ in range(80):
        frame = json.loads(await ws.recv())
        if frame.get("type") == "response" and frame.get("request_id") == rid:
            return frame
    raise AssertionError(f"no response to {command}")


def _composite_aruco(
    base: np.ndarray,
    marker_id: int,
    marker_size_px: int,
    top_left: tuple[int, int],
) -> np.ndarray:
    """Paste a black-on-white ArUco marker into the base image.

    The marker is drawn fronto-parallel — sufficient for the detector to
    recover pose via solvePnP.
    """
    dict_ = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_6X6_250)
    marker = np.zeros((marker_size_px, marker_size_px), dtype=np.uint8)
    cv2.aruco.generateImageMarker(dict_, marker_id, marker_size_px, marker, 1)
    # Add white border so detectMarkers finds the quad
    pad = max(20, marker_size_px // 6)
    bordered = np.full(
        (marker_size_px + 2 * pad, marker_size_px + 2 * pad), 255, dtype=np.uint8
    )
    bordered[pad : pad + marker_size_px, pad : pad + marker_size_px] = marker
    h, w = bordered.shape
    y, x = top_left
    out = base.copy()
    out[y : y + h, x : x + w] = np.stack([bordered] * 3, axis=-1)
    return out


@pytest.mark.asyncio
async def test_aruco_detection_on_real_mujoco_render(
    mujoco_bridge: str, tmp_path: Path
) -> None:
    from eliza_robot.perception.calibration import CameraIntrinsics
    from eliza_robot.perception.detectors.aruco_detector import ArucoDetector

    async with connect(mujoco_bridge) as ws:
        await ws.recv()  # session.hello

        response = await _request(ws, "camera.snapshot", {})
        assert response["ok"], response.get("message")
        raw = base64.b64decode(response["data"]["frame_base64"])
        frame = np.array(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.uint8)
        assert frame.shape == (480, 640, 3)

        marker_size_px = 160
        composited = _composite_aruco(
            frame, marker_id=3, marker_size_px=marker_size_px, top_left=(140, 240)
        )

        # Intrinsics roughly matching the DemoEnv's head camera (FOV ≈ 60°).
        intrinsics = CameraIntrinsics(
            fx=554.0, fy=554.0, cx=320.0, cy=240.0, width=640, height=480
        )
        detector = ArucoDetector(intrinsics, marker_size_m=0.05)
        detections = detector.detect(composited)
        assert len(detections) == 1, f"expected 1 ArUco marker, got {len(detections)}"
        d = detections[0]
        assert d.marker_id == 3
        # Distance must be positive and within a plausible band (fronto-
        # parallel marker 160px wide at fx=554 ≈ 0.17 m away).
        assert 0.05 < d.distance < 1.0, f"unrealistic distance: {d.distance:.3f} m"
        # tvec should be roughly centered (the marker is near image center).
        assert abs(d.tvec[0]) < 0.5
        assert abs(d.tvec[1]) < 0.5

        # Save the annotated frame as artifact for visual inspection.
        annotated = composited.copy()
        cv2.aruco.drawDetectedMarkers(
            annotated, [d.corners.reshape(1, 4, 2)], np.array([[d.marker_id]])
        )
        # Convert RGB -> BGR for cv2.imwrite
        cv2.imwrite(
            str(tmp_path / "aruco_on_mujoco_render.png"),
            cv2.cvtColor(annotated, cv2.COLOR_RGB2BGR),
        )
