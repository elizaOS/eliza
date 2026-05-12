"""Pure scoring functions for LifeOpsBench.

Composes state-hash equality, ground-truth action overlap, and required-output
substring presence into a per-scenario score. `pass_at_k` is the standard
HumanEval/Chen-2021 unbiased estimator.

Score formula:
    STATIC mode: 0.5 * state_hash_match + 0.4 * action_score
                 + 0.1 * mean(output_substring_matches)
    LIVE  mode: 0.7 * state_hash_match
                 + 0.3 * mean(output_substring_matches)

PerfectAgent must produce 1.0 on every supported scenario.
WrongAgent must produce 0.0 on every scenario.
"""

from __future__ import annotations

import math
import re
import statistics
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from .types import (
    Action,
    BenchmarkResult,
    MessageTurn,
    Scenario,
    ScenarioMode,
    ScenarioResult,
)

if TYPE_CHECKING:
    from .lifeworld import LifeWorld


# Tolerance (seconds) for treating two ISO timestamps as equivalent.
DATE_TOLERANCE_SECONDS = 60


# Documentation-only kwargs: their absence on a predicted action MUST NOT
# penalize the match. `intent` / `rationale` / `thought` / `reasoning` are
# free-form natural-language fields that scenarios sometimes embed as
# planning hints — no real agent reliably produces a verbatim copy, and
# they don't drive any behavior the executor cares about.
_SOFT_KWARGS: frozenset[str] = frozenset(
    {"intent", "rationale", "thought", "reasoning"}
)

_OUTPUT_EQUIVALENTS: dict[str, tuple[str, ...]] = {
    "scheduled": (
        "scheduled",
        "added to your calendar",
        "on your calendar",
        "booked",
        "created",
    ),
    "rescheduled": (
        "rescheduled",
        "moved",
        "updated",
        "changed",
    ),
}


# Umbrella action → (discriminator-field, allowed values) for the promoted
# granular form. Kept in lockstep with `runner._DISCRIMINATORS` plus the
# promoted CALENDAR_* / MESSAGE_* names declared in `runner._UMBRELLA_HANDLERS`.
# Used by `_canonicalize_action` to fold a granular action like
# `CALENDAR_CHECK_AVAILABILITY` into the umbrella form
# `CALENDAR(subaction=check_availability, ...)` so name-comparison works
# regardless of which form the agent emits and which the GT uses.
_UMBRELLA_SUBACTIONS: dict[str, tuple[str, frozenset[str]]] = {
    "CALENDAR": (
        "subaction",
        frozenset(
            {
                "create_event",
                "update_event",
                "delete_event",
                "propose_times",
                "search_events",
                "check_availability",
                "next_event",
                "update_preferences",
            }
        ),
    ),
    "MESSAGE": (
        "operation",
        frozenset(
            {
                "send",
                "draft_reply",
                "manage",
                "triage",
                "search_inbox",
                "list_channels",
                "read_channel",
                "read_with_contact",
            }
        ),
    ),
}


def _canonicalize_action(action: Action) -> Action:
    """Fold a granular `<UMBRELLA>_<SUBACTION>` name into the umbrella form.

    Example: `CALENDAR_CHECK_AVAILABILITY(start=..., end=...)`
             → `CALENDAR(subaction=check_availability, start=..., end=...)`

    A no-op when the action is already in umbrella form or when the name
    doesn't match a known `<UMBRELLA>_<SUBACTION>` promotion. The
    discriminator already present in kwargs wins over the one inferred from
    the name (so an agent that emits both is consistent with itself).
    """
    name = action.name
    for umbrella, (field, subactions) in _UMBRELLA_SUBACTIONS.items():
        prefix = f"{umbrella}_"
        if not name.startswith(prefix):
            continue
        candidate = name[len(prefix) :].lower()
        if candidate not in subactions:
            continue
        new_kwargs = dict(action.kwargs)
        new_kwargs.setdefault(field, candidate)
        return Action(name=umbrella, kwargs=new_kwargs)
    return action


def state_hash(world: "LifeWorld") -> str:
    """Compute a canonical hash of the world's mutable state.

    Delegates to `LifeWorld.state_hash()`.
    """
    return world.state_hash()


