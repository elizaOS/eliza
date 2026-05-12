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
# `source_used` is runner-injected metadata on HEALTH by_metric responses
# (which source won deduplication); GT scenarios pre-date this field so its
# absence in GT kwargs must not penalise the agent's predicted action.
_SOFT_KWARGS: frozenset[str] = frozenset(
    {"intent", "rationale", "thought", "reasoning", "source_used"}
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
    # LIFE umbrella covers reminders + alarms write-ops. hermes/openclaw
    # frequently emit `LIFE_CREATE` / `LIFE_COMPLETE` granular forms; GT
    # scenarios use the umbrella `LIFE(subaction=create, ...)` shape.
    # `policy_set_reminder` / `policy_configure_escalation` are the two
    # policy-shape subactions declared by `life.ts`.
    "LIFE": (
        "subaction",
        frozenset(
            {
                "create",
                "complete",
                "snooze",
                "review",
                "delete",
                "update",
                "skip",
                "list",
                "policy_set_reminder",
                "policy_configure_escalation",
            }
        ),
    ),
    # HEALTH read-ops. Three views currently coexist in the bench (see
    # W5-hlt deep-dive): `runner._DISCRIMINATORS` uses {by_metric,
    # summary, trends}, the action source-of-truth `health.ts` uses
    # {today, trend, by_metric, status}, and the owner surface declares
    # the same `today/trend/by_metric/status` quartet. Union both spellings
    # so an emission like `HEALTH_TRENDS` (runner) or `HEALTH_TREND`
    # (manifest) both canonicalize cleanly into `HEALTH(subaction=…)`.
    # `compare_actions` still treats a kwarg-level subaction mismatch as
    # partial credit, not full, so we are not over-rewarding wrong reads.
    "HEALTH": (
        "subaction",
        frozenset({"today", "trend", "trends", "by_metric", "status", "summary"}),
    ),
    # BLOCK umbrella: focus / DND blocking. Note `BLOCK_BLOCK` is the
    # canonical granular form for the "place a block" verb.
    "BLOCK": (
        "subaction",
        frozenset(
            {
                "block",
                "unblock",
                "status",
                "request_permission",
                "release",
                "list_active",
            }
        ),
    ),
    # ENTITY umbrella: contacts / identity surface.
    # P1-5: `create` is the canonical TS subaction; `add` is the legacy alias
    # (scenario corpus uses `add`). `create_contact` covers the promoted
    # ENTITY_CREATE_CONTACT form some agents emit. `set_relationship` covers
    # the relationship-only update path some agents emit as `set_identity`.
    "ENTITY": (
        "subaction",
        frozenset(
            {
                "create",
                "add",
                "create_contact",
                "read",
                "list",
                "set_identity",
                "set_relationship",
                "log_interaction",
                "merge",
            }
        ),
    ),
    # SCHEDULED_TASK — delayed-task primitives. Source of truth:
    # `plugins/app-lifeops/src/actions/scheduled-task.ts` SUBACTIONS.
    "SCHEDULED_TASK": (
        "subaction",
        frozenset(
            {
                "list",
                "get",
                "create",
                "update",
                "snooze",
                "skip",
                "complete",
                "acknowledge",
                "dismiss",
                "cancel",
                "reopen",
                "history",
            }
        ),
    ),
    # MONEY umbrella: finance dashboard + transactions + subscription audit.
    "MONEY": (
        "subaction",
        frozenset(
            {
                "dashboard",
                "list_sources",
                "list_transactions",
                "spending_summary",
                "recurring_charges",
                "add_source",
                "remove_source",
                "import_csv",
                "subscription_audit",
                "subscription_cancel",
                "subscription_status",
            }
        ),
    ),
    # BOOK_TRAVEL umbrella: search/prepare/book/cancel/hold flight + hotel.
    "BOOK_TRAVEL": (
        "subaction",
        frozenset({"search", "prepare", "book", "cancel", "hold"}),
    ),
}


