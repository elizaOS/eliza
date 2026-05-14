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
    _classify_scenario_kind,
    _is_read_only_action,
    _is_read_with_side_effects_action,
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
    # `WIDGET_FOO` is a deliberate non-umbrella name. (Previously this used
    # `BLOCK_BLOCK`, which became a real umbrella alias as of P0-1.)
    action = Action(name="WIDGET_FOO", kwargs={})
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
    """Repro for openclaw: granular action + state_hash=True is no longer zeroed.

    The agent emits CALENDAR_CHECK_AVAILABILITY with `start`/`end` kwargs while
    the GT uses `startAt`/`endAt`. The `_KWARG_ALIASES` table maps startAt→start
    and endAt→end, so these are equivalent. `intent` is in `_SOFT_KWARGS` so
    its absence doesn't penalize. Result: full action match → 1.0.

    NOTE: earlier versions of this test expected 0.65 (partial credit at 0.5)
    because the kwarg alias table didn't yet normalize `startAt`→`start`. The
    alias was added in the W4-A kwarg canonicalization pass. The correct
    expectation is now 1.0.

    READ weights: 0.1 state + 0.7 action + 0.2 substring.
    state=1.0, action=1.0 (kwargs match via aliases), substring=1.0.
    → 0.1 + 0.7 + 0.2 = 1.0.
    """
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
    # startAt→start alias + intent is soft → full action match → 1.0
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


# ---------------------------------------------------------------------------
# P0-1: extended _UMBRELLA_SUBACTIONS + OWNER_* aliases
#
# Each row asserts that a granular emission canonicalizes to the same
# umbrella shape as the GT, so compare_actions awards >= 0.5 (name match,
# kwarg overlap not required).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("granular_name", "umbrella", "subaction"),
    [
        # LIFE — reminders / alarms write-ops
        ("LIFE_CREATE", "LIFE", "create"),
        ("LIFE_COMPLETE", "LIFE", "complete"),
        ("LIFE_SNOOZE", "LIFE", "snooze"),
        ("LIFE_REVIEW", "LIFE", "review"),
        ("LIFE_DELETE", "LIFE", "delete"),
        ("LIFE_UPDATE", "LIFE", "update"),
        ("LIFE_SKIP", "LIFE", "skip"),
        ("LIFE_LIST", "LIFE", "list"),
        # HEALTH — read-ops
        ("HEALTH_TODAY", "HEALTH", "today"),
        ("HEALTH_TREND", "HEALTH", "trend"),
        ("HEALTH_BY_METRIC", "HEALTH", "by_metric"),
        ("HEALTH_STATUS", "HEALTH", "status"),
        # BLOCK — focus/DND
        ("BLOCK_BLOCK", "BLOCK", "block"),
        ("BLOCK_UNBLOCK", "BLOCK", "unblock"),
        ("BLOCK_STATUS", "BLOCK", "status"),
        ("BLOCK_REQUEST_PERMISSION", "BLOCK", "request_permission"),
        ("BLOCK_RELEASE", "BLOCK", "release"),
        ("BLOCK_LIST_ACTIVE", "BLOCK", "list_active"),
        # ENTITY — contacts
        ("ENTITY_ADD", "ENTITY", "add"),
        ("ENTITY_SET_IDENTITY", "ENTITY", "set_identity"),
        ("ENTITY_LOG_INTERACTION", "ENTITY", "log_interaction"),
        ("ENTITY_LIST", "ENTITY", "list"),
        ("ENTITY_MERGE", "ENTITY", "merge"),
        # SCHEDULED_TASK — delayed-task primitives
        ("SCHEDULED_TASK_CREATE", "SCHEDULED_TASK", "create"),
        ("SCHEDULED_TASK_UPDATE", "SCHEDULED_TASK", "update"),
        ("SCHEDULED_TASK_SNOOZE", "SCHEDULED_TASK", "snooze"),
        ("SCHEDULED_TASK_CANCEL", "SCHEDULED_TASK", "cancel"),
        ("SCHEDULED_TASK_COMPLETE", "SCHEDULED_TASK", "complete"),
        ("SCHEDULED_TASK_LIST", "SCHEDULED_TASK", "list"),
        # MONEY — finance
        ("MONEY_DASHBOARD", "MONEY", "dashboard"),
        ("MONEY_LIST_SOURCES", "MONEY", "list_sources"),
        ("MONEY_LIST_TRANSACTIONS", "MONEY", "list_transactions"),
        ("MONEY_SPENDING_SUMMARY", "MONEY", "spending_summary"),
        ("MONEY_RECURRING_CHARGES", "MONEY", "recurring_charges"),
        ("MONEY_ADD_SOURCE", "MONEY", "add_source"),
        ("MONEY_REMOVE_SOURCE", "MONEY", "remove_source"),
        ("MONEY_IMPORT_CSV", "MONEY", "import_csv"),
        ("MONEY_SUBSCRIPTION_AUDIT", "MONEY", "subscription_audit"),
        ("MONEY_SUBSCRIPTION_CANCEL", "MONEY", "subscription_cancel"),
        ("MONEY_SUBSCRIPTION_STATUS", "MONEY", "subscription_status"),
        # BOOK_TRAVEL
        ("BOOK_TRAVEL_SEARCH", "BOOK_TRAVEL", "search"),
        ("BOOK_TRAVEL_PREPARE", "BOOK_TRAVEL", "prepare"),
        ("BOOK_TRAVEL_BOOK", "BOOK_TRAVEL", "book"),
        ("BOOK_TRAVEL_CANCEL", "BOOK_TRAVEL", "cancel"),
        ("BOOK_TRAVEL_HOLD", "BOOK_TRAVEL", "hold"),
    ],
)
def test_canonicalize_extended_umbrellas(
    granular_name: str, umbrella: str, subaction: str
) -> None:
    """Each new umbrella subaction folds the granular emission into umbrella shape."""
    canon = _canonicalize_action(Action(name=granular_name, kwargs={}))
    assert canon.name == umbrella
    assert canon.kwargs["subaction"] == subaction


