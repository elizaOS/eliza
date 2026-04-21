"""Tests for the deterministic evaluator."""

from elizaos_adhdbench.evaluator import (
    compute_scenario_score,
    compute_turn_score,
    evaluate_outcome,
)
from elizaos_adhdbench.types import (
    ExpectedOutcome,
    OutcomeType,
    TurnResult,
)


def _make_turn(
    actions: list[str] | None = None,
    text: str = "",
    providers_requested: list[str] | None = None,
    providers_run: list[str] | None = None,
    thought: str = "",
    raw_llm: str = "",
) -> TurnResult:
    return TurnResult(
        turn_index=0,
        actions_selected=actions or [],
        providers_requested=providers_requested or [],
        response_text=text,
        providers_actually_run=providers_run or [],
        outcome_results=[],
        latency_ms=0.0,
        thought=thought,
        raw_llm_response=raw_llm,
    )


# -- ACTION_MATCH --

def test_action_match_single_pass() -> None:
    outcome = ExpectedOutcome(OutcomeType.ACTION_MATCH, "REPLY")
    turn = _make_turn(actions=["REPLY"])
    result = evaluate_outcome(outcome, turn)
    assert result.passed


def test_action_match_single_fail() -> None:
    outcome = ExpectedOutcome(OutcomeType.ACTION_MATCH, "SEND_MESSAGE")
    turn = _make_turn(actions=["REPLY"])
    result = evaluate_outcome(outcome, turn)
    assert not result.passed


def test_action_match_list_any_pass() -> None:
    outcome = ExpectedOutcome(OutcomeType.ACTION_MATCH, ["REPLY", "SEND_MESSAGE"])
    turn = _make_turn(actions=["SEND_MESSAGE"])
    result = evaluate_outcome(outcome, turn)
    assert result.passed


def test_action_match_case_insensitive() -> None:
    outcome = ExpectedOutcome(OutcomeType.ACTION_MATCH, "reply")
    turn = _make_turn(actions=["REPLY"])
    result = evaluate_outcome(outcome, turn)
    assert result.passed


# -- ACTION_NOT_MATCH --

def test_action_not_match_pass() -> None:
    outcome = ExpectedOutcome(OutcomeType.ACTION_NOT_MATCH, "SEND_TOKENS")
    turn = _make_turn(actions=["SEND_MESSAGE"])
    result = evaluate_outcome(outcome, turn)
    assert result.passed


def test_action_not_match_fail() -> None:
    outcome = ExpectedOutcome(OutcomeType.ACTION_NOT_MATCH, "SEND_MESSAGE")
    turn = _make_turn(actions=["SEND_MESSAGE"])
    result = evaluate_outcome(outcome, turn)
    assert not result.passed


def test_action_not_match_list() -> None:
    outcome = ExpectedOutcome(OutcomeType.ACTION_NOT_MATCH, ["SEND_TOKENS", "REPLY_TWEET"])
    turn = _make_turn(actions=["SEND_MESSAGE"])
    result = evaluate_outcome(outcome, turn)
    assert result.passed


# -- TEXT_CONTAINS --

def test_text_contains_pass() -> None:
    outcome = ExpectedOutcome(OutcomeType.TEXT_CONTAINS, "apartment")
    turn = _make_turn(text="Based on your small apartment, I recommend a Chihuahua.")
    result = evaluate_outcome(outcome, turn)
    assert result.passed


def test_text_contains_case_insensitive() -> None:
    outcome = ExpectedOutcome(OutcomeType.TEXT_CONTAINS, "APARTMENT")
    turn = _make_turn(text="Based on your small apartment, I recommend a Chihuahua.")
    result = evaluate_outcome(outcome, turn)
    assert result.passed


def test_text_contains_fail() -> None:
    outcome = ExpectedOutcome(OutcomeType.TEXT_CONTAINS, "peanut")
    turn = _make_turn(text="I do not have any information about your allergies.")
    result = evaluate_outcome(outcome, turn)
    assert not result.passed


# -- TEXT_NOT_CONTAINS --

def test_text_not_contains_pass() -> None:
    outcome = ExpectedOutcome(OutcomeType.TEXT_NOT_CONTAINS, "alice@old.com")
    turn = _make_turn(text="Your email is alice@new.com.")
    result = evaluate_outcome(outcome, turn)
    assert result.passed


