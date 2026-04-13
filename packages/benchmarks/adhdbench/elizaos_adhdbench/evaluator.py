"""Deterministic outcome evaluation."""

from __future__ import annotations

from collections.abc import Callable

from elizaos_adhdbench.types import (
    ExpectedOutcome,
    OutcomeResult,
    OutcomeType,
    TurnResult,
)

_EvalFn = Callable[[ExpectedOutcome, TurnResult], OutcomeResult]


def evaluate_outcome(outcome: ExpectedOutcome, turn: TurnResult) -> OutcomeResult:
    """Evaluate a single expected outcome against a turn result."""
    evaluator = _EVALUATORS.get(outcome.outcome_type)
    if evaluator is None:
        return OutcomeResult(
            outcome=outcome,
            passed=False,
            actual_value="",
            detail=f"Unknown outcome type: {outcome.outcome_type}",
        )
    return evaluator(outcome, turn)




def compute_turn_score(results: list[OutcomeResult]) -> float:
    """Compute the weighted score for a turn from its outcome results.

    Returns a float in [0.0, 1.0].  If there are no outcomes, returns 1.0
    (a turn with no assertions always passes).
    """
    if not results:
        return 1.0
    total_weight = sum(r.outcome.weight for r in results)
    if total_weight <= 0:
        return 1.0
    weighted_sum = sum(r.outcome.weight for r in results if r.passed)
    return weighted_sum / total_weight


def compute_scenario_score(turn_results: list[TurnResult]) -> float:
    """Compute the overall score for a scenario from its turn results.

    Only turns with expected outcomes contribute to the score.  Turns without
    outcomes (context-setting turns) are excluded.
    """
    scored_turns: list[float] = []
    for tr in turn_results:
        if tr.outcome_results:
            scored_turns.append(compute_turn_score(tr.outcome_results))
    if not scored_turns:
        return 1.0
    return sum(scored_turns) / len(scored_turns)


def _eval_action_match(outcome: ExpectedOutcome, turn: TurnResult) -> OutcomeResult:
    """Check if any of the expected actions were selected."""
    expected_actions: list[str]
    if isinstance(outcome.value, str):
        expected_actions = [outcome.value.upper()]
    elif isinstance(outcome.value, list):
        expected_actions = [a.upper() for a in outcome.value]
    else:
        return OutcomeResult(
            outcome=outcome, passed=False, actual_value=str(outcome.value),
            detail="Invalid value type for ACTION_MATCH",
        )

    selected_upper = [a.upper() for a in turn.actions_selected]
    # Pass if ANY expected action was selected
    matched = [a for a in expected_actions if a in selected_upper]
    passed = len(matched) > 0
    return OutcomeResult(
        outcome=outcome,
        passed=passed,
        actual_value=",".join(turn.actions_selected),
        detail=f"Expected one of {expected_actions}, got {selected_upper}. "
               f"{'Matched: ' + ','.join(matched) if matched else 'No match'}",
    )


def _eval_action_not_match(outcome: ExpectedOutcome, turn: TurnResult) -> OutcomeResult:
    """Check that none of the specified actions were selected."""
    forbidden_actions: list[str]
    if isinstance(outcome.value, str):
        forbidden_actions = [outcome.value.upper()]
    elif isinstance(outcome.value, list):
        forbidden_actions = [a.upper() for a in outcome.value]
    else:
        return OutcomeResult(
            outcome=outcome, passed=False, actual_value=str(outcome.value),
            detail="Invalid value type for ACTION_NOT_MATCH",
        )

    selected_upper = [a.upper() for a in turn.actions_selected]
    violations = [a for a in forbidden_actions if a in selected_upper]
    passed = len(violations) == 0
    return OutcomeResult(
        outcome=outcome,
        passed=passed,
        actual_value=",".join(turn.actions_selected),
        detail=f"Forbidden actions {forbidden_actions}. "
               f"{'No violations' if passed else 'Violations: ' + ','.join(violations)}",
    )


def _eval_text_contains(outcome: ExpectedOutcome, turn: TurnResult) -> OutcomeResult:
    """Check if the response text contains the expected substring (case-insensitive)."""
    if not isinstance(outcome.value, str):
        return OutcomeResult(
            outcome=outcome, passed=False, actual_value="",
            detail="Invalid value type for TEXT_CONTAINS: expected str",
        )

    needle = outcome.value.lower()
    haystack = turn.response_text.lower()
    passed = needle in haystack
    # Show a snippet around the match or the first 200 chars
    if passed:
        idx = haystack.index(needle)
        start = max(0, idx - 30)
        end = min(len(haystack), idx + len(needle) + 30)
        snippet = turn.response_text[start:end]
        detail = f"Found '{outcome.value}' in response: '...{snippet}...'"
    else:
        snippet = turn.response_text[:200]
        detail = f"'{outcome.value}' not found in response: '{snippet}...'"
    return OutcomeResult(outcome=outcome, passed=passed, actual_value=snippet, detail=detail)