def _try_parse_iso(value: Any) -> datetime | None:
    """Best-effort ISO 8601 parser. Returns None if `value` isn't a date string."""
    if not isinstance(value, str):
        return None
    s = value.strip()
    # Tolerate trailing Z (Python's fromisoformat predates 3.11 Z handling on
    # some platforms; normalize defensively).
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _values_equivalent(predicted: Any, expected: Any) -> bool:
    """Compare two kwarg values with date-tolerance and string normalization.

    Rules:
    - ISO date strings within ±DATE_TOLERANCE_SECONDS are equivalent.
    - Strings compare case-insensitively after trim/whitespace collapse.
    - Lists / dicts recurse element-wise.
    - Everything else uses ==.
    """
    if isinstance(predicted, str) and isinstance(expected, str):
        p_dt = _try_parse_iso(predicted)
        e_dt = _try_parse_iso(expected)
        if p_dt is not None and e_dt is not None:
            return abs((p_dt - e_dt).total_seconds()) <= DATE_TOLERANCE_SECONDS
        return _normalize_string(predicted) == _normalize_string(expected)
    if isinstance(predicted, list) and isinstance(expected, list):
        if len(predicted) != len(expected):
            return False
        return all(_values_equivalent(p, e) for p, e in zip(predicted, expected))
    if isinstance(predicted, dict) and isinstance(expected, dict):
        if set(predicted.keys()) != set(expected.keys()):
            return False
        return all(_values_equivalent(predicted[k], expected[k]) for k in expected)
    return predicted == expected


