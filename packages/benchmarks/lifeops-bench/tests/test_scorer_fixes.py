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
    compile_benchmark_result,
    output_substring_match,
    score_scenario,
)
from eliza_lifeops_bench.types import (
    Action,
    Domain,
    FirstQuestionFallback,
    MessageTurn,
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
    terminated_reason: str = "respond",
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
        terminated_reason=terminated_reason,  # type: ignore[arg-type]
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
    # Names and structural kwarg aliases align after canonicalization.
    assert compare_actions(predicted, gt) == 1.0


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


def test_compare_actions_accepts_field_registry_action_discriminator_aliases() -> None:
    """Runtime field-registry `action` aliases score like canonical discriminators."""
    assert (
        compare_actions(
            [
                Action(
                    name="CALENDAR",
                    kwargs={
                        "action": "check_availability",
                        "startAt": "2026-05-14T09:00:00Z",
                        "endAt": "2026-05-14T10:00:00Z",
                    },
                )
            ],
            [
                Action(
                    name="CALENDAR",
                    kwargs={
                        "subaction": "check_availability",
                        "startAt": "2026-05-14T09:00:00Z",
                        "endAt": "2026-05-14T10:00:00Z",
                    },
                )
            ],
        )
        == 1.0
    )
    assert (
        compare_actions(
            [Action(name="MESSAGE", kwargs={"action": "list_inbox"})],
            [Action(name="MESSAGE", kwargs={"operation": "search_inbox"})],
        )
        == 1.0
    )


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


def test_kwargs_match_structural_aliases_are_equivalent() -> None:
    """Adapters and authored GT use both camelCase and snake_case fields."""
    expected = {
        "subaction": "check_availability",
        "startAt": "2026-05-14T09:00:00Z",
        "endAt": "2026-05-14T10:00:00Z",
    }
    predicted = {
        "subaction": "check_availability",
        "start": "2026-05-14T09:00:00Z",
        "end": "2026-05-14T10:00:00Z",
    }
    assert _kwargs_match(predicted, expected) is True


def test_kwargs_match_propose_times_window_can_be_same_day_superset() -> None:
    """A broader same-day search window still covers the requested slot window."""
    expected = {
        "subaction": "propose_times",
        "durationMinutes": 60,
        "slotCount": 3,
        "windowStart": "2026-05-12T13:00:00Z",
        "windowEnd": "2026-05-15T22:00:00Z",
    }
    predicted = {
        "subaction": "propose_times",
        "durationMinutes": 60,
        "slotCount": 3,
        "windowStart": "2026-05-12T00:00:00Z",
        "windowEnd": "2026-05-15T23:59:59Z",
    }
    assert _kwargs_match(predicted, expected) is True


def test_kwargs_match_intent_present_but_mismatched_is_ignored() -> None:
    """`intent` is prose documentation; executable kwargs decide the match."""
    expected = {"subaction": "x", "intent": "find a free hour on monday"}
    predicted = {"subaction": "x", "intent": "send an email to john"}
    assert _kwargs_match(predicted, expected) is True


# ---------------------------------------------------------------------------
# Bug 3: triviality-guard refinement — but really this is bug 1 + bug 2's
# downstream effect. Verify the integration end-to-end.
# ---------------------------------------------------------------------------


def test_score_scenario_state_match_plus_granular_action_no_longer_zeroed() -> None:
    """Repro for openclaw: granular action + state_hash=True is semantically successful."""
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
    # action_score is promoted to 1.0 because the state hash matched and the
    # action name matched after canonicalization.
    assert score == pytest.approx(1.0)


def test_output_substring_match_accepts_calendar_confirmation_synonym() -> None:
    """A successful calendar creation can say 'added to your calendar'."""
    matches = output_substring_match(
        [
            MessageTurn(
                role="assistant",
                content="Your 30-minute focus block was added to your calendar.",
            )
        ],
        ["scheduled", "focus block"],
    )

    assert matches == [True, True]


def test_output_substring_match_accepts_slot_plural() -> None:
    matches = output_substring_match(
        [MessageTurn(role="assistant", content="Here are three slots.")],
        ["slot"],
    )

    assert matches == [True]


def test_output_substring_match_accepts_24_hour_time_for_pm_requirement() -> None:
    """`15:00 UTC` is the same output fact as `3pm`."""
    matches = output_substring_match(
        [
            MessageTurn(
                role="assistant",
                content='I moved "Sync: the roadmap" to 15:00-17:00 UTC.',
            )
        ],
        ["3pm", "roadmap"],
    )

    assert matches == [True, True]


def test_output_substring_match_accepts_pm_punctuation_spacing() -> None:
    """Human spelling variants such as `p.m.` should not miss the time check."""
    matches = output_substring_match(
        [
            MessageTurn(
                role="assistant",
                content="The meeting is now set for 3 p.m.",
            )
        ],
        ["15:00"],
    )

    assert matches == [True]


def test_output_substring_match_accepts_utc_time_for_am_requirement() -> None:
    """A 24-hour morning time should match the equivalent `am` requirement."""
    matches = output_substring_match(
        [
            MessageTurn(
                role="assistant",
                content="Your deep work block is scheduled at 10:00 UTC.",
            )
        ],
        ["10am"],
    )

    assert matches == [True]


def test_output_substring_match_rejects_different_clock_time() -> None:
    """The time equivalence layer must not turn any hour-like text into a hit."""
    matches = output_substring_match(
        [
            MessageTurn(
                role="assistant",
                content="I moved it to 13:00 UTC and added a 3 minute buffer.",
            )
        ],
        ["3pm"],
    )

    assert matches == [False]


def test_output_substring_match_normalizes_unicode_hyphen() -> None:
    """Scenario-authored nonbreaking hyphens should match normal hyphen output."""
    matches = output_substring_match(
        [
            MessageTurn(
                role="assistant",
                content="Your wind-down reminder is scheduled.",
            )
        ],
        ["wind‑down"],
    )

    assert matches == [True]


def test_output_substring_match_rejects_embedded_word() -> None:
    """Required output terms must not match inside unrelated words."""
    matches = output_substring_match(
        [
            MessageTurn(
                role="assistant",
                content="The email is already archived.",
            )
        ],
        ["read"],
    )

    assert matches == [False]


def test_score_scenario_state_match_plus_partial_action_and_synonym_passes() -> None:
    """Cerebras smoke: correct state + alias kwargs + calendar confirmation should pass."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "title": "deep work",
                    "details": {
                        "calendarId": "cal_primary",
                        "start": "2026-05-11T10:00:00Z",
                        "end": "2026-05-11T10:30:00Z",
                    },
                },
            )
        ],
        required_outputs=["scheduled", "deep work"],
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "title": "deep work",
                    "start_time": "2026-05-11T10:00:00Z",
                    "duration_minutes": 30,
                },
            )
        ],
        output_substring_matches=[True, True],
    )

    assert score_scenario(result, scenario) == pytest.approx(1.0)


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


def test_score_scenario_readonly_same_action_wrong_kwargs_scores_zero() -> None:
    """State hash cannot validate read-only lookups, so wrong params get no credit."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "check_availability",
                    "startAt": "2026-05-14T09:00:00Z",
                    "endAt": "2026-05-14T10:00:00Z",
                },
            )
        ],
        required_outputs=["free"],
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "check_availability",
                    "start": "2026-05-14T11:00:00Z",
                    "end": "2026-05-14T12:00:00Z",
                },
            )
        ],
        required_outputs=["free"],
        output_substring_matches=[True],
    )

    assert score_scenario(result, scenario) == 0.0


