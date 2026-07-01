"""Evidence script: ArUco-based localization through the bridge.

Captures a MuJoCo render via `camera.snapshot`, composites two ArUco
markers (ground origin + ground +X from the world frame), runs the
detector, and writes:

  - aruco_scene.png        — composited input frame
  - aruco_annotated.png    — same frame with detection overlays + pose axes
  - aruco_report.json      — per-marker pose + recovered world frame

For the real robot run, swap the `mujoco_bridge` factory for `--target real`
and replace the compositing helper with a frame pulled from the Obsbot
camera. The detector and pose-estimation math are identical.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import socket
import sys
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


def _composite_marker(
    base: np.ndarray, marker_id: int, size_px: int, top_left: tuple[int, int]
) -> np.ndarray:
    import cv2

    dict_ = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_6X6_250)
    marker = np.zeros((size_px, size_px), dtype=np.uint8)
    cv2.aruco.generateImageMarker(dict_, marker_id, size_px, marker, 1)
    pad = max(20, size_px // 6)
    bordered = np.full((size_px + 2 * pad, size_px + 2 * pad), 255, dtype=np.uint8)
    bordered[pad : pad + size_px, pad : pad + size_px] = marker
    h, w = bordered.shape
    y, x = top_left
    out = base.copy()
    out[y : y + h, x : x + w] = np.stack([bordered] * 3, axis=-1)
    return out


async def _request(ws, command: str, payload: dict | None = None) -> dict:
    rid = f"evidence-{command}"
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
    raise RuntimeError(f"no response to {command}")


async def _run(out_dir: Path) -> int:
    from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
    from eliza_robot.sim.mujoco.demo_env import DemoEnv
    from eliza_robot.perception.calibration import CameraIntrinsics
    from eliza_robot.perception.detectors.aruco_detector import ArucoDetector

    out_dir.mkdir(parents=True, exist_ok=True)
    port = _free_port()
    config = RuntimeConfig(
        queue_size=32,
        max_commands_per_sec=200,
        deadman_timeout_sec=60.0,
        trace_log_path="",
    )

    def _factory() -> MuJocoBackend:
        return MuJocoBackend(DemoEnv(target_position=(2.0, 0.0, 0.05)))

    async def handler(ws) -> None:
        await _handler(ws, _factory, config)

    server = await serve(handler, "127.0.0.1", port)
    serve_task = asyncio.create_task(server.serve_forever())
    await asyncio.sleep(0.15)
    print(f"[aruco-evidence] bridge listening on ws://127.0.0.1:{port}")

    try:
        async with connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.recv()

            response = await _request(ws, "camera.snapshot", {})
            assert response["ok"], response.get("message")
            raw = base64.b64decode(response["data"]["frame_base64"])
            frame = np.array(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.uint8)
            print(f"[aruco-evidence] captured frame {frame.shape}")

            # Composite two markers: ID 2 (origin) and ID 3 (+X)
            composited = _composite_marker(frame, marker_id=2, size_px=110, top_left=(160, 120))
            composited = _composite_marker(composited, marker_id=3, size_px=110, top_left=(160, 380))
            Image.fromarray(composited).save(out_dir / "aruco_scene.png")
            print(f"[aruco-evidence] wrote aruco_scene.png")

            intrinsics = CameraIntrinsics(
                fx=554.0, fy=554.0, cx=320.0, cy=240.0, width=640, height=480
            )
            detector = ArucoDetector(intrinsics, marker_size_m=0.05)
            detections = detector.detect(composited)
            print(f"[aruco-evidence] detected {len(detections)} markers")

            import cv2

            annotated = composited.copy()
            for d in detections:
                cv2.aruco.drawDetectedMarkers(
                    annotated,
                    [d.corners.reshape(1, 4, 2)],
                    np.array([[d.marker_id]]),
                )
                cv2.drawFrameAxes(
                    annotated, intrinsics.camera_matrix, intrinsics.dist_array,
                    d.rvec, d.tvec, 0.025,
                )
            Image.fromarray(annotated).save(out_dir / "aruco_annotated.png")
            print(f"[aruco-evidence] wrote aruco_annotated.png")

            report = {
                "intrinsics": {
                    "fx": intrinsics.fx, "fy": intrinsics.fy,
                    "cx": intrinsics.cx, "cy": intrinsics.cy,
                    "hfov_deg": intrinsics.hfov_deg,
                    "vfov_deg": intrinsics.vfov_deg,
                },
                "frame_shape": list(frame.shape),
                "detections": [
                    {
                        "marker_id": int(d.marker_id),
                        "tvec_m": [float(x) for x in d.tvec.flatten()],
                        "rvec_rad": [float(x) for x in d.rvec.flatten()],
                        "distance_m": float(d.distance),
                        "confidence": float(d.confidence),
                    }
                    for d in detections
                ],
            }
            (out_dir / "aruco_report.json").write_text(json.dumps(report, indent=2))
            print(f"[aruco-evidence] wrote aruco_report.json")
            return 0 if len(detections) >= 2 else 2
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
    )
    args = parser.parse_args()
    return asyncio.run(_run(args.out))


if __name__ == "__main__":
    sys.exit(main())
