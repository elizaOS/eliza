"""Bezier-foot gait controller for AiNex bipedal locomotion.

Ports the MuJoCo Playground / Berkeley Humanoid Bezier foot-height
trajectory into a self-contained numpy module plus a simple analytical
inverse-kinematics controller that drives the 24-DOF AiNex joint command.

Public surface:
    * :func:`get_rz` — desired foot Z (height) for a given gait phase.
    * :class:`BezierGaitController` — converts (vx, vy, vyaw) commands into
      24-dim joint targets in radians using ``get_rz`` + analytic 2-link IK.
    * :class:`JoystickGaitDriver` — wires the controller into the MuJoCo
      joystick env, replacing the RL policy with the open-loop gait.
"""

from .bezier import (
    advance_gait_phase,
    cubic_bezier_interpolation,
    get_rz,
    initialize_gait_phase,
)
from .controller import BezierGaitController
from .joystick_driver import JoystickGaitDriver

__all__ = [
    "BezierGaitController",
    "JoystickGaitDriver",
    "advance_gait_phase",
    "cubic_bezier_interpolation",
    "get_rz",
    "initialize_gait_phase",
]