@pytest.mark.parametrize(
    ("granular_name", "umbrella", "subaction"),
    [
        ("LIFE_CREATE", "LIFE", "create"),
        ("HEALTH_TODAY", "HEALTH", "today"),
        ("BLOCK_BLOCK", "BLOCK", "block"),
        ("ENTITY_ADD", "ENTITY", "add"),
        ("SCHEDULED_TASK_CREATE", "SCHEDULED_TASK", "create"),
        ("MONEY_DASHBOARD", "MONEY", "dashboard"),
        ("BOOK_TRAVEL_SEARCH", "BOOK_TRAVEL", "search"),
    ],
)
def test_compare_actions_extended_umbrella_happy_path(
    granular_name: str, umbrella: str, subaction: str
) -> None:
    """Granular agent emission scores full credit against umbrella GT."""
    gt = [Action(name=umbrella, kwargs={"subaction": subaction})]
    predicted = [Action(name=granular_name, kwargs={})]
    # subaction kwarg is provided by canonicalization, so this is a full match.
    assert compare_actions(predicted, gt) == pytest.approx(1.0)


@pytest.mark.parametrize(
    ("granular_name", "umbrella", "wrong_subaction"),
    [
        # Granular emission with subaction X, GT with a different subaction
        # Y in the same umbrella. After canonicalization the names match
        # (umbrella) but the subaction kwarg disagrees, so partial credit
        # (0.5) applies and full credit (1.0) does NOT.
        ("LIFE_CREATE", "LIFE", "delete"),
        ("HEALTH_TODAY", "HEALTH", "trend"),
        ("BLOCK_BLOCK", "BLOCK", "unblock"),
        ("ENTITY_ADD", "ENTITY", "merge"),
        ("SCHEDULED_TASK_CREATE", "SCHEDULED_TASK", "cancel"),
        ("MONEY_DASHBOARD", "MONEY", "subscription_audit"),
        ("BOOK_TRAVEL_SEARCH", "BOOK_TRAVEL", "cancel"),
    ],
)
def test_compare_actions_extended_umbrella_wrong_subaction(
    granular_name: str, umbrella: str, wrong_subaction: str
) -> None:
    """Mismatched subaction within the same umbrella drops to 0.5 (name-only credit)."""
    gt = [Action(name=umbrella, kwargs={"subaction": wrong_subaction})]
    predicted = [Action(name=granular_name, kwargs={})]
    assert compare_actions(predicted, gt) == pytest.approx(0.5)


# ---------------------------------------------------------------------------
# P0-1: OWNER_* surface aliases
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("owner_name", "umbrella", "subaction"),
    [
        # OWNER_HEALTH_* → HEALTH(subaction=*)
        ("OWNER_HEALTH_TODAY", "HEALTH", "today"),
        ("OWNER_HEALTH_TREND", "HEALTH", "trend"),
        ("OWNER_HEALTH_BY_METRIC", "HEALTH", "by_metric"),
        ("OWNER_HEALTH_STATUS", "HEALTH", "status"),
        # OWNER_ALARMS_* → LIFE(subaction=*) (alarm semantics carried by kwargs)
        ("OWNER_ALARMS_CREATE", "LIFE", "create"),
        ("OWNER_ALARMS_COMPLETE", "LIFE", "complete"),
        ("OWNER_ALARMS_SNOOZE", "LIFE", "snooze"),
        ("OWNER_ALARMS_LIST", "LIFE", "list"),
        # OWNER_REMINDERS_* → LIFE(subaction=*)
        ("OWNER_REMINDERS_CREATE", "LIFE", "create"),
        ("OWNER_REMINDERS_COMPLETE", "LIFE", "complete"),
        ("OWNER_REMINDERS_DELETE", "LIFE", "delete"),
        ("OWNER_REMINDERS_LIST", "LIFE", "list"),
        # OWNER_FINANCES_* → MONEY(subaction=*)
        ("OWNER_FINANCES_DASHBOARD", "MONEY", "dashboard"),
        ("OWNER_FINANCES_LIST_TRANSACTIONS", "MONEY", "list_transactions"),
        ("OWNER_FINANCES_SPENDING_SUMMARY", "MONEY", "spending_summary"),
        ("OWNER_FINANCES_SUBSCRIPTION_AUDIT", "MONEY", "subscription_audit"),
    ],
)
def test_canonicalize_owner_surface_aliases(
    owner_name: str, umbrella: str, subaction: str
) -> None:
    """Each `OWNER_<AREA>_<SUB>` folds into its umbrella with subaction=<sub>."""
    canon = _canonicalize_action(Action(name=owner_name, kwargs={}))
    assert canon.name == umbrella
    assert canon.kwargs["subaction"] == subaction


