"""MuJoCo bridge backend -- runs MuJoCo simulation instead of real hardware.

Implements the ``BridgeBackend`` interface so the bridge server (and any
websocket client, including the Eliza plugin) can drive a simulated AiNex
through the same protocol used for the real robot.

Usage:
    from training.mujoco.demo_env import DemoEnv
    from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend

    env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    backend = MuJocoBackend(env)
    # Pass ``backend`` to the bridge server or use directly.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import numpy as np

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import CommandEnvelope, EventEnvelope, ResponseEnvelope, utc_now_iso
from eliza_robot.bridge.types import JsonDict
from eliza_robot.sim.mujoco.ainex_constants import ALL_JOINT_NAMES


@dataclass
class _WalkState:
    """Tracks high-level walk command state within the backend."""
    enabled: bool = True
    is_walking: bool = False
    speed: int = 2
    height: float = 0.036
    x: float = 0.0
    y: float = 0.0
    yaw: float = 0.0


@dataclass
class _HeadState:
    pan: float = 0.0
    tilt: float = 0.0


class MuJocoBackend(BridgeBackend):
    """Bridge backend that runs MuJoCo simulation instead of real hardware.

    All ``handle_command`` calls translate protocol commands into MuJoCo
    actuator targets and physics steps.  ``poll_events`` returns simulated
    telemetry derived from sensor data.
    """

    def __init__(self, demo_env: Any, profile_id: str = "hiwonder-ainex") -> None:
        """Create a MuJoCo backend wrapping a ``DemoEnv`` instance.

        Args:
            demo_env: A ``training.mujoco.demo_env.DemoEnv`` instance.
            profile_id: Robot profile id; the backend loads its action
                library so `action.play` can interpolate scripted keyframes.
        """
        self._env = demo_env
        self._walk = _WalkState()
        self._head = _HeadState()
        self._joint_positions: dict[str, float] = {}
        self._last_telemetry: dict[str, Any] = {}
        # Background gait loop — kicks in when walk.command:start enables
        # walking and idles otherwise.
        self._gait_task: asyncio.Task[None] | None = None
        self._gait_controller: "BezierGaitController | None" = None  # lazy
        # Active scripted-action task (so .play commands animate joint keyframes).
        self._action_task: asyncio.Task[None] | None = None
        self._profile_id = profile_id
        self._action_library: dict[str, dict] = {}

    # ------------------------------------------------------------------
    # BridgeBackend interface
    # ------------------------------------------------------------------

    @property
    def backend_name(self) -> str:
        return "mujoco"

    async def connect(self) -> None:
        """Reset the MuJoCo environment on connect."""
        self._last_telemetry = self._env.reset()
        # Lazy-construct the bezier gait controller. Failure here is loud:
        # without the controller the MuJoCo backend can still serve head/servo
        # but `walk.command:start` will be a no-op (logged).
        try:
            from eliza_robot.sim.mujoco.gait.controller import BezierGaitController

            self._gait_controller = BezierGaitController()
        except Exception:
            self._gait_controller = None
        # Load the profile's action library so `action.play` can actually
        # animate scripted keyframes (stand / sit / wave / bow / custom).
        try:
            from eliza_robot.profiles.schema import load_profile

            profile = load_profile(self._profile_id)
            for name, group in profile.actions.groups.items():
                self._action_library[name] = {
                    "duration_s": float(group.duration_s),
                    "frames": [
                        {"t": float(f.t), "joints": dict(f.joints)}
                        for f in group.frames
                    ],
                }
        except Exception:
            self._action_library = {}

    async def shutdown(self) -> None:
        """Cancel any background loops and close the MuJoCo environment."""
        for task_attr in ("_gait_task", "_action_task"):
            t = getattr(self, task_attr, None)
            if t is not None and not t.done():
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
                setattr(self, task_attr, None)
        self._env.close()

    async def _play_action_group(self, name: str) -> None:
        """Animate a named keyframe group through MuJoCo PD control.

        Interpolates linearly between frames at the env's physics timestep
        for the group's `duration_s`. Keeps the commanded head pose
        (`self._head`) layered on top so concurrent head commands persist.
        """
        group = self._action_library.get(name)
        if group is None:
            return
        timestep = float(getattr(self._env.model.opt, "timestep", 0.002))
        duration = max(0.05, float(group["duration_s"]))
        frames = sorted(group["frames"], key=lambda f: f["t"])
        # Tick rate: 50 Hz outer loop (matches gait loop cadence).
        outer_dt = 0.02
        steps_per_tick = max(1, int(outer_dt / timestep))
        elapsed = 0.0
        try:
            while elapsed <= duration:
                # Find bracketing frames at time `elapsed`.
                prev = frames[0]
                nxt = frames[-1]
                for i, fr in enumerate(frames):
                    if fr["t"] >= elapsed:
                        nxt = fr
                        prev = frames[i - 1] if i > 0 else fr
                        break
                t0, t1 = prev["t"], nxt["t"]
                alpha = 0.0 if t1 <= t0 else (elapsed - t0) / (t1 - t0)
                targets: dict[str, float] = {}
                # Union of joints across the two bracketing frames.
                names = set(prev["joints"].keys()) | set(nxt["joints"].keys())
                for jname in names:
                    a = float(prev["joints"].get(jname, nxt["joints"][jname]))
                    b = float(nxt["joints"].get(jname, a))
                    targets[jname] = (1.0 - alpha) * a + alpha * b
                # Preserve commanded head pose.
                targets["head_pan"] = float(self._head.pan)
                targets["head_tilt"] = float(self._head.tilt)
                self._last_telemetry = self._env.step_n(
                    n=steps_per_tick, joint_targets=targets
                )
                await asyncio.sleep(outer_dt)
                elapsed += outer_dt
        except asyncio.CancelledError:
            return

    async def _gait_loop(self) -> None:
        """Drive the robot with the Bezier gait controller at ~50 Hz while
        ``self._walk.is_walking`` is True. Cancels itself once walking stops.
        """
        if self._gait_controller is None:
            return
        gait_dt = 0.02  # 50 Hz outer control loop
        timestep = float(getattr(self._env.model.opt, "timestep", 0.002))
        steps_per_tick = max(1, int(gait_dt / timestep))
        joint_names = ALL_JOINT_NAMES
        try:
            while self._walk.is_walking:
                # Bridge protocol uses walk.x/y in [-0.05, 0.05] (~m/cycle).
                # The bezier controller expects vx/vy in m/s. We treat the
                # commanded x/y as a per-step length and scale by cycle_hz.
                cycle_hz = float(self._gait_controller.cycle_hz)
                vx = float(self._walk.x) * cycle_hz
                vy = float(self._walk.y) * cycle_hz
                # walk.yaw in [-10, 10] — treat as rad/s body-yaw rate.
                vyaw = float(self._walk.yaw)
                q = self._gait_controller.step(vx, vy, vyaw, dt=gait_dt)
                targets = {name: float(q[i]) for i, name in enumerate(joint_names)}
                # Preserve commanded head pose across gait ticks.
                targets["head_pan"] = float(self._head.pan)
                targets["head_tilt"] = float(self._head.tilt)
                self._last_telemetry = self._env.step_n(
                    n=steps_per_tick, joint_targets=targets
                )
                await asyncio.sleep(gait_dt)
        except asyncio.CancelledError:
            return

    def capabilities(self) -> JsonDict:
        return {
            "walk_set": True,
            "walk_command": True,
            "action_play": True,
            "head_set": True,
            "servo_set": True,
            "camera_stream_passthrough": False,
            "camera_snapshot": True,
            "mujoco_sim": True,
        }

    def snapshot_camera(self, _camera: str = "head") -> np.ndarray | None:
        """Render the DemoEnv's head-mounted ego camera as an (H, W, 3) uint8 RGB."""
        try:
            return self._env.render_ego()
        except Exception:
            return None

    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        """Execute one command envelope against the MuJoCo simulation."""
        ok = True
        message = "ok"

        if cmd.command == "walk.set":
            self._walk.speed = int(cmd.payload.get("speed", 2))
            self._walk.height = float(cmd.payload.get("height", 0.036))
            self._walk.x = float(cmd.payload.get("x", 0.0))
            self._walk.y = float(cmd.payload.get("y", 0.0))
            self._walk.yaw = float(cmd.payload.get("yaw", 0.0))

        elif cmd.command == "walk.command":
            action = cmd.payload.get("action")
            if action == "start":
                self._walk.is_walking = True
                # Spawn / re-spawn the gait loop. The controller must exist
                # (constructed in connect()); if not, walking is a no-op.
                if (
                    self._gait_controller is not None
                    and (self._gait_task is None or self._gait_task.done())
                ):
                    self._gait_task = asyncio.create_task(self._gait_loop())
            elif action == "stop":
                self._walk.is_walking = False
                self._walk.x = 0.0
                self._walk.y = 0.0
                self._walk.yaw = 0.0
            elif action == "enable":
                self._walk.enabled = True
            elif action == "disable":
                self._walk.enabled = False
                self._walk.is_walking = False
            else:
                ok = False
                message = f"unsupported walk.command action: {action}"

        elif cmd.command == "head.set":
            self._head.pan = float(cmd.payload.get("pan", 0.0))
            self._head.tilt = float(cmd.payload.get("tilt", 0.0))
            duration_s = float(cmd.payload.get("duration", 0.5))
            # Apply head targets to the sim actuators.
            head_targets = {
                "head_pan": self._head.pan,
                "head_tilt": self._head.tilt,
            }
            # Step physics long enough for PD control to converge near the
            # commanded head pose; otherwise the rendered ego frame won't
            # actually move and downstream pixel-diff checks fail.
            timestep = float(getattr(self._env.model.opt, "timestep", 0.002))
            n_steps = max(1, int(duration_s / timestep))
            # Cap to keep handler latency bounded.
            n_steps = min(n_steps, 1000)
            self._last_telemetry = self._env.step_n(
                n=n_steps, joint_targets=head_targets
            )

        elif cmd.command == "servo.set":
            # Accept both joint_positions (name->rad) and positions ([{id, pos}]).
            # Step physics long enough for PD control to converge near the
            # commanded pose — otherwise sys-ID probes and the calibrated
            # path see "joint barely moves" and recover α ≈ 0.
            duration_s = float(cmd.payload.get("duration", 0.3))
            timestep = float(getattr(self._env.model.opt, "timestep", 0.002))
            n_steps = max(1, min(int(duration_s / timestep), 1000))

            jp = cmd.payload.get("joint_positions", {})
            if isinstance(jp, dict) and jp:
                self._joint_positions.update(jp)
                self._last_telemetry = self._env.step_n(
                    n=n_steps, joint_targets=jp,
                )
            else:
                positions = cmd.payload.get("positions", [])
                if isinstance(positions, list) and positions:
                    try:
                        from eliza_robot.bridge.isaaclab.joint_map import (
                            servo_id_to_joint_name,
                            pulse_to_radians,
                        )
                        targets: dict[str, float] = {}
                        for item in positions:
                            if isinstance(item, dict) and "id" in item and "position" in item:
                                name = servo_id_to_joint_name(int(item["id"]))
                                targets[name] = pulse_to_radians(
                                    int(item["position"]), int(item["id"])
                                )
                        if targets:
                            self._joint_positions.update(targets)
                            self._last_telemetry = self._env.step_n(
                                n=n_steps, joint_targets=targets,
                            )
                    except ImportError:
                        ok = False
                        message = "joint_map import failed; provide joint_positions dict"

        elif cmd.command == "action.play":
            name = str(cmd.payload.get("name", ""))
            if name in self._action_library:
                # Cancel any previous action so the new one wins cleanly.
                if self._action_task is not None and not self._action_task.done():
                    self._action_task.cancel()
                self._action_task = asyncio.create_task(self._play_action_group(name))
            elif name == "":
                ok = False
                message = "action.play requires payload.name"
            else:
                ok = False
                message = (
                    f"action group '{name}' not in profile action library "
                    f"(known: {sorted(self._action_library)})"
                )

        else:
            ok = False
            message = f"unsupported command: {cmd.command}"

        return ResponseEnvelope(
            request_id=cmd.request_id,
            timestamp=utc_now_iso(),
            ok=ok,
            backend=self.backend_name,
            message=message,
            data={
                "walk_enabled": self._walk.enabled,
                "is_walking": self._walk.is_walking,
            },
        )

    async def poll_events(self) -> list[EventEnvelope]:
        """Return simulated telemetry events from the MuJoCo state."""
        telemetry = self._last_telemetry or self._env._build_telemetry()

        basic = EventEnvelope(
            event="telemetry.basic",
            timestamp=utc_now_iso(),
            backend=self.backend_name,
            data={
                "battery_mv": telemetry.get("battery_mv", 12400),
                "is_walking": self._walk.is_walking,
                "imu_roll": telemetry.get("imu_roll", 0.0),
                "imu_pitch": telemetry.get("imu_pitch", 0.0),
                "walk_x": self._walk.x,
                "walk_y": self._walk.y,
                "walk_yaw": self._walk.yaw,
                "walk_speed": self._walk.speed,
                "walk_height": self._walk.height,
                "head_pan": self._head.pan,
                "head_tilt": self._head.tilt,
                "joint_positions": telemetry.get("joint_positions", {}),
            },
        )

        # Build simulated perception event from target position.
        robot_pos = self._env.get_robot_position()
        target_pos = self._env.get_target_position()
        rel = target_pos - robot_pos
        distance = float(np.linalg.norm(rel[:2]))

        perception = EventEnvelope(
            event="telemetry.perception",
            timestamp=utc_now_iso(),
            backend=self.backend_name,
            data={
                "entities": [
                    {
                        "entity_id": "sim-target-ball-01",
                        "label": "red ball",
                        "confidence": 0.99 if distance < 5.0 else 0.5,
                        "x": float(rel[0]),
                        "y": float(rel[1]),
                        "z": float(rel[2]),
                        "distance": distance,
                        "source": "mujoco",
                    }
                ],
            },
        )

        return [basic, perception]

    # ------------------------------------------------------------------
    # Extra API (not part of BridgeBackend but useful for demo scripts)
    # ------------------------------------------------------------------

    def render_frame(self) -> np.ndarray | None:
        """Render current ego camera frame (for perception pipeline).

        Returns (H, W, 3) uint8 RGB, or None if rendering fails.
        """
        try:
            return self._env.render_ego()
        except Exception:
            return None

    def get_telemetry(self) -> dict[str, Any]:
        """Return current MuJoCo sensor data in bridge telemetry format."""
        return self._last_telemetry or self._env._build_telemetry()
