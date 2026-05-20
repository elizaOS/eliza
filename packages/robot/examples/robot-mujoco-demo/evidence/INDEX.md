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
- Markers seen across the run: **[0, 1, 3, 4]** — four distinct IDs from
  `demo_aruco.yaml` (Robot Body, Robot Head, Ground +X, Ground +X +Y).
- 104 frames recorded, ~12 s at 12 fps.
- Detector identical to the one used on MuJoCo renders — same `ArucoDetector`,
  same `CameraIntrinsics`, same pose math. Only the pixel source differs.

## 5. Real AiNex action sweep (`real/`)

Driven via `scripts/evidence_real_robot_sweep.py` against the live AiNex
at **`192.168.1.218:9090`** (rosbridge_suite). The `AinexRemoteBackend`
(roslibpy-based, no ROS install required on the dev box) maps every
unified bridge command to the same topics/services `ros_backend.py` uses
with `rospy`.

| Artifact | Meaning |
| --- | --- |
| `real_robot_sweep_robot_cam.mp4` | Live `/camera/image_raw/compressed` feed from the AiNex's head camera, recorded continuously through all 15 actions with HUD overlay. The view pans/tilts/rotates as the robot moves. |
| `real_robot_onboard_strip.png` | Every-30th-frame strip from the onboard video. |
| `real_robot_contact_sheet.png` | One keyframe per action. |
| `real_robot_sweep_report.json` | Per-action telemetry deltas (battery, walking state, IMU, head, walk velocity), command results. |
| `real_robot_sweep_trace.jsonl` | Every command/response that crossed the bridge. |

Latest run: **15/15 actions returned ok**.

| Action | Result | Battery (mV before → after) |
| --- | --- | --- |
| AINEX_STAND          | OK | 12721 → 12689 |
| AINEX_HEAD_PAN_LEFT  | OK | 12689 → 12700 |
| AINEX_HEAD_PAN_RIGHT | OK | 12700 → 12704 |
| AINEX_HEAD_CENTER    | OK | 12704 → 12716 |
| AINEX_WAVE           | OK | 12716 → 12636 |
| AINEX_BOW            | OK | 12636 → 12685 |
| AINEX_SIT            | OK | 12685 → 12704 |
| AINEX_STAND_RECOVER  | OK | 12704 → 12693 |
| AINEX_WALK_FORWARD   | OK | 12693 → 12604 |
| AINEX_TURN_LEFT      | OK | 12604 → 12587 |
| AINEX_TURN_RIGHT     | OK | 12587 → 12604 |
| AINEX_STOP           | OK | 12604 → 12669 |
| AINEX_SET_SERVO      | OK | 12669 → 12704 |
| AINEX_RUN_ACTION_GROUP | OK | 12704 → 12610 |
| AINEX_FINAL_STAND    | OK | 12610 → 12663 |

The **external Obsbot camera disconnected from USB during this run** —
the script skipped the external mp4 and recorded only the onboard view.
Re-plug `/dev/video4` and re-run for a side-view recording.

### Reproduce

```bash
PYTHONPATH=packages/robot python packages/robot/scripts/evidence_real_robot_sweep.py \
  --host 192.168.1.218 --port 9090 --include-locomotion --obsbot-device 4
```

Drop `--include-locomotion` to skip walks/turns (safe default for first
contact). Pass `--obsbot-device -1` to record only the onboard camera.

---

To verify against a different AiNex / topology:

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
