"""Tests for the LLM-text -> RL velocity-command bridge.

This is the concrete "LLM action -> RL" seam: free-form text is parsed into a
skill + params, then mapped to the ``[vx, vy, vyaw]`` velocity command the
mujoco_playground locomotion policy consumes. These lock in the mapping so the
bridge is validated independently of (and much faster than) a full sim rollout.
"""

from __future__ import annotations

import pytest

from eliza_robot.rl.meta.command_parser import CommandParser
from eliza_robot.rl.meta.locomotion_command import (
    MAX_FORWARD_SPEED_M_S,
    MAX_YAW_RATE_RAD_S,
    velocity_from_text,
)


def test_walk_forward_is_positive_vx():
    cmd = velocity_from_text("walk forward")
    assert cmd.vx > 0
    assert cmd.vy == 0.0
    assert cmd.vyaw == 0.0


def test_walk_fast_faster_than_slow():
    fast = velocity_from_text("walk forward fast")
    slow = velocity_from_text("walk forward slowly")
    assert fast.vx > slow.vx > 0
    assert fast.vx <= MAX_FORWARD_SPEED_M_S + 1e-9


def test_walk_backward_is_negative_vx():
    cmd = velocity_from_text("walk backward")
    assert cmd.vx < 0


def test_turn_left_is_positive_yaw_right_is_negative():
    left = velocity_from_text("turn left")
    right = velocity_from_text("turn right")
    assert left.vyaw > 0
    assert right.vyaw < 0
    assert abs(left.vyaw) <= MAX_YAW_RATE_RAD_S + 1e-9


def test_strafe_left_is_positive_vy_right_is_negative():
    left = velocity_from_text("sidestep left")
    right = velocity_from_text("strafe right")
    assert left.vy > 0 and left.vx == 0.0 and left.vyaw == 0.0  # +y = robot's left
    assert right.vy < 0
    from eliza_robot.rl.meta.locomotion_command import MAX_LATERAL_SPEED_M_S
    assert abs(left.vy) <= MAX_LATERAL_SPEED_M_S + 1e-9


def test_strafe_does_not_collide_with_turn_or_walk():
    assert velocity_from_text("turn left").vyaw > 0  # turn unaffected
    assert velocity_from_text("turn left").vy == 0.0
    assert velocity_from_text("walk forward").vx > 0  # walk unaffected
    assert velocity_from_text("shuffle right").vy < 0


@pytest.mark.parametrize("phrase", ["stop", "stand still", "wave hello", "bow down"])
def test_non_locomotion_holds_still(phrase):
    cmd = velocity_from_text(phrase)
    assert cmd.as_tuple() == (0.0, 0.0, 0.0)


def test_shares_one_parser_instance():
    parser = CommandParser()
    a = velocity_from_text("go forward", parser=parser)
    b = velocity_from_text("turn right", parser=parser)
    assert a.vx > 0
    assert b.vyaw < 0
