"""Text -> joystick command resolution for the walking demonstration."""

from __future__ import annotations

from eliza_robot.rl.text_conditioned.joystick_text import (
    CANONICAL_COMMANDS,
    resolve_command,
)


def test_canonical_phrases_resolve_to_expected_commands():
    assert resolve_command("walk forward").as_tuple() == (1.0, 0.0, 0.0)
    assert resolve_command("go backward").as_tuple() == (-1.0, 0.0, 0.0)
    assert resolve_command("strafe left").as_tuple() == (0.0, 0.5, 0.0)
    assert resolve_command("strafe right").as_tuple() == (0.0, -0.5, 0.0)
    assert resolve_command("turn left").as_tuple() == (0.0, 0.0, 1.0)
    assert resolve_command("turn right").as_tuple() == (0.0, 0.0, -1.0)


def test_stand_and_unknown_are_safe_zero():
    assert resolve_command("stand still").is_stand()
    assert resolve_command("halt").is_stand()
    assert resolve_command("xyzzy").is_stand()  # unknown -> safe stand


def test_compound_instruction_accumulates():
    # "turn left" enables yaw; "go" adds forward velocity.
    cmd = resolve_command("go and turn left")
    assert cmd.vx == 1.0 and cmd.yaw == 1.0 and cmd.vy == 0.0


def test_canonical_set_is_distinct():
    tuples = [c.as_tuple() for c in CANONICAL_COMMANDS.values()]
    assert len(set(tuples)) == len(tuples)