@pytest.mark.parametrize(
    ("owner_name", "umbrella", "subaction"),
    [
        ("OWNER_HEALTH_TODAY", "HEALTH", "today"),
        ("OWNER_ALARMS_CREATE", "LIFE", "create"),
        ("OWNER_REMINDERS_CREATE", "LIFE", "create"),
        ("OWNER_FINANCES_DASHBOARD", "MONEY", "dashboard"),
    ],
)
def test_compare_actions_owner_alias_happy_path(
    owner_name: str, umbrella: str, subaction: str
) -> None:
    """Owner-surface emission scores 1.0 against umbrella GT after folding."""
    gt = [Action(name=umbrella, kwargs={"subaction": subaction})]
    predicted = [Action(name=owner_name, kwargs={})]
    assert compare_actions(predicted, gt) == pytest.approx(1.0)


@pytest.mark.parametrize(
    ("owner_name", "umbrella", "wrong_subaction"),
    [
        ("OWNER_HEALTH_TODAY", "HEALTH", "trend"),
        ("OWNER_ALARMS_CREATE", "LIFE", "delete"),
        ("OWNER_FINANCES_DASHBOARD", "MONEY", "subscription_audit"),
    ],
)
def test_compare_actions_owner_alias_wrong_subaction(
    owner_name: str, umbrella: str, wrong_subaction: str
) -> None:
    """Owner-surface alias against the wrong subaction lands at 0.5 (name-only credit)."""
    gt = [Action(name=umbrella, kwargs={"subaction": wrong_subaction})]
    predicted = [Action(name=owner_name, kwargs={})]
    assert compare_actions(predicted, gt) == pytest.approx(0.5)


def test_canonicalize_personal_assistant_book_travel_alias() -> None:
    """`PERSONAL_ASSISTANT_BOOK_TRAVEL` folds into the `BOOK_TRAVEL` umbrella."""
    action = Action(
        name="PERSONAL_ASSISTANT_BOOK_TRAVEL",
        kwargs={"subaction": "search", "origin": "SFO", "destination": "JFK"},
    )
    canon = _canonicalize_action(action)
    assert canon.name == "BOOK_TRAVEL"
    assert canon.kwargs == {
        "subaction": "search",
        "origin": "SFO",
        "destination": "JFK",
    }


def test_compare_actions_personal_assistant_book_travel_matches_umbrella() -> None:
    """The shorthand emission scores full credit against `BOOK_TRAVEL` GT."""
    gt = [
        Action(
            name="BOOK_TRAVEL",
            kwargs={"subaction": "search", "origin": "SFO", "destination": "JFK"},
        )
    ]
    predicted = [
        Action(
            name="PERSONAL_ASSISTANT_BOOK_TRAVEL",
            kwargs={"subaction": "search", "origin": "SFO", "destination": "JFK"},
        )
    ]
    assert compare_actions(predicted, gt) == pytest.approx(1.0)


def test_canonicalize_unknown_owner_surface_is_noop() -> None:
    """An `OWNER_<AREA>` not in the alias map is left alone."""
    action = Action(name="OWNER_LIBRARY_LIST", kwargs={})
    assert _canonicalize_action(action) is action


# ---------------------------------------------------------------------------
# P0-1 follow-up: subaction names added in the W6-1 second-pass review.
#
# Each row is a subaction that exists in the action source-of-truth
# (`plugins/app-lifeops/src/actions/`) or `runner._DISCRIMINATORS` but
# was missing from the original `_UMBRELLA_SUBACTIONS` table. The bench
# saw both spellings in real trajectories, so adding them prevents a
# silent 0-score on otherwise-correct emissions.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("granular_name", "umbrella", "subaction"),
    [
        # HEALTH 3-way drift: runner uses `trends`+`summary`, manifest
        # uses `trend`+`today`+`status`. Both views must canonicalize.
        ("HEALTH_TRENDS", "HEALTH", "trends"),
        ("HEALTH_SUMMARY", "HEALTH", "summary"),
        # LIFE policy-shape subactions from `life.ts`.
        ("LIFE_POLICY_SET_REMINDER", "LIFE", "policy_set_reminder"),
        ("LIFE_POLICY_CONFIGURE_ESCALATION", "LIFE", "policy_configure_escalation"),
        # SCHEDULED_TASK subactions present in `scheduled-task.ts`
        # SUBACTIONS but absent from the original table.
        ("SCHEDULED_TASK_GET", "SCHEDULED_TASK", "get"),
        ("SCHEDULED_TASK_SKIP", "SCHEDULED_TASK", "skip"),
        ("SCHEDULED_TASK_ACKNOWLEDGE", "SCHEDULED_TASK", "acknowledge"),
        ("SCHEDULED_TASK_DISMISS", "SCHEDULED_TASK", "dismiss"),
        ("SCHEDULED_TASK_REOPEN", "SCHEDULED_TASK", "reopen"),
        ("SCHEDULED_TASK_HISTORY", "SCHEDULED_TASK", "history"),
        # ENTITY set_relationship surface emitted by some agents.
        ("ENTITY_SET_RELATIONSHIP", "ENTITY", "set_relationship"),
    ],
)
def test_canonicalize_extended_umbrellas_second_pass(
    granular_name: str, umbrella: str, subaction: str
) -> None:
    """Subactions added in the W6-1 second-pass review fold cleanly."""
    canon = _canonicalize_action(Action(name=granular_name, kwargs={}))
    assert canon.name == umbrella
    assert canon.kwargs["subaction"] == subaction