# Read-only subactions per umbrella. Mirrors the runner's `_u_*` no-op
# branches: any (umbrella, subaction) pair listed here does NOT mutate
# LifeWorld, so the state hash trivially matches the seed regardless of
# how correct the agent's call was. This is the source of the P0-8
# inflation pattern (W5-foc / W5-msg / W5-mail): every read-only scenario
# floor-scored 0.5+ on state_hash alone.
#
# `score_scenario` consults this map to re-weight reads so action
# correctness dominates instead of state-hash. Keep in lockstep with
# runner.py — when the runner gains a real mutation for a previously
# no-op subaction, drop the entry from the matching frozenset.
_READ_ONLY_SUBACTIONS: dict[str, frozenset[str]] = {
    # CALENDAR: search_events, check_availability, next_event are pure
    # queries; propose_times and update_preferences are runner no-ops
    # (planner-config, not modeled in LifeWorld). create/update/delete_event
    # mutate.
    "CALENDAR": frozenset(
        {
            "search_events",
            "check_availability",
            "next_event",
            "propose_times",
            "update_preferences",
        }
    ),
    # MESSAGE: every read-listing operation is a runner no-op. draft_reply
    # for non-gmail sources is also a no-op but is omitted here because the
    # GT typically uses source=gmail (which writes a draft); the partial
    # no-op variant doesn't appear in any read-only scenario today.
    "MESSAGE": frozenset(
        {
            "triage",
            "search_inbox",
            "list_channels",
            "read_channel",
            "read_with_contact",
        }
    ),
    # ENTITY: log_interaction and list are no-ops; add and set_identity
    # mutate the contact store. `read` is the TS canonical alias for `list`.
    "ENTITY": frozenset({"log_interaction", "list", "read"}),
    # LIFE: update/skip/list are no-ops in the runner because alarm definitions
    # and skip logs aren't modeled. create/complete/snooze do mutate reminders.
    # policy_* are configuration writes — treat as write so a wrong policy
    # doesn't get the state-hash freebie.
    # NOTE: `review` is intentionally excluded — it now writes last_reviewed_at
    # to reminder lists, so it lives in _READ_WITH_SIDE_EFFECTS_SUBACTIONS.
    "LIFE": frozenset({"update", "skip", "list"}),
    # HEALTH: today/trend/by_metric/status are pure reads (runner is fully no-op).
    # NOTE: `summary` and `trends` are excluded — they write last_reviewed_at to
    # health metrics metadata, so they live in _READ_WITH_SIDE_EFFECTS_SUBACTIONS.
    "HEALTH": frozenset({"today", "trend", "by_metric", "status"}),
    # MONEY: read verbs are all no-ops. subscription_cancel mutates
    # when confirmed=True; add_source / remove_source / import_csv mutate.
    "MONEY": frozenset(
        {
            "dashboard",
            "list_sources",
            "list_transactions",
            "spending_summary",
            "recurring_charges",
            "subscription_audit",
            "subscription_status",
        }
    ),
    # BLOCK: focus blocks are not modeled in LifeWorld, so every BLOCK
    # subaction is a no-op. This is the W5-foc inflation root cause.
    "BLOCK": frozenset(
        {
            "block",
            "unblock",
            "status",
            "request_permission",
            "release",
            "list_active",
        }
    ),
    # BOOK_TRAVEL: every subaction is a no-op (no travel state modeled).
    "BOOK_TRAVEL": frozenset({"search", "prepare", "book", "cancel", "hold"}),
    # SCHEDULED_TASK: list/get/history are reads. The mutating verbs
    # (create/update/snooze/skip/complete/etc.) actually persist via the
    # reminders store, except create-without-seed which the runner also
    # no-ops. Conservative: only the unambiguous reads land here.
    "SCHEDULED_TASK": frozenset({"list", "get", "history"}),
}


# Read-with-side-effects subactions per umbrella. These operations are
# primarily reads (return data to the user) but also write a small metadata
# mutation — e.g. LIFE_REVIEW stamps last_reviewed_at on reminder lists,
# and HEALTH summary/trends could stamp a last_queried_at field. Because
# they DO mutate state, the pure-read weight (0.1 state_hash) is too low,
# but the full write weight (0.5 state_hash) is also wrong since the primary
# signal is still action correctness. Intermediate weights apply:
#   READ_WITH_SIDE_EFFECTS: 0.15 state + 0.55 substring + 0.3 action
#
# Keep in lockstep with runner.py — when a subaction here is promoted to a
# full write (state hash becomes the primary signal), move it to the write
# category instead (i.e. remove it from both maps).
_READ_WITH_SIDE_EFFECTS_SUBACTIONS: dict[str, frozenset[str]] = {
    # LIFE: review stamps last_reviewed_at on the target reminder list.
    "LIFE": frozenset({"review"}),
    # HEALTH: summary and trends are listed in runner._DISCRIMINATORS as
    # read-only but are expected to update health metadata (last_queried_at).
    # Using the intermediate weight acknowledges the side-effect without
    # giving the full write state-hash weight.
    "HEALTH": frozenset({"summary", "trends"}),
}


