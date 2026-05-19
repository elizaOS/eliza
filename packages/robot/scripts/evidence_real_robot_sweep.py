"""Drive the physical AiNex (over rosbridge_suite) through every plugin
action while continuously recording from the external Obsbot camera.

What you get in `--out`:
  - real_robot_sweep.mp4              external Obsbot, full sequence, action-labelled
  - real_robot_sweep_robot_cam.mp4    onboard /camera/image_raw, same sequence
  - real_robot_contact_sheet.png      one keyframe per action (external view)
  - real_robot_sweep_report.json      per-action telemetry deltas + response status
  - real_robot_sweep_trace.jsonl      every command/response that crossed the bridge

Safety:
  - Defaults to head + scripted-action subset (no walking) — those are
    proven-stable on the AiNex without supervision.
  - Pass `--include-locomotion` to also exercise the walk / turn / step
    actions. THESE MAKE A BIPED MOVE; the script always finishes with
    an explicit walk.command:stop and `stand` action group.

Outputs end up in
`packages/robot/examples/robot-mujoco-demo/evidence/real/` by default.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from eliza_robot.bridge.backends.ainex_remote import AinexRemoteBackend
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso


@dataclass
class ActionStep:
    label: str
    commands: list[tuple[str, dict]]
    hold_s: float
    locomotion: bool = False  # if True, only run with --include-locomotion
    post_stop: bool = False


# Subset mirrors `evidence_actions_sweep.py` so the contact sheets line up.
ACTION_SCRIPT: list[ActionStep] = [
    ActionStep("AINEX_STAND", [("action.play", {"name": "stand"})], hold_s=1.5),
    ActionStep("AINEX_HEAD_PAN_LEFT", [("head.set", {"pan": 0.8, "tilt": 0.0, "duration": 0.5})], hold_s=1.2),
    ActionStep("AINEX_HEAD_PAN_RIGHT", [("head.set", {"pan": -0.8, "tilt": 0.0, "duration": 0.5})], hold_s=1.2),
    ActionStep("AINEX_HEAD_CENTER", [("head.set", {"pan": 0.0, "tilt": 0.0, "duration": 0.4})], hold_s=0.8),
    ActionStep("AINEX_WAVE", [("action.play", {"name": "wave"})], hold_s=3.0),
    ActionStep("AINEX_BOW", [("action.play", {"name": "bow"})], hold_s=3.0),
    ActionStep("AINEX_SIT", [("action.play", {"name": "sit"})], hold_s=3.0),
    ActionStep("AINEX_STAND_RECOVER", [("action.play", {"name": "stand"})], hold_s=2.0),
    # locomotion subset — guarded by --include-locomotion
    ActionStep(
        "AINEX_WALK_FORWARD",
        [
            ("walk.set", {"speed": 1, "height": 0.036, "x": 0.02, "y": 0.0, "yaw": 0.0}),
            ("walk.command", {"action": "start"}),
        ],
        hold_s=2.0,
        locomotion=True,
        post_stop=True,
    ),
    ActionStep(
        "AINEX_TURN_LEFT",
        [
            ("walk.set", {"speed": 1, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": 4.0}),
            ("walk.command", {"action": "start"}),
        ],
        hold_s=2.0,
        locomotion=True,
        post_stop=True,
    ),
    ActionStep(
        "AINEX_TURN_RIGHT",
        [
            ("walk.set", {"speed": 1, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": -4.0}),
            ("walk.command", {"action": "start"}),
        ],
        hold_s=2.0,
        locomotion=True,
        post_stop=True,
    ),
    ActionStep("AINEX_STOP", [("walk.command", {"action": "stop"})], hold_s=0.5),
    ActionStep(
        "AINEX_SET_SERVO",
        [
            (
                "servo.set",
                {
                    "duration": 0.5,
                    "positions": [
                        {"id": 23, "position": 600},  # head_pan
                        {"id": 24, "position": 500},  # head_tilt
                    ],
                },
            )
        ],
        hold_s=1.2,
    ),
    ActionStep(
        "AINEX_RUN_ACTION_GROUP",
        [("action.play", {"name": "wave"})],
        hold_s=3.0,
    ),
    # Always finish standing.
    ActionStep("AINEX_FINAL_STAND", [("action.play", {"name": "stand"})], hold_s=2.0),
]


def _label(frame_bgr: np.ndarray, top: str, bottom: str) -> np.ndarray:
    out = frame_bgr.copy()
    h, w = out.shape[:2]
    overlay = out.copy()
    cv2.rectangle(overlay, (0, h - 70), (w, h), (0, 0, 0), -1)
    out = cv2.addWeighted(overlay, 0.55, out, 0.45, 0)
    cv2.putText(out, top, (16, h - 36), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (255, 255, 255), 2)
    cv2.putText(out, bottom, (16, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (180, 230, 180), 1)
    return out


async def _run(
    host: str,
    port: int,
    obsbot_device: int,
    out_dir: Path,
    fps: float,
    include_locomotion: bool,
) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[real] connecting to ws://{host}:{port}...")
    backend = AinexRemoteBackend(host=host, port=port)
    await backend.connect()
    print("[real] connected")
    # let telemetry warm up
    await asyncio.sleep(1.5)

    # Try to open the Obsbot. If absent or refused, we record only the
    # robot's onboard camera (which we always get over rosbridge).
    obsbot: cv2.VideoCapture | None = None
    obs_w = obs_h = 0
    first_frame: np.ndarray | None = None
    if obsbot_device >= 0:
        cap = cv2.VideoCapture(obsbot_device, cv2.CAP_V4L2)
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        cap.set(cv2.CAP_PROP_FPS, 30)
        for _ in range(20):
            ok, frame = cap.read()
            if ok and frame is not None and frame.size > 0:
                first_frame = frame
                break
            await asyncio.sleep(0.05)
        if first_frame is None:
            cap.release()
            print(
                f"[real] Obsbot at /dev/video{obsbot_device} did not produce a "
                f"frame — recording only the robot's onboard camera"
            )
        else:
            obsbot = cap
            obs_h, obs_w = first_frame.shape[:2]
            print(
                f"[real] Obsbot @ /dev/video{obsbot_device} -> {obs_w}x{obs_h}"
            )

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    ext_writer: cv2.VideoWriter | None = None
    if obsbot is not None:
        ext_writer = cv2.VideoWriter(
            str(out_dir / "real_robot_sweep.mp4"), fourcc, fps, (obs_w, obs_h)
        )
    # Always record the onboard camera. Default 640x480; allow it to vary.
    onboard_writer: cv2.VideoWriter | None = None
    onboard_size: tuple[int, int] | None = None

    trace_path = out_dir / "real_robot_sweep_trace.jsonl"
    trace_fh = trace_path.open("w")

    async def _send(command: str, payload: dict) -> dict:
        rid = f"real-{command}-{time.time_ns()}"
        env = CommandEnvelope(
            request_id=rid,
            timestamp=utc_now_iso(),
            command=command,
            payload=payload,
        )
        response = await backend.handle_command(env)
        trace_fh.write(
            json.dumps(
                {
                    "command": command,
                    "payload": payload,
                    "ok": response.ok,
                    "message": response.message,
                    "data": response.data,
                    "ts": time.time(),
                }
            )
            + "\n"
        )
        trace_fh.flush()
        return {"ok": response.ok, "message": response.message, "data": response.data}

    keyframes: list[tuple[str, np.ndarray]] = []
    per_action: list[dict] = []

    try:
        for step in ACTION_SCRIPT:
            if step.locomotion and not include_locomotion:
                print(f"[real] SKIP (locomotion guard): {step.label}")
                per_action.append(
                    {"label": step.label, "skipped": True, "reason": "locomotion-not-enabled"}
                )
                continue

            t0 = time.time()
            telemetry_before = (await backend.poll_events())[0].data

            print(f"[real] >>> {step.label}")
            cmd_results = []
            for cmd, payload in step.commands:
                result = await _send(cmd, payload)
                cmd_results.append({"cmd": cmd, "payload": payload, **result})
                if not result["ok"]:
                    print(f"[real]   FAIL {cmd}: {result['message']}")
                    break

            # Record `hold_s` seconds of synchronized frames.
            t_hold_start = time.time()
            first_ext = None
            first_onboard = None
            while (time.time() - t_hold_start) < step.hold_s:
                ms = int((time.time() - t0) * 1000)
                if obsbot is not None and ext_writer is not None:
                    ok, ext = obsbot.read()
                    if ok and ext is not None:
                        lab = _label(
                            ext, step.label,
                            f"real AiNex @ {host}:{port}    t+{ms} ms",
                        )
                        if first_ext is None:
                            first_ext = lab
                        ext_writer.write(lab)
                onboard = backend.snapshot_camera("head")
                if onboard is not None:
                    if onboard_writer is None:
                        onboard_size = (onboard.shape[1], onboard.shape[0])
                        onboard_writer = cv2.VideoWriter(
                            str(out_dir / "real_robot_sweep_robot_cam.mp4"),
                            fourcc, fps, onboard_size,
                        )
                    elif (onboard.shape[1], onboard.shape[0]) != onboard_size:
                        onboard = cv2.resize(onboard, onboard_size)
                    onboard_bgr = onboard[:, :, ::-1].copy()
                    onboard_lab = _label(
                        onboard_bgr,
                        f"{step.label}  [robot cam]",
                        f"real AiNex onboard    t+{ms} ms",
                    )
                    onboard_writer.write(onboard_lab)
                    if first_onboard is None:
                        first_onboard = onboard_lab

                await asyncio.sleep(max(0.0, 1.0 / fps - 0.005))

            # Post-stop for walking actions.
            if step.post_stop:
                await _send("walk.command", {"action": "stop"})
                for _ in range(int(0.6 * fps)):
                    if obsbot is not None and ext_writer is not None:
                        ok, ext = obsbot.read()
                        if ok and ext is not None:
                            ext_writer.write(
                                _label(ext, step.label, "post-stop")
                            )
                    onboard = backend.snapshot_camera("head")
                    if onboard is not None and onboard_writer is not None and onboard_size is not None:
                        if (onboard.shape[1], onboard.shape[0]) != onboard_size:
                            onboard = cv2.resize(onboard, onboard_size)
                        onboard_writer.write(
                            _label(onboard[:, :, ::-1].copy(), step.label, "post-stop")
                        )
                    await asyncio.sleep(0.04)

            telemetry_after = (await backend.poll_events())[0].data
            per_action.append({
                "label": step.label,
                "duration_s": round(time.time() - t0, 3),
                "commands": cmd_results,
                "telemetry_before": telemetry_before,
                "telemetry_after": telemetry_after,
            })
            keyframe = first_ext if first_ext is not None else first_onboard
            if keyframe is not None:
                keyframes.append((step.label, keyframe))
            print(
                f"[real]     done in {time.time() - t0:0.2f}s | "
                f"battery {telemetry_after.get('battery_mv')}mV | "
                f"walking={telemetry_after.get('is_walking')}"
            )
    finally:
        # Always stop walking + return to stand before we exit.
        try:
            await _send("walk.command", {"action": "stop"})
            await _send("action.play", {"name": "stand"})
        except Exception:
            pass
        if ext_writer is not None:
            ext_writer.release()
        if onboard_writer is not None:
            onboard_writer.release()
        if obsbot is not None:
            obsbot.release()
        trace_fh.close()
        await backend.shutdown()

    # Contact sheet (5x3) — same shape as the sim sweep.
    if keyframes:
        cell_w, cell_h = 320, 180
        cols = 5
        rows = (len(keyframes) + cols - 1) // cols
        sheet = np.full((rows * cell_h, cols * cell_w, 3), 30, dtype=np.uint8)
        for i, (_, frame) in enumerate(keyframes):
            cell = cv2.resize(frame, (cell_w, cell_h))
            r, c = divmod(i, cols)
            sheet[r * cell_h : (r + 1) * cell_h, c * cell_w : (c + 1) * cell_w] = cell
        cv2.imwrite(str(out_dir / "real_robot_contact_sheet.png"), sheet)
        print(f"[real] wrote {out_dir / 'real_robot_contact_sheet.png'}")

    (out_dir / "real_robot_sweep_report.json").write_text(
        json.dumps(
            {
                "host": f"{host}:{port}",
                "obsbot_device": f"/dev/video{obsbot_device}",
                "include_locomotion": include_locomotion,
                "fps": fps,
                "external_size": [obs_w, obs_h],
                "actions": per_action,
            },
            indent=2,
        )
    )
    print(f"[real] wrote {out_dir / 'real_robot_sweep_report.json'}")

    ok_count = sum(
        1 for a in per_action
        if not a.get("skipped") and all(c.get("ok") for c in a.get("commands", []))
    )
    run_count = sum(1 for a in per_action if not a.get("skipped"))
    print(f"[real] {ok_count}/{run_count} actions returned ok")
    return 0 if ok_count == run_count else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--obsbot-device", type=int, default=4)
    parser.add_argument("--fps", type=float, default=15.0)
    parser.add_argument(
        "--include-locomotion",
        action="store_true",
        help="also send walk/turn commands (robot must be on a clear surface)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "examples"
        / "robot-mujoco-demo"
        / "evidence"
        / "real",
    )
    args = parser.parse_args()
    return asyncio.run(
        _run(
            args.host, args.port, args.obsbot_device,
            args.out, args.fps, args.include_locomotion,
        )
    )


if __name__ == "__main__":
    sys.exit(main())