@pytest.mark.parametrize(
    ("owner_name", "umbrella", "subaction"),
    [
        # OWNER_TODOS / OWNER_GOALS / OWNER_ROUTINES → LIFE (see
        # `plugins/app-lifeops/src/actions/owner-surfaces.ts` for the
        # owner-surface action publishing list).
        ("OWNER_TODOS_CREATE", "LIFE", "create"),
        ("OWNER_TODOS_COMPLETE", "LIFE", "complete"),
        ("OWNER_GOALS_CREATE", "LIFE", "create"),
        ("OWNER_GOALS_REVIEW", "LIFE", "review"),
        ("OWNER_ROUTINES_CREATE", "LIFE", "create"),
        ("OWNER_ROUTINES_SKIP", "LIFE", "skip"),
    ],
)
def test_canonicalize_extra_owner_surface_aliases(
    owner_name: str, umbrella: str, subaction: str
) -> None:
    """Owner-surface aliases beyond REMINDERS/ALARMS/HEALTH/FINANCES."""
    canon = _canonicalize_action(Action(name=owner_name, kwargs={}))
    assert canon.name == umbrella
    assert canon.kwargs["subaction"] == subaction


def test_compare_actions_health_trends_runner_view_matches_manifest_view() -> None:
    """Runner GT uses `trends` (plural); agent emits manifest `HEALTH_TREND` (singular).

    Names match after canonicalization (both fold to `HEALTH`); the
    subaction kwarg differs (`trend` vs `trends`), so `compare_actions`
    awards the name-only partial credit (0.5). This is the right
    behavior — the agent emitted the right umbrella but the wrong
    discriminator value relative to what the runner enforces.
    """
    gt = [Action(name="HEALTH", kwargs={"subaction": "trends"})]
    predicted = [Action(name="HEALTH_TREND", kwargs={})]
    assert compare_actions(predicted, gt) == pytest.approx(0.5)


def test_compare_actions_life_policy_set_reminder_full_credit() -> None:
    """LIFE policy subaction folds into the umbrella for full credit."""
    gt = [Action(name="LIFE", kwargs={"subaction": "policy_set_reminder"})]
    predicted = [Action(name="LIFE_POLICY_SET_REMINDER", kwargs={})]
    assert compare_actions(predicted, gt) == pytest.approx(1.0)


def test_compare_actions_scheduled_task_acknowledge_full_credit() -> None:
    """SCHEDULED_TASK_ACKNOWLEDGE folds to the umbrella."""
    gt = [Action(name="SCHEDULED_TASK", kwargs={"subaction": "acknowledge"})]
    predicted = [Action(name="SCHEDULED_TASK_ACKNOWLEDGE", kwargs={})]
    assert compare_actions(predicted, gt) == pytest.approx(1.0)


def test_compare_actions_owner_todos_create_full_credit() -> None:
    """OWNER_TODOS_CREATE folds to LIFE(subaction=create) for full credit."""
    gt = [Action(name="LIFE", kwargs={"subaction": "create"})]
    predicted = [Action(name="OWNER_TODOS_CREATE", kwargs={})]
    assert compare_actions(predicted, gt) == pytest.approx(1.0)


def test_canonicalize_preserves_existing_subaction_kwarg() -> None:
    """If the agent already supplied a subaction kwarg, the name-derived
    candidate must NOT overwrite it. This protects against an agent that
    emits e.g. `LIFE_CREATE(subaction="delete")` — the kwargs win and
    the bench scores it against the intended GT row, not the name."""
    action = Action(
        name="LIFE_CREATE",
        kwargs={"subaction": "delete", "target": "reminder_x"},
    )
    canon = _canonicalize_action(action)
    assert canon.name == "LIFE"
    assert canon.kwargs["subaction"] == "delete"
    assert canon.kwargs["target"] == "reminder_x"