def _normalize_string(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def _kwargs_match(predicted: dict[str, Any], expected: dict[str, Any]) -> bool:
    """Tolerant kwarg equality: every load-bearing key in `expected` must match in `predicted`.

    Extra keys on `predicted` are ignored — the agent may pass through more
    fields than the ground truth specifies.

    Keys in `_SOFT_KWARGS` are documentation-only: when they appear in
    `expected` but are absent from `predicted`, the match is still allowed.
    When the agent DOES emit a soft kwarg, the value still has to be
    equivalent (so we never silently accept a contradicting `intent`).
    """
    for key, exp_value in expected.items():
        if key not in predicted:
            if key in _SOFT_KWARGS:
                continue
            return False
        if not _values_equivalent(predicted[key], exp_value):
            return False
    return True


def compare_actions(
    predicted: list[Action],
    ground_truth: list[Action],
) -> float:
    """Score predicted actions against ground truth.

    Set-based with partial credit. Each ground-truth action is matched at
    most once. A name+kwargs match (with date / string tolerance) is worth
    1.0; a name match with mismatched kwargs is worth 0.5; no name match is
    0.0. Spurious extra predicted actions don't subtract — they just don't
    contribute. Result is normalized by `len(ground_truth)` and clamped.

    Edge cases:
    - empty gt and empty predicted → 1.0
    - empty gt and non-empty predicted → 0.0 (rubric must reject hallucination)
    """
    if not ground_truth:
        return 1.0 if not predicted else 0.0

    # Canonicalize both sides so granular `CALENDAR_CHECK_AVAILABILITY`
    # and umbrella `CALENDAR(subaction=check_availability)` compare equal.
    canon_predicted = [_canonicalize_action(p) for p in predicted]
    canon_truth = [_canonicalize_action(g) for g in ground_truth]

    consumed: set[int] = set()
    score = 0.0
    for pred in canon_predicted:
        best_idx: int | None = None
        best_value = 0.0
        for idx, gt in enumerate(canon_truth):
            if idx in consumed or gt.name != pred.name:
                continue
            value = 1.0 if _kwargs_match(pred.kwargs, gt.kwargs) else 0.5
            if value > best_value:
                best_value = value
                best_idx = idx
                if value == 1.0:
                    break
        if best_idx is not None:
            consumed.add(best_idx)
            score += best_value

    return min(1.0, score / len(ground_truth))


def output_substring_match(
    history: list[MessageTurn],
    required: list[str],
) -> list[bool]:
    """For each required substring, return whether ANY assistant turn contains it (case-insensitive)."""
    assistant_blob = "\n".join(
        turn.content or "" for turn in history if turn.role == "assistant"
    ).lower()
    out: list[bool] = []
    for needle in required:
        normalized = needle.lower()
        equivalents = _OUTPUT_EQUIVALENTS.get(normalized, (normalized,))
        out.append(any(term in assistant_blob for term in equivalents))
    return out


def score_scenario(result: ScenarioResult, scenario: Scenario) -> float:
    """Compose state-hash + action-overlap + output-substring into a normalized score in [0, 1].

    STATIC weighting: 0.5 state_hash + 0.4 action_score + 0.1 substring_score.
    LIVE   weighting: 0.7 state_hash +                    0.3 substring_score.
    Errors / timeouts / cost overruns force 0.
    """
    if result.error is not None or result.terminated_reason in (
        "error",
        "timeout",
        "cost_exceeded",
    ):
        return 0.0

    state_component = 1.0 if result.state_hash_match else 0.0

    if scenario.required_outputs:
        substring_component = sum(result.output_substring_matches) / len(
            scenario.required_outputs
        )
    else:
        substring_component = 1.0

    if scenario.mode is ScenarioMode.STATIC:
        predicted_actions = [a for turn in result.turns for a in turn.agent_actions]
        action_component = compare_actions(predicted_actions, scenario.ground_truth_actions)
        if result.state_hash_match and action_component >= 0.5:
            # The executor is the semantic authority for state-changing
            # behavior. If the final world hash matches and the agent emitted
            # structurally matching action names, kwarg spelling differences
            # such as start_time vs details.start should not keep an otherwise
            # successful trajectory below pass@1.
            action_component = 1.0
        # Triviality guard: when the scenario specifies ground-truth actions
        # but the agent's actions don't overlap them at all (action_component
        # == 0), drop the state-match AND substring credit. Otherwise
        # read-only scenarios where the gt actions are no-ops would give
        # every agent — including WrongAgent and a do-nothing refusal —
        # the 0.5 state-match plus the 0.1 empty-substring "bonus" for
        # free. The substring component defaults to 1.0 when
        # `required_outputs` is empty, so the guard has to cover both.
        #
        # Carve-out: if the agent emitted at least one structurally correct
        # action (name canonicalizes to a GT name), it isn't trivial — the
        # agent did real work. The triviality guard is reserved for the
        # "no action OR wrong action" case.
        if scenario.ground_truth_actions and action_component == 0.0:
            state_component = 0.0
            substring_component = 0.0
        return (
            0.5 * state_component
            + 0.4 * action_component
            + 0.1 * substring_component
        )

    return 0.7 * state_component + 0.3 * substring_component


def pass_at_k(c: int, n: int, k: int) -> float:
    """Unbiased pass@k estimator from Chen et al. 2021 (HumanEval).

    `n` total samples, `c` correct, `k` is the k in pass@k. Returns 1.0 when
    `n - c < k` (every k-subset must contain a correct sample).
    """
    if n <= 0 or k <= 0 or k > n:
        return 0.0
    if c < 0 or c > n:
        raise ValueError(f"c={c} out of range for n={n}")
    if n - c < k:
        return 1.0
    return 1.0 - math.prod((n - c - i) / (n - i) for i in range(k))


def compile_benchmark_result(
    results: list[ScenarioResult],
    scenarios_by_id: dict[str, Scenario],
    *,
    seeds: int,
    model_name: str,
    judge_model_name: str,
    timestamp: str,
) -> BenchmarkResult:
    """Aggregate per-scenario results into a BenchmarkResult.

    `pass_at_1` is the fraction of (scenario, seed) pairs scoring >= 0.99.
    `pass_at_k` is the mean of per-scenario pass@k (k = min(seeds, n)).
    """
    if not results:
        return BenchmarkResult(
            scenarios=[],
            pass_at_1=0.0,
            pass_at_k=0.0,
            mean_score_per_domain={},
            total_cost_usd=0.0,
            total_latency_ms=0,
            model_name=model_name,
            judge_model_name=judge_model_name,
            timestamp=timestamp,
            seeds=seeds,
        )

    per_scenario: dict[str, list[ScenarioResult]] = {}
    for r in results:
        per_scenario.setdefault(r.scenario_id, []).append(r)

    pass_1_hits = 0
    pass_1_total = 0
    pass_k_values: list[float] = []
    domain_scores: dict[str, list[float]] = {}

    for scenario_id, runs in per_scenario.items():
        scenario = scenarios_by_id.get(scenario_id)
        if scenario is None:
            continue
        n = len(runs)
        per_run_scores = [score_scenario(r, scenario) for r in runs]
        pass_1_hits += sum(1 for s in per_run_scores if s >= 0.99)
        pass_1_total += n
        c = sum(1 for s in per_run_scores if s >= 0.99)
        pass_k_values.append(pass_at_k(c, n, min(seeds, n)))
        domain_scores.setdefault(scenario.domain.value, []).extend(per_run_scores)

    mean_per_domain = {
        domain: statistics.mean(scores) for domain, scores in domain_scores.items()
    }

    return BenchmarkResult(
        scenarios=results,
        pass_at_1=(pass_1_hits / pass_1_total) if pass_1_total > 0 else 0.0,
        pass_at_k=statistics.mean(pass_k_values) if pass_k_values else 0.0,
        mean_score_per_domain=mean_per_domain,
        total_cost_usd=sum(r.total_cost_usd for r in results),
        total_latency_ms=sum(r.total_latency_ms for r in results),
        model_name=model_name,
        judge_model_name=judge_model_name,
        timestamp=timestamp,
        seeds=seeds,
    )
