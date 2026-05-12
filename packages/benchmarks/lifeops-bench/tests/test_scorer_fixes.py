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