# ---------------------------------------------------------------------------
# P0-8: read-only scenarios get a different scoring weight so the state_hash
# floor stops gifting 0.5+ on read scenarios where the runner is a no-op.
#
# Synthesis §2 T2: read-only `_u_*` operations in runner.py return
# {ok:True, noop:True} without mutating LifeWorld. State hash trivially
# matches the seed → every read-only scenario gets a 0.5 floor on state_hash
# regardless of correctness. This is the "no false positives" fix.
#
# New weights:
#   READ:  0.1 state + 0.7 action + 0.2 substring
#   WRITE: 0.5 state + 0.4 action + 0.1 substring (unchanged)
#   MIXED: 0.35 state + 0.5 action + 0.15 substring
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("umbrella", "subaction"),
    [
        ("CALENDAR", "check_availability"),
        ("CALENDAR", "next_event"),
        ("CALENDAR", "search_events"),
        ("CALENDAR", "propose_times"),
        ("CALENDAR", "update_preferences"),
        ("MESSAGE", "triage"),
        ("MESSAGE", "search_inbox"),
        ("MESSAGE", "list_channels"),
        ("MESSAGE", "read_channel"),
        ("MESSAGE", "read_with_contact"),
        ("ENTITY", "list"),
        ("ENTITY", "log_interaction"),
        # LIFE/review removed — read_with_side_effects (P2-9)
        ("LIFE", "update"),
        ("LIFE", "skip"),
        ("LIFE", "list"),
        ("HEALTH", "today"),
        ("HEALTH", "trend"),
        # HEALTH/trends + HEALTH/summary removed — read_with_side_effects (P2-9)
        ("HEALTH", "by_metric"),
        ("HEALTH", "status"),
        ("MONEY", "dashboard"),
        ("MONEY", "list_sources"),
        ("MONEY", "list_transactions"),
        ("MONEY", "spending_summary"),
        ("MONEY", "recurring_charges"),
        ("MONEY", "subscription_audit"),
        ("MONEY", "subscription_status"),
        ("BLOCK", "block"),
        ("BLOCK", "unblock"),
        ("BLOCK", "status"),
        ("BLOCK", "list_active"),
        ("BLOCK", "release"),
        ("BLOCK", "request_permission"),
        ("BOOK_TRAVEL", "search"),
        ("BOOK_TRAVEL", "prepare"),
        ("BOOK_TRAVEL", "book"),
        ("BOOK_TRAVEL", "cancel"),
        ("BOOK_TRAVEL", "hold"),
        ("SCHEDULED_TASK", "list"),
        ("SCHEDULED_TASK", "get"),
        ("SCHEDULED_TASK", "history"),
    ],
)
def test_is_read_only_action_recognizes_runner_noops(
    umbrella: str, subaction: str
) -> None:
    """Every (umbrella, subaction) listed maps to a runner `_u_*` no-op branch."""
    # MESSAGE umbrella uses `operation` as its discriminator field.
    field = "operation" if umbrella == "MESSAGE" else "subaction"
    action = Action(name=umbrella, kwargs={field: subaction})
    assert _is_read_only_action(action), f"{umbrella}/{subaction} should be read-only"


@pytest.mark.parametrize(
    ("umbrella", "subaction"),
    [
        # CALENDAR mutators
        ("CALENDAR", "create_event"),
        ("CALENDAR", "update_event"),
        ("CALENDAR", "delete_event"),
        # MESSAGE mutators
        ("MESSAGE", "send"),
        ("MESSAGE", "manage"),
        ("MESSAGE", "draft_reply"),
        # ENTITY mutators
        ("ENTITY", "add"),
        ("ENTITY", "set_identity"),
        ("ENTITY", "set_relationship"),
        ("ENTITY", "merge"),
        # LIFE mutators
        ("LIFE", "create"),
        ("LIFE", "complete"),
        ("LIFE", "snooze"),
        ("LIFE", "delete"),
        ("LIFE", "policy_set_reminder"),
        ("LIFE", "policy_configure_escalation"),
        # MONEY mutators
        ("MONEY", "subscription_cancel"),
        ("MONEY", "add_source"),
        ("MONEY", "remove_source"),
        ("MONEY", "import_csv"),
        # SCHEDULED_TASK mutators
        ("SCHEDULED_TASK", "create"),
        ("SCHEDULED_TASK", "update"),
        ("SCHEDULED_TASK", "snooze"),
        ("SCHEDULED_TASK", "complete"),
        ("SCHEDULED_TASK", "cancel"),
    ],
)
def test_is_read_only_action_rejects_mutators(umbrella: str, subaction: str) -> None:
    """Mutating subactions must NOT be classified as reads."""
    field = "operation" if umbrella == "MESSAGE" else "subaction"
    action = Action(name=umbrella, kwargs={field: subaction})
    assert not _is_read_only_action(action), f"{umbrella}/{subaction} mutates"


def test_classify_scenario_kind_pure_read() -> None:
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="HEALTH", kwargs={"subaction": "today"}),
            Action(name="BLOCK", kwargs={"subaction": "block"}),
        ]
    )
    assert _classify_scenario_kind(scenario) == "read"


def test_classify_scenario_kind_pure_write() -> None:
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="CALENDAR", kwargs={"subaction": "create_event"}),
            Action(name="LIFE", kwargs={"subaction": "create"}),
        ]
    )
    assert _classify_scenario_kind(scenario) == "write"


def test_classify_scenario_kind_mixed() -> None:
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="CALENDAR", kwargs={"subaction": "check_availability"}),
            Action(name="CALENDAR", kwargs={"subaction": "create_event"}),
        ]
    )
    assert _classify_scenario_kind(scenario) == "mixed"


def test_classify_scenario_kind_empty_gt_is_write() -> None:
    """LIVE-mode scenarios have no GT actions; classifier defaults to write
    so LIVE-mode weighting (which doesn't use action_score) is unaffected."""
    scenario = _scenario(ground_truth_actions=[])
    assert _classify_scenario_kind(scenario) == "write"


def test_classify_scenario_kind_canonicalizes_granular() -> None:
    """Granular emissions are canonicalized before classification."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="BLOCK_BLOCK", kwargs={}),
            Action(name="HEALTH_TODAY", kwargs={}),
        ]
    )
    assert _classify_scenario_kind(scenario) == "read"


# ---------------------------------------------------------------------------
# P0-8 integration: end-to-end score behavior on read vs write scenarios.
# ---------------------------------------------------------------------------


def test_p0_8_read_scenario_correct_action_scores_high() -> None:
    """READ + correct action + matching state_hash → ~1.0 (action dominates)."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="CALENDAR", kwargs={"subaction": "next_event"}),
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(name="CALENDAR", kwargs={"subaction": "next_event"}),
        ],
    )
    # READ weights: 0.1*1 + 0.7*1.0 + 0.2*1.0 = 1.0
    assert score_scenario(result, scenario) == pytest.approx(1.0)


