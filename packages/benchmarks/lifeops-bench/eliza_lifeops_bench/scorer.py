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
import unicodedata
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
    "cancel": (
        "cancel",
        "cancelled",
        "canceled",
        "removed",
        "deleted",
    ),
    "slot": (
        "slot",
        "slots",
        "opening",
        "openings",
    ),
}

_TIME_12H_RE = re.compile(
    r"(?<![a-z0-9])"
    r"(?P<hour>1[0-2]|0?[1-9])"
    r"(?:[:.](?P<minute>[0-5]\d))?"
    r"\s*(?P<ampm>am|pm)\b"
)
_TIME_24H_RE = re.compile(
    r"(?<!\d)"
    r"(?P<hour>[01]?\d|2[0-3])"
    r":(?P<minute>[0-5]\d)"
    r"(?:\s*(?:utc|z))?\b"
)

_KWARG_ALIASES: dict[str, str] = {
    "atIso": "at_iso",
    "calendarId": "calendar_id",
    "completionCheck": "completion_check",
    "eventId": "event_id",
    "entityId": "entity_id",
    "displayName": "display_name",
    "daysAhead": "days_ahead",
    "durationMinutes": "duration_minutes",
    "endAt": "end",
    "end_time": "end",
    "listId": "list_id",
    "messageId": "message_id",
    "newEnd": "end",
    "newStart": "start",
    "promptInstructions": "prompt_instructions",
    "respectsGlobalPause": "respects_global_pause",
    "roomId": "room_id",
    "scheduledTaskId": "scheduled_task_id",
    "shouldFire": "should_fire",
    "slotCount": "slot_count",
    "startAt": "start",
    "start_time": "start",
    "taskId": "task_id",
    "threadId": "thread_id",
    "windowEnd": "window_end",
    "windowStart": "window_start",
}

_NESTED_KWARG_GROUPS: frozenset[str] = frozenset({"details", "updates"})


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

_DISCRIMINATOR_ACTION_ALIASES: dict[str, tuple[str, dict[str, str], frozenset[str]]] = {
    "CALENDAR": (
        "subaction",
        {
            "feed": "search_events",
            "trip_window": "search_events",
        },
        _UMBRELLA_SUBACTIONS["CALENDAR"][1],
    ),
    "MESSAGE": (
        "operation",
        {
            "draft_followup": "draft_reply",
            "list_inbox": "search_inbox",
            "respond": "send",
            "search": "search_inbox",
            "send_draft": "send",
        },
        _UMBRELLA_SUBACTIONS["MESSAGE"][1],
    ),
    "ENTITY": (
        "subaction",
        {
            "create": "add",
            "read": "list",
        },
        frozenset({"add", "list", "log_interaction", "set_identity"}),
    ),
}

_ACTION_NAME_ALIASES: dict[str, str] = {
    "SCHEDULED_TASKS_CREATE": "SCHEDULED_TASK_CREATE",
    "SCHEDULED_TASKS_SNOOZE": "SCHEDULED_TASK_SNOOZE",
    "SCHEDULED_TASKS_UPDATE": "SCHEDULED_TASK_UPDATE",
}

_HASH_INERT_ACTION_NAMES: frozenset[str] = frozenset(
    {
        "BOOK_TRAVEL",
        "BLOCK",
        "BLOCK_BLOCK",
        "BLOCK_LIST_ACTIVE",
        "BLOCK_RELEASE",
        "BLOCK_REQUEST_PERMISSION",
        "BLOCK_STATUS",
        "BLOCK_UNBLOCK",
        "HEALTH",
        "LIFE",
        "LIFE_REVIEW",
        "LIFE_SKIP",
        "LIFE_UPDATE",
        "MONEY",
        "MONEY_DASHBOARD",
        "MONEY_LIST_SOURCES",
        "MONEY_LIST_TRANSACTIONS",
        "MONEY_RECURRING_CHARGES",
        "MONEY_SPENDING_SUMMARY",
        "MONEY_SUBSCRIPTION_AUDIT",
        "MONEY_SUBSCRIPTION_STATUS",
        "SCHEDULED_TASKS",
        "SCHEDULED_TASKS_GET",
        "SCHEDULED_TASKS_HISTORY",
        "SCHEDULED_TASKS_LIST",
    }
)