def _is_read_only_action(action: Action) -> bool:
    """True if the (canonical umbrella, subaction) is a runner no-op.

    The caller should canonicalize first (`_canonicalize_action`) so this
    sees the umbrella shape regardless of granular vs umbrella spelling.
    """
    reads = _READ_ONLY_SUBACTIONS.get(action.name)
    if reads is None:
        return False
    field, _ = _UMBRELLA_SUBACTIONS.get(action.name, ("subaction", frozenset()))
    sub = action.kwargs.get(field)
    if isinstance(sub, str):
        return sub in reads
    return False


def _is_read_with_side_effects_action(action: Action) -> bool:
    """True if the (canonical umbrella, subaction) is a read-with-side-effects op.

    These operations primarily return data but also write small metadata
    mutations (e.g. last_reviewed_at). They get intermediate scoring weights
    rather than pure-read or pure-write weights.

    The caller should canonicalize first (`_canonicalize_action`).
    """
    rwse = _READ_WITH_SIDE_EFFECTS_SUBACTIONS.get(action.name)
    if rwse is None:
        return False
    field, _ = _UMBRELLA_SUBACTIONS.get(action.name, ("subaction", frozenset()))
    sub = action.kwargs.get(field)
    if isinstance(sub, str):
        return sub in rwse
    return False


def _classify_scenario_kind(scenario: Scenario) -> str:
    """Classify a scenario as 'read', 'write', 'mixed', or 'read_with_side_effects'.

    Classification rules (applied to every GT action after canonicalization):

    - `read`: every GT action is a runner no-op (pure read, no state change).
    - `read_with_side_effects`: every GT action is either a pure read or a
      read-with-side-effects op (e.g. LIFE_REVIEW writing last_reviewed_at),
      with at least one read_with_side_effects action present.
    - `write`: at least one GT action is a full mutating write and no reads
      or read_with_side_effects are present.
    - `mixed`: a combination of write actions with read or
      read_with_side_effects actions.

    Scenarios with no GT actions stay `write` so LIVE-mode weighting
    (which doesn't use action_score) is unaffected.
    """
    if not scenario.ground_truth_actions:
        return "write"
    saw_read = False
    saw_rwse = False
    saw_write = False
    for action in scenario.ground_truth_actions:
        canon = _canonicalize_action(action)
        if _is_read_only_action(canon):
            saw_read = True
        elif _is_read_with_side_effects_action(canon):
            saw_rwse = True
        else:
            saw_write = True
    if saw_write:
        return "write" if not (saw_read or saw_rwse) else "mixed"
    if saw_rwse:
        return "read_with_side_effects"
    return "read"