def test_score_scheduled_task_create_structural_fields_affect_state_hash() -> None:
    """ScheduledTask fields are now modeled, so missing structure changes state."""
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.scorer import state_hash

    scenario = _scenario(
        domain=Domain.SLEEP,
        ground_truth_actions=[
            Action(
                name="SCHEDULED_TASK_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "reminder",
                    "promptInstructions": "Wind down",
                    "trigger": {"atIso": "2026-05-10T22:00:00Z"},
                    "subject": {"kind": "self", "id": "me"},
                    "pipeline": {"onComplete": ["task_followup"]},
                },
            )
        ],
    )
    expected_world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    actual_world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    _execute_action(scenario.ground_truth_actions[0], expected_world)
    _execute_action(
        Action(
            name="SCHEDULED_TASK_CREATE",
            kwargs={
                "subaction": "create",
                "kind": "reminder",
                "promptInstructions": "Wind down",
                "trigger": {"atIso": "2026-05-10T22:00:00Z"},
            },
        ),
        actual_world,
    )
    assert state_hash(actual_world) != state_hash(expected_world)

    result = _result(
        state_hash_match=False,
        agent_actions=[
            Action(
                name="SCHEDULED_TASK_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "reminder",
                    "promptInstructions": "Wind down",
                    "trigger": {"atIso": "2026-05-10T22:00:00Z"},
                },
            )
        ],
    )

    assert score_scenario(result, scenario) < 1.0


def test_score_scheduled_task_plural_alias_matches_singular_ground_truth() -> None:
    scenario = _scenario(
        domain=Domain.SLEEP,
        ground_truth_actions=[
            Action(
                name="SCHEDULED_TASK_CREATE",
                kwargs={
                    "kind": "reminder",
                    "promptInstructions": "Wind down",
                    "trigger": {"atIso": "2026-05-10T22:00:00Z"},
                },
            )
        ],
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(
                name="SCHEDULED_TASKS_CREATE",
                kwargs={
                    "kind": "reminder",
                    "prompt_instructions": "Wind down",
                    "trigger": {"at_iso": "2026-05-10T22:00:00Z"},
                },
            )
        ],
    )

    assert score_scenario(result, scenario) == 1.0


def test_compile_benchmark_result_counts_missing_expected_runs_as_failures() -> None:
    """pass@1 is over expected scenario/seed pairs, not only returned rows."""
    scenario_a = _scenario(ground_truth_actions=[])
    scenario_b = Scenario(
        id="missing_scenario",
        name="missing",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="",
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=1,
    )
    result_a = _result(state_hash_match=True, agent_actions=[])
    aggregate = compile_benchmark_result(
        [result_a],
        {scenario_a.id: scenario_a, scenario_b.id: scenario_b},
        seeds=1,
        model_name="m",
        judge_model_name="j",
        timestamp="2026-05-12T00:00:00Z",
    )

    assert aggregate.pass_at_1 == pytest.approx(0.5)
    assert aggregate.mean_score_per_domain["calendar"] == pytest.approx(0.5)


def test_live_score_requires_judge_satisfaction() -> None:
    """LIVE mode must not pass just because no scripted state changed."""
    scenario = Scenario(
        id="live.test",
        name="live",
        domain=Domain.MAIL,
        mode=ScenarioMode.LIVE,
        persona=_PERSONA,
        instruction="draft the reply",
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=0,
    )
    unsatisfied = _result(
        state_hash_match=True,
        agent_actions=[],
        terminated_reason="max_turns",
    )
    satisfied = _result(
        state_hash_match=True,
        agent_actions=[],
        terminated_reason="satisfied",
    )

    assert score_scenario(unsatisfied, scenario) == 0.0
    assert score_scenario(satisfied, scenario) == pytest.approx(1.0)
