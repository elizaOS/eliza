"""Resolve free-text locomotion instructions to joystick velocity commands.

The MuJoCo-Playground joystick locomotion envs condition the policy on a command
``[vx, vy, yaw_rate]`` (forward m/s, lateral m/s, turn rad/s) carried in the
observation. A single trained walking policy therefore pursues *different goals*
depending on this command. This module maps natural-language instructions to
those commands, so the agent can be driven by text:

    >>> resolve_command("walk forward").as_tuple()
    (1.0, 0.0, 0.0)
    >>> resolve_command("turn left and go").as_tuple()
    (0.6, 0.0, 1.0)

Resolution is deliberately simple, deterministic keyword matching (no model
dependency): direction/turn keywords accumulate into a command, with sensible
default speeds. ``CANONICAL_COMMANDS`` is the labelled set used for evaluation
and the continual-learning skill sequence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

DEFAULT_SPEED = 1.0  # m/s forward/backward
DEFAULT_STRAFE = 0.5  # m/s lateral
DEFAULT_YAW = 1.0  # rad/s turn


@dataclass(frozen=True)
class JoystickCommand:
    vx: float = 0.0
    vy: float = 0.0
    yaw: float = 0.0

    def as_tuple(self) -> tuple[float, float, float]:
        return (self.vx, self.vy, self.yaw)

    def is_stand(self) -> bool:
        return self.vx == 0.0 and self.vy == 0.0 and self.yaw == 0.0


# Canonical labelled commands (used for eval + the continual skill sequence).
CANONICAL_COMMANDS: dict[str, JoystickCommand] = {
    "walk forward": JoystickCommand(vx=DEFAULT_SPEED),
    "walk backward": JoystickCommand(vx=-DEFAULT_SPEED),
    "strafe left": JoystickCommand(vy=DEFAULT_STRAFE),
    "strafe right": JoystickCommand(vy=-DEFAULT_STRAFE),
    "turn left": JoystickCommand(yaw=DEFAULT_YAW),
    "turn right": JoystickCommand(yaw=-DEFAULT_YAW),
    "stand still": JoystickCommand(),
}

_WORD = re.compile(r"[a-z]+")


def resolve_command(text: str) -> JoystickCommand:
    """Map a free-text instruction to a :class:`JoystickCommand`.

    Keyword rules (accumulated): forward/ahead/go → +vx; back(ward)/reverse → −vx;
    left → +vy or +yaw (if "turn"); right → −vy or −yaw; turn/rotate/spin enables
    yaw; stand/stop/halt/still/wait → zero. Unknown text → stand still (safe).
    """
    t = text.lower()
    words = set(_WORD.findall(t))
    turning = bool(words & {"turn", "rotate", "spin", "yaw"})

    vx = vy = yaw = 0.0
    if words & {"stop", "stand", "halt", "still", "wait", "idle", "freeze"}:
        return JoystickCommand()
    if words & {"forward", "ahead", "straight", "go", "walk", "march"} and "backward" not in t:
        vx += DEFAULT_SPEED
    if words & {"backward", "backwards", "back", "reverse", "retreat"}:
        vx -= DEFAULT_SPEED
    if "left" in words:
        if turning:
            yaw += DEFAULT_YAW
        else:
            vy += DEFAULT_STRAFE
    if "right" in words:
        if turning:
            yaw -= DEFAULT_YAW
        else:
            vy -= DEFAULT_STRAFE
    # "turn"/"spin" with no side defaults to a left turn.
    if turning and yaw == 0.0 and vy == 0.0:
        yaw += DEFAULT_YAW
    return JoystickCommand(vx=vx, vy=vy, yaw=yaw)