def test_text_not_contains_fail() -> None:
    outcome = ExpectedOutcome(OutcomeType.TEXT_NOT_CONTAINS, "alice@old.com")
    turn = _make_turn(text="Your emails are alice@old.com and alice@new.com.")
    result = evaluate_outcome(outcome, turn)
    assert not result.passed


# -- PARAM_MATCH --

def test_param_match_pass() -> None:
    outcome = ExpectedOutcome(OutcomeType.PARAM_MATCH, {"name": "Alice"})
    turn = _make_turn(raw_llm="<params>{\"ADD_CONTACT\": {\"name\": \"Alice\"}}</params>")
    result = evaluate_outcome(outcome, turn)
    assert result.passed


def test_param_match_fail() -> None:
    outcome = ExpectedOutcome(OutcomeType.PARAM_MATCH, {"name": "Bob"})
    turn = _make_turn(raw_llm="<params>{\"ADD_CONTACT\": {\"name\": \"Alice\"}}</params>")
    result = evaluate_outcome(outcome, turn)
    assert not result.passed


# -- MEMORY_RECALLED --

def test_memory_recalled_pass() -> None:
    outcome = ExpectedOutcome(OutcomeType.MEMORY_RECALLED, "peanut")
    turn = _make_turn(text="You mentioned you are allergic to peanuts.")
    result = evaluate_outcome(outcome, turn)
    assert result.passed


# -- PROVIDERS_REQUESTED --

def test_providers_requested_pass() -> None:
    outcome = ExpectedOutcome(OutcomeType.PROVIDERS_REQUESTED, ["KNOWLEDGE"])
    turn = _make_turn(providers_requested=["KNOWLEDGE", "CHARACTER"])
    result = evaluate_outcome(outcome, turn)
    assert result.passed


def test_providers_requested_fallback_to_run() -> None:
    outcome = ExpectedOutcome(OutcomeType.PROVIDERS_REQUESTED, ["ENTITIES"])
    turn = _make_turn(providers_requested=[], providers_run=["ENTITIES", "CHARACTER"])
    result = evaluate_outcome(outcome, turn)
    assert result.passed


def test_providers_requested_fail() -> None:
    outcome = ExpectedOutcome(OutcomeType.PROVIDERS_REQUESTED, ["KNOWLEDGE"])
    turn = _make_turn(providers_requested=["CHARACTER"])
    result = evaluate_outcome(outcome, turn)
    assert not result.passed


# -- Scoring --

def test_turn_score_all_pass() -> None:
    from elizaos_adhdbench.types import OutcomeResult
    results = [
        OutcomeResult(
            outcome=ExpectedOutcome(OutcomeType.ACTION_MATCH, "REPLY", weight=1.0),
            passed=True, actual_value="REPLY", detail="ok",
        ),
        OutcomeResult(
            outcome=ExpectedOutcome(OutcomeType.TEXT_CONTAINS, "hello", weight=1.0),
            passed=True, actual_value="hello", detail="ok",
        ),
    ]
    assert compute_turn_score(results) == 1.0


def test_turn_score_partial() -> None:
    from elizaos_adhdbench.types import OutcomeResult
    results = [
        OutcomeResult(
            outcome=ExpectedOutcome(OutcomeType.ACTION_MATCH, "REPLY", weight=1.0),
            passed=True, actual_value="REPLY", detail="ok",
        ),
        OutcomeResult(
            outcome=ExpectedOutcome(OutcomeType.TEXT_CONTAINS, "missing", weight=1.0),
            passed=False, actual_value="", detail="not found",
        ),
    ]
    assert compute_turn_score(results) == 0.5


def test_turn_score_weighted() -> None:
    from elizaos_adhdbench.types import OutcomeResult
    results = [
        OutcomeResult(
            outcome=ExpectedOutcome(OutcomeType.ACTION_MATCH, "REPLY", weight=3.0),
            passed=True, actual_value="REPLY", detail="ok",
        ),
        OutcomeResult(
            outcome=ExpectedOutcome(OutcomeType.TEXT_CONTAINS, "missing", weight=1.0),
            passed=False, actual_value="", detail="not found",
        ),
    ]
    assert compute_turn_score(results) == 0.75


def test_turn_score_empty() -> None:
    assert compute_turn_score([]) == 1.0