def test_p0_8_read_scenario_wrong_action_no_longer_inflated_by_state_hash() -> None:
    """Repro for P0-8 inflation: wrong action + matching state_hash now scores low.

    Pre-P0-8 this scored 0.5 (state) + 0 + 0.1 (empty substring) ≈ 0.6
    BUT the triviality guard zeroed state/substring when action=0 → 0.0.
    The real problem case was PARTIAL match: state_hash inflates the score
    even when the kwargs are wrong. See the next test for that.

    With wrong action_name + triviality guard: score=0.0 (unchanged).
    """
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="CALENDAR", kwargs={"subaction": "next_event"}),
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[Action(name="MAIL", kwargs={"operation": "send"})],
    )
    # Triviality guard zeroes state+substring on action=0 → 0.0
    assert score_scenario(result, scenario) == pytest.approx(0.0)


def test_p0_8_read_scenario_partial_action_no_longer_promoted() -> None:
    """Repro for W5-foc/W5-msg inflation: BLOCK with wrong kwargs no longer gets 1.0.

    Agent emits `BLOCK_BLOCK` with kwargs `apps` / `duration_minutes` /
    `duration:'2h'` — wrong shapes vs GT `hostnames` / `packageNames` /
    `durationMinutes`. After canonicalization both are BLOCK/block, so
    name matches, kwargs don't → action_score = 0.5 partial.

    Pre-P0-8: state_hash=True (BLOCK is a no-op) → action promoted to 1.0
    → score 0.5 + 0.4 + 0.1 = 1.0. BAD — kwargs were wrong.
    Post-P0-8: READ weights kick in, no promotion → 0.1 + 0.35 + 0.2 = 0.65.
    """
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="BLOCK",
                kwargs={
                    "subaction": "block",
                    "hostnames": ["news.example.test"],
                    "packageNames": ["com.example.distract"],
                    "durationMinutes": 120,
                },
            )
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(
                name="BLOCK_BLOCK",
                kwargs={
                    "apps": ["distract"],
                    "duration_minutes": 120,
                    "duration": "2h",
                },
            )
        ],
    )
    score = score_scenario(result, scenario)
    # Triviality guard: BLOCK is hash-inert + wrong kwargs → no creditable overlap → 0.0
    assert score == pytest.approx(0.0)
    assert score < 0.9  # contractual: must drop well below pre-P0-8 1.0 inflation


def test_p0_8_read_scenario_correct_kwargs_full_credit() -> None:
    """Counterpart to the inflation test: when the agent gets BLOCK right, it scores high."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="BLOCK",
                kwargs={
                    "subaction": "block",
                    "hostnames": ["news.example.test"],
                    "durationMinutes": 120,
                },
            )
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(
                name="BLOCK",
                kwargs={
                    "subaction": "block",
                    "hostnames": ["news.example.test"],
                    "durationMinutes": 120,
                },
            )
        ],
    )
    score = score_scenario(result, scenario)
    # 0.1 + 0.7 + 0.2 = 1.0
    assert score == pytest.approx(1.0)


def test_p0_8_write_scenario_correct_action_holds_at_1() -> None:
    """WRITE + correct action + state_hash → still 1.0 (no regression)."""
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
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
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
    )
    assert score_scenario(result, scenario) == pytest.approx(1.0)


def test_p0_8_write_scenario_state_hash_promotion_still_active() -> None:
    """WRITE state_hash → action ≥ 0.5 promotion still fires (no regression).

    The W4-A promotion only made sense for writes — the executor verified the
    world ended up correct, so kwarg spelling drift shouldn't keep the
    score under pass@1. P0-8 preserves that for writes.
    """
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
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "title": "deep work",
                    # `start_time` instead of `details.start` — partial match.
                    "start_time": "2026-05-11T10:00:00Z",
                },
            )
        ],
    )
    # Promotion fires for write: action 0.5 → 1.0 → 0.5 + 0.4 + 0.1 = 1.0
    assert score_scenario(result, scenario) == pytest.approx(1.0)


def test_p0_8_write_scenario_wrong_action_still_penalized() -> None:
    """WRITE + wrong action + matching state_hash → 0 (triviality guard)."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={"subaction": "create_event", "title": "x"},
            )
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[Action(name="LIFE", kwargs={"subaction": "create"})],
    )
    assert score_scenario(result, scenario) == pytest.approx(0.0)


def test_p0_8_message_read_with_zane_source_mismatch_loses_points() -> None:
    """Repro for W5-msg: openclaw scored 1.0 on `read_with_zane_on_slack`
    while routing to source=gmail. With P0-8, source mismatch lowers
    action_score AND the state_hash freebie is mostly gone.

    GT: MESSAGE/read_with_contact with source=slack.
    Agent: MESSAGE/read_with_contact with source=gmail → name match, kwargs differ.
    Pre-P0-8: state=True (no-op) → score ~0.7-1.0.
    Post-P0-8 (+ triviality guard): MESSAGE/read_with_contact is hash-inert.
    `_has_creditable_action_overlap` requires full kwargs match for hash-inert
    actions; source mismatch → no creditable overlap → triviality guard fires
    → score 0.0. The contractual requirement (no longer 1.0) is satisfied.
    """
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "read_with_contact",
                    "source": "slack",
                    "contact": "Zane",
                },
            )
        ],
        domain=Domain.MESSAGES,
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "read_with_contact",
                    "source": "gmail",
                    "contact": "Zane",
                },
            )
        ],
    )
    score = score_scenario(result, scenario)
    # Triviality guard: hash-inert action with wrong source → 0.0
    assert score == pytest.approx(0.0)
    assert score < 0.9  # no longer inflates to 1.0


