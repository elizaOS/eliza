"""Unit tests for the three scorer fixes (W4-A, 2026-05-11).

Bug 1: granular `<UMBRELLA>_<SUBACTION>` action names must compare equal to
       umbrella `<UMBRELLA>(subaction=<sub>)` form.
Bug 2: `intent` and other documentation-only kwargs must not penalize a
       match when expected-but-missing on the predicted side.
Bug 3: state_hash_match=True + structurally-correct action must not be
       zeroed by the triviality guard.

Each test below is keyed to one of the three bugs and verifies the fix
without re-running the agents.
"""

from __future__ import annotations

import pytest

from eliza_lifeops_bench.scorer import (
    _canonicalize_action,
    _kwargs_match,
    compare_actions,
    score_scenario,
)
from eliza_lifeops_bench.types import (
    Action,
    Domain,
    FirstQuestionFallback,
    Persona,
    Scenario,
    ScenarioMode,
    ScenarioResult,
    TurnResult,
)


_PERSONA = Persona(
    id="t",
    name="t",
    traits=[],
    background="",
    communication_style="terse",
)


def _scenario(
    *,
    ground_truth_actions: list[Action],
    required_outputs: list[str] | None = None,
    domain: Domain = Domain.CALENDAR,
) -> Scenario:
    return Scenario(
        id="t_scenario",
        name="t",
        domain=domain,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="",
        ground_truth_actions=ground_truth_actions,
        required_outputs=required_outputs or [],
        first_question_fallback=None,
        world_seed=0,
        max_turns=4,
    )


def _result(
    *,
    state_hash_match: bool,
    agent_actions: list[Action],
    required_outputs: list[str] | None = None,
    output_substring_matches: list[bool] | None = None,
) -> ScenarioResult:
    turns = [
        TurnResult(
            turn_number=1,
            agent_message="",
            agent_actions=agent_actions,
            user_response="",
            latency_ms=0,
            input_tokens=0,
            output_tokens=0,
            cost_usd=0.0,
        )
    ]
    matches = output_substring_matches or [False] * len(required_outputs or [])
    return ScenarioResult(
        scenario_id="t_scenario",
        seed=0,
        turns=turns,
        state_hash_match=state_hash_match,
        output_substring_matches=matches,
        total_score=0.0,
        max_score=1.0,
        terminated_reason="respond",
        total_cost_usd=0.0,
        total_latency_ms=0,
    )


# ---------------------------------------------------------------------------
# Bug 1: name aliasing
# ---------------------------------------------------------------------------


def test_canonicalize_granular_action_to_umbrella() -> None:
    """`CALENDAR_CHECK_AVAILABILITY` canonicalizes to `CALENDAR(subaction=check_availability)`."""
    granular = Action(
        name="CALENDAR_CHECK_AVAILABILITY",
        kwargs={"start": "2026-05-14T09:00:00Z", "end": "2026-05-14T10:00:00Z"},
    )
    canon = _canonicalize_action(granular)
    assert canon.name == "CALENDAR"
    assert canon.kwargs["subaction"] == "check_availability"
    assert canon.kwargs["start"] == "2026-05-14T09:00:00Z"
    assert canon.kwargs["end"] == "2026-05-14T10:00:00Z"


def test_canonicalize_unknown_granular_is_noop() -> None:
    """Names that don't match a known umbrella stay untouched."""
    action = Action(name="BLOCK_BLOCK", kwargs={})
    assert _canonicalize_action(action) is action


def test_canonicalize_umbrella_is_noop() -> None:
    """Already-umbrella actions are not modified."""
    action = Action(name="CALENDAR", kwargs={"subaction": "next_event"})
    canon = _canonicalize_action(action)
    assert canon.name == "CALENDAR"
    assert canon.kwargs == {"subaction": "next_event"}


def test_compare_actions_granular_matches_umbrella_gt() -> None:
    """Agent emits granular; GT in umbrella form — score should be ≥ 0.5 (partial)."""
    gt = [
        Action(
            name="CALENDAR",
            kwargs={
                "subaction": "check_availability",
                "startAt": "2026-05-14T09:00:00Z",
                "endAt": "2026-05-14T10:00:00Z",
            },
        )
    ]
    predicted = [
        Action(
            name="CALENDAR_CHECK_AVAILABILITY",
            kwargs={
                "start": "2026-05-14T09:00:00Z",
                "end": "2026-05-14T10:00:00Z",
            },
        )
    ]
    # Names align after canonicalization; kwargs partial overlap (different
    # key naming `startAt`/`start`), so 0.5 partial credit.
    assert compare_actions(predicted, gt) == 0.5


