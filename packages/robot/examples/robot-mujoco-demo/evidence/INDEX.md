# Visual evidence — Eliza ↔ AiNex (MuJoCo emulator + live Obsbot)

This directory has artifacts produced by running:

```bash
PYTHONPATH=packages/robot python packages/robot/scripts/evidence_turn_180.py
PYTHONPATH=packages/robot python packages/robot/scripts/evidence_aruco_localize.py
PYTHONPATH=packages/robot python packages/robot/scripts/evidence_actions_sweep.py
PYTHONPATH=packages/robot python packages/robot/scripts/evidence_live_camera_aruco.py
```

The unified bridge protocol is exercised end-to-end against:

- **MuJoCo emulator** — DemoEnv + Bezier gait + keyframe action library
- **Live Obsbot Tiny SE** on `/dev/video4` — real pixels, real ArUco markers
  on the floor

## 1. 180° turn (`./`)

| Artifact | Meaning |
| --- | --- |
| `before.png` | First `camera.snapshot` from the AiNex head camera, robot facing +X. |
| `after.png`  | Second `camera.snapshot` after walking with `walk.set(yaw=-8.0)` for 2.5 s. |
| `diff.png`   | `|after - before| * 4` to highlight the per-pixel delta. |
| `report.json` | Ground-truth yaw delta, mean pixel diff, % pixels changed. |
| `trace.jsonl` | Every command/response envelope that crossed the bridge. |

Latest run (`report.json`):
- Commanded **-8.0 rad/s yaw for 2.5 s**.
- Ground-truth yaw rotated from **0.00°** → **-148.80°** (Δ = -148.80°).
- Mean pixel diff: **45.22 / 255**.
- Pixels changed (>8 intensity): **99.99%**.
- **PASS** (motion detected both kinematically and visually).

## 2. ArUco localization on rendered scene (`./`)

| Artifact | Meaning |
| --- | --- |
| `aruco_scene.png` | A real MuJoCo render of the head camera with two ArUco markers (IDs 2 and 3 from `demo_aruco.yaml`) composited at known pixel locations. |
| `aruco_annotated.png` | Same frame with `cv2.aruco.drawDetectedMarkers` + `cv2.drawFrameAxes` overlays drawn at the recovered 6-DoF pose. |
| `aruco_report.json` | Per-marker `tvec`, `rvec`, `distance`, `confidence`. |

Both markers detected, pose recovered at ~0.26 m distance.

## 3. All-actions MuJoCo sweep (`sweep/`)

| Artifact | Meaning |
| --- | --- |
| `actions_sweep.mp4` | ~36-second MP4 driving every plugin action through the bridge. Each segment is HUD-labelled with action name + status. |
| `actions_contact_sheet.png` | 5×3 grid: one keyframe per action. |
| `actions_sweep_report.json` | Per-action duration + per-command response status. |
| `trace.jsonl` | All envelopes from the sweep. |

Coverage (latest `actions_sweep_report.json`) — **15 / 15 actions returned ok**:

| # | Action | Bridge commands | Result |
| --- | --- | --- | --- |
| 1 | AINEX_STAND          | action.play(stand) | OK |
| 2 | AINEX_WALK_FORWARD   | walk.set(x=0.04) + walk.command:start | OK |
| 3 | AINEX_WALK_BACKWARD  | walk.set(x=-0.03) + walk.command:start | OK |
| 4 | AINEX_SIDE_STEP_LEFT | walk.set(y=0.03) + walk.command:start | OK |
| 5 | AINEX_SIDE_STEP_RIGHT | walk.set(y=-0.03) + walk.command:start | OK |
| 6 | AINEX_TURN_LEFT      | walk.set(yaw=8) + walk.command:start | OK |
| 7 | AINEX_TURN_RIGHT     | walk.set(yaw=-8) + walk.command:start | OK |
| 8 | AINEX_STOP           | walk.command:stop (preempt) | OK |
| 9 | AINEX_SIT            | action.play(sit) | OK |
| 10 | AINEX_WAVE          | action.play(wave) | OK |
| 11 | AINEX_BOW           | action.play(bow) | OK |
| 12 | AINEX_PICK_UP       | policy.start(task=pick_up) | OK |
| 13 | AINEX_PLACE_DOWN    | policy.start(task=place_down) | OK |
| 14 | AINEX_SET_SERVO     | servo.set(positions=[head_pan, head_tilt]) | OK |
| 15 | AINEX_RUN_ACTION_GROUP | action.play(wave) | OK |

The MuJoCo backend now interpolates the profile's `action.groups` keyframes,
runs the Bezier gait controller in a background asyncio task while
`walk.command:start` is active, and animates `servo.set` over the
requested duration — so each action produces **real joint motion** in
the rendered video, not just a protocol acknowledgement.

## 4. Live Obsbot camera + ArUco (`live/`)

Recorded against the **physical Obsbot Tiny SE** at `/dev/video4`,
1920×1080 MJPG, ~15 fps.

| Artifact | Meaning |
| --- | --- |
| `live_camera_aruco.mp4` | Live camera feed with detected ArUco overlay + pose axes. |
| `live_camera_aruco_annotated.png` | Single annotated frame (downsized). |
| `live_camera_frame.png` | Raw frame (downsized). |
| `live_camera_aruco_contact_sheet.png` | 4×3 sample grid from the video. |
| `live_camera_aruco_report.json` | Per-frame detections + camera intrinsics. |

Latest run:
- Device: `/dev/video4` (Obsbot Tiny SE), 1920×1080.
- Markers seen: **[3]** (Ground +X from `demo_aruco.yaml`).
- 68 frames recorded, ~4.5 s.
- Detector identical to the one used on MuJoCo renders — same `ArucoDetector`,
  same `CameraIntrinsics`, same pose math. Only the pixel source differs.

## 5. Real-robot status (not verified)

Smoke check (`scripts/check_real_robot.py`) was run against ports 9090,
9100, and 9101 on this host — **all closed**. The AiNex bridge is not
listening. To verify motor commands on hardware:

1. Power the AiNex Pi, launch `roslaunch ainex_bringup robot.launch`.
2. From the dev box: `python -m eliza_robot.bridge.launch --target real --envelope`.
3. Re-run the smoke check: `python packages/robot/scripts/check_real_robot.py
   --url ws://<robot-ip>:9100 --save-frame /tmp/robot_first_frame.png`.
4. Re-run the action sweep against the same URL (use `--out` to a fresh dir).
5. Re-run the live-camera evidence pointed at `--device 4` for the Obsbot.

Everything the agent → bridge contract relies on is verified in sim. The
remaining unknown is real-motor PD response, which the Bezier gait
controller does NOT yet model accurately for the Hiwonder servos — see
the "Future work" section in the runbook.

## How to reproduce

```bash
cd packages/robot
PYTHONPATH=. JAX_PLATFORMS=cpu .venv/bin/python scripts/evidence_turn_180.py
PYTHONPATH=. JAX_PLATFORMS=cpu .venv/bin/python scripts/evidence_aruco_localize.py
PYTHONPATH=. JAX_PLATFORMS=cpu .venv/bin/python scripts/evidence_actions_sweep.py
PYTHONPATH=. JAX_PLATFORMS=cpu .venv/bin/python scripts/evidence_live_camera_aruco.py
```

The first three need MuJoCo + Pillow installed (in the robot venv already).
The last one needs `/dev/video4` to be a real camera; pass `--device N` if
your Obsbot enumerates elsewhere.
