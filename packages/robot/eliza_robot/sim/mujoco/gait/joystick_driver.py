"""Drive the AiNex joystick MuJoCo env with the Bezier gait controller.

The :class:`JoystickGaitDriver` is a thin wrapper that swaps the RL
policy out for :class:`BezierGaitController`. It is useful for two
things:

    1. Producing a baseline trajectory for the gait phase reward —
       i.e. the controller's foot-z over time should track ``get_rz``
       almost exactly, so the ``feet_phase`` reward should be near 1.
    2. Sanity-checking the ``ainex_primitives.xml`` model: if the robot
       falls over immediately under the open-loop gait, the model has
       a problem (wrong masses, wrong actuator gains, etc.) that no RL
       policy will recover from.

We deliberately keep the rendering optional so the import works in
environments without a GL backend.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

import numpy as np

from .controller import NUM_JOINTS, BezierGaitController

if TYPE_CHECKING:  # pragma: no cover - typing only
    import mujoco


@dataclass
class GaitRollout:
    """Result of a :meth:`JoystickGaitDriver.run` call.

    Attributes:
        qpos:   ``(T, nq)`` array of generalized positions over time.
        qvel:   ``(T, nv)`` array of generalized velocities over time.
        frames: ``list[np.ndarray]`` rendered frames if ``render=True``,
                otherwise an empty list.
    """

    qpos: np.ndarray
    qvel: np.ndarray
    frames: list[np.ndarray]


class JoystickGaitDriver:
    """Run the Bezier gait inside the AiNex MuJoCo joystick env."""

    def __init__(
        self,
        controller: Optional[BezierGaitController] = None,
        model_xml_path: Optional[str] = None,
        ctrl_dt: float = 0.02,
        sim_dt: float = 0.004,
    ) -> None:
        # Local import so module import works without mujoco installed.
        import mujoco

        if model_xml_path is None:
            from eliza_robot.sim.mujoco import ainex_constants as consts

            model_xml_path = str(consts.SCENE_PRIMITIVES_XML)

        self._mj = mujoco
        self._model = mujoco.MjModel.from_xml_path(model_xml_path)
        self._model.opt.timestep = sim_dt
        self._data = mujoco.MjData(self._model)

        self.controller = controller or BezierGaitController()
        self.ctrl_dt = float(ctrl_dt)
        self.sim_dt = float(sim_dt)
        self._n_substeps = max(1, int(round(self.ctrl_dt / self.sim_dt)))

        # Try to seed qpos with the bent-knees keyframe if it exists.
        try:
            kf = self._model.keyframe("stand_bent_knees")
            self._data.qpos[:] = kf.qpos
        except Exception:
            # Older XMLs may not include the keyframe. Leave qpos at 0
            # and rely on the controller's neutral pose for ctrl.
            pass
        mujoco.mj_forward(self._model, self._data)

    @property
    def model(self) -> "mujoco.MjModel":  # pragma: no cover - trivial
        return self._model

    @property
    def data(self) -> "mujoco.MjData":  # pragma: no cover - trivial
        return self._data

    def run(
        self,
        vx: float = 0.0,
        vy: float = 0.0,
        vyaw: float = 0.0,
        duration_s: float = 1.0,
        render: bool = False,
        camera: Optional[str] = None,
        height: int = 240,
        width: int = 320,
    ) -> GaitRollout:
        """Simulate the controller for ``duration_s`` seconds.

        Args:
            vx, vy, vyaw: Velocity command held constant for the run.
            duration_s:   Total simulated time, seconds.
            render:       When ``True``, render one RGB frame per control
                          step. Requires a working ``MUJOCO_GL`` backend.
            camera:       Optional camera name for rendering.
            height, width: Render dimensions.

        Returns:
            :class:`GaitRollout` with qpos, qvel, and (optionally) frames.
        """
        n_steps = max(1, int(round(duration_s / self.ctrl_dt)))
        nq = self._model.nq
        nv = self._model.nv

        qpos_trace = np.zeros((n_steps, nq), dtype=np.float64)
        qvel_trace = np.zeros((n_steps, nv), dtype=np.float64)
        frames: list[np.ndarray] = []

        renderer = None
        if render:
            renderer = self._mj.Renderer(self._model, height=height, width=width)

        self.controller.reset()
        n_ctrl = min(NUM_JOINTS, self._model.nu)

        try:
            for step in range(n_steps):
                ctrl = self.controller.step(vx=vx, vy=vy, vyaw=vyaw, dt=self.ctrl_dt)
                self._data.ctrl[:n_ctrl] = ctrl[:n_ctrl]
                for _ in range(self._n_substeps):
                    self._mj.mj_step(self._model, self._data)

                qpos_trace[step] = self._data.qpos
                qvel_trace[step] = self._data.qvel

                if renderer is not None:
                    if camera is not None:
                        renderer.update_scene(self._data, camera=camera)
                    else:
                        renderer.update_scene(self._data)
                    frames.append(renderer.render())
        finally:
            if renderer is not None:
                renderer.close()

        return GaitRollout(qpos=qpos_trace, qvel=qvel_trace, frames=frames)