def test_p0_8_mixed_scenario_split_weights() -> None:
    """MIXED scenarios use intermediate weights so neither pure-read nor pure-write rules dominate."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="CALENDAR", kwargs={"subaction": "check_availability"}),
            Action(name="CALENDAR", kwargs={"subaction": "create_event", "title": "x"}),
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(name="CALENDAR", kwargs={"subaction": "check_availability"}),
            Action(name="CALENDAR", kwargs={"subaction": "create_event", "title": "x"}),
        ],
    )
    # Mixed weights: 0.35 + 0.5 + 0.15 = 1.0 on perfect run.
    assert score_scenario(result, scenario) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# P2-10: MESSAGE/send source-mismatch penalty (W8-C).
#
# When the agent calls MESSAGE(operation="send") targeting a different contact
# than the GT specifies, the name-only partial credit (0.5) is halved to 0.25.
# The agent still gets some credit for using MESSAGE/send — just materially
# less for hitting the wrong person.
# ---------------------------------------------------------------------------


def test_p2_10_message_send_wrong_contact_halves_partial_credit() -> None:
    """MESSAGE/send to wrong contact: name match alone → 0.25 (not 0.5).

    GT: MESSAGE(operation=send, target=contact_00002, source=imessage).
    Agent: MESSAGE(operation=send, target=contact_00099, source=imessage).
    Kwargs don't match → partial. P2-10 penalty: 0.5 * 0.5 = 0.25.
    """
    gt = [
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "send",
                "source": "imessage",
                "targetKind": "contact",
                "target": "contact_00002",
                "message": "hello",
            },
        )
    ]
    predicted = [
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "send",
                "source": "imessage",
                "targetKind": "contact",
                "target": "contact_00099",  # wrong contact
                "message": "hello",
            },
        )
    ]
    assert compare_actions(predicted, gt) == pytest.approx(0.25)


def test_p2_10_message_send_correct_contact_no_penalty() -> None:
    """MESSAGE/send to correct contact with all matching kwargs → 1.0 (no regression)."""
    gt = [
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "send",
                "source": "imessage",
                "target": "Hannah Hill",
                "message": "on my way",
            },
        )
    ]
    predicted = [
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "send",
                "source": "imessage",
                "target": "Hannah Hill",
                "message": "on my way",
            },
        )
    ]
    assert compare_actions(predicted, gt) == pytest.approx(1.0)


def test_p2_10_message_send_case_insensitive_contact_match_no_penalty() -> None:
    """Contact name match is case-insensitive — no penalty when names agree."""
    gt = [
        Action(
            name="MESSAGE",
            kwargs={"operation": "send", "target": "Hannah Hill", "message": "hi"},
        )
    ]
    predicted = [
        Action(
            name="MESSAGE",
            kwargs={"operation": "send", "target": "hannah hill", "message": "hi"},
        )
    ]
    # Both sides have same contact (case-normalized) and same message → full match.
    assert compare_actions(predicted, gt) == pytest.approx(1.0)


def test_p2_10_message_non_send_operation_no_penalty() -> None:
    """P2-10 penalty only fires on operation=send, not on read ops."""
    gt = [
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "read_with_contact",
                "source": "slack",
                "contact": "Zane",
            },
        )
    ]
    predicted = [
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "read_with_contact",
                "source": "gmail",  # source mismatch handled by P0-8 READ weights
                "contact": "Zane",
            },
        )
    ]
    # P2-10 doesn't fire for read ops — standard 0.5 name-only partial credit.
    assert compare_actions(predicted, gt) == pytest.approx(0.5)


def test_p2_10_message_send_no_contact_in_gt_no_penalty() -> None:
    """When GT doesn't specify a contact key, no source-mismatch penalty applies."""
    gt = [
        Action(
            name="MESSAGE",
            kwargs={"operation": "send", "source": "imessage", "targetKind": "group", "roomId": "group_abc"},
        )
    ]
    predicted = [
        Action(
            name="MESSAGE",
            kwargs={"operation": "send", "source": "imessage", "targetKind": "group", "roomId": "group_xyz"},
        )
    ]
    # roomId mismatch → 0.5 partial, but no contact key → no P2-10 penalty.
    assert compare_actions(predicted, gt) == pytest.approx(0.5)


