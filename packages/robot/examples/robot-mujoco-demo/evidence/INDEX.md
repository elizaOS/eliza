# Visual evidence — Eliza ↔ MuJoCo AiNex

This directory holds artifacts produced by running:

```
PYTHONPATH=packages/robot python packages/robot/scripts/evidence_turn_180.py
PYTHONPATH=packages/robot python packages/robot/scripts/evidence_aruco_localize.py
```

Both scripts run the **unified bridge protocol** end-to-end:

```
client ─ ws ─→ bridge server ─→ MuJocoBackend ─→ DemoEnv (mj_step + render_ego) ─→ pixels back across the wire
```

## 180° turn verification — `evidence_turn_180.py`

| Artifact | Meaning |
| --- | --- |
| `before.png` | First `camera.snapshot` from the AiNex head camera, robot facing +X. |
| `after.png`  | Second `camera.snapshot` after walking with `walk.set(yaw=-8.0)` for 2.5 s. |
| `diff.png`   | `|after - before| * 4`, clipped to [0,255], to highlight the per-pixel delta. |
| `report.json` | Yaw delta (ground-truth from `DemoEnv.get_robot_yaw()`), mean pixel diff, % of pixels changed. |
| `trace.jsonl` | All command/response envelopes that crossed the websocket for the run. |

Latest run summary (from `report.json`):

- Commanded yaw rate: **-8.0 rad/s** for **2.5 s**.
- Ground-truth yaw rotated from **0.00°** to **-154.72°** (Δ = -154.72°).
- Mean pixel diff: **44.93 / 255**.
- Pixels changed (>8 intensity): **99.99%**.
- Verdict: **PASS** (motion detected both kinematically and visually).

The script is a hard pass/fail: it returns non-zero if the mean pixel diff
< 1.0 or if the yaw delta is < 30°. That's the gate the real-robot variant
must clear too — same script, just point `--url` at the `ros_real` bridge.

## ArUco localization — `evidence_aruco_localize.py`

| Artifact | Meaning |
| --- | --- |
| `aruco_scene.png` | A real MuJoCo render of the head camera with two ArUco markers (IDs 2 and 3 from `demo_aruco.yaml`) composited at known pixel locations. |
| `aruco_annotated.png` | Same frame with `cv2.aruco.drawDetectedMarkers` + `cv2.drawFrameAxes` overlays drawn at the recovered 6-DoF pose. |
| `aruco_report.json` | Per-marker `tvec` (translation, meters), `rvec` (Rodrigues), `distance`, and `confidence`. |

This is the integration counterpart to the synthetic-only
`tests/perception/test_aruco_e2e.py`. The detector + pose-estimation
math is byte-identical to what would run on a real Obsbot frame; only
the source of the pixels changes (MuJoCo render vs. v4l2 device).

## How to reproduce

```bash
# from repo root
cd packages/robot
PYTHONPATH=. JAX_PLATFORMS=cpu .venv/bin/python scripts/evidence_turn_180.py \
    --yaw-rate -8.0 --duration 2.5
PYTHONPATH=. JAX_PLATFORMS=cpu .venv/bin/python scripts/evidence_aruco_localize.py
```

Re-running the scripts overwrites the PNGs in this directory.

## What this does NOT prove

- The physical AiNex robot behaviour. The MuJoCo `DemoEnv` is an emulator;
  the real motor PD response, gait stability, and camera characteristics
  differ. The runbook in `../README.md` lists the matching steps to run
  against the `ros_real` target.
- That the Obsbot camera works at any specific device index. The bridge's
  `--camera-device` flag wires `OpenCVSource` for `camera.snapshot` calls
  with `camera=external`; the user needs to confirm `/dev/video*`
  enumeration on their host.
