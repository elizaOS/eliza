"""Breadth test of the text -> action (velocity command) bridge.

Fast and pure: this exercises the full natural-language surface of
:class:`eliza_robot.rl.meta.command_parser.CommandParser` and
:func:`eliza_robot.rl.meta.locomotion_command.velocity_from_text` without
loading jax, mujoco, or any sim. It is the cheap, breadth-first complement to
the (slow) policy-rollout proof: it locks in *which phrasings map to which
``[vx, vy, vyaw]`` velocity command*, and that the three locomotion families
(walk / turn / strafe) and stop do not collide.

What is intentionally NOT asserted: the *semantic correctness* of the
embedding fallback. The default :class:`TextEncoder` is the deterministic
bag-of-words hash (sentence-transformers is not installed in the fast lane),
so an unseen phrase routes to a hash-arbitrary skill. The only contract the
fallback owes us is: a known skill name + a finite confidence in ``[0, 1]``.
"""

from __future__ import annotations

import math

import pytest

from eliza_robot.rl.meta.command_parser import (
    SKILL_DESCRIPTIONS,
    CommandParser,
    parse_command_regex,
)
from eliza_robot.rl.meta.locomotion_command import (
    MAX_FORWARD_SPEED_M_S,
    MAX_LATERAL_SPEED_M_S,
    MAX_YAW_RATE_RAD_S,
    velocity_from_text,
)

# Single shared parser: parsing is pure and the encoder is stateless, so one
# instance is reused across every parametrized case (keeps the suite fast).
_PARSER = CommandParser()

KNOWN_SKILLS = frozenset(SKILL_DESCRIPTIONS)


def _vel(text: str):
    return velocity_from_text(text, parser=_PARSER)


# --------------------------------------------------------------------------- #
# (a) Many natural phrasings per action route to the correct sign / axis.
# --------------------------------------------------------------------------- #

# Phrasings that the regex fast-path recognises as forward walking. All must
# produce a strictly-forward command (vx > 0, no lateral, no yaw).
FORWARD_PHRASES = [
    "walk forward",
    "go forward",
    "move forward",
    "walk forward fast",
    "walk forward slowly",
    "walk",  # bare "walk" defaults to forward at speed 0.5
    "could you walk forward please",  # embedded in a sentence
    "WALK FORWARD",  # case-insensitive
]


@pytest.mark.parametrize("phrase", FORWARD_PHRASES)
def test_forward_phrasings_are_strictly_forward(phrase: str) -> None:
    cmd = _vel(phrase)
    assert cmd.vx > 0.0, f"{phrase!r} should drive forward, got vx={cmd.vx}"
    assert cmd.vy == 0.0, f"{phrase!r} should not strafe, got vy={cmd.vy}"
    assert cmd.vyaw == 0.0, f"{phrase!r} should not turn, got vyaw={cmd.vyaw}"


def test_forward_fast_exceeds_slow() -> None:
    fast = _vel("walk forward fast")
    slow = _vel("walk forward slowly")
    plain = _vel("walk forward")
    assert fast.vx > plain.vx > slow.vx > 0.0


# Phrasings the parser treats as backward (regex direction ~= pi -> vx < 0).
BACKWARD_PHRASES = [
    "walk backward",
    "walk backwards",
    "walk back",
    "go backward",
    "go back",
    "move back",
    "move backwards",
    "step back",
    "back up",
    "reverse",
]


@pytest.mark.parametrize("phrase", BACKWARD_PHRASES)
def test_backward_phrasings_are_negative_vx(phrase: str) -> None:
    cmd = _vel(phrase)
    assert cmd.vx < 0.0, f"{phrase!r} should drive backward, got vx={cmd.vx}"
    assert cmd.vy == 0.0
    assert cmd.vyaw == 0.0


# Turn phrasings: left -> +yaw (robot frame), right -> -yaw. No translation.
TURN_PHRASES = [
    ("turn left", +1),
    ("turn right", -1),
    ("rotate left", +1),
    ("rotate right", -1),
    ("Turn Left", +1),  # case-insensitive
]