# Owner-surface aliases. The personal-assistant front controller exposes a
# parallel `OWNER_<AREA>_<VERB>` naming scheme; folding these into the
# matching umbrella lets the scorer compare them against the canonical
# `<UMBRELLA>(subaction=<verb>)` GT shape. Mappings are conservative —
# only the four areas with an obvious umbrella mapping are aliased.
_OWNER_SURFACE_ALIASES: dict[str, str] = {
    "OWNER_HEALTH": "HEALTH",
    # OWNER_ALARMS_*, OWNER_REMINDERS_*, OWNER_TODOS_*, OWNER_GOALS_*,
    # and OWNER_ROUTINES_* all fold into LIFE; the kind distinction is
    # carried by other kwargs (e.g. `kind`), not by a separate umbrella.
    # Source of truth: `plugins/app-lifeops/src/actions/owner-surfaces.ts`.
    "OWNER_ALARMS": "LIFE",
    "OWNER_REMINDERS": "LIFE",
    "OWNER_TODOS": "LIFE",
    "OWNER_GOALS": "LIFE",
    "OWNER_ROUTINES": "LIFE",
    "OWNER_FINANCES": "MONEY",
    # P1-5: CONTACT_* surface (e.g. CONTACT_CREATE) folds into ENTITY.
    # The TS `contact.ts` action exposes `CONTACT(op='create')` alongside the
    # canonical `ENTITY(subaction='create')` umbrella; map it here so the scorer
    # accepts both spellings as equivalent.
    "CONTACT": "ENTITY",
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
        # NOTE: LIFE_REVIEW was removed — it now writes last_reviewed_at to
        # reminder lists (read_with_side_effects). The hash is no longer
        # trivially unchanged, so it must NOT be treated as hash-inert.
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

    Also folds the personal-assistant owner-surface forms
    (`OWNER_HEALTH_TODAY`, `OWNER_REMINDERS_CREATE`, etc.) and the
    explicit `PERSONAL_ASSISTANT_BOOK_TRAVEL` shorthand into the matching
    umbrella so they compare against the canonical GT shape.

    A no-op when the action is already in umbrella form or when the name
    doesn't match a known promotion. The discriminator already present in
    kwargs wins over the one inferred from the name (so an agent that
    emits both is consistent with itself).
    """
    name = _ACTION_NAME_ALIASES.get(action.name, action.name)
    if name != action.name:
        action = Action(name=name, kwargs=action.kwargs)

    # PERSONAL_ASSISTANT_BOOK_TRAVEL is a fixed shorthand for the BOOK_TRAVEL
    # umbrella with no implicit subaction — leave subaction resolution to
    # kwargs the agent already provided.
    if name == "PERSONAL_ASSISTANT_BOOK_TRAVEL":
        return Action(name="BOOK_TRAVEL", kwargs=dict(action.kwargs))

    # Owner-surface aliases: `OWNER_<AREA>_<SUB>` → `<UMBRELLA>(subaction=<sub>)`.
    # Check before the generic umbrella loop so e.g. `OWNER_HEALTH_TODAY` is
    # not accidentally read as an unknown `OWNER` prefix.
    for owner_prefix, umbrella in _OWNER_SURFACE_ALIASES.items():
        prefix = f"{owner_prefix}_"
        if not name.startswith(prefix):
            continue
        candidate = name[len(prefix) :].lower()
        field, subactions = _UMBRELLA_SUBACTIONS[umbrella]
        if candidate not in subactions:
            continue
        new_kwargs = dict(action.kwargs)
        new_kwargs.setdefault(field, candidate)
        return Action(name=umbrella, kwargs=new_kwargs)


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


def _coerce_passengers(value: Any) -> list[dict[str, str]] | None:
    """Coerce a passengers value to a canonical array form for comparison.

    The agent may emit a bare integer count (e.g. ``2``) while the GT scenario
    uses an array of passenger objects (e.g. ``[{type: "adult"}, ...]``). Both
    represent the same booking intent — the count is what matters, not the
    field names inside each passenger dict. Returns a list of length N with
    placeholder objects, or None if the value is not coercible.
    """
    if isinstance(value, int) and value > 0:
        return [{"name": f"passenger_{i + 1}", "seat_class": "economy"} for i in range(value)]
    if isinstance(value, float) and value > 0 and value == int(value):
        n = int(value)
        return [{"name": f"passenger_{i + 1}", "seat_class": "economy"} for i in range(n)]
    if isinstance(value, list):
        return value  # already array form; return as-is for length comparison
    return None


def _passengers_equivalent(predicted: Any, expected: Any) -> bool:
    """Compare two passengers kwarg values by passenger count only.

    Accepts: integer count, array of any passenger-shaped dicts (field names
    are ignored — only the array length is compared). This lets ``passengers: 2``
    score correctly against GT ``[{type: "adult"}, {type: "adult"}]``.
    """
    pred_arr = _coerce_passengers(predicted)
    exp_arr = _coerce_passengers(expected)
    if pred_arr is None or exp_arr is None:
        return predicted == expected
    return len(pred_arr) == len(exp_arr)


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
        pred_value = predicted[key]
        # passengers: accept integer count ↔ array-of-objects as equivalent
        # when the count matches. Agents often emit a bare integer while GT
        # scenarios use [{type:"adult"}, ...] or [{name:…, seat_class:…}, …].
        if key == "passengers":
            if not _passengers_equivalent(pred_value, exp_value):
                return False
            continue
        if key in {"window_start", "window_end"} and _range_boundary_equivalent(
            key, pred_value, exp_value
        ):
            continue
        if not _values_equivalent(pred_value, exp_value):
            return False
    return True


def _action_is_hash_inert(action: Action) -> bool:
    """Whether final-world hash equality cannot validate this action's kwargs."""
    action = _canonicalize_action(action)
    if action.name in _HASH_INERT_ACTION_NAMES:
        # Carve-out: LIFE(subaction=review) now writes last_reviewed_at to
        # reminder lists so the hash IS meaningful for LIFE/review calls.
        # All other LIFE subactions in the inert set are still no-ops.
        if action.name == "LIFE" and action.kwargs.get("subaction") == "review":
            return False
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


_MESSAGE_SEND_CONTACT_KEYS: tuple[str, ...] = (
    "target",
    "contact_id",
    "contact",
    "to",
    "recipient_id",
    "recipient",
)


def _message_send_wrong_contact(
    pred_kwargs: dict[str, Any],
    gt_kwargs: dict[str, Any],
) -> bool:
    """Return True when a MESSAGE/send GT specifies a contact and the agent
    addressed a different one.

    Looks at the canonical contact-identity keys in priority order. Returns
    False (no penalty) when GT doesn't specify a contact key or when the agent
    used the same contact.
    """
    for key in _MESSAGE_SEND_CONTACT_KEYS:
        gt_val = gt_kwargs.get(key)
        if not isinstance(gt_val, str) or not gt_val:
            continue
        pred_val = pred_kwargs.get(key)
        if not isinstance(pred_val, str) or not pred_val:
            return True
        if _normalize_string(pred_val) != _normalize_string(gt_val):
            return True
        return False
    return False


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

    P2-10 source-mismatch penalty: for MESSAGE/send actions, if the GT
    specifies a contact (target / contact_id / to / …) and the agent addressed
    a different one, the name-only partial credit is further multiplied by 0.5
    (yielding 0.25 instead of 0.5). The agent still tried to send a message —
    just to the wrong person — so it isn't scored as zero, but partial credit
    is materially reduced to signal the error.

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
            if _kwargs_match(pred.kwargs, gt.kwargs):
                value = 1.0
            else:
                value = 0.5
                # P2-10: penalize MESSAGE/send with wrong contact address.
                if (
                    pred.name == "MESSAGE"
                    and pred.kwargs.get("operation") == "send"
                    and gt.kwargs.get("operation") == "send"
                    and _message_send_wrong_contact(pred.kwargs, gt.kwargs)
                ):
                    value *= 0.5
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

    STATIC weighting depends on whether the scenario's ground-truth
    actions all canonicalize to runner-no-op reads:

    * WRITE scenarios (at least one mutating GT action):
          0.5 state_hash + 0.4 action_score + 0.1 substring_score.
      State hash is the executor's verdict on whether the world ended up
      where it was supposed to, so it's the dominant signal.

    * READ scenarios (every GT action is a runner no-op like
      CALENDAR/check_availability, MONEY/dashboard, HEALTH/today, …):
          0.1 state_hash + 0.7 action_score + 0.2 substring_score.
      The runner can't tell correct from incorrect read calls — both
      replays produce identical state hashes. Re-weighting forces
      action correctness to dominate so a malformed BLOCK or a
      `source: gmail`-mismatched MESSAGE/read_with_contact actually
      loses points instead of getting the 0.5 state_hash freebie.

    * READ_WITH_SIDE_EFFECTS scenarios (every GT action is a read or a
      read-with-side-effects op like LIFE/review or HEALTH/summary, with
      at least one side-effecting action present):
          0.15 state_hash + 0.3 action_score + 0.55 substring_score.
      These operations write small metadata mutations (e.g. last_reviewed_at)
      so the state hash is no longer trivially unchanged — but the primary
      signal is still action + output correctness, not the mutation. The
      0.15 state weight acknowledges the side-effect without giving the full
      write weight (0.5) to the hash component.

    * MIXED scenarios (some reads/rwse + some writes): split the difference,
      keeping state_hash credibility for the write portion while
      penalizing wrong reads — 0.35 state_hash + 0.5 action_score +
      0.15 substring_score.

    LIVE weighting (no GT actions, judged by world hash + judge):
          0.7 state_hash + 0.3 substring_score.

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

        kind = _classify_scenario_kind(scenario)

        # The state-hash → action promotion only makes sense for writes:
        # on a write scenario the world ending up correct is strong
        # evidence the agent's call did the right thing, even if kwarg
        # spellings drift (e.g. `start_time` vs `details.start`). On a
        # read scenario the state hash always matches trivially, so
        # promoting partial action credit to full is exactly the
        # inflation P0-8 exists to remove.
        if (
            kind == "write"
            and result.state_hash_match
            and action_component >= 0.5
            and _state_hash_can_promote_action_score(
                predicted_actions, scenario.ground_truth_actions
            )
        ):
            action_component = 1.0

        # Triviality guard: when the scenario specifies ground-truth actions
        # but the agent's actions don't overlap them at all (action_component
        # == 0), drop the state-match AND substring credit. Otherwise
        # read-only scenarios where the gt actions are no-ops would give
        # every agent — including WrongAgent and a do-nothing refusal —
        # the state-match plus the empty-substring "bonus" for free. The
        # substring component defaults to 1.0 when `required_outputs` is
        # empty, so the guard has to cover both.
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

        if kind == "read":
            state_weight, action_weight, substring_weight = 0.1, 0.7, 0.2
        elif kind == "read_with_side_effects":
            state_weight, action_weight, substring_weight = 0.15, 0.3, 0.55
        elif kind == "mixed":
            state_weight, action_weight, substring_weight = 0.35, 0.5, 0.15
        else:
            state_weight, action_weight, substring_weight = 0.5, 0.4, 0.1

        return (
            state_weight * state_component
            + action_weight * action_component
            + substring_weight * substring_component
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