# ---------------------------------------------------------------------------
# P2-9: read_with_side_effects category for LIFE_REVIEW + HEALTH summary/trends.
#
# LIFE/review stamps last_reviewed_at on reminder lists (not a pure no-op).
# HEALTH/summary and HEALTH/trends are side-effecting reads.
# Weights: 0.15 state + 0.3 action + 0.55 substring.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("umbrella", "subaction"),
    [
        ("LIFE", "review"),
        ("HEALTH", "summary"),
        ("HEALTH", "trends"),
    ],
)
def test_is_read_with_side_effects_action_recognizes_rwse_ops(
    umbrella: str, subaction: str
) -> None:
    """LIFE/review and HEALTH/summary+trends are read-with-side-effects."""
    action = Action(name=umbrella, kwargs={"subaction": subaction})
    assert _is_read_with_side_effects_action(action), f"{umbrella}/{subaction} should be rwse"
    assert not _is_read_only_action(action), f"{umbrella}/{subaction} must not be pure read"


@pytest.mark.parametrize(
    ("umbrella", "subaction"),
    [
        ("LIFE", "list"),
        ("LIFE", "update"),
        ("LIFE", "skip"),
        ("HEALTH", "today"),
        ("HEALTH", "trend"),
        ("HEALTH", "by_metric"),
        ("HEALTH", "status"),
        ("LIFE", "create"),
        ("LIFE", "complete"),
        ("CALENDAR", "create_event"),
    ],
)
def test_is_read_with_side_effects_action_rejects_non_rwse(
    umbrella: str, subaction: str
) -> None:
    """Non-rwse subactions are not classified as read_with_side_effects."""
    action = Action(name=umbrella, kwargs={"subaction": subaction})
    assert not _is_read_with_side_effects_action(action), f"{umbrella}/{subaction} is not rwse"


def test_classify_scenario_kind_life_review_is_rwse() -> None:
    """A scenario with only LIFE/review gets read_with_side_effects."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="LIFE", kwargs={"subaction": "review"}),
        ]
    )
    assert _classify_scenario_kind(scenario) == "read_with_side_effects"


def test_classify_scenario_kind_health_summary_is_rwse() -> None:
    """A scenario with only HEALTH/summary gets read_with_side_effects."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="HEALTH", kwargs={"subaction": "summary"}),
        ]
    )
    assert _classify_scenario_kind(scenario) == "read_with_side_effects"


def test_classify_scenario_kind_rwse_plus_read_is_rwse() -> None:
    """Mixing pure-read with rwse (no writes) yields read_with_side_effects."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="LIFE", kwargs={"subaction": "review"}),
            Action(name="HEALTH", kwargs={"subaction": "today"}),
        ]
    )
    assert _classify_scenario_kind(scenario) == "read_with_side_effects"


def test_classify_scenario_kind_rwse_plus_write_is_mixed() -> None:
    """LIFE/review combined with a write is mixed."""
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="LIFE", kwargs={"subaction": "review"}),
            Action(name="CALENDAR", kwargs={"subaction": "create_event", "title": "x"}),
        ]
    )
    assert _classify_scenario_kind(scenario) == "mixed"


def test_p2_9_life_review_correct_action_uses_rwse_weights() -> None:
    """LIFE/review correct action + state_hash match → 1.0 under rwse weights.

    READ_WITH_SIDE_EFFECTS: 0.15 state + 0.3 action + 0.55 substring.
    All components = 1.0 → total = 1.0.
    """
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="LIFE", kwargs={"subaction": "review"}),
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[Action(name="LIFE", kwargs={"subaction": "review"})],
    )
    assert score_scenario(result, scenario) == pytest.approx(1.0)


def test_p2_9_life_review_wrong_kwargs_partial_credit() -> None:
    """LIFE/review right name but wrong kwargs → partial action credit.

    READ_WITH_SIDE_EFFECTS: 0.15*1.0 + 0.3*0.5 + 0.55*1.0 = 0.85.
    """
    scenario = _scenario(
        ground_truth_actions=[
            Action(name="LIFE", kwargs={"subaction": "review", "list_id": "list_primary"}),
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(name="LIFE", kwargs={"subaction": "review", "list_id": "list_other"}),
        ],
    )
    assert score_scenario(result, scenario) == pytest.approx(0.85)


def test_p2_9_health_trends_uses_rwse_weights() -> None:
    """HEALTH/trends correct action scores 1.0 under rwse weights.

    HEALTH/trends is still hash-inert (runner doesn't write state yet), so
    partial kwarg matches are zeroed by the triviality guard. Test with a
    matching action to confirm rwse weights apply.

    READ_WITH_SIDE_EFFECTS: 0.15 + 0.3 + 0.55 = 1.0 on correct match.
    """
    scenario = _scenario(
        ground_truth_actions=[
            Action(
                name="HEALTH",
                kwargs={"subaction": "trends", "metric": "steps", "days": 7},
            )
        ]
    )
    result = _result(
        state_hash_match=True,
        agent_actions=[
            Action(
                name="HEALTH",
                kwargs={"subaction": "trends", "metric": "steps", "days": 7},
            ),
        ],
    )
    assert score_scenario(result, scenario) == pytest.approx(1.0)


def test_p2_9_health_today_still_pure_read() -> None:
    """HEALTH/today is still pure read (not affected by P2-9)."""
    action = Action(name="HEALTH", kwargs={"subaction": "today"})
    assert _is_read_only_action(action)
    assert not _is_read_with_side_effects_action(action)
    scenario = _scenario(ground_truth_actions=[action])
    assert _classify_scenario_kind(scenario) == "read"


def test_p2_9_life_review_not_read_only() -> None:
    """LIFE/review is no longer classified as pure read-only."""
    assert not _is_read_only_action(Action(name="LIFE", kwargs={"subaction": "review"}))