@pytest.mark.parametrize("phrase,yaw_sign", TURN_PHRASES)
def test_turn_phrasings_set_yaw_only(phrase: str, yaw_sign: int) -> None:
    cmd = _vel(phrase)
    assert math.copysign(1.0, cmd.vyaw) == yaw_sign, (
        f"{phrase!r} yaw sign wrong: vyaw={cmd.vyaw}"
    )
    assert cmd.vyaw != 0.0
    assert cmd.vx == 0.0, f"{phrase!r} should not translate forward, vx={cmd.vx}"
    assert cmd.vy == 0.0, f"{phrase!r} should not strafe, vy={cmd.vy}"


# Strafe phrasings: left -> +vy (robot's left is +y), right -> -vy. No yaw, no vx.
STRAFE_PHRASES = [
    ("sidestep left", +1),
    ("strafe right", -1),
    ("shuffle left", +1),
    ("step right", -1),
    ("slide left", +1),
    ("step left", +1),
    ("sidestep", +1),  # bare sidestep defaults to left
    ("STEP LEFT", +1),  # case-insensitive
]


@pytest.mark.parametrize("phrase,vy_sign", STRAFE_PHRASES)
def test_strafe_phrasings_set_lateral_only(phrase: str, vy_sign: int) -> None:
    cmd = _vel(phrase)
    assert math.copysign(1.0, cmd.vy) == vy_sign, (
        f"{phrase!r} lateral sign wrong: vy={cmd.vy}"
    )
    assert cmd.vy != 0.0
    assert cmd.vx == 0.0, f"{phrase!r} should not translate forward, vx={cmd.vx}"
    assert cmd.vyaw == 0.0, f"{phrase!r} should not turn, vyaw={cmd.vyaw}"


# Stop / stand phrasings: zero command, hold still.
STOP_PHRASES = [
    "stop",
    "halt",
    "stand still",
    "stand",
    "freeze",
    "please STOP now",  # embedded + mixed case
]


@pytest.mark.parametrize("phrase", STOP_PHRASES)
def test_stop_phrasings_hold_still(phrase: str) -> None:
    cmd = _vel(phrase)
    assert cmd.as_tuple() == (0.0, 0.0, 0.0), f"{phrase!r} should hold still"


# --------------------------------------------------------------------------- #
# (b) Walk / turn / strafe families do not collide.
# --------------------------------------------------------------------------- #


def _only_axis(cmd, *, vx: bool = False, vy: bool = False, vyaw: bool = False) -> bool:
    """True iff exactly the requested axes are non-zero."""
    return (
        (cmd.vx != 0.0) == vx
        and (cmd.vy != 0.0) == vy
        and (cmd.vyaw != 0.0) == vyaw
    )


# (phrase, expected_skill, expected_active_axis) — proves the regex precedence
# (strafe before turn) keeps "step left" out of the turn bucket, "turn left"
# out of the strafe bucket, and "walk forward" out of both.
NON_COLLISION_CASES = [
    ("step left", "strafe", "vy"),
    ("step right", "strafe", "vy"),
    ("turn left", "turn", "vyaw"),
    ("turn right", "turn", "vyaw"),
    ("walk forward", "walk", "vx"),
    ("shuffle right", "strafe", "vy"),
    ("rotate left", "turn", "vyaw"),
]


@pytest.mark.parametrize("phrase,skill,axis", NON_COLLISION_CASES)
def test_families_do_not_collide(phrase: str, skill: str, axis: str) -> None:
    parsed = parse_command_regex(phrase)
    assert parsed is not None, f"{phrase!r} should hit the regex fast path"
    assert parsed.skill_name == skill, (
        f"{phrase!r} parsed as {parsed.skill_name!r}, expected {skill!r}"
    )
    cmd = _vel(phrase)
    assert _only_axis(cmd, **{axis: True}), (
        f"{phrase!r} ({skill}) should only set {axis}, got {cmd.as_tuple()}"
    )


def test_step_left_strafes_turn_left_turns() -> None:
    """The notorious 'left' overlap: lateral step vs in-place turn stay split."""
    step = _vel("step left")
    turn = _vel("turn left")
    assert step.vy > 0.0 and step.vyaw == 0.0  # strafe: lateral, no yaw
    assert turn.vyaw > 0.0 and turn.vy == 0.0  # turn: yaw, no lateral