_HASH_INERT_UMBRELLA_SUBACTIONS: dict[str, tuple[str, frozenset[str]]] = {
    "CALENDAR": (
        "subaction",
        frozenset(
            {
                "check_availability",
                "next_event",
                "propose_times",
                "search_events",
                "update_preferences",
            }
        ),
    ),
    "ENTITY": ("subaction", frozenset({"list", "log_interaction"})),
    "MESSAGE": (
        "operation",
        frozenset(
            {
                "list_channels",
                "read_channel",
                "read_with_contact",
                "search_inbox",
                "triage",
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
    name = _ACTION_NAME_ALIASES.get(action.name, action.name)
    if name != action.name:
        action = Action(name=name, kwargs=action.kwargs)
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
    alias_config = _DISCRIMINATOR_ACTION_ALIASES.get(name)
    if alias_config is not None:
        field, aliases, allowed = alias_config
        raw_action = action.kwargs.get("action")
        if isinstance(raw_action, str):
            candidate = aliases.get(raw_action, raw_action)
            if candidate in allowed:
                new_kwargs = dict(action.kwargs)
                new_kwargs.setdefault(field, candidate)
                new_kwargs.pop("action", None)
                return Action(name=name, kwargs=new_kwargs)
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


def _canonical_kwarg_key(key: str) -> str:
    return _KWARG_ALIASES.get(key, key)


def _canonicalize_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Normalize structurally equivalent kwarg spellings for comparison only."""
    out: dict[str, Any] = {}
    nested: list[dict[str, Any]] = []
    for raw_key, raw_value in kwargs.items():
        key = _canonical_kwarg_key(raw_key)
        if key in _NESTED_KWARG_GROUPS and isinstance(raw_value, dict):
            nested.append(_canonicalize_kwargs(raw_value))
            continue
        value = (
            _canonicalize_kwargs(raw_value)
            if isinstance(raw_value, dict)
            else raw_value
        )
        out[key] = value

    # Scenario authors and adapters often disagree on whether `details` /
    # `updates` fields are nested or top-level. Merge nested structured fields
    # after top-level values so explicit top-level kwargs win.
    for nested_kwargs in nested:
        for key, value in nested_kwargs.items():
            out.setdefault(key, value)
    return out


def _range_boundary_equivalent(key: str, predicted: Any, expected: Any) -> bool:
    predicted_dt = _try_parse_iso(predicted)
    expected_dt = _try_parse_iso(expected)
    if predicted_dt is None or expected_dt is None:
        return False
    if predicted_dt.date() != expected_dt.date():
        return False
    if key == "window_start":
        return predicted_dt <= expected_dt
    if key == "window_end":
        return predicted_dt >= expected_dt
    return False


def _normalize_string(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def _normalize_output_text(s: str) -> str:
    normalized = unicodedata.normalize("NFKC", s)
    normalized = normalized.replace("\u00a0", " ").replace("\u202f", " ")
    normalized = re.sub(r"[\u2010-\u2015]", "-", normalized)
    normalized = normalized.lower()
    normalized = re.sub(r"\b([ap])\s*\.?\s*m\.?\b", r"\1m", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def _extract_time_minutes(text: str) -> set[int]:
    """Extract explicit clock times as minutes after midnight.

    Used only for required-output matching. This keeps exact substring
    matching as the primary rule while accepting equivalent spellings such as
    `3pm`, `3 p.m.`, `15:00`, and `15:00 UTC`.
    """
    normalized = _normalize_output_text(text)
    minutes: set[int] = set()

    for match in _TIME_12H_RE.finditer(normalized):
        hour = int(match.group("hour"))
        minute = int(match.group("minute") or "0")
        ampm = match.group("ampm")
        if ampm == "am" and hour == 12:
            hour = 0
        elif ampm == "pm" and hour != 12:
            hour += 12
        minutes.add(hour * 60 + minute)

    for match in _TIME_24H_RE.finditer(normalized):
        # `3:00pm` is already handled by the 12-hour regex. Treating the
        # `3:00` prefix as 03:00 would create a false equivalent for 3am.
        suffix = normalized[match.end() : match.end() + 4].lstrip()
        if suffix.startswith(("am", "pm")):
            continue
        hour = int(match.group("hour"))
        minute = int(match.group("minute"))
        minutes.add(hour * 60 + minute)

    return minutes


def _required_output_matches(
    *,
    assistant_blob: str,
    assistant_times: set[int],
    needle: str,
) -> bool:
    normalized = _normalize_output_text(needle)
    equivalents = _OUTPUT_EQUIVALENTS.get(normalized, (normalized,))

    for term in equivalents:
        normalized_term = _normalize_output_text(term)
        if normalized_term and _contains_normalized_phrase(
            assistant_blob, normalized_term
        ):
            return True
        expected_times = _extract_time_minutes(normalized_term)
        if expected_times and expected_times.intersection(assistant_times):
            return True

    return False


def _contains_normalized_phrase(haystack: str, needle: str) -> bool:
    """Return True when `needle` appears as a phrase, not inside another word."""
    if not needle:
        return False
    pattern = re.escape(needle)
    if needle[0].isalnum():
        pattern = rf"(?<![a-z0-9]){pattern}"
    if needle[-1].isalnum():
        pattern = rf"{pattern}(?![a-z0-9])"
    return re.search(pattern, haystack) is not None


def _kwargs_match(predicted: dict[str, Any], expected: dict[str, Any]) -> bool:
    """Tolerant kwarg equality: every load-bearing key in `expected` must match in `predicted`.

    Extra keys on `predicted` are ignored — the agent may pass through more
    fields than the ground truth specifies.

    Keys in `_SOFT_KWARGS` are documentation-only and never load-bearing.
    Real models often emit paraphrased `intent` fields while the executable
    kwargs are correct, so soft fields are ignored on both sides.
    """
    predicted = _canonicalize_kwargs(predicted)
    expected = _canonicalize_kwargs(expected)
    for key, exp_value in expected.items():
        if key in _SOFT_KWARGS:
            continue
        if key not in predicted:
            return False
        if key in {"window_start", "window_end"} and _range_boundary_equivalent(
            key, predicted[key], exp_value
        ):
            continue
        if not _values_equivalent(predicted[key], exp_value):
            return False
    return True


def _action_is_hash_inert(action: Action) -> bool:
    """Whether final-world hash equality cannot validate this action's kwargs."""
    action = _canonicalize_action(action)
    if action.name in _HASH_INERT_ACTION_NAMES:
        return True
    if action.name == "MONEY_SUBSCRIPTION_CANCEL":
        return not bool(action.kwargs.get("confirmed", False))
    if action.name == "LIFE_DELETE":
        target = action.kwargs.get("target")
        return not (isinstance(target, str) and target.startswith("reminder_"))
    discriminator = _HASH_INERT_UMBRELLA_SUBACTIONS.get(action.name)
    if discriminator is None:
        return False
    field, values = discriminator
    value = action.kwargs.get(field)
    return isinstance(value, str) and value in values


def _has_creditable_action_overlap(
    predicted: list[Action],
    ground_truth: list[Action],
) -> bool:
    """Return whether any emitted action is behaviorally creditable.

    For mutating actions, a canonical name match is enough for partial credit
    because a matching final state can validate the effect. For hash-inert
    read-only/no-op actions, kwargs must match too; otherwise WrongAgent-like
    same-tool calls can get free state-hash credit.
    """
    canon_predicted = [_canonicalize_action(p) for p in predicted]
    canon_truth = [_canonicalize_action(g) for g in ground_truth]
    for pred in canon_predicted:
        for gt in canon_truth:
            if pred.name != gt.name:
                continue
            if _action_is_hash_inert(gt):
                if _kwargs_match(pred.kwargs, gt.kwargs):
                    return True
                continue
            return True
    return False


def _state_hash_can_promote_action_score(
    predicted: list[Action],
    ground_truth: list[Action],
) -> bool:
    """Whether state equality can safely turn structural action overlap into 1.0."""
    canon_predicted = [_canonicalize_action(p) for p in predicted]
    canon_truth = [_canonicalize_action(g) for g in ground_truth]
    consumed: set[int] = set()
    for gt in canon_truth:
        best_idx: int | None = None
        for idx, pred in enumerate(canon_predicted):
            if idx in consumed or pred.name != gt.name:
                continue
            if _action_is_hash_inert(gt) and not _kwargs_match(pred.kwargs, gt.kwargs):
                continue
            best_idx = idx
            if _kwargs_match(pred.kwargs, gt.kwargs):
                break
        if best_idx is None:
            return False
        consumed.add(best_idx)
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
    """For each required substring, return whether ANY assistant turn contains it.

    Matching is case-insensitive and format-tolerant for output-only surface
    forms. It still requires literal content overlap except for explicit clock
    times, where equivalent 12-hour and 24-hour spellings compare equal.
    """
    assistant_blob = "\n".join(
        turn.content or "" for turn in history if turn.role == "assistant"
    )
    normalized_blob = _normalize_output_text(assistant_blob)
    assistant_times = _extract_time_minutes(normalized_blob)
    out: list[bool] = []
    for needle in required:
        out.append(
            _required_output_matches(
                assistant_blob=normalized_blob,
                assistant_times=assistant_times,
                needle=needle,
            )
        )
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
        action_component = compare_actions(
            predicted_actions, scenario.ground_truth_actions
        )
        if (
            result.state_hash_match
            and action_component >= 0.5
            and _state_hash_can_promote_action_score(
                predicted_actions, scenario.ground_truth_actions
            )
        ):
            # The executor is the semantic authority for state-changing
            # behavior. If the final world hash matches and the agent emitted
            # structurally matching action names, kwarg spelling differences
            # such as start_time vs details.start should not keep an otherwise
            # successful trajectory below pass@1. Read-only/no-op actions are
            # excluded unless their kwargs match, because state equality cannot
            # prove they looked up the right thing.
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
        if scenario.ground_truth_actions and (
            action_component == 0.0
            or not _has_creditable_action_overlap(
                predicted_actions, scenario.ground_truth_actions
            )
        ):
            action_component = 0.0
            state_component = 0.0
            substring_component = 0.0
        return (
            0.5 * state_component
            + 0.4 * action_component
            + 0.1 * substring_component
        )

    if result.terminated_reason != "satisfied":
        return 0.0
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

    expected_seed_count = max(1, seeds)
    for scenario_id, scenario in scenarios_by_id.items():
        runs = per_scenario.get(scenario_id, [])
        n = max(expected_seed_count, len(runs))
        per_run_scores = [score_scenario(r, scenario) for r in runs]
        pass_1_hits += sum(1 for s in per_run_scores if s >= 0.99)
        pass_1_total += n
        c = sum(1 for s in per_run_scores if s >= 0.99)
        pass_k_values.append(pass_at_k(c, n, min(expected_seed_count, n)))
        domain_scores.setdefault(scenario.domain.value, []).extend(
            per_run_scores + [0.0] * (n - len(per_run_scores))
        )

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
