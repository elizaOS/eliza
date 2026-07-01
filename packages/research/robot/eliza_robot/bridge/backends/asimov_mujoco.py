"""ASIMOV-1 MuJoCo command-envelope backend."""

from __future__ import annotations

import time

import numpy as np

from eliza_robot.asimov_1.constants import ASIMOV1_FIRMWARE_JOINT_ORDER, ASIMOV1_GENERATED_MJCF
from eliza_robot.asimov_1.controller import AsimovController
from eliza_robot.asimov_1.mujoco_assets import generate_asimov1_mjcf
from eliza_robot.bridge.backends.asimov_remote import _positions_from_payload
from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import (
    CommandEnvelope,
    EventEnvelope,
    ResponseEnvelope,
    utc_now_iso,
)
from eliza_robot.profiles.schema import load_profile


class AsimovMujocoBackend(BridgeBackend):
    def __init__(self, *, profile_id: str = "asimov-1") -> None:
        self.profile_id = profile_id
        self.controller = AsimovController()
        self.model = None
        self.data = None
        self._ctrl = np.zeros(len(ASIMOV1_FIRMWARE_JOINT_ORDER), dtype=np.float32)
        self._home = self._ctrl.copy()
        self._lower = np.full_like(self._ctrl, -1.0)
        self._upper = np.full_like(self._ctrl, 1.0)
        self._applied_targets = {name: 0.0 for name in ASIMOV1_FIRMWARE_JOINT_ORDER}
        self._events: list[EventEnvelope] = []

    @property
    def backend_name(self) -> str:
        return "asimov_mujoco"

    async def connect(self) -> None:
        import mujoco

        if not ASIMOV1_GENERATED_MJCF.is_file():
            generate_asimov1_mjcf()
        self.model = mujoco.MjModel.from_xml_path(str(ASIMOV1_GENERATED_MJCF))
        self.data = mujoco.MjData(self.model)
        profile = load_profile(self.profile_id)
        by_name = {joint.name: joint for joint in profile.kinematics.joints}
        for i, name in enumerate(ASIMOV1_FIRMWARE_JOINT_ORDER):
            joint = by_name[name]
            self._home[i] = float(joint.home_rad)
            self._lower[i] = float(joint.lower_rad)
            self._upper[i] = float(joint.upper_rad)
        self._ctrl[:] = self._home
        self._applied_targets = {name: float(self._home[i]) for i, name in enumerate(ASIMOV1_FIRMWARE_JOINT_ORDER)}
        self._apply_targets(dict(self._applied_targets), update_controller=False)
        self._events.append(self._telemetry_event())

    async def shutdown(self) -> None:
        self.model = None
        self.data = None

    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        try:
            if cmd.command == "asimov.mode":
                self.controller.set_mode(str(cmd.payload.get("mode", "")))
                data = {"mode": self.controller.mode.value}
            elif cmd.command == "walk.command" and "action" in cmd.payload:
                action = str(cmd.payload.get("action", "")).lower()
                mode = "DAMP" if action in {"stop", "disable", "disable_control"} else "STAND"
                self.controller.set_mode(mode)
                data = {"action": action, "mode": self.controller.mode.value}
            elif cmd.command in {"asimov.velocity", "walk.command", "walk.set"}:
                self.controller.set_velocity(
                    float(cmd.payload.get("vx_mps", cmd.payload.get("x", 0.0))),
                    float(cmd.payload.get("vy_mps", cmd.payload.get("y", 0.0))),
                    float(cmd.payload.get("yaw_rad_s", cmd.payload.get("yaw", 0.0))),
                )
                data = {"velocity": self.controller.velocity}
            elif cmd.command in {"asimov.trajectory", "servo.set", "policy.tick"}:
                targets = _positions_from_payload(cmd.payload)
                self._apply_targets(targets, duration_s=float(cmd.payload.get("duration", 0.05)))
                data = {
                    "joint_targets": dict(self.controller.joint_targets),
                    "applied_joint_targets": dict(self._applied_targets),
                }
            elif cmd.command == "action.play":
                if cmd.payload.get("name") == "stand":
                    self._apply_targets(
                        {name: float(self._home[i]) for i, name in enumerate(ASIMOV1_FIRMWARE_JOINT_ORDER)},
                        update_controller=False,
                    )
                    self.controller.set_mode("STAND")
                data = {"action": cmd.payload.get("name", "")}
            else:
                data = {}
            self._events.append(self._telemetry_event())
            return ResponseEnvelope(cmd.request_id, utc_now_iso(), True, self.backend_name, "ok", data)
        except Exception as exc:
            return ResponseEnvelope(cmd.request_id, utc_now_iso(), False, self.backend_name, str(exc), {})

    async def poll_events(self) -> list[EventEnvelope]:
        events, self._events = self._events, []
        return events

    def capabilities(self) -> dict:
        return {
            "profile_id": self.profile_id,
            "dof": len(ASIMOV1_FIRMWARE_JOINT_ORDER),
            "mujoco": True,
            "mjcf": str(ASIMOV1_GENERATED_MJCF),
        }

    def _apply_targets(
        self,
        targets: dict[str, float],
        *,
        duration_s: float = 0.05,
        update_controller: bool = True,
    ) -> None:
        import mujoco

        if self.model is None or self.data is None:
            raise RuntimeError("ASIMOV MuJoCo backend is not connected")
        for name, value in targets.items():
            idx = ASIMOV1_FIRMWARE_JOINT_ORDER.index(name)
            self._ctrl[idx] = float(value)
        self.data.ctrl[:] = np.clip(self._ctrl, self._lower, self._upper)
        self._ctrl[:] = self.data.ctrl
        for name in targets:
            idx = ASIMOV1_FIRMWARE_JOINT_ORDER.index(name)
            self._applied_targets[name] = float(self._ctrl[idx])
        if update_controller:
            self.controller.set_trajectory({name: float(value) for name, value in targets.items()})
        steps = max(1, int(round(float(duration_s) / float(self.model.opt.timestep))))
        for _ in range(steps):
            mujoco.mj_step(self.model, self.data)

    def _telemetry_event(self) -> EventEnvelope:
        data = self.controller.telemetry()
        if self.model is not None and self.data is not None:
            positions = {}
            velocities = {}
            for name in ASIMOV1_FIRMWARE_JOINT_ORDER:
                import mujoco

                jid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, name)
                positions[name] = float(self.data.qpos[self.model.jnt_qposadr[jid]])
                velocities[name] = float(self.data.qvel[self.model.jnt_dofadr[jid]])
            data.update(
                {
                    "joint_positions": positions,
                    "joint_velocities": velocities,
                    "applied_joint_targets": dict(self._applied_targets),
                    "mujoco_time_s": float(self.data.time),
                }
            )
        data["time_s"] = time.time()
        return EventEnvelope("telemetry.basic", utc_now_iso(), self.backend_name, data)