# --------------------------------------------------------------------------- #
# (c) Magnitudes stay within the configured caps.
# --------------------------------------------------------------------------- #

ALL_LOCOMOTION_PHRASES = (
    FORWARD_PHRASES
    + BACKWARD_PHRASES
    + [p for p, _ in TURN_PHRASES]
    + [p for p, _ in STRAFE_PHRASES]
    + STOP_PHRASES
)


@pytest.mark.parametrize("phrase", ALL_LOCOMOTION_PHRASES)
def test_command_magnitudes_within_caps(phrase: str) -> None:
    cmd = _vel(phrase)
    eps = 1e-9
    assert abs(cmd.vx) <= MAX_FORWARD_SPEED_M_S + eps, (
        f"{phrase!r} vx={cmd.vx} exceeds forward cap {MAX_FORWARD_SPEED_M_S}"
    )
    assert abs(cmd.vy) <= MAX_LATERAL_SPEED_M_S + eps, (
        f"{phrase!r} vy={cmd.vy} exceeds lateral cap {MAX_LATERAL_SPEED_M_S}"
    )
    assert abs(cmd.vyaw) <= MAX_YAW_RATE_RAD_S + eps, (
        f"{phrase!r} vyaw={cmd.vyaw} exceeds yaw cap {MAX_YAW_RATE_RAD_S}"
    )


def test_max_phrases_hit_the_caps_exactly() -> None:
    """The fastest phrasings should reach (not just stay under) the caps."""
    assert _vel("walk forward fast").vx == pytest.approx(0.8 * MAX_FORWARD_SPEED_M_S)
    assert abs(_vel("turn left").vyaw) == pytest.approx(MAX_YAW_RATE_RAD_S)
    assert abs(_vel("strafe right").vy) == pytest.approx(MAX_LATERAL_SPEED_M_S)


# --------------------------------------------------------------------------- #
# (d) Embedding fallback: unseen phrase -> known skill, finite confidence.
# --------------------------------------------------------------------------- #

# Phrases with no regex match, forcing the cosine-similarity fallback. Semantic
# correctness is not asserted (bag-of-words hash is not semantic); only the
# structural contract is.
UNSEEN_PHRASES = [
    "please locomote in a forward direction",
    "do a backflip",
    "dance around wildly",
    "scoot to the side",
    "amble onward",
    "pivot clockwise",
    "xyzzy plugh quux",  # pure nonsense
]


@pytest.mark.parametrize("phrase", UNSEEN_PHRASES)
def test_embedding_fallback_returns_known_skill_with_finite_confidence(
    phrase: str,
) -> None:
    assert parse_command_regex(phrase) is None, (
        f"{phrase!r} unexpectedly matched a regex; pick a truly unseen phrase"
    )
    result = _PARSER.parse(phrase)
    assert result.skill_name in KNOWN_SKILLS, (
        f"{phrase!r} -> unknown skill {result.skill_name!r}"
    )
    assert math.isfinite(result.confidence), (
        f"{phrase!r} confidence not finite: {result.confidence}"
    )
    assert 0.0 <= result.confidence <= 1.0, (
        f"{phrase!r} confidence out of [0,1]: {result.confidence}"
    )


@pytest.mark.parametrize("phrase", UNSEEN_PHRASES)
def test_fallback_phrases_still_produce_a_valid_velocity_command(
    phrase: str,
) -> None:
    """Every fallback path still yields a finite, in-cap velocity command."""
    cmd = _vel(phrase)
    for axis in cmd.as_tuple():
        assert math.isfinite(axis)
    assert abs(cmd.vx) <= MAX_FORWARD_SPEED_M_S + 1e-9
    assert abs(cmd.vy) <= MAX_LATERAL_SPEED_M_S + 1e-9
    assert abs(cmd.vyaw) <= MAX_YAW_RATE_RAD_S + 1e-9


def test_fallback_is_deterministic() -> None:
    """The bag-of-words encoder is a pure hash, so parsing is repeatable."""
    a = _PARSER.parse("amble onward gracefully")
    b = CommandParser().parse("amble onward gracefully")
    assert a.skill_name == b.skill_name
    assert a.confidence == pytest.approx(b.confidence)