def test_compare_actions_umbrella_matches_granular_gt() -> None:
    """Reverse direction: GT granular, agent umbrella."""
    gt = [
        Action(
            name="CALENDAR_NEXT_EVENT",
            kwargs={},
        )
    ]
    predicted = [
        Action(
            name="CALENDAR",
            kwargs={"subaction": "next_event"},
        )
    ]
    assert compare_actions(predicted, gt) == 1.0


# ---------------------------------------------------------------------------
# Bug 2: `intent` is a soft kwarg
# ---------------------------------------------------------------------------


def test_kwargs_match_intent_missing_is_ok() -> None:
    """Missing `intent` on the predicted side should not break the match."""
    expected = {
        "subaction": "next_event",
        "intent": "what is the next upcoming event on my calendars",
    }
    predicted = {"subaction": "next_event"}
    assert _kwargs_match(predicted, expected) is True


def test_kwargs_match_other_soft_kwargs_missing_is_ok() -> None:
    """`rationale`, `thought`, `reasoning` are all soft."""
    for soft in ("rationale", "thought", "reasoning"):
        expected = {"subaction": "x", soft: "free-form prose"}
        predicted = {"subaction": "x"}
        assert _kwargs_match(predicted, expected) is True, soft


def test_kwargs_match_required_field_missing_still_fails() -> None:
    """A hard required kwarg missing on predicted still breaks the match."""
    expected = {"subaction": "next_event", "calendarId": "cal_primary"}
    predicted = {"subaction": "next_event"}
    assert _kwargs_match(predicted, expected) is False


def test_kwargs_match_intent_present_but_mismatched_still_fails() -> None:
    """If predicted DOES emit `intent`, the value still has to match."""
    expected = {"subaction": "x", "intent": "find a free hour on monday"}
    predicted = {"subaction": "x", "intent": "send an email to john"}
    assert _kwargs_match(predicted, expected) is False


# ---------------------------------------------------------------------------
# Bug 3: triviality-guard refinement — but really this is bug 1 + bug 2's
# downstream effect. Verify the integration end-to-end.
# ---------------------------------------------------------------------------


def test_score_scenario_state_match_plus_granular_action_no_longer_zeroed() -> None:
    """Repro for openclaw: granular action + state_hash=True must score > 0."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "check_availability",
                    "intent": "is the owner free 2026-05-14T09:00 to 10:00 UTC",
                    "startAt": "2026-05-14T09:00:00Z",
                    "endAt": "2026-05-14T10:00:00Z",
                },
            )
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(
                name="CALENDAR_CHECK_AVAILABILITY",
                kwargs={
                    "start": "2026-05-14T09:00:00Z",
                    "end": "2026-05-14T10:00:00Z",
                },
            )
        ],
    )
    score = score_scenario(result, scenario)
    # action_score=0.5 (name match, kwargs differ on naming), state_score=1.0,
    # substring_score=1.0 (no required outputs).
    # 0.5*1.0 + 0.4*0.5 + 0.1*1.0 = 0.80.
    assert score == pytest.approx(0.80)


def test_score_scenario_hermes_intent_only_gap_now_full_credit() -> None:
    """Repro for hermes: only diff was the soft `intent` kwarg. Should be 1.0."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "next_event",
                    "intent": "what is the next upcoming event on my calendars",
                },
            )
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(
                name="CALENDAR",
                kwargs={"subaction": "next_event"},
            )
        ],
    )
    score = score_scenario(result, scenario)
    # action_score=1.0 (intent is soft), state_score=1.0, substring=1.0.
    assert score == pytest.approx(1.0)


def test_score_scenario_triviality_guard_still_zeros_wrong_action() -> None:
    """Negative control: agent emits a wrong action, state_hash matches — must still be 0."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={"subaction": "next_event"},
            )
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[Action(name="MAIL", kwargs={"operation": "send"})],
    )
    score = score_scenario(result, scenario)
    assert score == 0.0


def test_score_scenario_triviality_guard_still_zeros_no_action() -> None:
    """Negative control: do-nothing agent on a read-only scenario must score 0."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={"subaction": "next_event"},
            )
        ]
    )
    result = _result(state_hash_match=True, agent_actions=[])
    score = score_scenario(result, scenario)
    assert score == 0.0