def _eval_text_not_contains(outcome: ExpectedOutcome, turn: TurnResult) -> OutcomeResult:
    """Check that the response text does NOT contain the substring."""
    if not isinstance(outcome.value, str):
        return OutcomeResult(
            outcome=outcome, passed=False, actual_value="",
            detail="Invalid value type for TEXT_NOT_CONTAINS: expected str",
        )

    needle = outcome.value.lower()
    haystack = turn.response_text.lower()
    found = needle in haystack
    passed = not found
    detail: str
    if found:
        idx = haystack.index(needle)
        start = max(0, idx - 30)
        end = min(len(haystack), idx + len(needle) + 30)
        snippet = turn.response_text[start:end]
        detail = f"Unexpectedly found '{outcome.value}' in response: '...{snippet}...'"
    else:
        detail = f"Correctly absent: '{outcome.value}' not in response"
    return OutcomeResult(
        outcome=outcome, passed=passed,
        actual_value=turn.response_text[:100], detail=detail,
    )


def _eval_param_match(outcome: ExpectedOutcome, turn: TurnResult) -> OutcomeResult:
    """Check if action parameters contain expected key-value pairs.

    This is evaluated against the response text since the Python runtime
    stores parsed params in the Content proto.  We check for the param
    values appearing in the response or thought text.
    """
    if not isinstance(outcome.value, dict):
        return OutcomeResult(
            outcome=outcome, passed=False, actual_value="",
            detail="Invalid value type for PARAM_MATCH: expected dict",
        )

    combined_text = (turn.response_text + " " + turn.thought + " " + turn.raw_llm_response).lower()
    missing: list[str] = []
    found: list[str] = []
    for key, val in outcome.value.items():
        if val.lower() in combined_text:
            found.append(f"{key}={val}")
        else:
            missing.append(f"{key}={val}")
    passed = len(missing) == 0
    return OutcomeResult(
        outcome=outcome,
        passed=passed,
        actual_value=f"found={found}, missing={missing}",
        detail=f"Param check: found {found}, missing {missing}",
    )


def _eval_memory_recalled(outcome: ExpectedOutcome, turn: TurnResult) -> OutcomeResult:
    """Check if a fact from earlier appears in the response (alias for TEXT_CONTAINS)."""
    return _eval_text_contains(outcome, turn)


def _eval_providers_requested(outcome: ExpectedOutcome, turn: TurnResult) -> OutcomeResult:
    """Check if specific providers were requested by the LLM."""
    expected_providers: list[str]
    if isinstance(outcome.value, str):
        expected_providers = [outcome.value.upper()]
    elif isinstance(outcome.value, list):
        expected_providers = [p.upper() for p in outcome.value]
    else:
        return OutcomeResult(
            outcome=outcome, passed=False, actual_value="",
            detail="Invalid value type for PROVIDERS_REQUESTED",
        )

    requested_upper = [p.upper() for p in turn.providers_requested]
    # Also check providers_actually_run as fallback
    actually_run_upper = [p.upper() for p in turn.providers_actually_run]
    all_providers = set(requested_upper) | set(actually_run_upper)

    matched = [p for p in expected_providers if p in all_providers]
    passed = len(matched) == len(expected_providers)
    return OutcomeResult(
        outcome=outcome,
        passed=passed,
        actual_value=",".join(sorted(all_providers)),
        detail=f"Expected providers {expected_providers}. "
               f"Requested: {requested_upper}. Actually run: {actually_run_upper}. "
               f"{'All matched' if passed else 'Missing: ' + ','.join(set(expected_providers) - set(matched))}",
    )


_EVALUATORS: dict[OutcomeType, _EvalFn] = {
    OutcomeType.ACTION_MATCH: _eval_action_match,
    OutcomeType.ACTION_NOT_MATCH: _eval_action_not_match,
    OutcomeType.TEXT_CONTAINS: _eval_text_contains,
    OutcomeType.TEXT_NOT_CONTAINS: _eval_text_not_contains,
    OutcomeType.PARAM_MATCH: _eval_param_match,
    OutcomeType.MEMORY_RECALLED: _eval_memory_recalled,
    OutcomeType.PROVIDERS_REQUESTED: _eval_providers_requested,
}
