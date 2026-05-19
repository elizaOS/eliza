"""Live Obsbot ArUco evidence — captures from the real /dev/video* device,
runs ArUco detection on every frame for a short window, saves:

  - live_camera_frame.png           — sample raw frame
  - live_camera_aruco_annotated.png — same frame with detected markers + pose
  - live_camera_aruco.mp4           — short video of the live overlay
  - live_camera_aruco_report.json   — per-frame detection summary

This is the real-hardware counterpart to evidence_aruco_localize.py (which
uses composited markers on a MuJoCo render). The detector and pose math
are identical; only the pixel source changes.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.aruco_detector import ArucoDetector


def _open_camera(device: int, width: int, height: int) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(device, cv2.CAP_V4L2)
    # MJPG is required for >720p on most webcams
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, 30)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open /dev/video{device}")
    return cap


def _annotate(
    frame: np.ndarray,
    detections: list,
    intrinsics: CameraIntrinsics,
) -> np.ndarray:
    out = frame.copy()
    for d in detections:
        cv2.aruco.drawDetectedMarkers(
            out, [d.corners.reshape(1, 4, 2)], np.array([[d.marker_id]])
        )
        cv2.drawFrameAxes(
            out, intrinsics.camera_matrix, intrinsics.dist_array,
            d.rvec, d.tvec, 0.03,
        )
        x, y = d.corners.mean(axis=0).astype(int)
        cv2.putText(
            out,
            f"id={d.marker_id} d={d.distance:.2f}m",
            (int(x - 60), int(y - 12)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2,
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", type=int, default=4, help="v4l2 device index")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--duration", type=float, default=6.0, help="recording seconds")
    parser.add_argument("--fps", type=float, default=15.0, help="output mp4 fps")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "examples"
        / "robot-mujoco-demo"
        / "evidence"
        / "live",
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    cap = _open_camera(args.device, args.width, args.height)
    actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"[live] /dev/video{args.device} -> {actual_w}x{actual_h}")

    # Obsbot Tiny SE: horizontal FOV ~86° at 1080p; fx ≈ w / (2 tan(43°)) ≈ 1024
    fx = actual_w / (2 * np.tan(np.radians(43.0)))
    intrinsics = CameraIntrinsics(
        fx=fx, fy=fx, cx=actual_w / 2, cy=actual_h / 2,
        width=actual_w, height=actual_h,
    )
    detector = ArucoDetector(intrinsics, marker_size_m=0.0508)

    # Warm-up so AE / AWB stabilizes
    for _ in range(20):
        cap.read()
        time.sleep(0.03)

    sample_saved = False
    frames_written = 0
    per_frame_log: list[dict] = []
    seen_ids: set[int] = set()

    # mp4v keeps the file size small + plays everywhere; we encode whatever
    # res the camera negotiated (no scaling).
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(
        str(args.out / "live_camera_aruco.mp4"),
        fourcc, args.fps, (actual_w, actual_h),
    )
    if not writer.isOpened():
        raise RuntimeError("cv2.VideoWriter failed to open — check ffmpeg / codecs")

    start = time.time()
    while (time.time() - start) < args.duration:
        ok, frame = cap.read()
        if not ok or frame is None:
            print("[live] frame capture failed; retrying")
            time.sleep(0.05)
            continue

        detections = detector.detect(frame)
        for d in detections:
            seen_ids.add(int(d.marker_id))
        annot = _annotate(frame, detections, intrinsics)

        # HUD: timestamp + detection count + first marker pose
        hud = f"t={time.time() - start:0.2f}s  markers={len(detections)}"
        cv2.putText(
            annot, hud, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
            (255, 255, 255), 2,
        )
        cv2.putText(
            annot, "live Obsbot @ /dev/video{}".format(args.device),
            (12, actual_h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
            (200, 200, 200), 2,
        )

        if not sample_saved and len(detections) > 0:
            cv2.imwrite(str(args.out / "live_camera_aruco_annotated.png"), annot)
            cv2.imwrite(str(args.out / "live_camera_frame.png"), frame)
            sample_saved = True
            print(
                f"[live] saved sample frame with {len(detections)} markers "
                f"(ids={sorted(seen_ids)})"
            )

        per_frame_log.append({
            "t_s": time.time() - start,
            "markers": [
                {
                    "id": int(d.marker_id),
                    "tvec_m": d.tvec.flatten().round(4).tolist(),
                    "rvec_rad": d.rvec.flatten().round(4).tolist(),
                    "distance_m": float(round(d.distance, 4)),
                }
                for d in detections
            ],
        })
        writer.write(annot)
        frames_written += 1
        # cap our frame rate
        time.sleep(max(0.0, 1.0 / args.fps - 0.005))

    writer.release()
    cap.release()

    # If we never saw a marker, still save a raw sample so the user can debug.
    if not sample_saved:
        cap2 = _open_camera(args.device, args.width, args.height)
        for _ in range(10):
            cap2.read()
        ok, frame = cap2.read()
        cap2.release()
        if ok:
            cv2.imwrite(str(args.out / "live_camera_frame.png"), frame)

    report = {
        "device": f"/dev/video{args.device}",
        "frame_size": [actual_w, actual_h],
        "intrinsics": {
            "fx": intrinsics.fx, "fy": intrinsics.fy,
            "cx": intrinsics.cx, "cy": intrinsics.cy,
            "hfov_deg": intrinsics.hfov_deg,
            "vfov_deg": intrinsics.vfov_deg,
        },
        "frames_written": frames_written,
        "duration_s": args.duration,
        "fps": args.fps,
        "marker_ids_seen": sorted(seen_ids),
        "per_frame": per_frame_log[:120],  # cap to keep the report small
    }
    (args.out / "live_camera_aruco_report.json").write_text(
        json.dumps(report, indent=2)
    )
    print(
        f"[live] {frames_written} frames written to "
        f"{args.out / 'live_camera_aruco.mp4'}"
    )
    print(f"[live] markers seen across run: {sorted(seen_ids)}")
    return 0 if seen_ids else 2


if __name__ == "__main__":
    sys.exit(main())
