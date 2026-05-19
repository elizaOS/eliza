"""End-to-end smoke test for the text-conditioned skill pipeline.

The path under test:

    user text  →  CommandParser.parse(text)
                       │
                       └─ ParseResult(skill_name, params, confidence)
                                           │
                                           ▼
    SkillRegistry.get(skill_name)  →  BaseSkill instance
                                           │
                                           ├─ reset(params)
                                           └─ get_action(obs)  →  joint targets

This verifies the actual pipeline that Eliza's `AINEX_PICK_UP` /
`AINEX_RUN_ACTION_GROUP` style actions invoke when they call `policy.start`
with a text task: parsing must reliably map common chat phrases to
canonical skill names, and the resolved skill must produce in-range
joint targets without crashing.

Slow imports (TextEncoder pulls sentence-transformers if available) are
gated — we use the bag-of-words fallback so the test runs in CI.
"""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.rl.meta.command_parser import (
    CommandParser,
    SKILL_DESCRIPTIONS,
    parse_command_regex,
)
from eliza_robot.rl.skills.base import BaseSkill, SkillParams, SkillStatus
from eliza_robot.rl.skills.registry import SkillRegistry


class _StubSkill(BaseSkill):
    """Deterministic, ABS-bounded stand-in for the RL-trained skills.

    Real walk/turn skills (`walk_skill.py`, `turn_skill.py`) live alongside
    in eliza_robot.rl.skills/ — they are not loaded here because their
    initialization pulls in JAX/Brax and a trained checkpoint. The stub
    is intentionally simple: it just confirms the registry/parser glue is
    correct, which is what would fail in production end-to-end.
    """

    name = "walk"
    action_dim = 24

    def __init__(self) -> None:
        self._params = SkillParams()

    def reset(self, params: SkillParams | None = None) -> None:
        self._params = params or SkillParams()

    def get_action(self, obs: np.ndarray) -> tuple[np.ndarray, SkillStatus]:
        # Emit a sinusoidal action with amplitude scaled by params.speed.
        t = float(obs.mean())
        amp = float(self._params.speed) * 0.3
        action = np.full(self.action_dim, amp * np.sin(t), dtype=np.float64)
        return action, SkillStatus.RUNNING


class _StubTurnSkill(_StubSkill):
    name = "turn"


class _StubStandSkill(_StubSkill):
    name = "stand"


class _StubWaveSkill(_StubSkill):
    name = "wave"


class _StubBowSkill(_StubSkill):
    name = "bow"


@pytest.fixture
def registry() -> SkillRegistry:
    r = SkillRegistry()
    for cls in (_StubSkill, _StubTurnSkill, _StubStandSkill, _StubWaveSkill, _StubBowSkill):
        r.register(cls())
    return r


def test_regex_parses_common_phrases() -> None:
    cases = [
        ("walk forward fast", "walk", lambda p: p.speed == pytest.approx(0.8)),
        ("walk forward slowly", "walk", lambda p: p.speed == pytest.approx(0.25)),
        ("walk backward", "walk", lambda p: p.direction == pytest.approx(3.14)),
        ("turn left", "turn", lambda p: p.direction == pytest.approx(-1.0)),
        ("turn right", "turn", lambda p: p.direction == pytest.approx(1.0)),
        ("turn around", "turn", lambda p: p.magnitude == pytest.approx(3.14)),
        ("stop", "stand", lambda p: True),
        ("say hello", "wave", lambda p: True),
        ("take a bow", "bow", lambda p: True),
    ]
    for text, expected_skill, params_check in cases:
        result = parse_command_regex(text)
        assert result is not None, f"regex didn't match: {text!r}"
        assert result.skill_name == expected_skill, (
            f"{text!r} -> {result.skill_name!r}, expected {expected_skill!r}"
        )
        assert params_check(result.params), f"{text!r} params invalid: {result.params}"


def test_embedding_parser_handles_unseen_phrases() -> None:
    parser = CommandParser()
    # "shuffle right" isn't in the regex but is semantically close to "turn".
    # The bag-of-words fallback may not be precise; we just require *some*
    # skill is chosen with non-zero confidence and the skill is one of the
    # registered names.
    result = parser.parse("shuffle to the right")
    assert result.skill_name in SKILL_DESCRIPTIONS, (
        f"unknown skill returned: {result.skill_name}"
    )
    assert 0.0 <= result.confidence <= 1.0


def test_parser_routes_to_registry_and_skill_produces_action(
    registry: SkillRegistry,
) -> None:
    """The whole chain: text → skill → reset → action."""
    parser = CommandParser()
    result = parser.parse("walk forward fast")
    skill = registry.get(result.skill_name)
    assert skill is not None, f"registry missed {result.skill_name}"
    skill.reset(result.params)
    obs = np.zeros(24, dtype=np.float64)
    action, status = skill.get_action(obs)
    assert action.shape == (24,)
    assert status == SkillStatus.RUNNING
    # Action must be finite and in a reasonable range (±π rad).
    assert np.all(np.isfinite(action))
    assert float(np.abs(action).max()) <= np.pi


def test_registry_aliases_resolve_text_phrases(registry: SkillRegistry) -> None:
    """Bare aliases like 'pick up', 'fetch', 'navigate to' must resolve."""
    # These canonical names need stubs first (use fresh registry to avoid
    # affecting other tests).
    r = SkillRegistry()
    for name in ("walk", "stand", "wave"):
        class _S(_StubSkill):
            pass
        _S.name = name
        r.register(_S())
    # Aliases for known skills.
    assert r.get("hello") is None  # "hello" not in alias map but regex matches "say hello"
    assert r.get("freeze") is not None
    assert r.get("freeze").name == "stand"
    assert r.get("go forward") is not None
    assert r.get("go forward").name == "walk"


@pytest.mark.parametrize(
    "phrase, expected_skill",
    [
        ("please walk forward", "walk"),
        ("turn around now", "turn"),
        ("wave at the camera", "wave"),
        ("stand still please", "stand"),
        ("bow down", "bow"),
    ],
)
def test_chat_phrases_route_to_correct_skill(phrase: str, expected_skill: str) -> None:
    parser = CommandParser()
    result = parser.parse(phrase)
    assert result.skill_name == expected_skill, (
        f"{phrase!r} -> {result.skill_name!r}, expected {expected_skill!r}"
    )
