"""Open-loop Bezier gait controller for the AiNex 24-DOF joint layout.

This is an analytic gait, not a learned policy. We maintain a single
phase variable, look up the desired Z-height of each foot via
:func:`get_rz`, and convert that height into hip-pitch / knee / ankle
joint angles using a closed-form 2-link leg IK. The body of the robot
stays at a fixed nominal hip height; the swinging leg rises by
``swing_height`` at the peak of its phase.

This will not win any locomotion contests. The aim is to produce
joint targets that, when fed into ``ainex_primitives.xml``, keep the
robot upright for a few seconds — and at low speeds gently nudge it
forward. The MuJoCo Playground gait phase reward (see
``packages/robot/eliza_robot/sim/mujoco/joystick.py``) is built around
the same :func:`get_rz` trajectory, so this controller doubles as a
sanity-check baseline for that reward.

Joint order matches :data:`eliza_robot.sim.mujoco.ainex_constants.ALL_JOINT_NAMES`:

    legs (12): r_hip_yaw r_hip_roll r_hip_pitch r_knee r_ank_pitch r_ank_roll
               l_hip_yaw l_hip_roll l_hip_pitch l_knee l_ank_pitch l_ank_roll
    head (2):  head_pan head_tilt
    arms (10): r_sho_pitch r_sho_roll r_el_pitch r_el_yaw r_gripper
               l_sho_pitch l_sho_roll l_el_pitch l_el_yaw l_gripper
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

import numpy as np

from .bezier import advance_gait_phase, get_rz

if TYPE_CHECKING:  # pragma: no cover - typing only
    # The RobotProfile abstraction is being introduced by W1.4 and may
    # not yet exist on disk. Importing under TYPE_CHECKING keeps mypy
    # happy without forcing a runtime dependency on the profile module.
    from eliza_robot.profiles import RobotProfile  # noqa: F401


# ----------------------------------------------------------------------
# Joint layout (must mirror ainex_constants.ALL_JOINT_NAMES order).
# ----------------------------------------------------------------------

NUM_JOINTS = 24
NUM_LEG_JOINTS = 12

# Indices within the 24-vector.
R_HIP_YAW, R_HIP_ROLL, R_HIP_PITCH, R_KNEE, R_ANK_PITCH, R_ANK_ROLL = range(0, 6)
L_HIP_YAW, L_HIP_ROLL, L_HIP_PITCH, L_KNEE, L_ANK_PITCH, L_ANK_ROLL = range(6, 12)
HEAD_PAN, HEAD_TILT = 12, 13
(
    R_SHO_PITCH, R_SHO_ROLL, R_EL_PITCH, R_EL_YAW, R_GRIPPER,
    L_SHO_PITCH, L_SHO_ROLL, L_EL_PITCH, L_EL_YAW, L_GRIPPER,
) = range(14, 24)

# Nominal AiNex link lengths (meters) — these match the
# ``ainex_primitives.xml`` capsule lengths within a few millimeters.
# TODO: read from RobotProfile once the schema lands (W1.4).
_THIGH_LENGTH = 0.10   # hip pitch -> knee
_SHIN_LENGTH = 0.10    # knee -> ankle
_LEG_LENGTH = _THIGH_LENGTH + _SHIN_LENGTH  # 0.20 m fully extended

# Nominal standing pose — slight knee bend so the IK has headroom in
# both directions. Matches the spirit of the ``stand_bent_knees`` MJCF
# keyframe used by ``AiNexEnv``.
_DEFAULT_HIP_PITCH = 0.35      # rad, forward lean of the upper leg
_DEFAULT_KNEE = -0.70          # rad, knee fold (negative = bend back)
_DEFAULT_ANKLE_PITCH = 0.35    # rad, compensates so the foot is flat
_DEFAULT_NOMINAL_HEIGHT = (
    _THIGH_LENGTH * np.cos(_DEFAULT_HIP_PITCH)
    + _SHIN_LENGTH * np.cos(_DEFAULT_HIP_PITCH + _DEFAULT_KNEE)
)  # ~0.193 m hip-to-foot when standing bent

# Arms held in a relaxed pose, mirroring the keyframe.
_DEFAULT_ARM = {
    R_SHO_PITCH: 0.0,
    R_SHO_ROLL: -0.2,
    R_EL_PITCH: -0.4,
    R_EL_YAW: 0.0,
    R_GRIPPER: 0.0,
    L_SHO_PITCH: 0.0,
    L_SHO_ROLL: 0.2,
    L_EL_PITCH: -0.4,
    L_EL_YAW: 0.0,
    L_GRIPPER: 0.0,
}


def _two_link_ik(target_z: float) -> tuple[float, float, float]:
    """Solve hip-pitch / knee / ankle-pitch for a desired hip-to-foot
    vertical distance ``target_z``.

    The leg is treated as a planar 2-link arm in the sagittal plane:

        - link 1 = thigh (length _THIGH_LENGTH)
        - link 2 = shin  (length _SHIN_LENGTH)

    The foot is constrained to lie directly under the hip (zero forward
    reach) so the body stays balanced. Knee angle uses the law of
    cosines; hip pitch is half the knee fold so the shin stays roughly
    vertical; ankle pitch counter-rotates so the foot stays flat.

    ``target_z`` must be in ``(0, _LEG_LENGTH]``. Values outside that
    range are clamped — at full extension the knee is straight, at zero
    extension we cap at the minimum reachable distance.
    """
    # Clamp to the reachable range, leaving a small margin so the knee
    # never fully locks (cos(theta) = 1 is singular for the IK Jacobian).
    z_min = 0.05
    z_max = _LEG_LENGTH - 1e-3
    z = float(np.clip(target_z, z_min, z_max))

    # Law of cosines: z^2 = a^2 + b^2 - 2ab*cos(pi - knee)
    # =>  cos(knee_interior) = (a^2 + b^2 - z^2) / (2ab)
    a, b = _THIGH_LENGTH, _SHIN_LENGTH
    cos_interior = (a * a + b * b - z * z) / (2 * a * b)
    cos_interior = float(np.clip(cos_interior, -1.0, 1.0))
    interior = np.arccos(cos_interior)        # 0 = straight, pi = fully folded
    knee = -(np.pi - interior)                # negative = bend back

    # With foot directly under hip, hip-pitch is half the knee fold.
    hip_pitch = (np.pi - interior) / 2.0

    # Ankle pitch keeps the foot flat: total pitch chain = 0.
    ankle_pitch = -(hip_pitch + knee)

    return hip_pitch, knee, ankle_pitch


class BezierGaitController:
    """Open-loop Bezier-foot gait → 24-DOF joint targets.

    Parameters
    ----------
    profile:
        Optional :class:`RobotProfile` (introduced in W1.4). When
        provided, ``swing_height``, ``cycle_hz``, ``stance_width`` and
        ``foot_offset`` are pulled from the profile. Until the profile
        schema lands, the explicit kwargs serve as the source of truth.
    swing_height:
        Maximum foot lift during swing (m).
    cycle_hz:
        Gait frequency in Hertz (full cycles per second).
    stance_width:
        Lateral hip-to-foot offset (m). Currently used only to bias
        ``hip_roll``; the IK itself assumes a vertical leg.
    foot_offset:
        Small constant Z bias added to the desired foot height (m).
        Useful for trimming the standing pose when the IK clamps near
        the limit.
    """

    def __init__(
        self,
        profile: "Optional[RobotProfile]" = None,
        swing_height: float = 0.08,
        cycle_hz: float = 4.1,
        stance_width: float = 0.10,
        foot_offset: float = 0.0,
    ) -> None:
        if profile is not None:
            gait_cfg = getattr(profile, "gait", None) or {}
            swing_height = float(gait_cfg.get("swing_height", swing_height))
            cycle_hz = float(gait_cfg.get("cycle_hz", cycle_hz))
            stance_width = float(gait_cfg.get("stance_width", stance_width))
            foot_offset = float(gait_cfg.get("foot_offset", foot_offset))
        # TODO: once W1.4 ships, also pull link lengths and the neutral
        # standing pose from the profile instead of the hard-coded
        # constants at the top of this file.

        self.swing_height = float(swing_height)
        self.cycle_hz = float(cycle_hz)
        self.stance_width = float(stance_width)
        self.foot_offset = float(foot_offset)
        self._profile = profile

        # Initial phases: left and right feet 180 degrees apart.
        self._phase = np.array([0.0, np.pi], dtype=np.float64)
        self._neutral = self._build_neutral_pose()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def reset(self) -> np.ndarray:
        """Clear the gait phase and return the neutral standing pose."""
        self._phase = np.array([0.0, np.pi], dtype=np.float64)
        return self._neutral.copy()

    def step(self, vx: float, vy: float, vyaw: float, dt: float) -> np.ndarray:
        """Advance the gait by ``dt`` seconds and return joint targets.

        Args:
            vx:   Forward velocity command (m/s, body frame).
            vy:   Lateral velocity command (m/s, body frame).
            vyaw: Yaw rate command (rad/s).
            dt:   Control-loop timestep (s).

        Returns:
            ``np.ndarray`` of shape ``(24,)`` with joint targets in
            radians, in :data:`ainex_constants.ALL_JOINT_NAMES` order.
        """
        # Phase increment scales with cycle_hz (not with vx — vx only
        # changes the per-foot forward swing amplitude below).
        phase_dt = 2 * np.pi * self.cycle_hz * dt
        self._phase = advance_gait_phase(self._phase, phase_dt)

        # Desired foot Z for each leg (left=index 0, right=index 1).
        desired_lift = get_rz(self._phase, swing_height=self.swing_height)

        # Convert lift into a hip-to-foot distance. When the foot is on
        # the ground we want the nominal stance height; lifting the foot
        # by ``rz`` shortens the hip-to-foot distance by ``rz``.
        hip_to_foot = _DEFAULT_NOMINAL_HEIGHT - desired_lift - self.foot_offset

        # Solve IK per leg.
        l_hip_pitch, l_knee, l_ank_pitch = _two_link_ik(float(hip_to_foot[0]))
        r_hip_pitch, r_knee, r_ank_pitch = _two_link_ik(float(hip_to_foot[1]))

        # Forward velocity bias: lean the swing leg slightly forward.
        # Stance leg stays centered. We detect "swinging" as the foot
        # currently above the ground.
        swing_bias = float(np.clip(vx, -0.5, 0.5)) * 0.30  # rad per (m/s)
        if desired_lift[0] > 1e-3:  # left in swing
            l_hip_pitch += swing_bias
            l_ank_pitch -= swing_bias
        if desired_lift[1] > 1e-3:  # right in swing
            r_hip_pitch += swing_bias
            r_ank_pitch -= swing_bias

        # Yaw command -> opposite hip-yaw on each leg (very small turn).
        yaw_bias = float(np.clip(vyaw, -1.0, 1.0)) * 0.05  # rad per (rad/s)

        # Lateral command -> hip-roll bias (very small side-step).
        roll_bias = float(np.clip(vy, -0.3, 0.3)) * 0.20  # rad per (m/s)
        # Stance width adds a constant outward roll so the legs are not
        # perfectly vertical (matches the standing keyframe).
        stance_roll = self.stance_width  # rough proportional mapping

        q = self._neutral.copy()
        # Left leg.
        q[L_HIP_YAW] = +yaw_bias
        q[L_HIP_ROLL] = -stance_roll + roll_bias
        q[L_HIP_PITCH] = l_hip_pitch
        q[L_KNEE] = l_knee
        q[L_ANK_PITCH] = l_ank_pitch
        q[L_ANK_ROLL] = +stance_roll - roll_bias
        # Right leg.
        q[R_HIP_YAW] = -yaw_bias
        q[R_HIP_ROLL] = +stance_roll + roll_bias
        q[R_HIP_PITCH] = r_hip_pitch
        q[R_KNEE] = r_knee
        q[R_ANK_PITCH] = r_ank_pitch
        q[R_ANK_ROLL] = -stance_roll - roll_bias

        # Head + arms: keep neutral.
        return q

    @property
    def phase(self) -> np.ndarray:
        """Current per-foot phase (read-only view)."""
        return self._phase.copy()

    @property
    def neutral_pose(self) -> np.ndarray:
        """Standing pose used by :meth:`reset` (read-only copy)."""
        return self._neutral.copy()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_neutral_pose(self) -> np.ndarray:
        """Build the 24-vector standing pose used at reset and as a base.

        Pulled from :class:`RobotProfile` when available, else falls back
        to the hard-coded ``stand_bent_knees``-style pose.
        """
        if self._profile is not None:
            pose = getattr(self._profile, "neutral_pose", None)
            if pose is not None:
                arr = np.asarray(pose, dtype=np.float64)
                if arr.shape != (NUM_JOINTS,):
                    raise ValueError(
                        f"profile.neutral_pose has shape {arr.shape}, "
                        f"expected ({NUM_JOINTS},)"
                    )
                return arr

        q = np.zeros(NUM_JOINTS, dtype=np.float64)
        # Legs.
        for hip_pitch_idx, knee_idx, ankle_idx, hip_roll_idx, sign in (
            (L_HIP_PITCH, L_KNEE, L_ANK_PITCH, L_HIP_ROLL, -1),
            (R_HIP_PITCH, R_KNEE, R_ANK_PITCH, R_HIP_ROLL, +1),
        ):
            q[hip_pitch_idx] = _DEFAULT_HIP_PITCH
            q[knee_idx] = _DEFAULT_KNEE
            q[ankle_idx] = _DEFAULT_ANKLE_PITCH
            q[hip_roll_idx] = sign * self.stance_width
        # Arms.
        for idx, value in _DEFAULT_ARM.items():
            q[idx] = value
        return q
