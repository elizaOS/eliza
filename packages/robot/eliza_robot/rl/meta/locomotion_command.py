"""Bridge: parsed LLM text command -> RL locomotion velocity command.

The mujoco_playground joystick locomotion policies (Unitree H1/G1, Berkeley
Humanoid) are conditioned on a 3-vector velocity command
``[vx (m/s), vy (m/s), vyaw (rad/s)]``. The LLM side speaks free-form text,
which ``CommandParser`` turns into ``(skill_name, SkillParams)``. This module
is the single, pure, tested seam that turns that into the velocity command the
RL policy actually consumes — the concrete "LLM action -> RL" link.

Pure (no sim/jax/torch) so the mapping is cheap to unit-test and reusable by
the bridge, deploy harnesses, and eval.
"""

from __future__ import annotations

from dataclasses import dataclass

from eliza_robot.rl.meta.command_parser import CommandParser, ParseResult
from eliza_robot.rl.skills.base import SkillParams

# Default command magnitudes. Chosen to sit inside the playground joystick
# training ranges so the policy is queried in-distribution. Actual env ranges:
# H1 lin_vel_x [-1.5,1.5], G1 lin_vel_x [-1.0,1.0], both ang_vel_yaw [-1.0,1.0].
# 1.0 is a conservative forward default in-range for every supported robot.
MAX_FORWARD_SPEED_M_S = 1.0
MAX_YAW_RATE_RAD_S = 1.0
# direction (radians) within this of pi is treated as "backward".
_BACKWARD_CONE_RAD = 1.0


@dataclass(frozen=True)
class VelocityCommand:
    vx: float  # forward (+) / backward (-), m/s
    vy: float  # left (+) / right (-), m/s
    vyaw: float  # turn left (+) / right (-), rad/s

    def as_tuple(self) -> tuple[float, float, float]:
        return (self.vx, self.vy, self.vyaw)


def velocity_from_parse(result: ParseResult) -> VelocityCommand:
    """Map a :class:`ParseResult` to a locomotion velocity command.

    - ``walk`` -> forward/backward vx scaled by ``params.speed``; a
      ``direction`` near pi means walk backward.
    - ``turn`` -> vyaw from ``params.direction`` sign (left = +, right = -).
    - ``stand`` / anything else -> zero command (hold still).
    """
    p: SkillParams = result.params
    skill = result.skill_name

    if skill == "walk":
        speed = max(0.0, min(1.0, float(p.speed)))
        backward = abs(abs(float(p.direction)) - 3.141592653589793) <= _BACKWARD_CONE_RAD
        vx = -speed * MAX_FORWARD_SPEED_M_S if backward else speed * MAX_FORWARD_SPEED_M_S
        return VelocityCommand(vx=vx, vy=0.0, vyaw=0.0)

    if skill == "turn":
        # command_parser: turn left -> direction -1.0, turn right -> +1.0.
        # Robot frame: +yaw is left, so invert the parser sign.
        turn_sign = -1.0 if float(p.direction) >= 0 else 1.0
        return VelocityCommand(vx=0.0, vy=0.0, vyaw=turn_sign * MAX_YAW_RATE_RAD_S)

    # stand / wave / bow / unknown -> hold position.
    return VelocityCommand(vx=0.0, vy=0.0, vyaw=0.0)


def velocity_from_text(text: str, parser: CommandParser | None = None) -> VelocityCommand:
    """Convenience: parse free-form text then map to a velocity command."""
    parser = parser or CommandParser()
    return velocity_from_parse(parser.parse(text))
