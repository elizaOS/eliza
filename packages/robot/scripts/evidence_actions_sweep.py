"""Action-sweep evidence — drive every AINEX_* action through the bridge
against the MuJoCo emulator and record an annotated MP4 + contact sheet.

Steps:

  1. Boot a MuJoCo bridge in-process (DemoEnv + Bezier gait + action library).
  2. For each of the 15 plugin actions, send the same bridge command the
     `@elizaos/plugin-ainex` action handler sends (see the plugin source).
  3. Render frames continuously from `DemoEnv.render_ego()` at ~30 Hz,
     overlay the action name + ms-elapsed, and append to the MP4 writer.
  4. Save a contact sheet showing one keyframe per action.
  5. Write a JSON report: per-action duration, response ok, payload sent.

Outputs land in `packages/robot/examples/robot-mujoco-demo/evidence/sweep/`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import socket
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.bridge.server import RuntimeConfig, _handler


@dataclass
class ActionStep:
    label: str  # e.g. "AINEX_WALK_FORWARD"
    commands: list[tuple[str, dict, bool]]  # [(command, payload, preempt), ...]
    hold_s: float  # how long to keep recording after sending commands
    post_stop: bool = False  # if True, send walk.command:stop after hold


# The 15 plugin actions, mirrored from plugins/plugin-ainex/src/actions/.
# Each action sends one or more bridge commands; we record while the robot
# responds, then optionally issue STOP so the next action starts clean.
ACTION_SCRIPT: list[ActionStep] = [
    ActionStep(
        "AINEX_STAND",
        [("action.play", {"name": "stand"}, False)],
        hold_s=1.5,
    ),
    ActionStep(
        "AINEX_WALK_FORWARD",
        [
            ("walk.set", {"speed": 2, "height": 0.036, "x": 0.04, "y": 0.0, "yaw": 0.0}, False),
            ("walk.command", {"action": "start"}, False),
        ],
        hold_s=2.0,
        post_stop=True,
    ),
    ActionStep(
        "AINEX_WALK_BACKWARD",
        [
            ("walk.set", {"speed": 2, "height": 0.036, "x": -0.03, "y": 0.0, "yaw": 0.0}, False),
            ("walk.command", {"action": "start"}, False),
        ],
        hold_s=2.0,
        post_stop=True,
    ),
    ActionStep(
        "AINEX_SIDE_STEP_LEFT",
        [
            ("walk.set", {"speed": 2, "height": 0.036, "x": 0.0, "y": 0.03, "yaw": 0.0}, False),
            ("walk.command", {"action": "start"}, False),
        ],
        hold_s=2.0,
        post_stop=True,
    ),
    ActionStep(
        "AINEX_SIDE_STEP_RIGHT",
        [
            ("walk.set", {"speed": 2, "height": 0.036, "x": 0.0, "y": -0.03, "yaw": 0.0}, False),
            ("walk.command", {"action": "start"}, False),
        ],
        hold_s=2.0,
        post_stop=True,
    ),
    ActionStep(
        "AINEX_TURN_LEFT",
        [
            ("walk.set", {"speed": 2, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": 8.0}, False),
            ("walk.command", {"action": "start"}, False),
        ],
        hold_s=2.0,
        post_stop=True,
    ),
    ActionStep(
        "AINEX_TURN_RIGHT",
        [
            ("walk.set", {"speed": 2, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": -8.0}, False),
            ("walk.command", {"action": "start"}, False),
        ],
        hold_s=2.0,
        post_stop=True,
    ),
    ActionStep(
        "AINEX_STOP",
        [("walk.command", {"action": "stop"}, True)],
        hold_s=0.8,
    ),
    ActionStep(
        "AINEX_SIT",
        [("action.play", {"name": "sit"}, False)],
        hold_s=2.0,
    ),
    ActionStep(
        "AINEX_WAVE",
        [("action.play", {"name": "wave"}, False)],
        hold_s=2.2,
    ),
    ActionStep(
        "AINEX_BOW",
        [("action.play", {"name": "bow"}, False)],
        hold_s=2.2,
    ),
    ActionStep(
        "AINEX_PICK_UP",
        [
            (
                "policy.start",
                {
                    "task": "pick_up",
                    "canonical_action": "pick_up",
                    "target_label": "red ball",
                    "target_entity_id": "",
                    "hz": 10,
                    "max_steps": 100,
                },
                False,
            ),
            ("policy.stop", {"reason": "demo_done"}, False),
        ],
        hold_s=1.5,
    ),
    ActionStep(
        "AINEX_PLACE_DOWN",
        [
            (
                "policy.start",
                {
                    "task": "place_down",
                    "canonical_action": "place_down",
                    "target_label": "",
                    "target_entity_id": "",
                    "hz": 10,
                    "max_steps": 100,
                },
                False,
            ),
            ("policy.stop", {"reason": "demo_done"}, False),
        ],
        hold_s=1.5,
    ),
    ActionStep(
        "AINEX_SET_SERVO",
        [
            (
                "servo.set",
                {
                    "duration": 0.5,
                    "positions": [
                        {"id": 13, "position": 700},  # head_pan
                        {"id": 14, "position": 500},  # head_tilt
                    ],
                },
                False,
            ),
        ],
        hold_s=1.5,
    ),
    ActionStep(
        "AINEX_RUN_ACTION_GROUP",
        [("action.play", {"name": "wave"}, False)],
        hold_s=2.2,
    ),
]


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def _send(ws, command: str, payload: dict, preempt: bool) -> dict:
    rid = f"sweep-{command}-{time.time_ns()}"
    envelope = CommandEnvelope(
        request_id=rid,
        timestamp=utc_now_iso(),
        command=command,
        payload=payload,
        preempt=preempt,
    )
    await ws.send(json.dumps(envelope.to_json()))
    for _ in range(120):
        frame = json.loads(await ws.recv())
        if frame.get("type") == "response" and frame.get("request_id") == rid:
            return frame
    raise RuntimeError(f"no response to {command}")


def _label_frame(rgb: np.ndarray, label: str, status: str) -> np.ndarray:
    """Convert RGB → BGR for writing, draw HUD, return BGR frame."""
    bgr = rgb[:, :, ::-1].copy()
    h, w = bgr.shape[:2]
    # Bottom banner
    overlay = bgr.copy()
    cv2.rectangle(overlay, (0, h - 70), (w, h), (0, 0, 0), -1)
    bgr = cv2.addWeighted(overlay, 0.55, bgr, 0.45, 0)
    cv2.putText(
        bgr, label, (16, h - 36),
        cv2.FONT_HERSHEY_SIMPLEX, 0.85, (255, 255, 255), 2,
    )
    cv2.putText(
        bgr, status, (16, h - 12),
        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (180, 230, 180), 1,
    )
    return bgr


async def _run(out_dir: Path, fps: float) -> int:
    from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
    from eliza_robot.sim.mujoco.demo_env import DemoEnv

    out_dir.mkdir(parents=True, exist_ok=True)
    port = _free_port()
    config = RuntimeConfig(
        queue_size=64,
        max_commands_per_sec=200,
        deadman_timeout_sec=60.0,
        trace_log_path=str(out_dir / "trace.jsonl"),
    )

    env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    backend = MuJocoBackend(env)
    factory = lambda: backend

    async def handler(ws) -> None:
        await _handler(ws, factory, config)

    server = await serve(handler, "127.0.0.1", port)
    serve_task = asyncio.create_task(server.serve_forever())
    await asyncio.sleep(0.15)

    # Use the auto-tracking external camera so the recording shows the
    # robot moving, not what the robot sees.
    render_w, render_h = 1280, 720
    sample = env.render_external(width=render_w, height=render_h)
    h, w = sample.shape[:2]
    print(f"[sweep] bridge listening, third-person render {w}x{h}")

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(
        str(out_dir / "actions_sweep.mp4"),
        fourcc, fps, (w, h),
    )
    assert writer.isOpened(), "VideoWriter failed to open"

    keyframes: list[tuple[str, np.ndarray]] = []
    report: list[dict] = []

    try:
        async with connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.recv()  # session.hello

            for step in ACTION_SCRIPT:
                t0 = time.time()
                status = "→ sending"
                responses: list[dict] = []
                for cmd, payload, preempt in step.commands:
                    response = await _send(ws, cmd, payload, preempt)
                    responses.append({
                        "command": cmd,
                        "ok": bool(response["ok"]),
                        "message": response.get("message"),
                    })
                    if not response["ok"]:
                        status = f"FAIL: {response['message']}"
                        break
                else:
                    status = "ok — observing motion"

                # Record `hold_s` seconds of rendered frames at `fps` Hz.
                frame_interval = 1.0 / fps
                t_hold_start = time.time()
                first_frame = None
                while (time.time() - t_hold_start) < step.hold_s:
                    rgb = env.render_external(width=render_w, height=render_h)
                    ms = int((time.time() - t0) * 1000)
                    labelled = _label_frame(
                        rgb, step.label, f"{status}    t+{ms} ms"
                    )
                    if first_frame is None:
                        first_frame = labelled
                    writer.write(labelled)
                    await asyncio.sleep(frame_interval * 0.5)

                if first_frame is not None:
                    keyframes.append((step.label, first_frame))

                # Optional post-stop to clear walking state.
                if step.post_stop:
                    await _send(ws, "walk.command", {"action": "stop"}, True)
                    # short tail to capture the deceleration
                    for _ in range(int(0.4 * fps)):
                        rgb = env.render_external(width=render_w, height=render_h)
                        writer.write(_label_frame(rgb, step.label, "post-stop"))
                        await asyncio.sleep(frame_interval * 0.5)

                step_dt = time.time() - t0
                report.append({
                    "label": step.label,
                    "duration_s": round(step_dt, 3),
                    "responses": responses,
                    "post_stop": step.post_stop,
                })
                print(
                    f"[sweep] {step.label:28s} | "
                    f"{step_dt:0.2f}s | "
                    f"{'OK' if all(r['ok'] for r in responses) else 'FAIL'}"
                )

        writer.release()

        # Contact sheet: one frame per action, 5x3 grid.
        if keyframes:
            cell_w, cell_h = 320, 240
            cols = 5
            rows = (len(keyframes) + cols - 1) // cols
            sheet = np.full((rows * cell_h, cols * cell_w, 3), 30, dtype=np.uint8)
            for i, (_, frame) in enumerate(keyframes):
                cell = cv2.resize(frame, (cell_w, cell_h))
                r, c = divmod(i, cols)
                sheet[r * cell_h : (r + 1) * cell_h, c * cell_w : (c + 1) * cell_w] = cell
            cv2.imwrite(str(out_dir / "actions_contact_sheet.png"), sheet)
            print(f"[sweep] wrote {out_dir / 'actions_contact_sheet.png'}")

        (out_dir / "actions_sweep_report.json").write_text(
            json.dumps({"actions": report, "render_size": [w, h], "fps": fps}, indent=2)
        )
        print(f"[sweep] wrote {out_dir / 'actions_sweep_report.json'}")

        # All actions returned ok at least once?
        all_ok = all(all(r["ok"] for r in step["responses"]) for step in report)
        return 0 if all_ok else 2
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
        / "evidence"
        / "sweep",
    )
    parser.add_argument("--fps", type=float, default=30.0)
    args = parser.parse_args()
    return asyncio.run(_run(args.out, args.fps))


if __name__ == "__main__":
    sys.exit(main())
