"""Benchmark orchestration for LifeOpsBench.

Drives an agent through each scenario, applies its tool calls against an
in-memory `LifeWorld`, and computes per-scenario + aggregate scores.

The agent function signature is `(history, tool_manifest) -> next_assistant_turn`.
Tool calls embedded in the assistant turn (`tool_calls=[{...}]`) are executed
against the world via `_execute_action`. Unknown action names raise
`UnsupportedAction` so gaps surface immediately rather than silently no-op.

Action-name vocabulary
----------------------
The executor speaks two distinct surfaces and dispatches both through the
same registry so adapters can mix-and-match:

1. **Umbrella verbs** (the canonical Eliza surface, also what the static
   scenario corpus authors): a single name per domain (e.g. `CALENDAR`, `MESSAGE`,
   `ENTITY`, `LIFE_CREATE`, `MONEY`) with a discriminator inside kwargs:

       Action(name="CALENDAR", kwargs={"subaction": "update_event", ...})

   The discriminator field is `subaction` for most umbrellas; the
   `MESSAGE` umbrella uses `operation` because that matches the Eliza
   message handler. These mirror the planner's surface.

2. **Fine-grained verbs** (kept for the inline conformance corpus and
   adapters that emit explicit tool ids): `<DOMAIN>.<verb>` like
   `CALENDAR.create`, `MAIL.archive`, `REMINDER.complete`. These remain
   supported because the inline conformance scenarios use them.

Determinism contract
--------------------
For state-hash scoring to work, two replays of the same `Action` against
two different worlds must produce identical mutations. Where a scenario
omits an explicit id (umbrella `LIFE_CREATE`, etc.), the executor derives
a deterministic synthetic id from kwargs via `_synthetic_id()`. Read-only
subactions return diagnostic payloads but never mutate state.
"""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import logging
import os
import re
import secrets
from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, cast

from .action_lineage import (
    scheduled_task_create_receipt_id,
    scheduled_task_trigger,
)
from .clients.base import BaseClient
from .evaluator import LifeOpsEvaluator
from .evidence import (
    EvidenceVerificationError,
    TrustedEvidenceVerifier,
    TrustedExecutionContext,
    TrustedToolExecutor,
    mark_authenticated_external_result,
    mark_deterministic_lifeworld_result,
    validate_action_policy,
    validate_tool_call_id,
    verify_result_trusted_evidence,
)
from .lifeworld import EntityKind, LifeWorld
from .lifeworld.entities import (
    ChatChannel,
    ChatMessage,
    Contact,
    EmailFolder,
    EmailMessage,
    EmailThread,
    FocusBlock,
    HealthMetric,
    MessageSource,
    Reminder,
    TravelOffer,
    WorkoutRecord,
)
from .scorer import (
    compile_benchmark_result,
    output_substring_match,
    score_scenario,
    state_hash,
)
from .types import (
    Action,
    BenchmarkResult,
    Disruption,
    Domain,
    EvaluatorTraceEntry,
    MessageTurn,
    Scenario,
    ScenarioMode,
    ScenarioResult,
    StaticGradingMode,
    TrustedEvidenceRequirement,
    TurnResult,
    VerifiedEvidenceReceipt,
    compute_cache_hit_pct,
)

logger = logging.getLogger(__name__)


AgentFn = Callable[[list[MessageTurn], list[dict[str, Any]]], Awaitable[MessageTurn]]
WorldFactory = Callable[[int, str], LifeWorld]
AgentFactory = Callable[["Scenario"], AgentFn]


class CostBudgetExceeded(Exception):
    """Raised when the cumulative spend across scenarios exceeds the configured cap."""


class UnsupportedAction(RuntimeError):
    """Raised when the executor doesn't know how to apply an action against the world."""


def _unsupported_no_effect(
    *,
    operation: str,
    reason: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return an explicit failure when LifeWorld cannot model an operation.

    A state-preserving result must never look like successful execution merely
    because ground-truth replay preserves the same hash. Modeled reads return
    their real snapshot data instead; unmodeled reads and writes use this
    failure shape so adapters, traces, and corpus audits can distinguish a
    genuine empty result from missing benchmark semantics.
    """
    result: dict[str, Any] = {
        "ok": False,
        "status": "unsupported",
        "noEffect": True,
        "operation": operation,
        "reason": reason,
    }
    if details:
        result.update(details)
    return result


# ---------------------------------------------------------------------------
# Action executor — top-level dispatch
# ---------------------------------------------------------------------------


def _execute_action(action: Action, world: LifeWorld) -> dict[str, Any]:
    """Apply a ground-truth-style `Action` to `world` and return a tool-result payload.

    Two-level dispatch: the action name picks an umbrella handler, which then
    inspects `kwargs` to choose the concrete world mutation. Unknown names
    raise `UnsupportedAction` — never silently no-op. The runner catches and
    surfaces these so gaps land in `LIFEOPS_BENCH_GAPS.md`.
    """
    action = _normalize_action(action)
    handler = _ACTION_HANDLERS.get(action.name)
    if handler is None:
        raise UnsupportedAction(
            f"unsupported action in execute path: {action.name} — file gap in LIFEOPS_BENCH_GAPS.md"
        )
    return handler(world, action.kwargs, action.name)


def _initial_user_content(scenario: Scenario) -> str:
    return _benchmark_clock_context(scenario.now_iso) + "\n\n" f"{scenario.instruction}"


def _static_semantic_expectations(scenario: Scenario) -> bool:
    """Whether a STATIC scenario asks the judge to interpret response meaning."""
    return scenario.mode is ScenarioMode.STATIC and bool(
        scenario.required_outputs or scenario.static_rubric
    )


def _has_complete_static_semantic_trace(
    result: ScenarioResult,
    scenario: Scenario,
) -> bool:
    """Validate exact semantic-criterion coverage for publication metadata."""
    expected_ids = [
        f"output_{index + 1}" for index in range(len(scenario.required_outputs))
    ] + [f"rubric_{index + 1}" for index in range(len(scenario.static_rubric))]
    entries = [
        entry
        for entry in result.evaluator_trace
        if entry.role == "judge" and entry.judge_kind == "static_semantic"
    ]
    if len(entries) != 1:
        return False
    entry = entries[0]
    if entry.verdict_invalid or entry.criterion_verdicts is None:
        return False
    returned_ids = [item.get("id") for item in entry.criterion_verdicts]
    return returned_ids == expected_ids and all(
        isinstance(item.get("met"), bool) for item in entry.criterion_verdicts
    )


def _opening_leaks_hidden_goal(opening: str, hidden_goal: str) -> bool:
    """Detect verbatim and near-verbatim disclosure of an evaluator-only goal."""

    def tokens(value: str) -> list[str]:
        return re.findall(r"[^\W_]+", value.casefold(), flags=re.UNICODE)

    opening_tokens = tokens(opening)
    goal_tokens = tokens(hidden_goal)
    if not goal_tokens:
        return False
    normalized_opening = " ".join(opening_tokens)
    normalized_goal = " ".join(goal_tokens)
    if normalized_goal in normalized_opening:
        return True

    matcher = difflib.SequenceMatcher(
        None,
        goal_tokens,
        opening_tokens,
        autojunk=False,
    )
    matching_goal_tokens = sum(block.size for block in matcher.get_matching_blocks())
    longest = matcher.find_longest_match(
        0,
        len(goal_tokens),
        0,
        len(opening_tokens),
    ).size
    goal_coverage = matching_goal_tokens / len(goal_tokens)
    long_span_threshold = min(8, max(4, int(len(goal_tokens) * 0.65)))
    return len(goal_tokens) >= 5 and (
        goal_coverage >= 0.8 or longest >= long_span_threshold
    )


def _benchmark_clock_context(now_iso: str) -> str:
    """Render deterministic date context for model-facing benchmark prompts."""
    now = _try_parse_iso(now_iso)
    if now is None:
        return (
            f"Current benchmark time: {now_iso}. "
            "Interpret relative dates against this timestamp, not the wall-clock date."
        )

    weekday_name = now.strftime("%A")
    today = now.date()
    day_names = (
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    )
    anchors: list[str] = []
    for index, day_name in enumerate(day_names):
        delta = (index - now.weekday()) % 7
        if delta == 0:
            delta = 7
        anchors.append(f"{day_name}={today + timedelta(days=delta)}")

    return (
        f"Current benchmark time: {now_iso} ({weekday_name}, {today}). "
        "Interpret relative dates against this timestamp, not the wall-clock date. "
        "For bare weekday names, use the next occurrence after the benchmark time. "
        "Upcoming weekday anchors: " + ", ".join(anchors) + "."
    )


def supported_actions() -> set[str]:
    """Return every action name the executor knows how to apply against a LifeWorld."""
    return set(_ACTION_HANDLERS.keys())


_PROMOTED_ACTION_DEFAULTS: dict[str, tuple[str, str, str]] = {
    "CALENDAR_CREATE_EVENT": ("CALENDAR", "subaction", "create_event"),
    "CALENDAR_UPDATE_EVENT": ("CALENDAR", "subaction", "update_event"),
    "CALENDAR_DELETE_EVENT": ("CALENDAR", "subaction", "delete_event"),
    "CALENDAR_PROPOSE_TIMES": ("CALENDAR", "subaction", "propose_times"),
    "CALENDAR_SEARCH_EVENTS": ("CALENDAR", "subaction", "search_events"),
    "CALENDAR_CHECK_AVAILABILITY": ("CALENDAR", "subaction", "check_availability"),
    "CALENDAR_NEXT_EVENT": ("CALENDAR", "subaction", "next_event"),
    "CALENDAR_UPDATE_PREFERENCES": ("CALENDAR", "subaction", "update_preferences"),
    "CALENDAR_FEED": ("CALENDAR", "subaction", "search_events"),
    "CALENDAR_TRIP_WINDOW": ("CALENDAR", "subaction", "search_events"),
    "CALENDAR_BULK_RESCHEDULE": ("CALENDAR", "subaction", "bulk_reschedule"),
    # Small local models sometimes apply the granular BLOCK naming pattern to
    # source enumeration. Preserve the single CALENDAR_SOURCES contract while
    # accepting that unambiguous read-only spelling at the adapter boundary.
    "CALENDAR_LIST_ACTIVE": ("CALENDAR_SOURCES", "operation", "list"),
    # P1-5: contact-create aliases. Agents emit ENTITY_CREATE_CONTACT,
    # CONTACT_CREATE, or contact_create interchangeably with ENTITY/create.
    # Normalise all of them into ENTITY(subaction=create) before dispatch.
    "ENTITY_CREATE_CONTACT": ("ENTITY", "subaction", "create"),
    "CONTACT_CREATE": ("ENTITY", "subaction", "create"),
    "MESSAGE_SEND": ("MESSAGE", "operation", "send"),
    "MESSAGE_DRAFT_REPLY": ("MESSAGE", "operation", "draft_reply"),
    "MESSAGE_MANAGE": ("MESSAGE", "operation", "manage"),
    "MESSAGE_TRIAGE": ("MESSAGE", "operation", "triage"),
    "MESSAGE_SEARCH_INBOX": ("MESSAGE", "operation", "search_inbox"),
    "MESSAGE_LIST_CHANNELS": ("MESSAGE", "operation", "list_channels"),
    "MESSAGE_READ_CHANNEL": ("MESSAGE", "operation", "read_channel"),
    "MESSAGE_READ_WITH_CONTACT": ("MESSAGE", "operation", "read_with_contact"),
}

_ACTION_NAME_ALIASES: dict[str, str] = {
    # Retired action names → canonical replacements.
    "DEVICE_INTENT": "BLOCK",
    "LIFEOPS": "LIFE",
    "SCHEDULED_TASKS_CREATE": "SCHEDULED_TASK_CREATE",
    "SCHEDULED_TASKS_SNOOZE": "SCHEDULED_TASK_SNOOZE",
    "SCHEDULED_TASKS_UPDATE": "SCHEDULED_TASK_UPDATE",
}


_CALENDAR_ACTION_ALIASES: dict[str, str] = {
    "feed": "search_events",
    "trip_window": "search_events",
}

_MESSAGE_ACTION_ALIASES: dict[str, str] = {
    "list_inbox": "search_inbox",
    "search": "search_inbox",
    "respond": "send",
    "send_draft": "send",
    "draft_followup": "draft_reply",
}

_ENTITY_ACTION_ALIASES: dict[str, str] = {
    "create": "add",
    "read": "list",
}


def _normalize_action(action: Action) -> Action:
    """Canonicalize planner-facing aliases before executor dispatch."""
    aliased_name = _ACTION_NAME_ALIASES.get(action.name)
    if aliased_name is not None:
        return _normalize_action(Action(name=aliased_name, kwargs=action.kwargs))
    if action.name in {"REPLY", "RESPOND"}:
        return Action(name="REPLY", kwargs=action.kwargs)
    if action.name in {"ARCHIVE_EMAIL_THREAD", "ARCHIVE_THREAD"}:
        kwargs = dict(action.kwargs)
        kwargs.setdefault("source", "gmail")
        kwargs.setdefault("operation", "manage")
        kwargs.setdefault("manageOperation", "archive")
        return Action(name="MESSAGE", kwargs=kwargs)
    promoted = _PROMOTED_ACTION_DEFAULTS.get(action.name)
    if promoted is None:
        return _normalize_umbrella_discriminator(action)
    parent, discriminator, value = promoted
    kwargs = dict(action.kwargs)
    kwargs.setdefault(discriminator, value)
    return Action(name=parent, kwargs=kwargs)


def _normalize_umbrella_discriminator(action: Action) -> Action:
    """Accept field-registry discriminator aliases on umbrella actions."""
    if action.name == "CALENDAR":
        return _with_discriminator_alias(
            action,
            target_field="subaction",
            aliases=_CALENDAR_ACTION_ALIASES,
            allowed=set(_DISCRIMINATORS["CALENDAR"][1]),
        )
    if action.name == "MESSAGE":
        return _with_discriminator_alias(
            action,
            target_field="operation",
            aliases=_MESSAGE_ACTION_ALIASES,
            allowed=set(_DISCRIMINATORS["MESSAGE"][1]),
        )
    if action.name == "ENTITY":
        return _with_discriminator_alias(
            action,
            target_field="subaction",
            aliases=_ENTITY_ACTION_ALIASES,
            allowed=set(_DISCRIMINATORS["ENTITY"][1]),
        )
    return action


def _with_discriminator_alias(
    action: Action,
    *,
    target_field: str,
    aliases: dict[str, str],
    allowed: set[str],
) -> Action:
    kwargs = dict(action.kwargs)
    if target_field not in kwargs:
        if (
            action.name == "MESSAGE"
            and target_field == "operation"
            and "manage" in allowed
            and any(
                isinstance(kwargs.get(key), str) and kwargs.get(key)
                for key in (
                    "manageOperation",
                    "manage_operation",
                    "mailOperation",
                    "mail_operation",
                )
            )
        ):
            kwargs[target_field] = "manage"
            return Action(name=action.name, kwargs=kwargs)
        raw = kwargs.get("action")
        if action.name == "MESSAGE" and target_field == "operation":
            raw = kwargs.get("subaction", raw)
        if isinstance(raw, str):
            candidate = aliases.get(raw, raw)
            if candidate in allowed:
                kwargs[target_field] = candidate
    return Action(name=action.name, kwargs=kwargs)


_OPENAI_FUNCTION_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_TOOL_DESCRIPTIONS: dict[str, str] = {
    "CALENDAR": (
        "Read or mutate calendar state. Use subaction=create_event, update_event, "
        "delete_event, propose_times, search_events, check_availability, next_event, "
        "or update_preferences. Also use CALENDAR.create_event to carve out time "
        "on the calendar — focus blocks, deep-work blocks, and any 'block out N "
        "hours for X' request are calendar events, NOT BLOCK actions."
    ),
    "CALENDAR_SOURCES": (
        "List or administer exact calendar sources. Use operation=list before "
        "select/deselect, then echo provider, grantId, connectorAccountId, "
        "calendarId, and expectedVersion. Connect/reconnect returns an explicit "
        "authorization, device-permission, or configuration handoff; it never "
        "means the external source is connected until a provider receipt proves it."
    ),
    "MESSAGE": (
        "Send, draft, search, triage, or manage messages and email. Use operation=send, "
        "draft_reply, manage, triage, search_inbox, list_channels, read_channel, or "
        "read_with_contact. Use source=gmail for email."
    ),
    "ENTITY": (
        "Manage people and identity records. Use subaction=create, add, update, "
        "set_identity, set_relationship, log_interaction, or list."
    ),
    "LIFE_CREATE": (
        "Create a life record. Required: subaction='create', title:str, kind='definition', "
        "and details:{kind ∈ {reminder, alarm, workout, health_metric}, ...typed fields}. "
        "For reminder/alarm: details.due (ISO8601) and details.listId (default 'list_personal'); "
        "alarms also take cadence ∈ {daily, weekly}, timeOfDay 'HH:MM', dayOfWeek:[str] (weekly). "
        "Workout: details.distanceKm, durationMinutes, effort, occurredAtIso. "
        "Health metric: details.metric (e.g. weight_kg), value:float, occurredAtIso."
    ),
    "LIFE_COMPLETE": (
        "Mark a reminder complete. Required: subaction='complete', target='reminder_*' id. "
        "Only reminder_* targets are supported; other ids raise UnsupportedAction."
    ),
    "LIFE_SNOOZE": (
        "Push a reminder's due time forward. Required: subaction='snooze', "
        "target='reminder_*' id, minutes:int. The new due_at is the existing due_at "
        "(or world.now_iso) plus minutes."
    ),
    "LIFE_REVIEW": (
        "Read-only listing of life records. Required: subaction='review'. No state mutation."
    ),
    "LIFE_DELETE": (
        "Delete a reminder by id. Required: subaction='delete', target='reminder_*' id. "
        "Alarm definitions (no concrete id) are a structured no-op for parity with the executor."
    ),
    "LIFE_UPDATE": (
        "Update an alarm/reminder definition. Required: subaction='update', kind='definition', "
        "title:str, details:{...fields to patch} (e.g. timeOfDay, cadence). Modeled as a no-op "
        "because definitions aren't a separate LifeWorld entity."
    ),
    "LIFE_SKIP": (
        "Skip one occurrence of an alarm/reminder. Required: subaction='skip', kind='definition', "
        "title:str, details:{skipDate:'YYYY-MM-DD' or skipDates:[...]}. No-op (no skip-log entity)."
    ),
    "HEALTH": "Read health data without mutating state.",
    "MONEY": "Read financial state or route a money subaction.",
    "MONEY_DASHBOARD": "Read the financial dashboard.",
    "MONEY_LIST_TRANSACTIONS": "List financial transactions.",
    "MONEY_LIST_SOURCES": "List connected financial sources.",
    "MONEY_RECURRING_CHARGES": "List recurring charges.",
    "MONEY_SPENDING_SUMMARY": "Summarize spending.",
    "MONEY_SUBSCRIPTION_STATUS": "Read subscription status.",
    "MONEY_SUBSCRIPTION_AUDIT": "Audit subscriptions.",
    "MONEY_SUBSCRIPTION_CANCEL": (
        "Cancel a subscription. Include confirmed=true only when the user has "
        "authorized cancellation."
    ),
    "BOOK_TRAVEL": "Search or prepare travel options without booking.",
    "BLOCK": (
        "Block or unblock specific phone apps and desktop websites only. "
        "NOT for carving out blocks of time on the calendar — for calendar "
        "time-blocks (e.g. 'block 2 hours for deep work'), use CALENDAR with "
        "subaction=create_event."
    ),
    "BLOCK_BLOCK": "Block specific phone apps or desktop websites (not calendar time-blocks).",
    "BLOCK_UNBLOCK": "Unblock specific phone apps or desktop websites.",
    "BLOCK_LIST_ACTIVE": "List active app/website blocks.",
    "BLOCK_RELEASE": "Release an app/website block.",
    "BLOCK_STATUS": "Read app/website block status.",
    "BLOCK_REQUEST_PERMISSION": "Request permission to create or change an app/website block.",
    "SCHEDULED_TASK_CREATE": (
        "Create a scheduled task. Wire shape: kind, promptInstructions, and trigger "
        "are TOP-LEVEL flat fields. trigger is an OBJECT, not a string — use "
        '{"kind":"once","atIso":"2026-05-12T09:00:00Z"} for one-shot tasks or '
        '{"kind":"recurring","rrule":"FREQ=DAILY"} for recurring. Example: '
        '{"kind":"reminder","promptInstructions":"Stand up and stretch",'
        '"trigger":{"kind":"once","atIso":"2026-05-12T09:00:00Z"}}.'
    ),
    "SCHEDULED_TASK_UPDATE": (
        "Update an existing scheduled task. Wire shape: taskId is a TOP-LEVEL flat "
        "field; trigger (when present) is an OBJECT with kind+atIso/rrule, never a "
        "string. Example: "
        '{"subaction":"update","taskId":"task_abc",'
        '"trigger":{"kind":"once","atIso":"2026-05-13T10:00:00Z"}}.'
    ),
    "SCHEDULED_TASK_SNOOZE": (
        "Snooze a scheduled task. Wire shape: taskId and minutes are TOP-LEVEL flat "
        "fields. Example: "
        '{"subaction":"snooze","taskId":"task_abc","minutes":30}.'
    ),
}

_DISCRIMINATORS: dict[str, tuple[str, list[str]]] = {
    "CALENDAR": (
        "subaction",
        [
            "create_event",
            "update_event",
            "delete_event",
            "propose_times",
            "search_events",
            "check_availability",
            "next_event",
            "update_preferences",
        ],
    ),
    "CALENDAR_SOURCES": (
        "operation",
        ["list", "select", "deselect", "connect", "reconnect"],
    ),
    "MESSAGE": (
        "operation",
        [
            "send",
            "draft_reply",
            "manage",
            "triage",
            "search_inbox",
            "list_channels",
            "read_channel",
            "read_with_contact",
        ],
    ),
    # P1-5: `create` is the canonical TS subaction; `add` is the legacy alias
    # retained for scenario-corpus compatibility. `create_contact` covers the
    # ENTITY_CREATE_CONTACT promoted form some agents emit.
    "ENTITY": (
        "subaction",
        [
            "create",
            "add",
            "create_contact",
            "update",
            "set_identity",
            "set_relationship",
            "log_interaction",
            "list",
        ],
    ),
    "LIFE_CREATE": ("subaction", ["create"]),
    "LIFE_UPDATE": ("subaction", ["update"]),
    "LIFE_DELETE": ("subaction", ["delete"]),
    "LIFE_COMPLETE": ("subaction", ["complete"]),
    "LIFE_SKIP": ("subaction", ["skip"]),
    "LIFE_SNOOZE": ("subaction", ["snooze"]),
    "LIFE_REVIEW": ("subaction", ["review"]),
    "SCHEDULED_TASK_UPDATE": ("subaction", ["update"]),
    "SCHEDULED_TASK_SNOOZE": ("subaction", ["snooze"]),
    # All six spellings used across scenarios, scorer, and TS backend:
    # - "trend" (singular) appears in health_batch_001 GT scenarios
    # - "trends" (plural) appears in older runner fixture
    # - "today" / "status" / "summary" match the TS health.ts surface
    "HEALTH": (
        "subaction",
        [
            "by_metric",
            "delete_metric",
            "summary",
            "trends",
            "trend",
            "today",
            "status",
        ],
    ),
}


# JSON-schema fragment for SCHEDULED_TASK_* trigger objects. Documented inline so
# the LLM sees the {kind, atIso}/{kind, rrule} shape rather than guessing.
_TRIGGER_OBJECT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "Trigger is an OBJECT, never a string. Use kind=once with atIso (ISO8601) "
        "for one-shot triggers, or kind=recurring with rrule for recurring."
    ),
    "properties": {
        "kind": {"type": "string", "enum": ["once", "recurring"]},
        "atIso": {
            "type": "string",
            "description": "ISO8601 datetime (e.g. 2026-05-12T09:00:00Z) for kind=once.",
        },
        "rrule": {
            "type": "string",
            "description": "RFC 5545 RRULE string for kind=recurring.",
        },
    },
    "required": ["kind"],
    "additionalProperties": True,
}


# JSON-schema fragment for LIFE_CREATE details. Top-level fields are forbidden
# (title belongs at the top level of kwargs, not here).
_LIFE_CREATE_DETAILS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "Typed fields for the record being created. Do NOT put title here — title "
        "is a TOP-LEVEL flat field on the action kwargs."
    ),
    "properties": {
        "kind": {
            "type": "string",
            "enum": ["reminder", "alarm", "workout", "health_metric"],
            "description": "Discriminates the kind of life record to create.",
        },
        "listId": {
            "type": "string",
            "description": "Reminder list id (e.g. list_personal). Reminder/alarm only.",
        },
        "due": {
            "type": "string",
            "description": "ISO8601 due datetime. Reminder/alarm only.",
        },
        "cadence": {
            "type": "string",
            "description": "Cadence label (daily/weekly/etc). Reminder/alarm only.",
        },
        "timeOfDay": {
            "type": "string",
            "description": "HH:MM local time. Alarm only.",
        },
        "distanceKm": {"type": "number", "description": "Workout only."},
        "durationMinutes": {"type": "number", "description": "Workout only."},
        "occurredAtIso": {
            "type": "string",
            "description": "ISO8601 timestamp for workouts / health metrics.",
        },
        "metric": {
            "type": "string",
            "description": "Health metric type (e.g. weight_kg). health_metric only.",
        },
        "value": {
            "type": "number",
            "description": "Health metric numeric value. health_metric only.",
        },
    },
    "additionalProperties": True,
}


def _tool_parameters_for_action(action_name: str) -> dict[str, Any]:
    """Return a permissive JSON Schema for a LifeOps action.

    The schema requires only the action discriminator where one exists, but
    surfaces explicit top-level shape hints for LIFE_* / SCHEDULED_TASK_*
    verbs so the planner sees title/target as flat fields and trigger as an
    object. LifeOps scenarios use a broad, evolving action vocabulary, and a
    too-strict schema would reject valid benchmark kwargs before the executor
    can apply its own deterministic checks, so additionalProperties stays
    open.
    """
    schema: dict[str, Any] = {
        "type": "object",
        "properties": {},
        "additionalProperties": True,
    }
    discriminator = _DISCRIMINATORS.get(action_name)
    if discriminator is not None:
        field, values = discriminator
        schema["properties"][field] = {
            "type": "string",
            "enum": values,
            "description": f"LifeOps {action_name} discriminator.",
        }
        schema["required"] = [field]

    if action_name == "CALENDAR_SOURCES":
        schema["properties"].update(
            {
                "provider": {
                    "type": "string",
                    "enum": ["google", "microsoft", "apple_calendar", "ics"],
                    "description": "Exact calendar provider.",
                },
                "grantId": {
                    "type": "string",
                    "description": "Exact grant id copied from a fresh list result.",
                },
                "connectorAccountId": {
                    "type": "string",
                    "description": (
                        "Exact connector account id copied from a fresh list " "result."
                    ),
                },
                "calendarId": {
                    "type": "string",
                    "description": "Exact calendar id copied from a fresh list result.",
                },
                "expectedVersion": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Selection revision copied from a fresh list result.",
                },
                "forceSync": {
                    "type": "boolean",
                    "description": "Request a provider refresh before listing.",
                },
                "name": {
                    "type": "string",
                    "description": "Display name for a new ICS source.",
                },
                "url": {
                    "type": "string",
                    "description": "HTTPS or webcal URL for a new ICS source.",
                },
            }
        )
    elif action_name == "LIFE_CREATE":
        schema["properties"]["title"] = {
            "type": "string",
            "description": (
                "TOP-LEVEL flat field — the human-readable record title. "
                "Do NOT nest title inside details."
            ),
        }
        schema["properties"]["details"] = _LIFE_CREATE_DETAILS_SCHEMA
        schema["required"] = sorted({*schema.get("required", []), "title"})
    elif action_name == "LIFE_UPDATE":
        schema["properties"]["target"] = {
            "type": "string",
            "description": (
                "TOP-LEVEL flat field — the id of the record being updated "
                "(e.g. reminder_*). Do NOT nest target inside details."
            ),
        }
        schema["properties"]["details"] = {
            "type": "object",
            "description": "Changed fields. title/due/listId go here, not at top level.",
            "additionalProperties": True,
        }
    elif action_name in {"LIFE_DELETE", "LIFE_COMPLETE", "LIFE_SKIP"}:
        schema["properties"]["target"] = {
            "type": "string",
            "description": (
                "TOP-LEVEL flat field — the id of the target record "
                "(e.g. reminder_*). Do NOT nest target inside details."
            ),
        }
        schema["required"] = sorted({*schema.get("required", []), "target"})
    elif action_name == "LIFE_SNOOZE":
        schema["properties"]["target"] = {
            "type": "string",
            "description": (
                "TOP-LEVEL flat field — the id of the reminder to snooze "
                "(e.g. reminder_*)."
            ),
        }
        schema["properties"]["minutes"] = {
            "type": "integer",
            "description": "TOP-LEVEL flat field — snooze duration in minutes.",
            "minimum": 1,
        }
        schema["required"] = sorted({*schema.get("required", []), "target", "minutes"})
    elif action_name == "LIFE_REVIEW":
        schema["properties"]["details"] = {
            "type": "object",
            "description": "Optional filters (kind, listId, from, to).",
            "additionalProperties": True,
        }
    elif action_name == "SCHEDULED_TASK_CREATE":
        schema["properties"]["kind"] = {
            "type": "string",
            "description": "TOP-LEVEL flat field — scheduled task kind (e.g. reminder).",
        }
        schema["properties"]["promptInstructions"] = {
            "type": "string",
            "description": "TOP-LEVEL flat field — instructions used as the task title.",
        }
        schema["properties"]["trigger"] = _TRIGGER_OBJECT_SCHEMA
        schema["required"] = sorted(
            {*schema.get("required", []), "promptInstructions", "trigger"}
        )
    elif action_name == "SCHEDULED_TASK_UPDATE":
        schema["properties"]["taskId"] = {
            "type": "string",
            "description": "TOP-LEVEL flat field — id of the scheduled task to update.",
        }
        schema["properties"]["trigger"] = _TRIGGER_OBJECT_SCHEMA
        schema["required"] = sorted({*schema.get("required", []), "taskId"})
    elif action_name == "SCHEDULED_TASK_SNOOZE":
        schema["properties"]["taskId"] = {
            "type": "string",
            "description": "TOP-LEVEL flat field — id of the scheduled task to snooze.",
        }
        schema["properties"]["minutes"] = {
            "type": "integer",
            "description": "TOP-LEVEL flat field — snooze duration in minutes.",
            "minimum": 1,
        }
        schema["required"] = sorted({*schema.get("required", []), "taskId", "minutes"})
    elif action_name == "BOOK_TRAVEL":
        # Passengers must be an array of objects. Emit a named+seat_class shape
        # so agents produce [{name, seat_class}] instead of a bare integer count.
        # The scorer coerces an integer passenger count to this canonical array
        # form when comparing against GT, so both representations score correctly.
        schema["properties"]["origin"] = {
            "type": "string",
            "description": "IATA origin airport code (e.g. LAX).",
        }
        schema["properties"]["destination"] = {
            "type": "string",
            "description": "IATA destination airport code (e.g. JFK).",
        }
        schema["properties"]["departureDate"] = {
            "type": "string",
            "description": "Departure date in YYYY-MM-DD format.",
        }
        schema["properties"]["returnDate"] = {
            "type": "string",
            "description": "Return date in YYYY-MM-DD format, or omit for one-way.",
        }
        schema["properties"]["passengers"] = {
            "type": "array",
            "description": (
                "Array of passenger objects. Each entry must have "
                "name (string) and seat_class ('economy'|'business'|'first'). "
                'Example: [{"name": "passenger_1", "seat_class": "economy"}]. '
                "Do NOT pass a bare integer count."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "seat_class": {
                        "type": "string",
                        "enum": ["economy", "business", "first"],
                    },
                },
                "required": ["name", "seat_class"],
            },
        }

    return schema


@lru_cache(maxsize=1)
def _field_registry_tools_by_name() -> dict[str, dict[str, Any]]:
    manifest_path = (
        Path(__file__).resolve().parents[1] / "manifests" / "actions.manifest.json"
    )
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        # Without the manifest every tool degrades to a discriminator-only
        # schema and schema-obedient models score ~0 — never fail silently.
        logger.warning(
            "actions.manifest.json unavailable at %s (%s); falling back to "
            "discriminator-only tool schemas — expect severely degraded scores",
            manifest_path,
            exc,
        )
        return {}
    actions = raw.get("actions") if isinstance(raw, dict) else None
    if not isinstance(actions, list):
        logger.warning(
            "actions.manifest.json at %s has no 'actions' list; falling back "
            "to discriminator-only tool schemas",
            manifest_path,
        )
        return {}
    tools: dict[str, dict[str, Any]] = {}
    for tool in actions:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        if not isinstance(name, str):
            continue
        if _OPENAI_FUNCTION_NAME_RE.fullmatch(name) is None:
            continue
        tools.setdefault(name, tool)
    return tools


def _registry_tool_for_action(action_name: str) -> dict[str, Any] | None:
    tool = _field_registry_tools_by_name().get(action_name)
    if tool is None:
        return None
    function = tool.get("function")
    if not isinstance(function, dict):
        return None
    params = function.get("parameters")
    if not isinstance(params, dict) or params.get("type") != "object":
        return None
    sanitized_function = deepcopy(function)
    sanitized_function = {
        "name": action_name,
        "description": (
            _TOOL_DESCRIPTIONS.get(action_name)
            or sanitized_function.get("description")
            or "Execute this LifeOps action when the user request requires it."
        ),
        "parameters": _sanitize_registry_parameters(
            action_name, sanitized_function["parameters"]
        ),
    }
    return {"type": "function", "function": sanitized_function}


def _with_calendar_date_anchor(
    tool: dict[str, Any],
    action_name: str,
    now_iso: str,
) -> dict[str, Any]:
    """Add benchmark-clock guidance to calendar tool descriptions and date fields."""
    if not action_name.startswith("CALENDAR"):
        return tool
    now = _try_parse_iso(now_iso)
    if now is None:
        return tool

    thursday_delta = (3 - now.weekday()) % 7
    if thursday_delta == 0:
        thursday_delta = 7
    next_thursday = (now + timedelta(days=thursday_delta)).date().isoformat()
    anchor = (
        f" Benchmark clock is {now_iso}; resolve relative dates from that clock. "
        f"For example, bare 'Thursday' resolves to {next_thursday}."
    )

    patched = deepcopy(tool)
    function = patched.get("function")
    if not isinstance(function, dict):
        return patched
    description = str(function.get("description") or "")
    if anchor not in description:
        function["description"] = description + anchor

    parameters = function.get("parameters")
    properties = parameters.get("properties") if isinstance(parameters, dict) else None
    if isinstance(properties, dict):
        for field in (
            "startAt",
            "endAt",
            "start",
            "end",
            "timeMin",
            "timeMax",
            "windowStart",
            "windowEnd",
            "date",
            "when",
        ):
            schema = properties.get(field)
            if isinstance(schema, dict):
                field_description = str(schema.get("description") or "")
                if anchor not in field_description:
                    schema["description"] = (field_description + anchor).strip()
    return patched


def _sanitize_registry_parameters(
    action_name: str, schema: dict[str, Any]
) -> dict[str, Any]:
    schema = deepcopy(schema)
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    if not isinstance(schema["properties"], dict):
        schema["properties"] = {}
    # Keep top-level schemas permissive so real planner aliases can still be
    # accepted by the executor while the field registry supplies better hints.
    schema["additionalProperties"] = True

    promoted = _PROMOTED_ACTION_DEFAULTS.get(action_name)
    if promoted is not None:
        _, discriminator, value = promoted
        _set_schema_discriminator(schema, discriminator, [value], required=False)
        return schema

    discriminator = _DISCRIMINATORS.get(action_name)
    if discriminator is not None:
        field, values = discriminator
        _set_schema_discriminator(schema, field, values, required=True)
    return schema


def _set_schema_discriminator(
    schema: dict[str, Any],
    field: str,
    values: list[str],
    *,
    required: bool,
) -> None:
    properties = schema["properties"]
    existing = properties.get(field)
    if not isinstance(existing, dict):
        existing = {}
    existing["type"] = "string"
    existing["enum"] = list(values)
    existing.setdefault("description", f"LifeOps discriminator: {', '.join(values)}.")
    properties[field] = existing

    # If the field registry used `action` for a canonical discriminator, keep
    # it as an optional alias but restrict it to executor-supported values.
    if field != "action":
        alias = properties.get("action")
        if isinstance(alias, dict):
            alias["enum"] = list(values)

    current_required = schema.get("required")
    required_values = [
        item
        for item in (current_required if isinstance(current_required, list) else [])
        if isinstance(item, str) and item != "action"
    ]
    if required and field not in required_values:
        required_values.append(field)
    elif not required:
        required_values = [item for item in required_values if item != field]
    schema["required"] = required_values


def build_tool_manifest(
    _world: LifeWorld,
    requirement: TrustedEvidenceRequirement | None = None,
) -> list[dict[str, Any]]:
    """Build the OpenAI-compatible tool manifest for the current LifeOps world.

    Only OpenAI-compatible function names are exposed. The runner still
    executes legacy dotted actions such as ``CALENDAR.create`` when adapters
    produce them, but those names are not valid function identifiers for
    Cerebras/OpenAI-style tool schemas.

    For an evidence-gated scenario the manifest is narrowed to the contract's
    allowed surfaces. Offering every action while the contract admits a
    handful makes an out-of-contract call near-certain, and such a call is
    denied pre-dispatch — so an unfiltered manifest measures the mismatch
    rather than the model's capability on the scenario.
    """
    allowed: set[str] | None = None
    if requirement is not None and requirement.allowed_actions:
        allowed = {policy.name for policy in requirement.allowed_actions}
    tools: list[dict[str, Any]] = []
    for action_name in sorted(supported_actions()):
        if _OPENAI_FUNCTION_NAME_RE.fullmatch(action_name) is None:
            continue
        if allowed is not None:
            promoted = _PROMOTED_ACTION_DEFAULTS.get(action_name)
            canonical = promoted[0] if promoted else action_name
            if canonical not in allowed:
                continue
        registry_tool = _registry_tool_for_action(action_name)
        if registry_tool is not None:
            tools.append(
                _with_calendar_date_anchor(registry_tool, action_name, _world.now_iso)
            )
            continue
        tools.append(
            _with_calendar_date_anchor(
                {
                    "type": "function",
                    "function": {
                        "name": action_name,
                        "description": _TOOL_DESCRIPTIONS.get(
                            action_name,
                            (
                                "Execute this LifeOps action when the user request "
                                "requires it."
                            ),
                        ),
                        "parameters": _tool_parameters_for_action(action_name),
                    },
                },
                action_name,
                _world.now_iso,
            )
        )
    return tools


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _required(kwargs: dict[str, Any], key: str, *, action: str, sub: str) -> Any:
    if key not in kwargs:
        raise KeyError(
            f"{action}/{sub} missing required field '{key}' in kwargs={sorted(kwargs)}"
        )
    return kwargs[key]


def _details(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Return the kwargs.details dict if present, else {}."""
    raw = kwargs.get("details")
    return raw if isinstance(raw, dict) else {}


def _string_list(value: Any) -> list[str]:
    """Normalize a string-or-list field into a list of non-empty strings."""
    if isinstance(value, str):
        stripped = value.strip()
        return [stripped] if stripped else []
    if isinstance(value, list):
        return [
            item.strip() for item in value if isinstance(item, str) and item.strip()
        ]
    return []


def _synthetic_id(prefix: str, payload: dict[str, Any]) -> str:
    """Produce a stable deterministic id from a dict payload.

    Used when the scenario omits an explicit id (umbrella LIFE_CREATE,
    SCHEDULED_TASK_CREATE, etc.) but the executor still has to pick a
    primary key. Hashing the canonical-json kwargs guarantees that two
    replays of the same Action produce the same id, which is the only way
    state-hash matching can succeed for these scenarios.
    """
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


# ---------------------------------------------------------------------------
# Fine-grained handlers (inline conformance corpus)
# ---------------------------------------------------------------------------


def _h_calendar_create(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    event = world.create_calendar_event(
        event_id=kw["event_id"],
        calendar_id=kw["calendar_id"],
        title=kw["title"],
        start=kw["start"],
        end=kw["end"],
        description=kw.get("description", ""),
        location=kw.get("location"),
        attendees=kw.get("attendees"),
        all_day=kw.get("all_day", False),
        recurrence_rule=kw.get("recurrence_rule"),
    )
    return {"id": event.id, "title": event.title}


def _h_calendar_reschedule(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    event = world.move_event(kw["event_id"], start=kw["start"], end=kw["end"])
    return {"id": event.id, "start": event.start, "end": event.end}


def _h_calendar_cancel(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    event = world.cancel_event(kw["event_id"])
    return {"id": event.id, "status": event.status}


def _h_mail_send(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    msg = world.send_email(
        message_id=kw["message_id"],
        thread_id=kw["thread_id"],
        from_email=kw["from_email"],
        to_emails=list(kw["to_emails"]),
        subject=kw["subject"],
        body_plain=kw["body_plain"],
        cc_emails=kw.get("cc_emails"),
        attachments=kw.get("attachments"),
        labels=kw.get("labels"),
    )
    return {"id": msg.id, "thread_id": msg.thread_id}


def _h_mail_archive(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    msg_id = kw.get("message_id") or kw.get("messageId") or kw.get("id")
    if msg_id is None:
        thread_id = kw.get("thread_id") or kw.get("threadId")
        if thread_id is not None:
            return _h_mail_archive_thread(world, {"thread_id": thread_id}, _name)
        raise KeyError("MAIL.archive needs message_id or thread_id")
    msg = world.archive_email(msg_id)
    return {"id": msg.id, "folder": msg.folder}


def _h_mail_archive_thread(
    world: LifeWorld,
    kw: dict[str, Any],
    _name: str,
) -> dict[str, Any]:
    thread_id = kw.get("thread_id") or kw.get("threadId")
    if not isinstance(thread_id, str) or not thread_id:
        raise KeyError("MAIL.archive_thread needs thread_id")
    archived: list[str] = []
    for eid, em in list(world.emails.items()):
        if em.thread_id == thread_id and em.folder != "archive":
            world.archive_email(eid)
            archived.append(eid)
    return {"thread_id": thread_id, "archived_ids": archived}


def _h_mail_mark_read(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    msg = world.mark_read(kw["message_id"])
    return {"id": msg.id, "is_read": msg.is_read}


def _h_mail_star(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    msg = world.star_email(kw["message_id"], starred=kw.get("starred", True))
    return {"id": msg.id, "is_starred": msg.is_starred}


def _h_mail_trash(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    msg = world.trash_email(kw["message_id"])
    return {"id": msg.id, "folder": msg.folder}


def _h_message_send_simple(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    msg = world.send_message(
        message_id=kw["message_id"],
        conversation_id=kw["conversation_id"],
        from_handle=kw["from_handle"],
        to_handles=list(kw["to_handles"]),
        text=kw["text"],
        attachments=kw.get("attachments"),
    )
    return {"id": msg.id, "conversation_id": msg.conversation_id}


def _h_contact_add(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    contact = Contact(
        id=kw["id"],
        display_name=kw["display_name"],
        given_name=kw["given_name"],
        family_name=kw["family_name"],
        primary_email=kw["primary_email"],
        phones=list(kw.get("phones", [])),
        company=kw.get("company"),
        role=kw.get("role"),
        relationship=kw.get("relationship", "acquaintance"),
        importance=int(kw.get("importance", 0)),
        tags=list(kw.get("tags", [])),
        birthday=kw.get("birthday"),
    )
    world.add(EntityKind.CONTACT, contact)
    return {"id": contact.id}


def _h_contact_update(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    contact_id = kw["id"]
    patches = {k: v for k, v in kw.items() if k != "id"}
    updated = world.update(EntityKind.CONTACT, contact_id, **patches)
    return {"id": updated.id}


def _h_contact_delete(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    world.delete(EntityKind.CONTACT, kw["id"])
    return {"id": kw["id"], "deleted": True}


def _h_reminder_create(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    reminder_id = (
        kw.get("reminder_id")
        or kw.get("reminderId")
        or kw.get("id")
        or _synthetic_id(
            "reminder_auto",
            {
                "l": kw.get("list_id") or kw.get("listId"),
                "t": kw.get("title"),
                "d": kw.get("due_at") or kw.get("dueAt") or kw.get("due"),
            },
        )
    )
    list_id = kw.get("list_id") or kw.get("listId") or "list_personal"
    reminder = world.create_reminder(
        reminder_id=reminder_id,
        list_id=list_id,
        title=kw["title"],
        notes=kw.get("notes", ""),
        due_at=kw.get("due_at") or kw.get("dueAt") or kw.get("due"),
        priority=kw.get("priority", "none"),
        tags=kw.get("tags"),
    )
    return {"id": reminder.id}


def _h_reminder_complete(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    reminder_id = (
        kw.get("reminder_id")
        or kw.get("reminderId")
        or kw.get("id")
        or kw.get("target")
    )
    if not isinstance(reminder_id, str) or not reminder_id:
        raise KeyError("REMINDER.complete needs reminder_id/reminderId/id/target")
    reminder = world.complete_reminder(reminder_id)
    return {"id": reminder.id, "completed_at": reminder.completed_at}


def _h_note_create(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    note = world.create_note(
        note_id=kw["note_id"],
        title=kw["title"],
        body_markdown=kw["body_markdown"],
        tags=kw.get("tags"),
        source=kw.get("source", "apple-notes"),
    )
    return {"id": note.id}


# ---------------------------------------------------------------------------
# Umbrella handlers
# ---------------------------------------------------------------------------


_CALENDAR_PREFERENCE_KEYS = frozenset(
    {
        "blackoutWindows",
        "category",
        "defaultDurationMinutes",
        "description",
        "digest",
        "intent",
        "minimumNoticeMinutes",
        "notificationStyle",
        "preferredEndLocal",
        "preferredStartLocal",
        "timeZone",
        "travelBufferMinutes",
        "workingDays",
    }
)


def _validated_json_value(value: Any, *, field: str) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and (value != value or abs(value) == float("inf")):
            raise ValueError(f"{field} must not contain NaN or infinity")
        return value
    if isinstance(value, list):
        return [
            _validated_json_value(item, field=f"{field}[{index}]")
            for index, item in enumerate(value)
        ]
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str) or not key:
                raise ValueError(f"{field} object keys must be non-empty strings")
            normalized[key] = _validated_json_value(item, field=f"{field}.{key}")
        return normalized
    raise ValueError(f"{field} contains unsupported value {value!r}")


def _calendar_preferences_from_action(
    kw: dict[str, Any],
    details: dict[str, Any],
) -> dict[str, Any]:
    unknown_details = (
        set(details)
        - _CALENDAR_PREFERENCE_KEYS
        - {
            "calendar",
            "calendarId",
            "expectedVersion",
        }
    )
    if unknown_details:
        raise ValueError(
            f"CALENDAR/update_preferences has unknown fields: {sorted(unknown_details)}"
        )
    preferences: dict[str, Any] = {}
    for key in _CALENDAR_PREFERENCE_KEYS:
        if key in details:
            preferences[key] = _validated_json_value(
                details[key],
                field=f"details.{key}",
            )
        elif key in kw:
            preferences[key] = _validated_json_value(kw[key], field=key)
    if not preferences:
        raise ValueError("CALENDAR/update_preferences requires at least one preference")

    for field in ("preferredStartLocal", "preferredEndLocal"):
        value = preferences.get(field)
        if value is not None and (
            not isinstance(value, str)
            or re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value) is None
        ):
            raise ValueError(f"CALENDAR/update_preferences {field} must use HH:MM")
    for field in (
        "defaultDurationMinutes",
        "minimumNoticeMinutes",
        "travelBufferMinutes",
    ):
        value = preferences.get(field)
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, int) or value < 0
        ):
            raise ValueError(
                f"CALENDAR/update_preferences {field} must be a non-negative integer"
            )
    return preferences


def _calendar_ids_from_action(
    world: LifeWorld,
    kw: dict[str, Any],
    details: dict[str, Any],
) -> list[str]:
    raw_many = kw.get("calendarIds", details.get("calendarIds"))
    if raw_many is not None:
        if not isinstance(raw_many, list) or not raw_many:
            raise ValueError("CALENDAR calendarIds must be a non-empty list")
        resolved: list[str] = []
        for index, raw in enumerate(raw_many):
            calendar_id = _resolve_calendar_id(world, raw)
            if calendar_id is None:
                raise KeyError(f"CALENDAR unknown calendarIds[{index}]: {raw!r}")
            if calendar_id not in resolved:
                resolved.append(calendar_id)
        return resolved
    raw_one = (
        kw.get("calendarId")
        or details.get("calendarId")
        or kw.get("calendar")
        or details.get("calendar")
    )
    if raw_one is not None:
        calendar_id = _resolve_calendar_id(world, raw_one)
        if calendar_id is None:
            raise KeyError(f"CALENDAR unknown calendar: {raw_one!r}")
        return [calendar_id]
    return sorted(world.calendars)


def _strict_positive_integer(
    value: Any,
    *,
    field: str,
    default: int,
    maximum: int,
) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an integer")
    if value <= 0 or value > maximum:
        raise ValueError(f"{field} must be between 1 and {maximum}")
    return value


def _u_calendar(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """Dispatch the CALENDAR umbrella on `subaction`.

    Subactions:
        create_event, update_event, delete_event,
        propose_times, search_events, check_availability,
        next_event, update_preferences
    """
    sub = kw.get("subaction") or kw.get("action") or kw.get("operation")
    if not sub:
        sub = _required(kw, "subaction", action=name, sub="<missing>")
    details = _details(kw)
    if sub == "create_event":
        calendar_id = _resolve_calendar_id(
            world,
            details.get("calendarId")
            or kw.get("calendarId")
            or details.get("calendar_id")
            or kw.get("calendar_id")
            or details.get("calendar")
            or kw.get("calendar"),
        )
        if not calendar_id:
            calendar_id = _primary_calendar_id(world)
        start = (
            details.get("start")
            or kw.get("start")
            or details.get("startAt")
            or kw.get("startAt")
            or details.get("start_time")
            or kw.get("start_time")
        )
        end = (
            details.get("end")
            or kw.get("end")
            or details.get("endAt")
            or kw.get("endAt")
            or details.get("end_time")
            or kw.get("end_time")
        )
        if start and not end:
            end = _shift_iso(str(start), minutes=_duration_minutes(kw, details, 30))
        title = kw.get("title") or details.get("title") or "Untitled"
        if not calendar_id or not start or not end:
            raise KeyError(
                f"CALENDAR/create_event needs details.calendarId/start/end "
                f"(got details keys={sorted(details)})"
            )
        event_id = (
            kw.get("eventId")
            or details.get("eventId")
            or _synthetic_id(
                "event_auto", {"t": title, "s": start, "e": end, "c": calendar_id}
            )
        )
        if event_id in world.calendar_events:
            event = world.calendar_events[str(event_id)]
            return {"id": event.id, "title": event.title, "idempotent": True}
        event = world.create_calendar_event(
            event_id=event_id,
            calendar_id=calendar_id,
            title=title,
            start=start,
            end=end,
            description=details.get("description", ""),
            location=details.get("location"),
            attendees=details.get("attendees"),
            all_day=bool(details.get("all_day", False)),
            recurrence_rule=details.get("recurrence_rule"),
        )
        return {"id": event.id, "title": event.title}
    if sub == "update_event":
        updates = kw.get("updates") or details.get("updates") or {}
        if not isinstance(updates, dict):
            updates = {}
        requested_event_id = (
            details.get("eventId")
            or kw.get("eventId")
            or details.get("event_id")
            or kw.get("event_id")
            or details.get("id")
            or kw.get("id")
        )
        event = _find_calendar_event(
            world,
            event_id=requested_event_id,
            title=details.get("title")
            or kw.get("title")
            or updates.get("title")
            or details.get("eventTitle")
            or kw.get("eventTitle")
            or details.get("event_name")
            or kw.get("event_name")
            or (
                requested_event_id
                if isinstance(requested_event_id, str)
                and requested_event_id not in world.calendar_events
                else None
            ),
            date_hint=details.get("start")
            or kw.get("start")
            or details.get("startAt")
            or kw.get("startAt")
            or details.get("new_start")
            or kw.get("new_start")
            or details.get("newStart")
            or kw.get("newStart")
            or updates.get("start")
            or updates.get("new_start")
            or updates.get("newStart")
            or details.get("date")
            or kw.get("date")
            or details.get("when")
            or kw.get("when"),
            calendar_hint=details.get("calendarId")
            or kw.get("calendarId")
            or details.get("calendar_id")
            or kw.get("calendar_id")
            or details.get("calendar")
            or kw.get("calendar"),
        )
        if event is None:
            raise KeyError(
                f"{name}/{sub} missing required field 'eventId' in kwargs={sorted(kw)}"
            )
        explicit_start = (
            details.get("start")
            or kw.get("start")
            or details.get("startAt")
            or kw.get("startAt")
            or details.get("new_start")
            or kw.get("new_start")
            or details.get("newStart")
            or kw.get("newStart")
            or updates.get("start")
            or updates.get("new_start")
            or updates.get("newStart")
        )
        explicit_end = (
            details.get("end")
            or kw.get("end")
            or details.get("endAt")
            or kw.get("endAt")
            or details.get("new_end")
            or kw.get("new_end")
            or details.get("newEnd")
            or kw.get("newEnd")
            or updates.get("end")
            or updates.get("new_end")
            or updates.get("newEnd")
        )
        start = explicit_start or event.start
        if explicit_end:
            end = explicit_end
        elif explicit_start:
            end = _shift_iso(
                str(start),
                minutes=_duration_minutes(
                    kw, details, _calendar_event_duration_minutes(event, 60)
                ),
            )
        else:
            end = event.end
        patches: dict[str, Any] = {"start": start, "end": end}
        for source, aliases in {
            "title": ("newTitle", "new_title"),
            "description": ("newDescription", "new_description"),
            "location": ("newLocation", "new_location"),
            "attendees": ("attendees", "newAttendees", "new_attendees"),
            "status": ("status",),
            "all_day": ("all_day", "allDay"),
        }.items():
            for alias in aliases:
                if alias in updates:
                    patches[source] = updates[alias]
                    break
                if alias in details:
                    patches[source] = details[alias]
                    break
                if alias in kw:
                    patches[source] = kw[alias]
                    break
        if "attendees" in patches:
            patches["attendees"] = _string_list(patches["attendees"])
        event = world.update(EntityKind.CALENDAR_EVENT, event.id, **patches)
        return {
            "id": event.id,
            "title": event.title,
            "start": event.start,
            "end": event.end,
        }
    if sub == "delete_event":
        requested_event_id = (
            details.get("eventId")
            or kw.get("eventId")
            or details.get("event_id")
            or kw.get("event_id")
            or details.get("id")
            or kw.get("id")
        )
        event = _find_calendar_event(
            world,
            event_id=requested_event_id,
            title=details.get("title")
            or kw.get("title")
            or details.get("eventTitle")
            or kw.get("eventTitle")
            or details.get("event_name")
            or kw.get("event_name"),
            date_hint=details.get("date")
            or kw.get("date")
            or details.get("start")
            or kw.get("start")
            or details.get("startAt")
            or kw.get("startAt")
            or details.get("when")
            or kw.get("when"),
            calendar_hint=details.get("calendarId")
            or kw.get("calendarId")
            or details.get("calendar_id")
            or kw.get("calendar_id")
            or details.get("calendar")
            or kw.get("calendar"),
        )
        if event is None:
            if requested_event_id:
                return {
                    "ok": False,
                    "noEffect": True,
                    "missing_id": str(requested_event_id),
                    "subaction": sub,
                }
            raise KeyError(
                f"{name}/{sub} missing required field 'eventId' in kwargs={sorted(kw)}"
            )
        event = world.cancel_event(event.id)
        return {"id": event.id, "status": event.status}
    if sub == "check_availability":
        start = (
            kw.get("startAt")
            or details.get("startAt")
            or kw.get("start")
            or details.get("start")
            or kw.get("timeMin")
            or details.get("timeMin")
        )
        end = (
            kw.get("endAt")
            or details.get("endAt")
            or kw.get("end")
            or details.get("end")
            or kw.get("timeMax")
            or details.get("timeMax")
        )
        if not isinstance(start, str) or not isinstance(end, str):
            raise KeyError(
                f"{name}/{sub} requires startAt/endAt or start/end in kwargs={sorted(kw)}"
            )
        return {
            "subaction": sub,
            "ok": True,
            "events": _search_calendar_events(world, kw, details),
        }
    if sub in {"search_events", "next_event"}:
        return {
            "subaction": sub,
            "ok": True,
            "events": _search_calendar_events(world, kw, details),
        }
    if sub == "bulk_reschedule":
        return _unsupported_no_effect(
            operation=f"CALENDAR/{sub}",
            reason="LifeWorld has no atomic bulk-reschedule transaction",
            details={"events": _search_calendar_events(world, kw, details)},
        )
    if sub == "propose_times":
        window_start = (
            kw.get("windowStart")
            or details.get("windowStart")
            or kw.get("start")
            or details.get("start")
        )
        window_end = (
            kw.get("windowEnd")
            or details.get("windowEnd")
            or kw.get("end")
            or details.get("end")
        )
        if not isinstance(window_start, str) or not isinstance(window_end, str):
            raise KeyError("CALENDAR/propose_times requires windowStart/windowEnd")
        duration_minutes = _strict_positive_integer(
            kw.get("durationMinutes", details.get("durationMinutes")),
            field="CALENDAR/propose_times durationMinutes",
            default=30,
            maximum=24 * 60,
        )
        slot_count = _strict_positive_integer(
            kw.get("slotCount", details.get("slotCount")),
            field="CALENDAR/propose_times slotCount",
            default=3,
            maximum=50,
        )
        proposals = world.propose_calendar_times(
            window_start=window_start,
            window_end=window_end,
            duration_minutes=duration_minutes,
            slot_count=slot_count,
            calendar_ids=_calendar_ids_from_action(world, kw, details),
            time_zone=kw.get("timeZone") or details.get("timeZone"),
        )
        return {
            "ok": True,
            "effect": "none",
            "subaction": sub,
            "slots": [
                {
                    "id": proposal.id,
                    "start": proposal.start,
                    "end": proposal.end,
                    "durationMinutes": proposal.duration_minutes,
                    "calendarIds": proposal.calendar_ids,
                }
                for proposal in proposals
            ],
            "count": len(proposals),
            "requestedCount": slot_count,
        }
    if sub == "update_preferences":
        calendar_ids = _calendar_ids_from_action(world, kw, details)
        if len(calendar_ids) != 1:
            primary = _primary_calendar_id(world)
            if primary is None:
                raise ValueError(
                    "CALENDAR/update_preferences requires a target calendar"
                )
            calendar_ids = [primary]
        expected_version_raw = kw.get(
            "expectedVersion",
            details.get("expectedVersion"),
        )
        if expected_version_raw is not None and (
            isinstance(expected_version_raw, bool)
            or not isinstance(expected_version_raw, int)
            or expected_version_raw < 0
        ):
            raise ValueError(
                "CALENDAR/update_preferences expectedVersion must be a non-negative integer"
            )
        calendar, replayed = world.update_calendar_preferences(
            calendar_id=calendar_ids[0],
            preferences=_calendar_preferences_from_action(kw, details),
            expected_version=expected_version_raw,
        )
        return {
            "ok": True,
            "effect": "none" if replayed else "updated",
            "subaction": sub,
            "calendarId": calendar.id,
            "preferences": calendar.preferences,
            "version": calendar.preferences_version,
            "updatedAt": calendar.preferences_updated_at,
            "replayed": replayed,
        }
    raise UnsupportedAction(
        f"unsupported action in execute path: CALENDAR/{sub} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


def _u_calendar_sources(
    world: LifeWorld,
    kw: dict[str, Any],
    name: str,
) -> dict[str, Any]:
    """Expose source-administration semantics without fabricating provider E2E.

    LifeWorld can enumerate its deterministic calendars, but it cannot perform
    OAuth, native permission grants, or external ICS fetches. Connect and write
    operations therefore return explicit pending/unsupported states. The
    runner-owned execution stamp marks every payload as deterministic, so these
    results can exercise planning without satisfying trusted-evidence gates.
    """
    operation = kw.get("operation") or kw.get("subaction")
    if operation not in {"list", "select", "deselect", "connect", "reconnect"}:
        raise KeyError(
            f"{name} requires operation=list|select|deselect|connect|reconnect"
        )

    def provider_name(source: str) -> str:
        return {
            "apple": "apple_calendar",
            "outlook": "microsoft",
        }.get(source, source)

    sources: list[dict[str, Any]] = []
    for calendar in sorted(
        world.calendars.values(),
        key=lambda item: (item.source, item.owner, item.id),
    ):
        provider = provider_name(calendar.source)
        account_id = _synthetic_id(
            "calendar_account",
            {"provider": provider, "owner": calendar.owner},
        )
        grant_id = f"simulated-grant:{provider}:{account_id}"
        sources.append(
            {
                "key": {
                    "provider": provider,
                    "side": "owner",
                    "grantId": grant_id,
                    "connectorAccountId": account_id,
                    "calendarId": calendar.id,
                },
                "accountEmail": calendar.owner,
                "summary": calendar.name,
                "primary": calendar.is_primary,
                "accessRole": "owner",
                "includeInFeed": True,
                "selectionVersion": 0,
                "health": {
                    "status": "fresh",
                    "visibility": "details",
                    "syncedAt": world.now_iso,
                },
            }
        )

    if operation == "list":
        return {
            "operation": operation,
            "snapshot": {
                "state": "complete" if sources else "unavailable",
                "observedAt": world.now_iso,
                "sources": sources,
            },
            "simulatedOnly": True,
            "providerReceipt": None,
        }

    provider = kw.get("provider")
    if provider not in {"google", "microsoft", "apple_calendar", "ics"}:
        raise KeyError(f"{name}/{operation} requires an exact provider")
    if operation in {"connect", "reconnect"}:
        if provider in {"google", "microsoft"}:
            state = "authorization_required"
            handoff = "external_oauth_required"
        elif provider == "apple_calendar":
            state = "permission_required"
            handoff = "native_device_permission_required"
        else:
            state = "configuration_required"
            handoff = "external_ics_fetch_required"
        return {
            "operation": operation,
            "connection": {
                "state": state,
                "provider": provider,
                "connected": False,
                "handoff": handoff,
            },
            "ok": False,
            "simulatedOnly": True,
            "providerReceipt": None,
        }

    required_identity = {
        "provider": provider,
        "grantId": kw.get("grantId"),
        "connectorAccountId": kw.get("connectorAccountId"),
        "calendarId": kw.get("calendarId"),
    }
    if (
        any(
            not isinstance(value, str) or not value
            for value in required_identity.values()
        )
        or not isinstance(kw.get("expectedVersion"), int)
        or kw["expectedVersion"] < 0
    ):
        raise KeyError(
            f"{name}/{operation} requires exact provider, grantId, "
            "connectorAccountId, calendarId, and non-negative expectedVersion"
        )
    target = next(
        (
            source
            for source in sources
            if source["key"]
            == {
                **required_identity,
                "side": "owner",
            }
        ),
        None,
    )
    return {
        "operation": operation,
        "ok": False,
        "error": (
            "deterministic_source_not_found"
            if target is None
            else "external_source_selection_required"
        ),
        "source": target,
        "changed": False,
        "simulatedOnly": True,
        "providerReceipt": None,
    }


def _u_message(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """Dispatch the MESSAGE umbrella on `operation`.

    MESSAGE is used for both chat (imessage/whatsapp/telegram/slack/etc) AND
    mail (gmail). The `source` field disambiguates. Operations seen:
        send, draft_reply, manage, triage,
        search_inbox, list_channels, read_channel, read_with_contact
    """
    op = _required(kw, "operation", action=name, sub="<missing>")
    source = kw.get("source", "")

    if op == "send":
        # Either source=gmail (mail) or source in chat channels.
        if source == "gmail":
            return _send_email_via_message(world, kw)
        return _send_chat_via_message(world, kw, source)
    if op == "draft_reply":
        return _draft_reply_via_message(world, kw, source)
    if op == "manage":
        return _manage_email_via_message(world, kw)
    if op == "triage":
        return _triage_messages(world, kw)
    if op == "search_inbox":
        return _search_messages(world, kw)
    if op == "list_channels":
        return _list_message_channels(world, kw)
    if op == "read_channel":
        return _read_message_channel(world, kw)
    if op == "read_with_contact":
        return _read_messages_with_contact(world, kw)
    raise UnsupportedAction(
        f"unsupported action in execute path: MESSAGE/{op} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


def _send_email_via_message(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    to_emails = (
        _string_list(kw.get("to_emails"))
        or _string_list(kw.get("to"))
        or _string_list(kw.get("target"))
    )
    if not to_emails:
        raise KeyError("MESSAGE/send (gmail) requires to_emails")
    subject = kw.get("subject") or ""
    body = (
        kw.get("body")
        or kw.get("body_plain")
        or kw.get("messageBody")
        or kw.get("text")
        or ""
    )
    from_email = kw.get("from_email") or "me@example.test"
    thread_id = (
        kw.get("threadId")
        or kw.get("thread_id")
        or _synthetic_id("thread_auto", {"to": sorted(to_emails), "s": subject})
    )
    message_id = (
        kw.get("messageId")
        or kw.get("message_id")
        or kw.get("id")
        or _synthetic_id("email_auto", {"th": thread_id, "b": body, "s": subject})
    )
    msg = world.send_email(
        message_id=message_id,
        thread_id=thread_id,
        from_email=from_email,
        to_emails=to_emails,
        subject=subject,
        body_plain=body,
    )
    return {"id": msg.id, "thread_id": msg.thread_id}


def _send_chat_via_message(
    world: LifeWorld, kw: dict[str, Any], source: str
) -> dict[str, Any]:
    target_kind = kw.get("targetKind") or kw.get("target_kind") or "contact"
    text = kw.get("message") or kw.get("text") or ""
    if not text:
        raise KeyError("MESSAGE/send (chat) requires message/text")
    channel = source or "imessage"

    if target_kind in {"group", "room", "channel"}:
        room_id = (
            kw.get("roomId")
            or kw.get("room_id")
            or kw.get("channelId")
            or kw.get("channel_id")
            or kw.get("target")
        )
        if not isinstance(room_id, str) or not room_id:
            raise KeyError("MESSAGE/send (group) requires roomId/channelId/target")
        if room_id not in world.conversations:
            world.ensure_synthetic_conversation(
                conversation_id=room_id,
                channel=channel,
                participants=["+15550000000", "+15551111111"],
                title=room_id,
                is_group=True,
            )
        message_id = _synthetic_id(
            "chat_auto", {"r": room_id, "t": text, "src": channel}
        )
        msg = world.send_message(
            message_id=message_id,
            conversation_id=room_id,
            from_handle="+15550000000",
            to_handles=["+15551111111"],
            text=text,
        )
        return {"id": msg.id, "conversation_id": msg.conversation_id}

    # contact target — derive a deterministic conversation id from the name.
    target = kw.get("target") or kw.get("contact") or ""
    if not target:
        raise KeyError("MESSAGE/send (contact) requires target")
    conv_id = _synthetic_id("conv_auto", {"src": channel, "to": target})
    world.ensure_synthetic_conversation(
        conversation_id=conv_id,
        channel=channel,
        participants=["+15550000000", target],
        title=target,
        is_group=False,
    )
    message_id = _synthetic_id("chat_auto", {"c": conv_id, "t": text})
    msg = world.send_message(
        message_id=message_id,
        conversation_id=conv_id,
        from_handle="+15550000000",
        to_handles=[target],
        text=text,
    )
    return {"id": msg.id, "conversation_id": msg.conversation_id}


def _draft_reply_via_message(
    world: LifeWorld, kw: dict[str, Any], source: str
) -> dict[str, Any]:
    if source != "gmail":
        return _draft_chat_reply(world, kw, source)
    parent_id = (
        kw.get("messageId")
        or kw.get("message_id")
        or kw.get("inReplyToId")
        or kw.get("in_reply_to_id")
        or kw.get("id")
        or kw.get("target")
    )
    if not isinstance(parent_id, str) or not parent_id:
        raise KeyError("MESSAGE/draft_reply needs messageId/inReplyToId/id")
    parent = world.emails.get(parent_id)
    thread_id = (
        parent.thread_id
        if parent is not None
        else _synthetic_id("thread_auto", {"p": parent_id})
    )
    body = (
        kw.get("body")
        or kw.get("body_plain")
        or kw.get("reply")
        or kw.get("replyText")
        or kw.get("messageBody")
        or kw.get("text")
        or ""
    )
    subject = (
        f"Re: {parent.subject}" if parent is not None else (kw.get("subject") or "Re:")
    )
    from_email = kw.get("from_email") or "me@example.test"
    to_emails = (
        [parent.from_email]
        if parent is not None and parent.from_email
        else list(kw.get("to_emails") or [])
    )
    if not to_emails:
        raise KeyError(
            f"MESSAGE/draft_reply needs a parent email or to_emails (parent={parent_id})"
        )
    draft_id = _synthetic_id("email_draft", {"p": parent_id, "b": body})
    existing = world.emails.get(draft_id)
    if existing is not None:
        if (
            existing.folder != "drafts"
            or existing.thread_id != thread_id
            or existing.from_email != from_email
            or existing.to_emails != to_emails
            or existing.subject != subject
            or existing.body_plain != body
        ):
            raise ValueError(f"email draft idempotency conflict: {draft_id}")
        return {
            "id": existing.id,
            "folder": existing.folder,
            "thread_id": existing.thread_id,
            "replayed": True,
        }
    msg = world.create_draft_email(
        message_id=draft_id,
        thread_id=thread_id,
        from_email=from_email,
        to_emails=to_emails,
        subject=subject,
        body_plain=body,
    )
    return {
        "id": msg.id,
        "folder": msg.folder,
        "thread_id": msg.thread_id,
        "replayed": False,
    }


_CHAT_SOURCES = frozenset(
    {"imessage", "whatsapp", "signal", "telegram", "slack", "discord", "sms"}
)
_MESSAGE_SOURCES = frozenset({"gmail", *_CHAT_SOURCES})
_EMAIL_FOLDERS = frozenset({"inbox", "sent", "drafts", "archive", "trash", "spam"})
_GMAIL_QUERY_CLAUSE_RE = re.compile(
    r"(?P<key>from|subject|is):(?:\"(?P<quoted>[^\"]*)\"|(?P<bare>\S+))",
    flags=re.IGNORECASE,
)


def _validated_message_source(
    value: Any,
    *,
    field: str = "source",
    required: bool = False,
) -> MessageSource | None:
    if value is None or value == "":
        if required:
            raise KeyError(f"MESSAGE requires non-empty {field}")
        return None
    if not isinstance(value, str) or value not in _MESSAGE_SOURCES:
        raise ValueError(
            f"MESSAGE {field} must be one of {sorted(_MESSAGE_SOURCES)}, got {value!r}"
        )
    return cast(MessageSource, value)


def _validated_message_sources(kw: dict[str, Any]) -> list[MessageSource]:
    raw_sources = kw.get("sources")
    if raw_sources is None:
        single = _validated_message_source(kw.get("source"))
        return [single] if single is not None else []
    if not isinstance(raw_sources, list) or not raw_sources:
        raise ValueError("MESSAGE sources must be a non-empty list")
    sources: list[MessageSource] = []
    for index, raw in enumerate(raw_sources):
        source = _validated_message_source(
            raw, field=f"sources[{index}]", required=True
        )
        if source not in sources:
            sources.append(source)
    return sources


def _validated_email_folder(value: Any) -> EmailFolder | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or value not in _EMAIL_FOLDERS:
        raise ValueError(
            f"MESSAGE folder must be one of {sorted(_EMAIL_FOLDERS)}, got {value!r}"
        )
    return cast(EmailFolder, value)


def _positive_limit(value: Any, *, default: int = 50) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"MESSAGE limit must be a positive integer, got {value!r}")
    return min(value, 500)


def _message_time_bounds(kw: dict[str, Any]) -> tuple[datetime | None, datetime | None]:
    since_raw = kw.get("since", kw.get("from"))
    until_raw = kw.get("until")

    def parse(raw: Any, *, field: str, end_of_day: bool) -> datetime | None:
        if raw is None:
            return None
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f"MESSAGE {field} must be a non-empty ISO date/time")
        parsed = _try_parse_iso(raw)
        if parsed is None:
            raise ValueError(f"MESSAGE {field} is not a valid ISO date/time: {raw!r}")
        if end_of_day and re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw.strip()):
            parsed += timedelta(days=1)
            parsed -= timedelta(microseconds=1)
        return parsed.astimezone(timezone.utc)

    since = parse(since_raw, field="since/from", end_of_day=False)
    until = parse(until_raw, field="until", end_of_day=True)
    if since is not None and until is not None and since > until:
        raise ValueError("MESSAGE since/from must not be after until")
    return since, until


def _message_in_bounds(
    timestamp: str,
    *,
    since: datetime | None,
    until: datetime | None,
) -> bool:
    parsed = _try_parse_iso(timestamp)
    if parsed is None:
        raise ValueError(f"LifeWorld message has invalid timestamp: {timestamp!r}")
    parsed = parsed.astimezone(timezone.utc)
    return not (
        (since is not None and parsed < since) or (until is not None and parsed > until)
    )


def _email_projection(message: EmailMessage) -> dict[str, Any]:
    return {
        "kind": "email",
        "id": message.id,
        "threadId": message.thread_id,
        "source": "gmail",
        "folder": message.folder,
        "from": message.from_email,
        "to": list(message.to_emails),
        "cc": list(message.cc_emails),
        "subject": message.subject,
        "text": message.body_plain,
        "sentAt": message.sent_at,
        "receivedAt": message.received_at,
        "isRead": message.is_read,
        "isStarred": message.is_starred,
        "attachments": list(message.attachments),
    }


def _chat_projection(message: ChatMessage) -> dict[str, Any]:
    return {
        "kind": "chat",
        "id": message.id,
        "conversationId": message.conversation_id,
        "source": message.channel,
        "from": message.from_handle,
        "to": list(message.to_handles),
        "text": message.text,
        "sentAt": message.sent_at,
        "isRead": message.is_read,
        "isOutgoing": message.is_outgoing,
        "attachments": list(message.attachments),
    }


def _parse_gmail_query(query: str) -> tuple[dict[str, list[str]], list[str]]:
    clauses: dict[str, list[str]] = {"from": [], "subject": [], "is": []}
    occupied: list[tuple[int, int]] = []
    for match in _GMAIL_QUERY_CLAUSE_RE.finditer(query):
        value = match.group("quoted")
        if value is None:
            value = match.group("bare")
        if value is None or not value.strip():
            raise ValueError(
                f"MESSAGE search query has an empty {match.group('key')}: clause"
            )
        clauses[match.group("key").casefold()].append(value.strip().casefold())
        occupied.append(match.span())
    remaining = list(query)
    for start, end in occupied:
        remaining[start:end] = " " * (end - start)
    remainder = "".join(remaining)
    phrases = [item.strip().casefold() for item in re.findall(r'"([^"]+)"', remainder)]
    remainder = re.sub(r'"[^"]+"', " ", remainder)
    terms = [*phrases, *(item.casefold() for item in remainder.split() if item)]
    return clauses, terms


def _email_matches_query(message: EmailMessage, query: str) -> bool:
    clauses, terms = _parse_gmail_query(query)
    if clauses["from"] and not all(
        message.from_email.casefold() == value for value in clauses["from"]
    ):
        return False
    if clauses["subject"] and not all(
        value in message.subject.casefold() for value in clauses["subject"]
    ):
        return False
    for state in clauses["is"]:
        if state == "unread" and message.is_read:
            return False
        if state == "read" and not message.is_read:
            return False
        if state == "starred" and not message.is_starred:
            return False
        if state not in {"unread", "read", "starred"}:
            raise ValueError(
                f"MESSAGE search query has unsupported is: value {state!r}"
            )
    haystack = " ".join(
        (
            message.from_email,
            message.subject,
            message.body_plain,
            " ".join(message.to_emails),
            " ".join(message.cc_emails),
        )
    ).casefold()
    return all(term in haystack for term in terms)


def _search_messages(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    source = _validated_message_source(kw.get("source"))
    query = kw.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("MESSAGE/search_inbox requires a non-empty query")
    since, until = _message_time_bounds(kw)
    limit = _positive_limit(kw.get("limit"), default=100)
    results: list[dict[str, Any]] = []
    if source in {None, "gmail"}:
        results.extend(
            _email_projection(message)
            for message in world.emails.values()
            if message.folder not in {"trash", "spam"}
            and _message_in_bounds(
                message.received_at or message.sent_at,
                since=since,
                until=until,
            )
            and _email_matches_query(message, query)
        )
    if source != "gmail":
        query_terms = [term.casefold() for term in query.split() if term]
        results.extend(
            _chat_projection(message)
            for message in world.chat_messages.values()
            if (source is None or message.channel == source)
            and _message_in_bounds(message.sent_at, since=since, until=until)
            and all(term in message.text.casefold() for term in query_terms)
        )
    results.sort(
        key=lambda item: (item.get("receivedAt") or item["sentAt"], item["id"]),
        reverse=True,
    )
    return {
        "ok": True,
        "effect": "none",
        "operation": "MESSAGE/search_inbox",
        "source": source,
        "query": query,
        "count": min(len(results), limit),
        "results": results[:limit],
    }


def _list_message_channels(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    source = _validated_message_source(kw.get("source"))
    if source == "gmail":
        raise ValueError("MESSAGE/list_channels does not accept source='gmail'")
    limit = _positive_limit(kw.get("limit"))
    channels = [
        {
            "id": conversation.id,
            "source": conversation.channel,
            "participants": list(conversation.participants),
            "title": conversation.title,
            "lastActivityAt": conversation.last_activity_at,
            "isGroup": conversation.is_group,
            "messageCount": sum(
                message.conversation_id == conversation.id
                for message in world.chat_messages.values()
            ),
            "unreadCount": sum(
                message.conversation_id == conversation.id and not message.is_read
                for message in world.chat_messages.values()
            ),
        }
        for conversation in world.conversations.values()
        if source is None or conversation.channel == source
    ]
    channels.sort(
        key=lambda item: (item["lastActivityAt"], item["id"]),
        reverse=True,
    )
    return {
        "ok": True,
        "effect": "none",
        "operation": "MESSAGE/list_channels",
        "source": source,
        "count": min(len(channels), limit),
        "channels": channels[:limit],
    }


def _read_message_channel(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    source = _validated_message_source(kw.get("source"), required=True)
    room_id = kw.get("roomId") or kw.get("room_id") or kw.get("channelId")
    if not isinstance(room_id, str) or not room_id:
        raise KeyError("MESSAGE/read_channel requires roomId/channelId")
    since, until = _message_time_bounds(kw)
    limit = _positive_limit(kw.get("limit"), default=100)
    if source == "gmail":
        if room_id not in world.email_threads:
            raise KeyError(f"MESSAGE/read_channel email thread not found: {room_id}")
        rows = [
            _email_projection(message)
            for message in world.emails.values()
            if message.thread_id == room_id
            and _message_in_bounds(
                message.received_at or message.sent_at,
                since=since,
                until=until,
            )
        ]
        source_mismatch = False
    else:
        conversation = world.conversations.get(room_id)
        if conversation is None:
            raise KeyError(f"MESSAGE/read_channel conversation not found: {room_id}")
        source_mismatch = conversation.channel != source
        rows = [
            _chat_projection(message)
            for message in world.chat_messages.values()
            if message.conversation_id == room_id
            and message.channel == source
            and _message_in_bounds(message.sent_at, since=since, until=until)
        ]
    rows.sort(key=lambda item: (item["sentAt"], item["id"]))
    rows = rows[-limit:]
    return {
        "ok": True,
        "effect": "none",
        "operation": "MESSAGE/read_channel",
        "source": source,
        "roomId": room_id,
        "sourceMismatch": source_mismatch,
        "count": len(rows),
        "messages": rows,
    }


def _contact_matches(world: LifeWorld, reference: str) -> list[Contact]:
    direct = world.contacts.get(reference)
    if direct is not None:
        return [direct]
    folded = reference.casefold()
    return sorted(
        (
            contact
            for contact in world.contacts.values()
            if contact.display_name.casefold() == folded
            or contact.primary_email.casefold() == folded
            or any(phone.casefold() == folded for phone in contact.phones)
        ),
        key=lambda contact: contact.id,
    )


def _read_messages_with_contact(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    source = _validated_message_source(kw.get("source"))
    reference = kw.get("contact") or kw.get("entityId") or kw.get("target")
    if not isinstance(reference, str) or not reference.strip():
        raise KeyError("MESSAGE/read_with_contact requires contact/entityId/target")
    if reference.startswith("contact_") and reference not in world.contacts:
        raise KeyError(f"MESSAGE/read_with_contact contact not found: {reference}")
    contacts = _contact_matches(world, reference)
    handles = {reference.casefold()}
    for contact in contacts:
        handles.add(contact.display_name.casefold())
        handles.add(contact.primary_email.casefold())
        handles.update(phone.casefold() for phone in contact.phones)
    since, until = _message_time_bounds(kw)
    limit = _positive_limit(kw.get("limit"))
    rows: list[dict[str, Any]] = []
    if source in {None, "gmail"}:
        rows.extend(
            _email_projection(message)
            for message in world.emails.values()
            if any(
                address.casefold() in handles
                for address in {
                    message.from_email,
                    *message.to_emails,
                    *message.cc_emails,
                }
            )
            and _message_in_bounds(
                message.received_at or message.sent_at,
                since=since,
                until=until,
            )
        )
    if source != "gmail":
        rows.extend(
            _chat_projection(message)
            for message in world.chat_messages.values()
            if (source is None or message.channel == source)
            and any(
                handle.casefold() in handles
                for handle in {message.from_handle, *message.to_handles}
            )
            and _message_in_bounds(message.sent_at, since=since, until=until)
        )
    rows.sort(
        key=lambda item: (item.get("receivedAt") or item["sentAt"], item["id"]),
        reverse=True,
    )
    return {
        "ok": True,
        "effect": "none",
        "operation": "MESSAGE/read_with_contact",
        "source": source,
        "contact": reference,
        "matchedContactIds": [contact.id for contact in contacts],
        "purpose": kw.get("purpose"),
        "count": min(len(rows), limit),
        "messages": rows[:limit],
    }


def _triage_messages(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    sources = _validated_message_sources(kw)
    folder = _validated_email_folder(kw.get("folder"))
    content = kw.get("content")
    if content is not None and (not isinstance(content, str) or not content.strip()):
        raise ValueError(
            "MESSAGE/triage content must be a non-empty string when provided"
        )
    if isinstance(content, str):
        directive = content.strip()
        policy_id = _synthetic_id(
            "triage_policy",
            {
                "directive": directive,
                "sources": sources,
                "folder": folder,
            },
        )
        policy, replayed = world.create_message_triage_policy(
            policy_id=policy_id,
            directive=directive,
            sources=sources,
            folder=folder,
        )
        return {
            "ok": True,
            "effect": "persisted",
            "operation": "MESSAGE/triage",
            "id": policy.id,
            "version": policy.version,
            "createdAt": policy.created_at,
            "updatedAt": policy.updated_at,
            "replayed": replayed,
        }

    selected_sources = set(sources) if sources else set(_MESSAGE_SOURCES)
    emails = [
        message
        for message in world.emails.values()
        if "gmail" in selected_sources and (folder is None or message.folder == folder)
    ]
    chats = [
        message
        for message in world.chat_messages.values()
        if message.channel in selected_sources
    ]
    starred = sorted(
        (_email_projection(message) for message in emails if message.is_starred),
        key=lambda item: (item.get("receivedAt") or item["sentAt"], item["id"]),
        reverse=True,
    )
    unread = sorted(
        (
            [
                _email_projection(message)
                for message in emails
                if not message.is_read and not message.is_starred
            ]
            + [_chat_projection(message) for message in chats if not message.is_read]
        ),
        key=lambda item: (item.get("receivedAt") or item["sentAt"], item["id"]),
        reverse=True,
    )
    return {
        "ok": True,
        "effect": "none",
        "operation": "MESSAGE/triage",
        "sources": sorted(selected_sources),
        "folder": folder,
        "buckets": {
            "starred": starred,
            "unread": unread,
        },
        "counts": {
            "starred": len(starred),
            "unread": len(unread),
            "totalConsidered": len(emails) + len(chats),
        },
    }


def _draft_chat_reply(
    world: LifeWorld,
    kw: dict[str, Any],
    source_value: str,
) -> dict[str, Any]:
    source = _validated_message_source(source_value)
    if source == "gmail":
        raise ValueError("chat draft helper cannot accept source='gmail'")
    channel = cast(ChatChannel | None, source)
    target = (
        kw.get("recipient")
        or kw.get("target")
        or kw.get("roomId")
        or kw.get("channelId")
    )
    if not isinstance(target, str) or not target.strip():
        raise KeyError("MESSAGE/draft_reply requires recipient/target/roomId")
    target = target.strip()
    target_kind = str(kw.get("targetKind") or kw.get("target_kind") or "contact")
    conversation_id = kw.get("conversationId") or kw.get("roomId")
    if conversation_id is not None and (
        not isinstance(conversation_id, str) or not conversation_id
    ):
        raise ValueError("MESSAGE/draft_reply conversationId/roomId must be non-empty")
    text_value = (
        kw.get("message")
        or kw.get("text")
        or kw.get("body")
        or kw.get("reply")
        or kw.get("replyText")
    )
    if text_value is not None and (
        not isinstance(text_value, str) or not text_value.strip()
    ):
        raise ValueError("MESSAGE/draft_reply text must be non-empty when provided")
    text = text_value.strip() if isinstance(text_value, str) else None
    confirmation_value = kw.get(
        "requiresConfirmation",
        kw.get("requiresApproval", True),
    )
    if not isinstance(confirmation_value, bool):
        raise ValueError("MESSAGE/draft_reply confirmation flag must be boolean")
    privacy_raw = kw.get("privacyConstraints", [])
    if not isinstance(privacy_raw, list) or any(
        not isinstance(item, str) or not item.strip() for item in privacy_raw
    ):
        raise ValueError("MESSAGE/draft_reply privacyConstraints must be strings")
    privacy_constraints = [item.strip() for item in privacy_raw]
    directives = {
        key: kw[key] for key in ("constraint", "offer", "purpose", "tone") if key in kw
    }
    draft_id = _synthetic_id(
        "chat_draft",
        {
            "channel": channel,
            "target": target,
            "targetKind": target_kind,
            "conversationId": conversation_id,
            "text": text,
            "requiresConfirmation": confirmation_value,
            "privacyConstraints": privacy_constraints,
            "directives": directives,
        },
    )
    draft, replayed = world.create_chat_draft(
        draft_id=draft_id,
        channel=channel,
        target=target,
        target_kind=target_kind,
        conversation_id=conversation_id,
        text=text,
        requires_confirmation=confirmation_value,
        privacy_constraints=privacy_constraints,
        directives=directives,
    )
    return {
        "ok": True,
        "effect": "created",
        "operation": "MESSAGE/draft_reply",
        "id": draft.id,
        "status": draft.status,
        "sent": False,
        "target": draft.target,
        "source": draft.channel,
        "createdAt": draft.created_at,
        "updatedAt": draft.updated_at,
        "replayed": replayed,
    }


def _manage_email_via_message(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    raw_op = (
        kw.get("manageOperation")
        or kw.get("manage_operation")
        or kw.get("mailOperation")
        or kw.get("mail_operation")
        or kw.get("action")
        or kw.get("verb")
    )
    if not isinstance(raw_op, str) or not raw_op:
        raise KeyError("MESSAGE/manage missing required field 'manageOperation'")
    op = {
        "archive_thread": "archive",
        "markRead": "mark_read",
        "mark_read": "mark_read",
        "read": "mark_read",
        "delete": "trash",
        "trash_email": "trash",
        "star_email": "star",
    }.get(raw_op, raw_op)
    msg_id = (
        kw.get("messageId") or kw.get("message_id") or kw.get("id") or kw.get("target")
    )
    thread_id = kw.get("threadId") or kw.get("thread_id")
    if op == "archive":
        if msg_id is not None:
            msg = world.archive_email(msg_id)
            return {"id": msg.id, "folder": msg.folder}
        if thread_id is not None:
            archived: list[str] = []
            for eid, em in list(world.emails.items()):
                if em.thread_id == thread_id and em.folder != "archive":
                    world.archive_email(eid)
                    archived.append(eid)
            return {"thread_id": thread_id, "archived_ids": archived}
        raise KeyError("MESSAGE/manage(archive) needs messageId or threadId")
    if op == "mark_read":
        if msg_id is None:
            raise KeyError("MESSAGE/manage(mark_read) needs messageId")
        msg = world.mark_read(msg_id)
        return {"id": msg.id, "is_read": msg.is_read}
    if op == "trash":
        if msg_id is None:
            raise KeyError("MESSAGE/manage(trash) needs messageId")
        msg = world.trash_email(msg_id)
        return {"id": msg.id, "folder": msg.folder}
    if op == "star":
        if msg_id is None:
            raise KeyError("MESSAGE/manage(star) needs messageId")
        msg = world.star_email(msg_id, starred=bool(kw.get("starred", True)))
        return {"id": msg.id, "is_starred": msg.is_starred}
    raise UnsupportedAction(
        f"unsupported action in execute path: MESSAGE/manage/{op} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


def _u_entity(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """Dispatch the ENTITY umbrella on `subaction`.

    Canonical subaction is `create`; `add` is the legacy alias (kept for
    scenario-corpus compatibility). Agents also emit `create_contact` and
    the promoted `ENTITY_CREATE_CONTACT` / `CONTACT_CREATE` surface names —
    all four route to the same contact-creation handler (P1-5 vocab alignment).
    """
    sub = _required(kw, "subaction", action=name, sub="<missing>")
    # Normalise the four contact-create variants into a single branch.
    if sub in {"add", "create", "create_contact"}:
        display = kw.get("name") or "Unknown"
        parts = display.split(maxsplit=1)
        given = parts[0] if parts else display
        family = parts[1] if len(parts) > 1 else ""
        email = kw.get("email") or kw.get("handle") or "unknown@example.test"
        contact_id = kw.get("entityId") or _synthetic_id(
            "contact_auto", {"n": display, "e": email}
        )
        contact = Contact(
            id=contact_id,
            display_name=display,
            given_name=given,
            family_name=family,
            primary_email=email,
            phones=[kw["phone"]] if kw.get("phone") else [],
            relationship=kw.get("relationship", "acquaintance"),
            notes=kw.get("notes"),
            priority_flag=kw.get("priorityFlag") or kw.get("priority_flag"),
        )
        world.add(EntityKind.CONTACT, contact)
        return {"id": contact.id}
    if sub == "update":
        contact_id = kw.get("entityId") or kw.get("id")
        existing = (
            world.contacts.get(contact_id) if isinstance(contact_id, str) else None
        )
        display_name = kw.get("name") or kw.get("displayName")
        if existing is None and isinstance(display_name, str) and display_name:
            matches = [
                contact
                for contact in world.contacts.values()
                if contact.display_name.casefold() == display_name.casefold()
            ]
            if len(matches) > 1:
                raise ValueError(f"ENTITY/update name is ambiguous: {display_name!r}")
            existing = matches[0] if matches else None
        created = existing is None
        if existing is None:
            if not isinstance(display_name, str) or not display_name:
                raise KeyError("ENTITY/update needs entityId/id or a non-empty name")
            parts = display_name.split(maxsplit=1)
            contact_id = (
                contact_id
                if isinstance(contact_id, str) and contact_id
                else _synthetic_id("contact_auto", {"n": display_name})
            )
            existing = Contact(
                id=contact_id,
                display_name=display_name,
                given_name=parts[0],
                family_name=parts[1] if len(parts) > 1 else "",
                primary_email=f"{contact_id}@example.test",
            )
            world.add(EntityKind.CONTACT, existing)
        patches: dict[str, Any] = {}
        if isinstance(display_name, str) and display_name:
            parts = display_name.split(maxsplit=1)
            patches.update(
                display_name=display_name,
                given_name=parts[0],
                family_name=parts[1] if len(parts) > 1 else "",
            )
        if "notes" in kw:
            patches["notes"] = kw["notes"]
        if "priorityFlag" in kw or "priority_flag" in kw:
            patches["priority_flag"] = kw.get("priorityFlag") or kw.get("priority_flag")
        if "importance" in kw:
            patches["importance"] = int(kw["importance"])
        if "tags" in kw:
            patches["tags"] = list(kw["tags"])
        if not patches:
            raise ValueError("ENTITY/update contains no supported contact fields")
        updated = world.update(EntityKind.CONTACT, existing.id, **patches)
        return {"id": updated.id, "created": created}
    if sub == "set_identity":
        contact_id = _required(kw, "entityId", action=name, sub=sub)
        platform = kw.get("platform")
        handle = _required(kw, "handle", action=name, sub=sub)
        patches: dict[str, Any] = {}
        existing = world.contacts.get(contact_id)
        if platform == "phone":
            phones = [handle] + [
                p for p in (existing.phones if existing else []) if p != handle
            ]
            patches["phones"] = phones
        elif platform == "email":
            patches["primary_email"] = handle
        else:
            phones = [handle] + [
                p for p in (existing.phones if existing else []) if p != handle
            ]
            patches["phones"] = phones
        if "displayName" in kw:
            patches["display_name"] = kw["displayName"]
        updated = world.update(EntityKind.CONTACT, contact_id, **patches)
        return {"id": updated.id}
    if sub == "set_relationship":
        contact_id = _required(kw, "toEntityId", action=name, sub=sub)
        relationship_type = _required(kw, "relationshipType", action=name, sub=sub)
        if not isinstance(contact_id, str) or not contact_id:
            raise ValueError(
                "ENTITY/set_relationship toEntityId must be a non-empty string"
            )
        if not isinstance(relationship_type, str) or not relationship_type:
            raise ValueError(
                "ENTITY/set_relationship relationshipType must be a non-empty string"
            )
        relationship = {
            "family_of": "family",
            "co_parent_of": "family",
            "friend_of": "friend",
            "colleague_of": "work",
            "acquaintance_of": "acquaintance",
        }.get(relationship_type)
        if relationship is None:
            raise ValueError(
                f"ENTITY/set_relationship unsupported relationshipType={relationship_type!r}"
            )
        existing = world.contacts.get(contact_id)
        created = existing is None
        if existing is None:
            display_name = (
                contact_id.rsplit("-", maxsplit=1)[-1].replace("_", " ").title()
            )
            parts = display_name.split(maxsplit=1)
            existing = Contact(
                id=contact_id,
                display_name=display_name,
                given_name=parts[0],
                family_name=parts[1] if len(parts) > 1 else "",
                primary_email=f"{contact_id}@example.test",
            )
            world.add(EntityKind.CONTACT, existing)
        metadata = kw.get("metadata") or {}
        if not isinstance(metadata, dict):
            raise ValueError("ENTITY/set_relationship metadata must be an object")
        updated = world.update(
            EntityKind.CONTACT,
            existing.id,
            relationship=relationship,
            relationship_type=relationship_type,
            relationship_evidence=kw.get("evidence"),
            relationship_metadata=dict(metadata),
        )
        return {
            "id": updated.id,
            "relationshipType": relationship_type,
            "created": created,
        }
    if sub == "log_interaction":
        return _log_entity_interaction(world, kw)
    if sub == "list":
        return _list_entities(world, kw)
    raise UnsupportedAction(
        f"unsupported action in execute path: ENTITY/{sub} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


_ENTITY_INTENT_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^list contacts whose family name is (?P<value>.+)$"), "family_name"),
    (re.compile(r"^list contacts where company is (?P<value>.+)$"), "company"),
    (
        re.compile(r"^list contacts where email ends with (?P<value>.+)$"),
        "email_suffix",
    ),
    (
        re.compile(r"^list contacts where phone starts with (?P<value>.+)$"),
        "phone_prefix",
    ),
    (
        re.compile(r"^list contacts where relationship is (?P<value>.+)$"),
        "relationship",
    ),
    (re.compile(r"^list contacts with (?P<value>.+) tag$"), "tag"),
)


def _parse_entity_list_filters(kw: dict[str, Any]) -> dict[str, Any]:
    raw_filters = kw.get("filters", {})
    if not isinstance(raw_filters, dict):
        raise ValueError("ENTITY/list filters must be an object")
    filters = dict(raw_filters)
    aliases = {
        "familyName": "family_name",
        "emailSuffix": "email_suffix",
        "phonePrefix": "phone_prefix",
    }
    for source_key, target_key in aliases.items():
        if source_key in filters and target_key not in filters:
            filters[target_key] = filters.pop(source_key)
        if source_key in kw and target_key not in filters:
            filters[target_key] = kw[source_key]
    for key in (
        "name",
        "family_name",
        "company",
        "email_suffix",
        "phone_prefix",
        "relationship",
        "tag",
        "missing",
    ):
        if key in kw and key not in filters:
            filters[key] = kw[key]

    intent = kw.get("intent")
    if intent is not None:
        if not isinstance(intent, str) or not intent.strip():
            raise ValueError("ENTITY/list intent must be a non-empty string")
        normalized = " ".join(intent.casefold().split())
        if normalized == "list contacts missing email":
            filters.setdefault("missing", "email")
        elif normalized == "list contacts where notes are empty":
            filters.setdefault("missing", "notes")
        elif normalized == "list family contacts missing phone":
            filters.setdefault("relationship", "family")
            filters.setdefault("missing", "phone")
        elif normalized not in {"list contacts", "list all contacts"}:
            match = None
            for pattern, field in _ENTITY_INTENT_PATTERNS:
                candidate = pattern.fullmatch(normalized)
                if candidate is not None:
                    match = (candidate, field)
                    break
            if match is None:
                raise ValueError(
                    "ENTITY/list intent cannot be represented by deterministic filters; "
                    "provide structured filters"
                )
            matched, field = match
            if matched is None:
                raise AssertionError("matched ENTITY/list intent unexpectedly vanished")
            filters.setdefault(field, matched.group("value").strip())

    allowed = {
        "name",
        "family_name",
        "company",
        "email_suffix",
        "phone_prefix",
        "relationship",
        "tag",
        "missing",
    }
    unknown = set(filters) - allowed
    if unknown:
        raise ValueError(f"ENTITY/list has unsupported filters: {sorted(unknown)}")
    for key, value in filters.items():
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"ENTITY/list filter {key!r} must be a non-empty string")
        filters[key] = value.strip()
    if filters.get("missing") not in {None, "email", "notes", "phone"}:
        raise ValueError("ENTITY/list missing filter must be email, notes, or phone")
    return filters


def _contact_matches_filters(contact: Contact, filters: dict[str, Any]) -> bool:
    def folded(key: str) -> str | None:
        value = filters.get(key)
        return value.casefold() if isinstance(value, str) else None

    name = folded("name")
    if name is not None and name not in contact.display_name.casefold():
        return False
    family_name = folded("family_name")
    if family_name is not None and contact.family_name.casefold() != family_name:
        return False
    company = folded("company")
    if company is not None and (
        contact.company is None or contact.company.casefold() != company
    ):
        return False
    email_suffix = folded("email_suffix")
    if email_suffix is not None and not contact.primary_email.casefold().endswith(
        email_suffix
    ):
        return False
    phone_prefix = filters.get("phone_prefix")
    if isinstance(phone_prefix, str) and not any(
        phone.startswith(phone_prefix) for phone in contact.phones
    ):
        return False
    relationship = folded("relationship")
    if relationship is not None and contact.relationship.casefold() != relationship:
        return False
    tag = folded("tag")
    if tag is not None and tag not in {item.casefold() for item in contact.tags}:
        return False
    missing = filters.get("missing")
    if missing == "email" and contact.primary_email.strip():
        return False
    if missing == "notes" and contact.notes not in {None, ""}:
        return False
    if missing == "phone" and contact.phones:
        return False
    return True


def _list_entities(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    filters = _parse_entity_list_filters(kw)
    limit = _positive_limit(kw.get("limit"), default=100)
    contacts = sorted(
        (
            contact
            for contact in world.contacts.values()
            if _contact_matches_filters(contact, filters)
        ),
        key=lambda contact: (contact.display_name.casefold(), contact.id),
    )
    rows = [
        {
            "id": contact.id,
            "displayName": contact.display_name,
            "givenName": contact.given_name,
            "familyName": contact.family_name,
            "primaryEmail": contact.primary_email,
            "phones": list(contact.phones),
            "company": contact.company,
            "relationship": contact.relationship,
            "tags": list(contact.tags),
            "notes": contact.notes,
        }
        for contact in contacts[:limit]
    ]
    return {
        "ok": True,
        "effect": "none",
        "operation": "ENTITY/list",
        "filters": filters,
        "count": len(rows),
        "entities": rows,
    }


def _log_entity_interaction(world: LifeWorld, kw: dict[str, Any]) -> dict[str, Any]:
    entity_id_value = kw.get("entityId") or kw.get("id")
    if entity_id_value is not None and (
        not isinstance(entity_id_value, str) or not entity_id_value.strip()
    ):
        raise ValueError("ENTITY/log_interaction entityId/id must be non-empty")
    entity_id = entity_id_value.strip() if isinstance(entity_id_value, str) else None
    supplied_name = kw.get("name")
    if supplied_name is not None and (
        not isinstance(supplied_name, str) or not supplied_name.strip()
    ):
        raise ValueError("ENTITY/log_interaction name must be non-empty")
    supplied_name = supplied_name.strip() if isinstance(supplied_name, str) else None
    contact: Contact | None = None
    if entity_id is not None:
        contact = world.contacts.get(entity_id)
        if contact is None:
            raise KeyError(f"ENTITY/log_interaction contact not found: {entity_id}")
    elif supplied_name is not None:
        matches = _contact_matches(world, supplied_name)
        if len(matches) > 1:
            raise ValueError(
                f"ENTITY/log_interaction name is ambiguous: {supplied_name!r}"
            )
        if matches:
            contact = matches[0]
            entity_id = contact.id
    else:
        raise KeyError("ENTITY/log_interaction requires entityId/id or name")

    notes = kw.get("notes")
    if not isinstance(notes, str) or not notes.strip():
        raise ValueError("ENTITY/log_interaction requires non-empty notes")
    notes = notes.strip()
    channel = _validated_message_source(kw.get("channel"), field="channel")
    occurred_at_value = (
        kw.get("occurredAt")
        or kw.get("occurred_at")
        or kw.get("timestamp")
        or world.now_iso
    )
    if (
        not isinstance(occurred_at_value, str)
        or _try_parse_iso(occurred_at_value) is None
    ):
        raise ValueError(
            "ENTITY/log_interaction occurredAt must be a valid ISO date/time"
        )
    store_allowed = kw.get("storeAllowed", kw.get("store_allowed", True))
    if not isinstance(store_allowed, bool):
        raise ValueError("ENTITY/log_interaction storeAllowed must be boolean")
    subject_name = supplied_name or (
        contact.display_name if contact is not None else ""
    )
    source_name_mismatch = (
        contact is not None
        and supplied_name is not None
        and supplied_name.casefold() != contact.display_name.casefold()
    )
    if not store_allowed:
        return {
            "ok": True,
            "effect": "none",
            "operation": "ENTITY/log_interaction",
            "persisted": False,
            "privacyGuard": "storage_prohibited",
            "entityId": entity_id,
            "noteDigest": hashlib.sha256(notes.encode("utf-8")).hexdigest(),
        }

    record_id = _synthetic_id(
        "interaction",
        {
            "entityId": entity_id,
            "subjectName": subject_name,
            "notes": notes,
            "channel": channel,
            "occurredAt": occurred_at_value,
        },
    )
    record, replayed = world.create_interaction_record(
        record_id=record_id,
        entity_id=entity_id,
        subject_name=subject_name,
        notes=notes,
        channel=channel,
        occurred_at=occurred_at_value,
        source_name_mismatch=source_name_mismatch,
    )
    return {
        "ok": True,
        "effect": "created",
        "operation": "ENTITY/log_interaction",
        "id": record.id,
        "entityId": record.entity_id,
        "subjectName": record.subject_name,
        "occurredAt": record.occurred_at,
        "createdAt": record.created_at,
        "sourceNameMismatch": record.source_name_mismatch,
        "replayed": replayed,
    }


_LIFE_DEFINITION_FIELDS = frozenset(
    {
        "anchor",
        "appliesTo",
        "cadence",
        "dedupeKey",
        "defaultAfterLocal",
        "dueDay",
        "dueDaySemantic",
        "earliestLocal",
        "endLocal",
        "exampleLocal",
        "label",
        "latestLocal",
        "offsetMinutes",
        "policy",
        "requiresOverride",
        "rotations",
        "skipDates",
        "startLocal",
        "timeOfDay",
        "timezoneSemantic",
        "windowAfterMinutes",
    }
)
_LIFE_TASK_UPDATE_FIELDS = frozenset(
    {
        "active",
        "anchor",
        "cadence",
        "due",
        "dueAt",
        "due_at",
        "listId",
        "notes",
        "priority",
        "skipDates",
        "state",
        "timeOfDay",
        "title",
    }
)


def _life_schedule(details: dict[str, Any]) -> dict[str, Any]:
    return {
        field: _validated_json_value(details[field], field=f"details.{field}")
        for field in sorted(_LIFE_DEFINITION_FIELDS)
        if field in details
    }


def _life_task_by_reference(
    world: LifeWorld,
    *,
    target: Any,
    title: Any,
) -> Any:
    if isinstance(target, str) and target.strip():
        task = world.scheduled_tasks.get(target.strip())
        if task is not None:
            return task
    if not isinstance(title, str) or not title.strip():
        raise KeyError("LIFE operation requires target or title")
    matches = [
        task
        for task in world.scheduled_tasks.values()
        if task.prompt_instructions.casefold() == title.strip().casefold()
        and task.metadata.get("lifeDefinition") is True
    ]
    if not matches:
        raise KeyError(f"LIFE definition not found for title: {title!r}")
    if len(matches) > 1:
        raise ValueError(f"LIFE definition title is ambiguous: {title!r}")
    return matches[0]


def _life_expected_version(kw: dict[str, Any], current: int) -> None:
    raw = kw.get("expectedVersion")
    if raw is None:
        return
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 1:
        raise ValueError("LIFE expectedVersion must be a positive integer")
    if raw != current:
        raise ValueError(
            f"LIFE definition version conflict: expected {raw}, found {current}"
        )


def _ensure_life_definition(
    world: LifeWorld,
    *,
    title: str,
    detail_kind: str,
    list_id: str,
    due_at: str | None,
    details: dict[str, Any],
) -> tuple[Any | None, bool]:
    schedule = _life_schedule(details)
    if detail_kind != "alarm" and not schedule:
        return None, False
    definition_id_raw = details.get("definitionId")
    definition_id = (
        definition_id_raw.strip()
        if isinstance(definition_id_raw, str) and definition_id_raw.strip()
        else _synthetic_id(
            "life_definition",
            {
                "title": title,
                "kind": detail_kind,
                "listId": list_id,
                "due": due_at,
                "schedule": schedule,
            },
        )
    )
    trigger = dict(schedule)
    trigger["kind"] = "recurring" if schedule.get("cadence") else "once"
    if due_at is not None:
        trigger["atIso"] = due_at
    metadata = {
        "lifeDefinition": True,
        "version": 1,
        "definition": {
            "kind": detail_kind,
            "listId": list_id,
            **schedule,
        },
    }
    existing = world.scheduled_tasks.get(definition_id)
    if existing is not None:
        if (
            existing.kind != detail_kind
            or existing.prompt_instructions != title
            or existing.trigger != trigger
            or existing.metadata != metadata
            or existing.state != "active"
        ):
            raise ValueError(f"LIFE definition idempotency conflict: {definition_id}")
        return existing, True
    task = world.create_scheduled_task(
        task_id=definition_id,
        kind=detail_kind,
        prompt_instructions=title,
        trigger=trigger,
        metadata=metadata,
    )
    return task, False


def _u_life_create(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """Create typed reminders, recurring definitions, workouts, and readings."""
    sub = _required(kw, "subaction", action=name, sub="<missing>")
    if sub != "create":
        raise UnsupportedAction(
            f"unsupported action in execute path: LIFE_CREATE/{sub}"
        )
    details = _details(kw)
    title_raw = kw.get("title") or details.get("title")
    if not isinstance(title_raw, str) or not title_raw.strip():
        raise ValueError("LIFE_CREATE title must be a non-empty string")
    title = title_raw.strip()
    detail_kind = details.get("kind") or kw.get("kind") or "reminder"
    if detail_kind in {"reminder", "alarm"}:
        list_id = (
            details.get("listId")
            or details.get("list_id")
            or kw.get("listId")
            or kw.get("list_id")
            or "list_personal"
        )
        if not isinstance(list_id, str) or list_id not in world.reminder_lists:
            raise KeyError(
                f"LIFE_CREATE references unknown reminder list {list_id!r} "
                f"(known: {sorted(world.reminder_lists)})"
            )
        due_at = (
            details.get("due")
            or details.get("due_at")
            or details.get("dueAt")
            or kw.get("due")
            or kw.get("due_at")
            or kw.get("dueAt")
        )
        if due_at is not None and (
            not isinstance(due_at, str) or _try_parse_iso(due_at) is None
        ):
            raise ValueError("LIFE_CREATE due must be a valid ISO date/time")
        schedule = _life_schedule(details)
        reminder_id = _synthetic_id(
            "reminder_auto",
            {
                "t": title,
                "l": list_id,
                "d": due_at,
                "kind": detail_kind,
                "schedule": schedule,
            },
        )
        candidate = Reminder(
            id=reminder_id,
            list_id=list_id,
            title=title,
            due_at=due_at,
            schedule=schedule,
        )
        reminder = world.reminders.get(reminder_id)
        replayed = reminder is not None
        if reminder is not None and reminder != candidate:
            raise ValueError(f"LIFE reminder idempotency conflict: {reminder_id}")
        if reminder is None:
            reminder = world.create_reminder(
                reminder_id=reminder_id,
                list_id=list_id,
                title=title,
                due_at=due_at,
                schedule=schedule,
            )
        definition, definition_replayed = _ensure_life_definition(
            world,
            title=title,
            detail_kind=str(detail_kind),
            list_id=list_id,
            due_at=due_at,
            details=details,
        )
        return {
            "id": reminder.id,
            "title": reminder.title,
            "definitionId": definition.id if definition is not None else None,
            "replayed": replayed and (definition is None or definition_replayed),
        }
    if detail_kind == "workout":
        duration_minutes = _strict_positive_integer(
            details.get("durationMinutes", details.get("duration_minutes")),
            field="LIFE_CREATE workout durationMinutes",
            default=1,
            maximum=24 * 60,
        )
        occurred_at = details.get("occurredAtIso") or world.now_iso
        if not isinstance(occurred_at, str) or _try_parse_iso(occurred_at) is None:
            raise ValueError("LIFE_CREATE workout occurredAtIso must be ISO date/time")
        workout_id = _synthetic_id(
            "workout",
            {
                "t": title,
                "d": details.get("distanceKm"),
                "m": duration_minutes,
                "o": occurred_at,
            },
        )
        activity_type = (
            details.get("workoutType")
            or details.get("activityType")
            or details.get("activity_type")
            or title
        )
        calories_raw = details.get("calories", details.get("kcal"))
        if calories_raw is not None and (
            isinstance(calories_raw, bool)
            or not isinstance(calories_raw, (int, float))
            or calories_raw < 0
        ):
            raise ValueError("LIFE_CREATE workout calories must be non-negative")
        calories = int(calories_raw) if calories_raw is not None else None
        distance_raw = details.get("distanceKm", details.get("distance_km"))
        if distance_raw is not None and (
            isinstance(distance_raw, bool)
            or not isinstance(distance_raw, (int, float))
            or distance_raw < 0
        ):
            raise ValueError("LIFE_CREATE workout distanceKm must be non-negative")
        distance_km = float(distance_raw) if distance_raw is not None else None
        candidate = WorkoutRecord(
            id=workout_id,
            activity_type=str(activity_type),
            duration_minutes=duration_minutes,
            calories=calories,
            recorded_at=occurred_at,
            distance_km=distance_km,
        )
        existing = world.workouts.get(workout_id)
        if existing is not None:
            if existing != candidate:
                raise ValueError(f"LIFE workout idempotency conflict: {workout_id}")
            return {"id": existing.id, "kind": "workout", "replayed": True}
        workout = world.log_workout(
            workout_id=workout_id,
            activity_type=str(activity_type),
            duration_minutes=duration_minutes,
            calories=calories,
            recorded_at=occurred_at,
            distance_km=distance_km,
        )
        return {"id": workout.id, "kind": "workout", "replayed": False}
    if detail_kind == "health_metric":
        metric_type = _validated_health_metric(
            _required(details, "metric", action=name, sub="create/health_metric"),
            required=True,
        )
        value_raw = _required(details, "value", action=name, sub="create/health_metric")
        if isinstance(value_raw, bool) or not isinstance(value_raw, (int, float)):
            raise ValueError("LIFE_CREATE health metric value must be numeric")
        value = float(value_raw)
        if value != value or abs(value) == float("inf"):
            raise ValueError("LIFE_CREATE health metric value must be finite")
        occurred_at = details.get("occurredAtIso") or world.now_iso
        if not isinstance(occurred_at, str) or _try_parse_iso(occurred_at) is None:
            raise ValueError(
                "LIFE_CREATE health metric occurredAtIso must be ISO date/time"
            )
        metric_id = _synthetic_id(
            "hm_auto",
            {"m": metric_type, "v": value, "o": occurred_at},
        )
        candidate = HealthMetric(
            id=metric_id,
            metric_type=metric_type,  # type: ignore[arg-type]
            value=value,
            recorded_at=occurred_at,
            source="manual",
        )
        existing = world.health_metrics.get(metric_id)
        if existing is not None:
            if existing != candidate:
                raise ValueError(
                    f"LIFE health metric idempotency conflict: {metric_id}"
                )
            return {
                "id": existing.id,
                "metric": existing.metric_type,
                "value": existing.value,
                "replayed": True,
            }
        metric = world.log_health_metric(
            metric_id=metric_id,
            metric_type=metric_type,
            value=value,
            recorded_at=occurred_at,
        )
        return {
            "id": metric.id,
            "metric": metric.metric_type,
            "value": metric.value,
            "replayed": False,
        }
    raise UnsupportedAction(
        f"unsupported action in execute path: LIFE_CREATE/create/{detail_kind}"
    )


def _u_life_complete(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    sub = kw.get("subaction", "complete")
    target = _required(kw, "target", action=name, sub=sub)
    if target.startswith("reminder_"):
        existing = world.reminders.get(target)
        if existing is None:
            raise KeyError(f"LIFE_COMPLETE references unknown reminder: {target}")
        operation_id = _synthetic_id(
            "life_operation", {"op": "complete", "target": target}
        )
        if existing.last_operation_id == operation_id:
            return {
                "id": existing.id,
                "completed_at": existing.completed_at,
                "replayed": True,
            }
        reminder = world.complete_reminder(target)
        reminder = world.update(
            EntityKind.REMINDER,
            reminder.id,
            version=reminder.version + 1,
            last_operation_id=operation_id,
        )
        return {
            "id": reminder.id,
            "completed_at": reminder.completed_at,
            "replayed": False,
        }
    raise UnsupportedAction(
        f"unsupported action in execute path: LIFE_COMPLETE/{target} — only reminder_* targets supported"
    )


def _u_life_snooze(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    sub = kw.get("subaction", "snooze")
    target = _required(kw, "target", action=name, sub=sub)
    minutes = int(_required(kw, "minutes", action=name, sub=sub))
    if not target.startswith("reminder_"):
        raise UnsupportedAction(
            f"unsupported action in execute path: LIFE_SNOOZE/{target} — only reminder_* targets supported"
        )
    existing = world.reminders.get(target)
    if existing is None:
        raise KeyError(f"LIFE_SNOOZE references unknown reminder: {target}")
    base = existing.due_at or world.now_iso
    operation_id = _synthetic_id(
        "life_operation",
        {"op": "snooze", "target": target, "minutes": minutes},
    )
    if existing.last_operation_id == operation_id:
        return {"id": existing.id, "due_at": existing.due_at, "replayed": True}
    new_due = _shift_iso(base, minutes=minutes)
    reminder = world.snooze_reminder(target, new_due_at=new_due)
    reminder = world.update(
        EntityKind.REMINDER,
        reminder.id,
        version=reminder.version + 1,
        last_operation_id=operation_id,
    )
    return {"id": reminder.id, "due_at": reminder.due_at, "replayed": False}


def _u_life_review(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """LIFE_REVIEW stamps last_reviewed_at on the target list (side-effect).

    Even though the primary purpose is a read/listing operation, a review call
    writes a ``last_reviewed_at`` timestamp to the reminder list so that
    subsequent review cadence queries can tell when the list was last checked.
    This is the mutation that makes LIFE_REVIEW a "read_with_side_effects"
    scenario rather than a pure read.
    """
    sub = kw.get("subaction", "review")
    list_id = kw.get("list_id") or kw.get("listId")
    if list_id is not None:
        if not isinstance(list_id, str) or list_id not in world.reminder_lists:
            raise KeyError(f"LIFE_REVIEW references unknown reminder list: {list_id!r}")
        current = world.reminder_lists[list_id]
        if current.last_reviewed_at == world.now_iso:
            return {
                "subaction": sub,
                "ok": True,
                "list_id": list_id,
                "last_reviewed_at": current.last_reviewed_at,
                "replayed": True,
            }
        updated = world.touch_reminder_list_reviewed(list_id)
        return {
            "subaction": sub,
            "ok": True,
            "list_id": list_id,
            "last_reviewed_at": updated.last_reviewed_at,
            "replayed": False,
        }
    for lid in list(world.reminder_lists):
        if world.reminder_lists[lid].last_reviewed_at != world.now_iso:
            world.touch_reminder_list_reviewed(lid)
    return {
        "subaction": sub,
        "ok": True,
        "last_reviewed_at": world.now_iso,
    }


def _u_life_delete(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """Delete reminders or retain an idempotent tombstone for definitions."""
    target = kw.get("target")
    if (
        isinstance(target, str)
        and target.startswith("reminder_")
        and target in world.reminders
    ):
        world.delete(EntityKind.REMINDER, target)
        return {"id": target, "deleted": True, "replayed": False}
    task = _life_task_by_reference(world, target=target, title=kw.get("title"))
    if task.state == "deleted":
        return {"id": task.id, "deleted": True, "replayed": True}
    version = int(task.metadata.get("version", 1))
    _life_expected_version(kw, version)
    metadata = {**task.metadata, "version": version + 1, "deletedAt": world.now_iso}
    deleted = world.update_scheduled_task(task.id, state="deleted", metadata=metadata)
    return {"id": deleted.id, "deleted": True, "replayed": False}


def _u_life_update(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """Apply versioned updates to reminders or scheduler-backed definitions."""
    updates_raw = kw.get("updates")
    updates = updates_raw if isinstance(updates_raw, dict) else _details(kw)
    if not updates:
        raise ValueError("LIFE_UPDATE requires a non-empty updates/details object")
    unknown = set(updates) - _LIFE_TASK_UPDATE_FIELDS
    if unknown:
        raise ValueError(f"LIFE_UPDATE has unknown fields: {sorted(unknown)}")
    normalized = {
        key: _validated_json_value(value, field=f"updates.{key}")
        for key, value in updates.items()
    }
    target = kw.get("target")
    if isinstance(target, str) and target in world.reminders:
        reminder = world.reminders[target]
        _life_expected_version(kw, reminder.version)
        patches: dict[str, Any] = {}
        aliases = {
            "title": "title",
            "notes": "notes",
            "priority": "priority",
            "listId": "list_id",
            "due": "due_at",
            "dueAt": "due_at",
            "due_at": "due_at",
        }
        for source, destination in aliases.items():
            if source in normalized:
                patches[destination] = normalized[source]
        if "list_id" in patches and patches["list_id"] not in world.reminder_lists:
            raise KeyError(
                f"LIFE_UPDATE references unknown reminder list: {patches['list_id']!r}"
            )
        if "due_at" in patches and (
            not isinstance(patches["due_at"], str)
            or _try_parse_iso(patches["due_at"]) is None
        ):
            raise ValueError("LIFE_UPDATE due must be a valid ISO date/time")
        operation_id = _synthetic_id(
            "life_operation",
            {"op": "update", "target": target, "updates": normalized},
        )
        if reminder.last_operation_id == operation_id:
            return {"id": reminder.id, "version": reminder.version, "replayed": True}
        updated = world.update(
            EntityKind.REMINDER,
            reminder.id,
            **patches,
            version=reminder.version + 1,
            last_operation_id=operation_id,
        )
        return {"id": updated.id, "version": updated.version, "replayed": False}

    task = _life_task_by_reference(
        world,
        target=target,
        title=kw.get("title"),
    )
    version = int(task.metadata.get("version", 1))
    _life_expected_version(kw, version)
    definition = dict(task.metadata.get("definition") or {})
    definition.update(normalized)
    trigger = dict(task.trigger)
    for field in ("anchor", "cadence", "timeOfDay"):
        if field in normalized:
            trigger[field] = normalized[field]
    due = normalized.get(
        "due",
        normalized.get("dueAt", normalized.get("due_at")),
    )
    if due is not None:
        if not isinstance(due, str) or _try_parse_iso(due) is None:
            raise ValueError("LIFE_UPDATE due must be a valid ISO date/time")
        trigger["atIso"] = due
    metadata = {**task.metadata, "definition": definition}
    task_patches: dict[str, Any] = {"trigger": trigger}
    if "title" in normalized:
        title = normalized["title"]
        if not isinstance(title, str) or not title.strip():
            raise ValueError("LIFE_UPDATE title must be a non-empty string")
        task_patches["prompt_instructions"] = title.strip()
    if "priority" in normalized:
        priority = normalized["priority"]
        if priority not in {"low", "medium", "normal", "high"}:
            raise ValueError("LIFE_UPDATE priority is invalid")
        task_patches["priority"] = priority
    if "state" in normalized:
        state = normalized["state"]
        if not isinstance(state, str) or not state:
            raise ValueError("LIFE_UPDATE state must be a non-empty string")
        task_patches["state"] = state
    if "active" in normalized:
        if not isinstance(normalized["active"], bool):
            raise ValueError("LIFE_UPDATE active must be boolean")
        task_patches["state"] = "active" if normalized["active"] else "paused"
    candidate_metadata = {**metadata, "version": version + 1}
    unchanged = (
        all(getattr(task, field) == value for field, value in task_patches.items())
        and metadata == task.metadata
    )
    if unchanged:
        return {"id": task.id, "version": version, "replayed": True}
    task_patches["metadata"] = candidate_metadata
    updated = world.update_scheduled_task(task.id, **task_patches)
    return {"id": updated.id, "version": version + 1, "replayed": False}


def _u_life_skip(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """Persist a dated occurrence skip or a structural scheduler skip."""
    details = _details(kw)
    target = kw.get("target")
    title = kw.get("title")
    skip_date = details.get("skipDate") or kw.get("skipDate")
    reason = kw.get("reason") or details.get("reason") or "owner_request"
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("LIFE_SKIP reason must be a non-empty string")
    task = _life_task_by_reference(world, target=target, title=title)
    version = int(task.metadata.get("version", 1))
    _life_expected_version(kw, version)
    metadata = dict(task.metadata)
    if skip_date is not None:
        if not isinstance(skip_date, str):
            raise ValueError("LIFE_SKIP skipDate must be YYYY-MM-DD")
        try:
            date.fromisoformat(skip_date)
        except ValueError as exc:
            raise ValueError("LIFE_SKIP skipDate must be YYYY-MM-DD") from exc
        skip_dates = list(metadata.get("skipDates") or [])
        if skip_date in skip_dates:
            return {"id": task.id, "skipDate": skip_date, "replayed": True}
        skip_dates.append(skip_date)
        metadata["skipDates"] = sorted(skip_dates)
        next_state = task.state
    else:
        skip_key = _synthetic_id(
            "life_skip",
            {"target": task.id, "reason": reason.strip()},
        )
        if metadata.get("lastSkipKey") == skip_key and task.state == "skipped":
            return {"id": task.id, "reason": reason.strip(), "replayed": True}
        metadata["lastSkipKey"] = skip_key
        metadata["skipReason"] = reason.strip()
        next_state = "skipped"
    metadata["version"] = version + 1
    updated = world.update_scheduled_task(
        task.id,
        state=next_state,
        metadata=metadata,
    )
    return {
        "id": updated.id,
        "skipDate": skip_date,
        "reason": reason.strip(),
        "version": version + 1,
        "replayed": False,
    }


def _scheduled_task_id(kw: dict[str, Any]) -> str | None:
    raw = (
        kw.get("taskId")
        or kw.get("task_id")
        or kw.get("id")
        or kw.get("target")
        or kw.get("scheduledTaskId")
        or kw.get("scheduled_task_id")
    )
    return raw if isinstance(raw, str) and raw.strip() else None


def _scheduled_task_trigger(kw: dict[str, Any]) -> dict[str, Any]:
    return scheduled_task_trigger(kw)


def _scheduled_task_patches(
    kw: dict[str, Any], *, include_identity: bool = True
) -> dict[str, Any]:
    patches: dict[str, Any] = {}
    if include_identity:
        kind = kw.get("kind")
        if isinstance(kind, str) and kind:
            patches["kind"] = kind
        prompt = (
            kw.get("promptInstructions")
            or kw.get("prompt_instructions")
            or kw.get("instructions")
            or kw.get("title")
        )
        if isinstance(prompt, str):
            patches["prompt_instructions"] = prompt
        trigger = _scheduled_task_trigger(kw)
        if trigger:
            patches["trigger"] = trigger

    alias_groups = {
        "output": ("output",),
        "subject": ("subject",),
        "priority": ("priority",),
        "should_fire": ("shouldFire", "should_fire"),
        "completion_check": ("completionCheck", "completion_check"),
        "pipeline": ("pipeline",),
        "metadata": ("metadata",),
        "state": ("state", "status"),
        "respects_global_pause": ("respectsGlobalPause", "respects_global_pause"),
    }
    for field, aliases in alias_groups.items():
        for alias in aliases:
            if alias not in kw:
                continue
            value = kw[alias]
            if field in {
                "output",
                "subject",
                "should_fire",
                "completion_check",
                "pipeline",
                "metadata",
            }:
                if isinstance(value, dict):
                    patches[field] = dict(value)
                elif value is None:
                    patches[field] = None
            elif field == "respects_global_pause":
                patches[field] = bool(value)
            else:
                patches[field] = value
            break
    return patches


def _u_scheduled_task_mutate(
    world: LifeWorld, kw: dict[str, Any], name: str
) -> dict[str, Any]:
    """Apply SCHEDULED_TASK_UPDATE/SNOOZE to an existing scheduled task."""
    task_id = _scheduled_task_id(kw)
    if not task_id:
        raise KeyError(f"{name} needs taskId/task_id/id/target")
    existing = world.scheduled_tasks.get(task_id)
    if existing is None:
        raise KeyError(f"{name} target does not exist: {task_id}")

    if name.endswith("SNOOZE"):
        minutes_raw = (
            kw.get("minutes") or kw.get("durationMinutes") or kw.get("duration")
        )
        minutes = int(minutes_raw) if isinstance(minutes_raw, (int, float, str)) else 0
        trigger = dict(existing.trigger)
        base = str(trigger.get("atIso") or trigger.get("at_iso") or world.now_iso)
        trigger["atIso"] = (
            kw.get("until")
            or kw.get("untilIso")
            or kw.get("until_iso")
            or _shift_iso(base, minutes=minutes)
        )
        metadata = dict(existing.metadata)
        metadata.update({"snoozedMinutes": minutes, "lastMutation": name})
        updated = world.update_scheduled_task(
            task_id,
            trigger=trigger,
            state="snoozed",
            metadata=metadata,
        )
        return {"id": updated.id, "state": updated.state, "trigger": updated.trigger}

    updates = kw.get("updates") or _details(kw)
    if not isinstance(updates, dict):
        updates = {}
    patches = _scheduled_task_patches({**kw, **updates})
    metadata = dict(existing.metadata)
    metadata["lastMutation"] = name
    patches["metadata"] = {**metadata, **dict(patches.get("metadata") or {})}
    updated = world.update_scheduled_task(task_id, **patches)
    return {"id": updated.id, "state": updated.state}


_SCHEDULED_TASK_STATE_BY_ACTION: dict[str, str] = {
    "SCHEDULED_TASKS_ACKNOWLEDGE": "acknowledged",
    "SCHEDULED_TASKS_CANCEL": "cancelled",
    "SCHEDULED_TASKS_COMPLETE": "completed",
    "SCHEDULED_TASKS_DISMISS": "dismissed",
    "SCHEDULED_TASKS_REOPEN": "active",
    "SCHEDULED_TASKS_SKIP": "skipped",
}


def _u_scheduled_task_state(
    world: LifeWorld, kw: dict[str, Any], name: str
) -> dict[str, Any]:
    task_id = _scheduled_task_id(kw)
    if not task_id:
        raise KeyError(f"{name} needs taskId/task_id/id/target")
    existing = world.scheduled_tasks.get(task_id)
    if existing is None:
        raise KeyError(f"{name} target does not exist: {task_id}")
    state = _SCHEDULED_TASK_STATE_BY_ACTION[name]
    metadata = dict(existing.metadata)
    metadata["lastMutation"] = name
    task = world.update_scheduled_task(task_id, state=state, metadata=metadata)
    return {"id": task.id, "state": task.state}


def _u_scheduled_tasks_readonly(
    world: LifeWorld, kw: dict[str, Any], name: str
) -> dict[str, Any]:
    task_id = _scheduled_task_id(kw)
    tasks = list(world.scheduled_tasks.values())
    if task_id:
        tasks = [task for task in tasks if task.id == task_id]
    kind = kw.get("kind")
    if isinstance(kind, str) and kind:
        tasks = [task for task in tasks if task.kind == kind]
    state = kw.get("state") or kw.get("status")
    if isinstance(state, str) and state:
        tasks = [task for task in tasks if task.state == state]
    return {
        "subaction": kw.get("subaction") or kw.get("action") or name,
        "ok": True,
        "tasks": [
            {
                "id": task.id,
                "kind": task.kind,
                "state": task.state,
                "trigger": task.trigger,
                "promptInstructions": task.prompt_instructions,
            }
            for task in sorted(tasks, key=lambda item: item.id)
        ],
    }


def _u_scheduled_tasks(
    world: LifeWorld, kw: dict[str, Any], name: str
) -> dict[str, Any]:
    op = str(kw.get("operation") or kw.get("action") or kw.get("subaction") or "list")
    op = {
        "ack": "acknowledge",
        "create_task": "create",
        "list_tasks": "list",
    }.get(op, op)
    if op == "create":
        return _u_scheduled_task_create(world, kw, "SCHEDULED_TASK_CREATE")
    if op in {"update", "snooze"}:
        return _u_scheduled_task_mutate(world, kw, f"SCHEDULED_TASK_{op.upper()}")
    state_action = {
        "acknowledge": "SCHEDULED_TASKS_ACKNOWLEDGE",
        "cancel": "SCHEDULED_TASKS_CANCEL",
        "complete": "SCHEDULED_TASKS_COMPLETE",
        "dismiss": "SCHEDULED_TASKS_DISMISS",
        "reopen": "SCHEDULED_TASKS_REOPEN",
        "skip": "SCHEDULED_TASKS_SKIP",
    }.get(op)
    if state_action is not None:
        return _u_scheduled_task_state(world, kw, state_action)
    if op in {"get", "history", "list"}:
        return _u_scheduled_tasks_readonly(world, kw, name)
    raise UnsupportedAction(
        f"unsupported action in execute path: SCHEDULED_TASKS/{op} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


_HEALTH_METRIC_TYPES = frozenset(
    {
        "blood_pressure",
        "body_fat_percent",
        "calories",
        "heart_rate",
        "sleep_hours",
        "sleep_quality",
        "steps",
        "weight_kg",
    }
)
_SLEEP_SOURCE_PRIORITY = ("manual", "fitbit", "apple-health", "oura")
_ACTIVITY_SOURCE_PRIORITY = ("manual", "fitbit", "oura", "apple-health")


def _validated_health_metric(value: Any, *, required: bool) -> str | None:
    if value is None or value == "":
        if required:
            raise KeyError("HEALTH requires metric")
        return None
    if not isinstance(value, str):
        raise ValueError("HEALTH metric must be a string")
    metric = value.strip().lower()
    if metric not in _HEALTH_METRIC_TYPES:
        raise ValueError(
            f"HEALTH metric must be one of {sorted(_HEALTH_METRIC_TYPES)}, got {value!r}"
        )
    return metric


def _health_window_days(value: Any, *, default: int) -> int:
    return _strict_positive_integer(
        value,
        field="HEALTH days",
        default=default,
        maximum=3650,
    )


def _health_data_points(
    world: LifeWorld,
    *,
    metric_type: str | None,
    days: int,
) -> list[dict[str, Any]]:
    now = _try_parse_iso(world.now_iso)
    if now is None:
        raise ValueError(f"LifeWorld has invalid now_iso: {world.now_iso!r}")
    cutoff = now - timedelta(days=days)
    raw_metrics = []
    for metric in world.health_metrics.values():
        if metric_type is not None and metric.metric_type != metric_type:
            continue
        recorded = _try_parse_iso(metric.recorded_at)
        if recorded is None:
            raise ValueError(
                f"LifeWorld health metric {metric.id} has invalid recorded_at"
            )
        if recorded < cutoff or recorded > now:
            continue
        raw_metrics.append(metric)

    def source_rank(metric: Any) -> int:
        priorities = (
            _SLEEP_SOURCE_PRIORITY
            if metric.metric_type in {"sleep_hours", "sleep_quality"}
            else _ACTIVITY_SOURCE_PRIORITY
        )
        try:
            return priorities.index(metric.source)
        except ValueError:
            return -1

    # Connector mirrors can report the same observation. Exact timestamps,
    # rather than whole days, preserve legitimate intraday samples.
    best: dict[tuple[str, str], Any] = {}
    for metric in raw_metrics:
        key = (metric.metric_type, metric.recorded_at)
        existing = best.get(key)
        if existing is None or source_rank(metric) > source_rank(existing):
            best[key] = metric
    return [
        {
            "id": metric.id,
            "metric_type": metric.metric_type,
            "value": metric.value,
            "recorded_at": metric.recorded_at,
            "source": metric.source,
        }
        for metric in sorted(
            best.values(),
            key=lambda item: (item.recorded_at, item.id),
        )
    ]


def _health_statistics(
    data_points: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in data_points:
        grouped.setdefault(str(item["metric_type"]), []).append(item)
    summaries: dict[str, dict[str, Any]] = {}
    for metric_type, items in sorted(grouped.items()):
        values = [float(item["value"]) for item in items]
        first = values[0]
        last = values[-1]
        delta = last - first
        summaries[metric_type] = {
            "count": len(values),
            "average": sum(values) / len(values),
            "minimum": min(values),
            "maximum": max(values),
            "first": first,
            "latest": last,
            "delta": delta,
            "direction": "up" if delta > 0 else "down" if delta < 0 else "flat",
            "firstRecordedAt": items[0]["recorded_at"],
            "latestRecordedAt": items[-1]["recorded_at"],
        }
    return summaries


def _u_health(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """Project or delete authoritative health readings from LifeWorld."""
    subaction = kw.get("subaction", "by_metric")
    if subaction not in {
        "by_metric",
        "delete_metric",
        "status",
        "summary",
        "today",
        "trend",
        "trends",
    }:
        raise UnsupportedAction(
            f"unsupported action in execute path: HEALTH/{subaction}"
        )

    if subaction == "delete_metric":
        metric_type = _validated_health_metric(kw.get("metric"), required=True)
        deleted_ids = sorted(
            metric.id
            for metric in world.health_metrics.values()
            if metric.metric_type == metric_type
        )
        for metric_id in deleted_ids:
            world.delete(EntityKind.HEALTH_METRIC, metric_id)
        return {
            "ok": True,
            "effect": "deleted" if deleted_ids else "none",
            "subaction": subaction,
            "metric": metric_type,
            "deletedIds": deleted_ids,
            "deletedCount": len(deleted_ids),
            "replayed": not deleted_ids,
        }

    metric_type = _validated_health_metric(
        kw.get("metric"),
        required=subaction in {"trend", "trends"},
    )
    days = _health_window_days(
        kw.get("days"),
        default=1 if subaction == "today" else 30,
    )
    data_points = _health_data_points(
        world,
        metric_type=metric_type,
        days=days,
    )
    sources = sorted({str(item["source"]) for item in data_points})
    result: dict[str, Any] = {
        "ok": True,
        "effect": "none",
        "subaction": subaction,
        "metric": metric_type or "all",
        "days": days,
        "data": data_points,
        "count": len(data_points),
        "source_used": (
            sources[0] if len(sources) == 1 else "multi" if sources else None
        ),
    }
    if subaction in {"status", "summary", "trend", "trends"}:
        result["statistics"] = _health_statistics(data_points)
    return result


def _money_window_days(value: Any, *, default: int) -> int:
    return _strict_positive_integer(
        value,
        field="MONEY windowDays",
        default=default,
        maximum=3650,
    )


def _money_bounds(
    world: LifeWorld,
    kw: dict[str, Any],
    *,
    window_field: str = "windowDays",
    default_days: int,
) -> tuple[datetime, datetime, int]:
    now = _try_parse_iso(world.now_iso)
    if now is None:
        raise ValueError(f"LifeWorld has invalid now_iso: {world.now_iso!r}")
    days = _money_window_days(
        kw.get(window_field, kw.get("window_days")),
        default=default_days,
    )
    start_raw = kw.get("start_date") or kw.get("startDate")
    end_raw = kw.get("end_date") or kw.get("endDate")
    start = now - timedelta(days=days)
    end = now
    if start_raw is not None:
        if not isinstance(start_raw, str):
            raise ValueError("MONEY startDate must be an ISO date/time")
        parsed = _try_parse_iso(start_raw)
        if parsed is None:
            raise ValueError("MONEY startDate must be an ISO date/time")
        start = parsed
    if end_raw is not None:
        if not isinstance(end_raw, str):
            raise ValueError("MONEY endDate must be an ISO date/time")
        parsed = _try_parse_iso(end_raw)
        if parsed is None:
            raise ValueError("MONEY endDate must be an ISO date/time")
        end = parsed
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", end_raw):
            end += timedelta(days=1) - timedelta(microseconds=1)
    if start > end:
        raise ValueError("MONEY startDate must not be after endDate")
    return start, end, days


def _money_filtered_transactions(
    world: LifeWorld,
    kw: dict[str, Any],
    *,
    default_days: int,
) -> tuple[list[Any], int]:
    start, end, days = _money_bounds(world, kw, default_days=default_days)
    category_raw = kw.get("category")
    if category_raw is not None and not isinstance(category_raw, str):
        raise ValueError("MONEY category must be a string")
    category = (category_raw or "").strip().casefold()
    merchant_raw = kw.get("merchantContains", kw.get("merchant"))
    if merchant_raw is not None and not isinstance(merchant_raw, str):
        raise ValueError("MONEY merchantContains must be a string")
    merchant = (merchant_raw or "").strip().casefold()
    only_debits_raw = kw.get("onlyDebits", kw.get("only_debits", False))
    if not isinstance(only_debits_raw, bool):
        raise ValueError("MONEY onlyDebits must be boolean")

    filtered = []
    for transaction in world.transactions.values():
        posted = _try_parse_iso(transaction.posted_at)
        if posted is None:
            raise ValueError(
                f"LifeWorld transaction {transaction.id} has invalid posted_at"
            )
        if posted < start or posted > end:
            continue
        if category and transaction.category.casefold() != category:
            continue
        if merchant and merchant not in transaction.merchant.casefold():
            continue
        if only_debits_raw and transaction.amount_cents >= 0:
            continue
        filtered.append(transaction)
    filtered.sort(key=lambda item: (item.posted_at, item.id), reverse=True)
    return filtered, days


def _money_transaction_projection(transaction: Any) -> dict[str, Any]:
    return {
        "id": transaction.id,
        "accountId": transaction.account_id,
        "merchant": transaction.merchant,
        "category": transaction.category,
        "description": transaction.description,
        "amountCents": transaction.amount_cents,
        "currency": transaction.currency,
        "postedAt": transaction.posted_at,
        "isPending": transaction.is_pending,
    }


def _money_grouped_spending(
    transactions: list[Any],
    *,
    group_by: str,
) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], int] = {}
    for transaction in transactions:
        key_value = {
            "account": transaction.account_id,
            "category": transaction.category,
            "merchant": transaction.merchant,
        }[group_by]
        key = (key_value, transaction.currency)
        grouped[key] = grouped.get(key, 0) + transaction.amount_cents
    return [
        {
            "key": key,
            "currency": currency,
            "netCents": amount,
            "spendingCents": max(0, -amount),
        }
        for (key, currency), amount in sorted(grouped.items())
    ]


def _subscription_slug(name: str) -> str:
    normalized = name.casefold().replace("+", " plus ")
    return re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")


def _find_subscription(world: LifeWorld, kw: dict[str, Any]) -> Any:
    subscription_id = kw.get("subscriptionId") or kw.get("subscription_id")
    if subscription_id is not None:
        if not isinstance(subscription_id, str) or not subscription_id:
            raise ValueError("MONEY subscriptionId must be a non-empty string")
        subscription = world.subscriptions.get(subscription_id)
        if subscription is None:
            raise KeyError(f"MONEY subscription not found: {subscription_id}")
        return subscription
    service_name = kw.get("serviceName")
    service_slug = kw.get("serviceSlug")
    if service_name is not None and (
        not isinstance(service_name, str) or not service_name.strip()
    ):
        raise ValueError("MONEY serviceName must be a non-empty string")
    if service_slug is not None and (
        not isinstance(service_slug, str) or not service_slug.strip()
    ):
        raise ValueError("MONEY serviceSlug must be a non-empty string")
    if service_name is None and service_slug is None:
        raise KeyError(
            "MONEY subscription operation requires serviceName or serviceSlug"
        )
    matches = [
        subscription
        for subscription in world.subscriptions.values()
        if (
            isinstance(service_name, str)
            and subscription.name.casefold() == service_name.strip().casefold()
        )
        or (
            isinstance(service_slug, str)
            and _subscription_slug(subscription.name) == service_slug.strip().casefold()
        )
    ]
    if not matches:
        raise KeyError(
            f"MONEY subscription not found for serviceName={service_name!r}, "
            f"serviceSlug={service_slug!r}"
        )
    if len(matches) > 1:
        raise ValueError("MONEY subscription reference is ambiguous")
    return matches[0]


def _subscription_projection(
    subscription: Any,
    *,
    transactions: list[Any],
) -> dict[str, Any]:
    observed = [
        transaction
        for transaction in transactions
        if transaction.merchant.casefold() == subscription.name.casefold()
    ]
    observed.sort(key=lambda item: (item.posted_at, item.id), reverse=True)
    categories = sorted({item.category for item in observed})
    return {
        "id": subscription.id,
        "name": subscription.name,
        "slug": _subscription_slug(subscription.name),
        "monthlyCents": subscription.monthly_cents,
        "billingDay": subscription.billing_day,
        "nextChargeAt": subscription.next_charge_at,
        "status": subscription.status,
        "observedChargeCount": len(observed),
        "lastObservedChargeAt": observed[0].posted_at if observed else None,
        "categories": categories,
    }


def _u_money_readonly(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """Return typed account, transaction, spending, and subscription projections."""
    raw_subaction = kw.get("subaction", "dashboard")
    aliases = {"status": "subscription_status", "audit": "subscription_audit"}
    subaction = aliases.get(raw_subaction, raw_subaction)
    if subaction not in {
        "dashboard",
        "list_sources",
        "list_transactions",
        "recurring_charges",
        "spending_summary",
        "subscription_status",
    }:
        raise UnsupportedAction(
            f"unsupported action in execute path: MONEY/{subaction}"
        )

    if subaction == "list_sources":
        accounts = [
            {
                "id": account.id,
                "institution": account.institution,
                "accountType": account.account_type,
                "balanceCents": account.balance_cents,
                "currency": account.currency,
                "last4": account.last4,
            }
            for account in sorted(world.accounts.values(), key=lambda item: item.id)
        ]
        return {
            "ok": True,
            "effect": "none",
            "subaction": subaction,
            "accounts": accounts,
            "count": len(accounts),
        }

    if subaction == "subscription_status":
        subscription = _find_subscription(world, kw)
        transactions, days = _money_filtered_transactions(
            world,
            {"windowDays": kw.get("windowDays", 3650)},
            default_days=3650,
        )
        return {
            "ok": True,
            "effect": "none",
            "subaction": subaction,
            "windowDays": days,
            "subscription": _subscription_projection(
                subscription,
                transactions=transactions,
            ),
        }

    transactions, days = _money_filtered_transactions(
        world,
        kw,
        default_days=30 if subaction != "recurring_charges" else 180,
    )
    if subaction == "list_transactions":
        return {
            "ok": True,
            "effect": "none",
            "subaction": subaction,
            "windowDays": days,
            "transactions": [
                _money_transaction_projection(transaction)
                for transaction in transactions
            ],
            "count": len(transactions),
        }

    if subaction == "recurring_charges":
        subscriptions = [
            _subscription_projection(subscription, transactions=transactions)
            for subscription in sorted(
                world.subscriptions.values(),
                key=lambda item: item.id,
            )
            if subscription.status != "cancelled"
        ]
        return {
            "ok": True,
            "effect": "none",
            "subaction": subaction,
            "windowDays": days,
            "subscriptions": subscriptions,
            "count": len(subscriptions),
        }

    group_by_raw = kw.get("groupBy", "category")
    if group_by_raw not in {"account", "category", "merchant"}:
        raise ValueError("MONEY groupBy must be one of account, category, or merchant")
    groups = _money_grouped_spending(transactions, group_by=group_by_raw)
    totals_by_currency: dict[str, dict[str, int]] = {}
    for transaction in transactions:
        totals = totals_by_currency.setdefault(
            transaction.currency,
            {"incomeCents": 0, "spendingCents": 0, "netCents": 0},
        )
        totals["netCents"] += transaction.amount_cents
        if transaction.amount_cents < 0:
            totals["spendingCents"] += -transaction.amount_cents
        else:
            totals["incomeCents"] += transaction.amount_cents

    result: dict[str, Any] = {
        "ok": True,
        "effect": "none",
        "subaction": subaction,
        "windowDays": days,
        "transactionCount": len(transactions),
        "totalsByCurrency": totals_by_currency,
        "groupBy": group_by_raw,
        "groups": groups,
    }
    if subaction == "dashboard":
        balances: dict[str, int] = {}
        for account in world.accounts.values():
            balances[account.currency] = (
                balances.get(account.currency, 0) + account.balance_cents
            )
        result["accountCount"] = len(world.accounts)
        result["balancesByCurrency"] = balances
        result["pendingTransactionCount"] = sum(
            transaction.is_pending for transaction in transactions
        )
    return result


def _u_money_subscription_audit(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """Compare subscription records with observed charges in a bounded window."""
    days = _money_window_days(kw.get("queryWindowDays"), default=365)
    transactions, _ = _money_filtered_transactions(
        world,
        {"windowDays": days},
        default_days=days,
    )
    category_raw = kw.get("category")
    if category_raw is not None and (
        not isinstance(category_raw, str) or not category_raw.strip()
    ):
        raise ValueError("MONEY subscription audit category must be a non-empty string")
    category = (
        category_raw.strip().casefold() if isinstance(category_raw, str) else None
    )
    projections = [
        _subscription_projection(subscription, transactions=transactions)
        for subscription in sorted(
            world.subscriptions.values(), key=lambda item: item.id
        )
    ]
    if category is not None:
        projections = [
            item
            for item in projections
            if category in {value.casefold() for value in item["categories"]}
        ]
    active = [item for item in projections if item["status"] == "active"]
    return {
        "ok": True,
        "effect": "none",
        "subaction": "subscription_audit",
        "windowDays": days,
        "category": category,
        "subscriptions": projections,
        "activeCount": len(active),
        "monthlyActiveCents": sum(item["monthlyCents"] for item in active),
    }


def _u_money_subscription_cancel(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """Cancel a subscription. Resolves by serviceSlug first, then serviceName."""
    confirmed = kw.get("confirmed", False)
    if not isinstance(confirmed, bool):
        raise ValueError("MONEY_SUBSCRIPTION_CANCEL confirmed must be boolean")
    if not confirmed:
        return {
            "subaction": "cancel",
            "ok": False,
            "status": "confirmation_required",
            "noEffect": True,
            "reason": "unconfirmed",
        }
    subscription = _find_subscription(world, kw)
    if subscription.status == "cancelled":
        return {
            "id": subscription.id,
            "status": subscription.status,
            "replayed": True,
        }
    cancelled = world.cancel_subscription(subscription.id)
    return {"id": cancelled.id, "status": cancelled.status, "replayed": False}


_FOCUS_SUBACTION_BY_NAME = {
    "BLOCK_BLOCK": "block",
    "BLOCK_UNBLOCK": "unblock",
    "BLOCK_LIST_ACTIVE": "list_active",
    "BLOCK_RELEASE": "release",
    "BLOCK_STATUS": "status",
    "BLOCK_REQUEST_PERMISSION": "request_permission",
}
_FOCUS_HOSTNAME_RE = re.compile(
    r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",
    flags=re.IGNORECASE,
)
_FOCUS_PACKAGE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}")
_DATE_ONLY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _focus_subaction(kw: dict[str, Any], name: str) -> str:
    raw = kw.get("subaction") or kw.get("action") or _FOCUS_SUBACTION_BY_NAME.get(name)
    if raw is None and name == "BLOCK":
        raw = "block"
    if raw not in {
        "block",
        "unblock",
        "list_active",
        "release",
        "status",
        "request_permission",
    }:
        raise UnsupportedAction(f"unsupported action in execute path: BLOCK/{raw}")
    return cast(str, raw)


def _focus_targets(kw: dict[str, Any]) -> tuple[list[str], list[str]]:
    raw_hostnames = [
        *_string_list(kw.get("hostnames")),
        *_string_list(kw.get("hostname")),
        *_string_list(kw.get("websites")),
    ]
    raw_packages = [
        *_string_list(kw.get("packageNames")),
        *_string_list(kw.get("package_names")),
        *_string_list(kw.get("apps")),
        *_string_list(kw.get("bundle_ids")),
        *_string_list(kw.get("bundle_id")),
        *_string_list(kw.get("app_name")),
        *_string_list(kw.get("identifier")),
    ]
    hostnames = sorted({item.casefold().rstrip(".") for item in raw_hostnames})
    package_names = sorted(set(raw_packages))
    invalid_hosts = [
        hostname
        for hostname in hostnames
        if _FOCUS_HOSTNAME_RE.fullmatch(hostname) is None
    ]
    invalid_packages = [
        package_name
        for package_name in package_names
        if _FOCUS_PACKAGE_RE.fullmatch(package_name) is None
    ]
    if invalid_hosts:
        raise ValueError(f"BLOCK has invalid hostnames: {invalid_hosts}")
    if invalid_packages:
        raise ValueError(f"BLOCK has invalid package names: {invalid_packages}")
    return hostnames, package_names


def _focus_schedule(
    kw: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    raw_schedule = kw.get("schedule")
    if raw_schedule is not None and not isinstance(raw_schedule, dict):
        raise ValueError("BLOCK schedule must be an object")
    schedule = deepcopy(raw_schedule) if isinstance(raw_schedule, dict) else None
    if schedule is not None:
        weekdays = schedule.get("weekdays")
        if not isinstance(weekdays, list) or not weekdays:
            raise ValueError("BLOCK schedule.weekdays must be a non-empty list")
        if any(
            isinstance(day, bool) or not isinstance(day, int) or not 1 <= day <= 7
            for day in weekdays
        ):
            raise ValueError(
                "BLOCK schedule weekdays must be integers from 1 through 7"
            )
        for field in ("start", "end"):
            value = schedule.get(field)
            if (
                not isinstance(value, str)
                or re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value) is None
            ):
                raise ValueError(f"BLOCK schedule.{field} must be HH:MM")
        schedule["weekdays"] = sorted(set(weekdays))

    raw_exceptions = kw.get("exceptions", [])
    if not isinstance(raw_exceptions, list) or any(
        not isinstance(item, dict) for item in raw_exceptions
    ):
        raise ValueError("BLOCK exceptions must be a list of objects")
    return schedule, [deepcopy(item) for item in raw_exceptions]


def _focus_effective_status(block: FocusBlock, now_iso: str) -> str:
    if block.status != "active" or block.expires_at is None:
        return block.status
    expires_at = _try_parse_iso(block.expires_at)
    now = _try_parse_iso(now_iso)
    if expires_at is None or now is None:
        raise ValueError(f"focus block {block.id} has an invalid timestamp")
    return "expired" if expires_at <= now else "active"


def _focus_block_projection(block: FocusBlock, now_iso: str) -> dict[str, Any]:
    return {
        "id": block.id,
        "hostnames": list(block.hostnames),
        "packageNames": list(block.package_names),
        "status": block.status,
        "effectiveStatus": _focus_effective_status(block, now_iso),
        "mode": block.mode,
        "durationMinutes": block.duration_minutes,
        "schedule": deepcopy(block.schedule),
        "exceptions": deepcopy(block.exceptions),
        "policy": block.policy,
        "permissionRequestId": block.permission_request_id,
        "createdAt": block.created_at,
        "updatedAt": block.updated_at,
        "expiresAt": block.expires_at,
        "releasedAt": block.released_at,
        "releaseReason": block.release_reason,
    }


def _u_block(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """Apply the BLOCK family against typed focus rules and approval requests."""
    subaction = _focus_subaction(kw, name)
    operation = f"BLOCK/{subaction}"

    if subaction == "list_active":
        include_scheduled = kw.get("includeScheduled") is True
        blocks = [
            block
            for block in world.focus_blocks.values()
            if _focus_effective_status(block, world.now_iso) == "active"
            or (include_scheduled and block.status == "scheduled")
        ]
        blocks.sort(key=lambda item: item.id)
        return {
            "ok": True,
            "effect": "none",
            "operation": operation,
            "count": len(blocks),
            "blocks": [
                _focus_block_projection(block, world.now_iso) for block in blocks
            ],
        }

    if subaction == "status":
        rule_id = kw.get("ruleId") or kw.get("rule_id") or kw.get("id")
        if rule_id is not None and (
            not isinstance(rule_id, str) or not rule_id.strip()
        ):
            raise ValueError("BLOCK/status ruleId must be a non-empty string")
        if isinstance(rule_id, str):
            block = world.focus_blocks.get(rule_id)
            return {
                "ok": True,
                "effect": "none",
                "operation": operation,
                "found": block is not None,
                "block": (
                    _focus_block_projection(block, world.now_iso)
                    if block is not None
                    else None
                ),
            }
        scope = kw.get("scope")
        if scope not in {None, "active_focus"}:
            raise ValueError(f"BLOCK/status has unsupported scope: {scope!r}")
        blocks = sorted(world.focus_blocks.values(), key=lambda item: item.id)
        return {
            "ok": True,
            "effect": "none",
            "operation": operation,
            "scope": scope or "all",
            "blocks": [
                _focus_block_projection(block, world.now_iso) for block in blocks
            ],
        }

    hostnames, package_names = _focus_targets(kw)
    if subaction in {"block", "request_permission"} and not (
        hostnames or package_names
    ):
        raise ValueError(f"BLOCK/{subaction} requires hostnames or packageNames")

    mode_raw = kw.get("mode")
    if mode_raw is not None and (not isinstance(mode_raw, str) or not mode_raw.strip()):
        raise ValueError("BLOCK mode must be a non-empty string")
    mode = mode_raw.strip() if isinstance(mode_raw, str) else None

    if subaction == "request_permission":
        reason_raw = kw.get("reason") or kw.get("intent")
        if not isinstance(reason_raw, str) or not reason_raw.strip():
            raise ValueError("BLOCK/request_permission requires a reason")
        reason = reason_raw.strip()
        confirmation_required = kw.get("confirmationRequired", True)
        no_bypass = kw.get("noBypass", False)
        if not isinstance(confirmation_required, bool) or not isinstance(
            no_bypass, bool
        ):
            raise ValueError(
                "BLOCK permission flags confirmationRequired/noBypass must be booleans"
            )
        request_id_raw = kw.get("requestId") or kw.get("request_id")
        if request_id_raw is not None and (
            not isinstance(request_id_raw, str) or not request_id_raw.strip()
        ):
            raise ValueError("BLOCK requestId must be a non-empty string")
        request_id = (
            request_id_raw.strip()
            if isinstance(request_id_raw, str)
            else _synthetic_id(
                "focus_permission",
                {
                    "hostnames": hostnames,
                    "packageNames": package_names,
                    "reason": reason,
                    "mode": mode,
                    "confirmationRequired": confirmation_required,
                    "noBypass": no_bypass,
                },
            )
        )
        request, replayed = world.create_focus_permission_request(
            request_id=request_id,
            hostnames=hostnames,
            package_names=package_names,
            reason=reason,
            confirmation_required=confirmation_required,
            no_bypass=no_bypass,
            mode=mode,
        )
        return {
            "ok": True,
            "effect": "none" if replayed else "applied",
            "operation": operation,
            "replayed": replayed,
            "request": {
                "id": request.id,
                "status": request.status,
                "hostnames": list(request.hostnames),
                "packageNames": list(request.package_names),
                "reason": request.reason,
                "mode": request.mode,
                "confirmationRequired": request.confirmation_required,
                "noBypass": request.no_bypass,
                "createdAt": request.created_at,
            },
        }

    if subaction == "block":
        if kw.get("confirmed") is False:
            raise PermissionError("BLOCK/block requires confirmation")
        duration_raw = kw.get("durationMinutes")
        if duration_raw is not None and (
            isinstance(duration_raw, bool)
            or not isinstance(duration_raw, int)
            or duration_raw <= 0
        ):
            raise ValueError("BLOCK durationMinutes must be a positive integer")
        duration_minutes = cast(int | None, duration_raw)
        schedule, exceptions = _focus_schedule(kw)
        policy_raw = kw.get("policy")
        if policy_raw is not None and (
            not isinstance(policy_raw, str) or not policy_raw.strip()
        ):
            raise ValueError("BLOCK policy must be a non-empty string")
        policy = policy_raw.strip() if isinstance(policy_raw, str) else None
        matching_permission = next(
            (
                request
                for request in sorted(
                    world.focus_permission_requests.values(),
                    key=lambda item: item.id,
                )
                if request.hostnames == hostnames
                and request.package_names == package_names
                and request.mode == mode
                and request.status in {"pending", "approved"}
            ),
            None,
        )
        if (mode == "harsh" or kw.get("noBypass") is True) and (
            matching_permission is None or kw.get("confirmed") is not True
        ):
            raise PermissionError(
                "BLOCK harsh/no-bypass rules require a matching permission request "
                "and confirmed=True"
            )
        block_id_raw = kw.get("ruleId") or kw.get("rule_id") or kw.get("id")
        if block_id_raw is not None and (
            not isinstance(block_id_raw, str) or not block_id_raw.strip()
        ):
            raise ValueError("BLOCK ruleId must be a non-empty string")
        identity = {
            "hostnames": hostnames,
            "packageNames": package_names,
            "mode": mode,
            "durationMinutes": duration_minutes,
            "schedule": schedule,
            "exceptions": exceptions,
            "policy": policy,
            "permissionRequestId": (
                matching_permission.id if matching_permission is not None else None
            ),
        }
        block_id = (
            block_id_raw.strip()
            if isinstance(block_id_raw, str)
            else _synthetic_id("focus_rule", identity)
        )
        block, replayed = world.create_focus_block(
            block_id=block_id,
            hostnames=hostnames,
            package_names=package_names,
            status="scheduled" if schedule is not None else "active",
            mode=mode,
            duration_minutes=duration_minutes,
            schedule=schedule,
            exceptions=exceptions,
            policy=policy,
            permission_request_id=(
                matching_permission.id if matching_permission is not None else None
            ),
            expires_at=(
                _shift_iso(world.now_iso, minutes=duration_minutes)
                if duration_minutes is not None
                else None
            ),
        )
        if matching_permission is not None and matching_permission.status == "pending":
            world.update(
                EntityKind.FOCUS_PERMISSION_REQUEST,
                matching_permission.id,
                status="approved",
                updated_at=world.now_iso,
            )
        return {
            "ok": True,
            "effect": "none" if replayed else "applied",
            "operation": operation,
            "replayed": replayed,
            "block": _focus_block_projection(block, world.now_iso),
        }

    if kw.get("confirmed") is not True:
        raise PermissionError(f"BLOCK/{subaction} requires confirmed=True")
    rule_id = kw.get("ruleId") or kw.get("rule_id") or kw.get("id")
    if rule_id is not None and (not isinstance(rule_id, str) or not rule_id.strip()):
        raise ValueError(f"BLOCK/{subaction} ruleId must be a non-empty string")
    if isinstance(rule_id, str) and (hostnames or package_names):
        raise ValueError(
            f"BLOCK/{subaction} accepts either ruleId or explicit targets, not both"
        )
    if isinstance(rule_id, str):
        matching_ids = [rule_id]
    elif hostnames or package_names:
        matching_ids = sorted(
            block.id
            for block in world.focus_blocks.values()
            if set(block.hostnames).intersection(hostnames)
            or set(block.package_names).intersection(package_names)
        )
    else:
        matching_ids = sorted(
            block.id
            for block in world.focus_blocks.values()
            if block.status in {"active", "scheduled"}
        )
    if not matching_ids:
        raise KeyError(f"BLOCK/{subaction} matched no focus rules")
    reason_raw = kw.get("reason") or kw.get("intent") or subaction
    if not isinstance(reason_raw, str) or not reason_raw.strip():
        raise ValueError(f"BLOCK/{subaction} reason must be a non-empty string")
    released, replayed = world.release_focus_blocks(
        matching_ids,
        reason=reason_raw.strip(),
    )
    return {
        "ok": True,
        "effect": "applied" if released else "none",
        "operation": operation,
        "replayed": not released and bool(replayed),
        "released": [
            _focus_block_projection(block, world.now_iso) for block in released
        ],
        "alreadyReleased": [
            _focus_block_projection(block, world.now_iso) for block in replayed
        ],
    }


def _travel_code(value: Any, *, field: str, required: bool) -> str | None:
    if value is None or value == "":
        if required:
            raise KeyError(f"BOOK_TRAVEL requires {field}")
        return None
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[A-Za-z]{3}", value.strip()) is None
    ):
        raise ValueError(f"BOOK_TRAVEL {field} must be a three-letter location code")
    return value.strip().upper()


def _travel_date_window(
    value: Any,
    *,
    field: str,
    required: bool,
) -> tuple[date, date] | None:
    if value is None or value == "":
        if required:
            raise KeyError(f"BOOK_TRAVEL requires {field}")
        return None
    if not isinstance(value, str):
        raise ValueError(f"BOOK_TRAVEL {field} must be an ISO date or date range")
    parts = value.strip().split("/")
    if len(parts) not in {1, 2} or any(
        _DATE_ONLY_RE.fullmatch(part) is None for part in parts
    ):
        raise ValueError(f"BOOK_TRAVEL {field} must be YYYY-MM-DD[/YYYY-MM-DD]")
    try:
        parsed = [date.fromisoformat(part) for part in parts]
    except ValueError as exc:
        raise ValueError(f"BOOK_TRAVEL {field} contains an invalid date") from exc
    start, end = parsed[0], parsed[-1]
    if start > end:
        raise ValueError(f"BOOK_TRAVEL {field} range starts after it ends")
    return start, end


def _travel_date_matches(value: str | None, window: tuple[date, date] | None) -> bool:
    if window is None:
        return True
    if value is None or _DATE_ONLY_RE.fullmatch(value) is None:
        return False
    parsed = date.fromisoformat(value)
    return window[0] <= parsed <= window[1]


def _travel_offer_projection(offer: TravelOffer) -> dict[str, Any]:
    return {
        "id": offer.id,
        "kind": offer.kind,
        "provider": offer.provider,
        "origin": offer.origin,
        "destination": offer.destination,
        "departureDate": offer.departure_date,
        "returnDate": offer.return_date,
        "hotelCheckIn": offer.hotel_check_in,
        "priceCents": offer.price_cents,
        "currency": offer.currency,
        "metadata": deepcopy(offer.metadata),
    }


def _travel_passenger_count(value: Any) -> int:
    if value is None:
        return 1
    if isinstance(value, bool):
        raise ValueError("BOOK_TRAVEL passengers must be a positive count or list")
    if isinstance(value, int):
        if value <= 0:
            raise ValueError("BOOK_TRAVEL passengers must be positive")
        return value
    if isinstance(value, list):
        if not value or any(not isinstance(item, dict) for item in value):
            raise ValueError("BOOK_TRAVEL passengers must be a non-empty object list")
        return len(value)
    raise ValueError("BOOK_TRAVEL passengers must be a positive count or list")


def _u_book_travel(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """Project provider offers and persist approval-gated holds without booking."""
    subaction = kw.get("subaction") or kw.get("action") or "search"
    if subaction not in {"search", "prepare", "hold", "book", "cancel"}:
        raise UnsupportedAction(
            f"unsupported action in execute path: BOOK_TRAVEL/{subaction}"
        )
    if subaction in {"book", "cancel"}:
        raise UnsupportedAction(
            f"BOOK_TRAVEL/{subaction} crosses the external booking boundary; "
            "LifeWorld supports offer search and pre-booking holds only"
        )
    hotel_check_in_raw = kw.get("hotelCheckIn") or kw.get("hotel_check_in")
    kind = "hotel" if hotel_check_in_raw is not None else "flight"
    destination = _travel_code(
        kw.get("destination"),
        field="destination",
        required=True,
    )
    origin = _travel_code(
        kw.get("origin"),
        field="origin",
        required=kind == "flight",
    )
    departure_window = _travel_date_window(
        kw.get("departureDate") or kw.get("departure_date"),
        field="departureDate",
        required=kind == "flight",
    )
    return_window = _travel_date_window(
        kw.get("returnDate") or kw.get("return_date"),
        field="returnDate",
        required=False,
    )
    hotel_window = _travel_date_window(
        hotel_check_in_raw,
        field="hotelCheckIn",
        required=kind == "hotel",
    )
    if destination is None:
        raise KeyError("BOOK_TRAVEL requires destination")

    offers = [
        offer
        for offer in world.travel_offers.values()
        if offer.kind == kind
        and offer.destination == destination
        and (origin is None or offer.origin == origin)
        and _travel_date_matches(offer.departure_date, departure_window)
        and _travel_date_matches(offer.return_date, return_window)
        and _travel_date_matches(offer.hotel_check_in, hotel_window)
    ]
    offers.sort(key=lambda offer: (offer.price_cents, offer.id))

    requested_offer_id = kw.get("offerId") or kw.get("offer_id")
    if requested_offer_id is not None and (
        not isinstance(requested_offer_id, str) or not requested_offer_id.strip()
    ):
        raise ValueError("BOOK_TRAVEL offerId must be a non-empty string")
    if isinstance(requested_offer_id, str):
        offers = [offer for offer in offers if offer.id == requested_offer_id.strip()]

    operation = f"BOOK_TRAVEL/{subaction}"
    if subaction in {"search", "prepare"}:
        return {
            "ok": True,
            "effect": "none",
            "operation": operation,
            "query": {
                "kind": kind,
                "origin": origin,
                "destination": destination,
                "departureDate": (kw.get("departureDate") or kw.get("departure_date")),
                "returnDate": kw.get("returnDate") or kw.get("return_date"),
                "hotelCheckIn": hotel_check_in_raw,
            },
            "count": len(offers),
            "offers": [_travel_offer_projection(offer) for offer in offers],
        }

    if not offers:
        raise LookupError("BOOK_TRAVEL/hold matched no available offer")
    approval_raw = kw.get("approval", {})
    if approval_raw is None:
        approval_raw = {}
    if not isinstance(approval_raw, dict):
        raise ValueError("BOOK_TRAVEL approval must be an object")
    approval_required = approval_raw.get("required", True)
    if not isinstance(approval_required, bool):
        raise ValueError("BOOK_TRAVEL approval.required must be a boolean")
    approval_queue = approval_raw.get("queue")
    if approval_queue is not None and (
        not isinstance(approval_queue, str) or not approval_queue.strip()
    ):
        raise ValueError("BOOK_TRAVEL approval.queue must be a non-empty string")
    passengers = _travel_passenger_count(kw.get("passengers"))
    selected = offers[0]
    hold_id_raw = kw.get("holdId") or kw.get("hold_id")
    if hold_id_raw is not None and (
        not isinstance(hold_id_raw, str) or not hold_id_raw.strip()
    ):
        raise ValueError("BOOK_TRAVEL holdId must be a non-empty string")
    hold_id = (
        hold_id_raw.strip()
        if isinstance(hold_id_raw, str)
        else _synthetic_id(
            "travel_hold",
            {
                "offerId": selected.id,
                "passengers": passengers,
                "approvalRequired": approval_required,
                "approvalQueue": approval_queue,
            },
        )
    )
    hold, replayed = world.create_travel_hold(
        hold_id=hold_id,
        offer=selected,
        passengers=passengers,
        approval_required=approval_required,
        approval_queue=(
            approval_queue.strip() if isinstance(approval_queue, str) else None
        ),
    )
    return {
        "ok": True,
        "effect": "none" if replayed else "applied",
        "operation": operation,
        "replayed": replayed,
        "hold": {
            "id": hold.id,
            "offerId": hold.offer_id,
            "kind": hold.kind,
            "origin": hold.origin,
            "destination": hold.destination,
            "departureDate": hold.departure_date,
            "returnDate": hold.return_date,
            "hotelCheckIn": hold.hotel_check_in,
            "passengers": hold.passengers,
            "status": hold.status,
            "approvalRequired": hold.approval_required,
            "approvalQueue": hold.approval_queue,
            "createdAt": hold.created_at,
        },
    }


def _u_scheduled_task_create(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """SCHEDULED_TASK_CREATE — model the production task primitive directly."""
    trigger = _scheduled_task_trigger(kw)
    prompt = str(
        kw.get("promptInstructions")
        or kw.get("prompt_instructions")
        or kw.get("instructions")
        or kw.get("title")
        or "Scheduled task"
    )
    task_id = _scheduled_task_id(kw) or scheduled_task_create_receipt_id(kw)
    if task_id in world.scheduled_tasks:
        task = world.scheduled_tasks[task_id]
        return {"id": task.id, "kind": task.kind, "idempotent": True}
    task = world.create_scheduled_task(
        task_id=task_id,
        kind=str(kw.get("kind") or "reminder"),
        prompt_instructions=prompt,
        trigger=trigger,
        **_scheduled_task_patches(kw, include_identity=False),
    )
    return {"id": task.id, "kind": task.kind, "state": task.state}


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def _shift_iso(iso: str, *, minutes: int) -> str:
    """Add `minutes` to an ISO8601 string and return ISO8601 with Z."""
    s = iso.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    shifted = dt + timedelta(minutes=minutes)
    out = shifted.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return f"{out}Z"


def _try_parse_iso(value: str) -> datetime | None:
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _primary_calendar_id(world: LifeWorld) -> str | None:
    primary = next((cal for cal in world.calendars.values() if cal.is_primary), None)
    if primary is not None:
        return primary.id
    first = next(iter(world.calendars.values()), None)
    return first.id if first is not None else None


def _resolve_calendar_id(world: LifeWorld, value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        raw = value.strip()
        if raw in world.calendars:
            return raw
        lowered = raw.lower()
        if lowered in {"primary", "main", "default"}:
            return _primary_calendar_id(world)
        for calendar in world.calendars.values():
            if calendar.name.lower() == lowered:
                return calendar.id
            if _calendar_hint_matches(calendar.id, raw):
                return calendar.id
    return None


def _duration_minutes(
    kw: dict[str, Any], details: dict[str, Any], fallback: int
) -> int:
    raw = (
        details.get("duration_minutes")
        or kw.get("duration_minutes")
        or details.get("durationMinutes")
        or kw.get("durationMinutes")
        or kw.get("duration")
        or details.get("duration")
    )
    if isinstance(raw, (int, float)):
        return max(1, int(raw))
    if isinstance(raw, str):
        match = re.fullmatch(
            r"\s*(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours)?\s*", raw
        )
        if match:
            value = int(match.group(1))
            unit = match.group(2) or "minutes"
            return max(1, value * 60 if unit.startswith("h") else value)
    hours = details.get("duration_hours") or kw.get("duration_hours")
    if isinstance(hours, (int, float)):
        return max(1, int(hours * 60))
    return fallback


def _calendar_event_duration_minutes(event: Any, fallback: int) -> int:
    start = _try_parse_iso(str(getattr(event, "start", "")))
    end = _try_parse_iso(str(getattr(event, "end", "")))
    if start is None or end is None:
        return fallback
    minutes = int((end - start).total_seconds() // 60)
    return max(1, minutes)


def _find_calendar_event(
    world: LifeWorld,
    *,
    event_id: Any = None,
    title: Any = None,
    date_hint: Any = None,
    calendar_hint: Any = None,
) -> Any:
    if isinstance(event_id, str) and event_id in world.calendar_events:
        return world.calendar_events[event_id]
    if isinstance(title, str) and title.strip():
        wanted = title.strip().lower()
        active_events = [
            event
            for event in world.calendar_events.values()
            if event.status != "cancelled"
            and _calendar_hint_matches(event.calendar_id, calendar_hint)
        ]
        matches = [
            event for event in active_events if event.title.strip().lower() == wanted
        ]
        if not matches:
            matches = [
                event
                for event in active_events
                if wanted in event.title.strip().lower()
                or event.title.strip().lower() in wanted
            ]
        if not matches:
            wanted_tokens = _meaningful_title_tokens(wanted)
            matches = [
                event
                for event in active_events
                if wanted_tokens
                and (
                    wanted_tokens.issubset(_meaningful_title_tokens(event.title))
                    or _meaningful_title_tokens(event.title).issubset(wanted_tokens)
                )
            ]
        if matches:
            hint = _parse_calendar_datetime_hint(date_hint, world.now_iso)
            if hint is None:
                hint = _try_parse_iso(world.now_iso)
            hint_date = hint.date() if hint is not None else None

            def rank(event: Any) -> tuple[int, float, int, str]:
                event_start = _try_parse_iso(str(event.start))
                same_day = (
                    0
                    if hint_date is not None
                    and event_start is not None
                    and event_start.date() == hint_date
                    else 1
                )
                distance = (
                    abs((event_start - hint).total_seconds())
                    if event_start is not None and hint is not None
                    else float("inf")
                )
                primary = 0 if event.calendar_id == "cal_primary" else 1
                return (same_day, distance, primary, event.id)

            return sorted(matches, key=rank)[0]
    return None


def _meaningful_title_tokens(value: Any) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", str(value).lower())
        if token not in {"a", "an", "and", "for", "of", "on", "the", "to"}
    }


def _calendar_hint_matches(calendar_id: str, hint: Any) -> bool:
    if not isinstance(hint, str) or not hint.strip():
        return True
    wanted = hint.strip().lower()
    if wanted == calendar_id.lower():
        return True
    normalized = re.sub(r"[^a-z0-9]+", "", wanted)
    calendar_normalized = re.sub(r"[^a-z0-9]+", "", calendar_id.lower())
    return normalized == calendar_normalized or calendar_normalized.endswith(normalized)


def _parse_calendar_datetime_hint(value: Any, now_iso: str) -> datetime | None:
    if isinstance(value, str):
        parsed = _try_parse_iso(value)
        if parsed is not None:
            return parsed
    parsed_date = _parse_calendar_date_hint(value, now_iso)
    if parsed_date is None:
        return None
    return datetime(
        parsed_date.year, parsed_date.month, parsed_date.day, tzinfo=timezone.utc
    )


def _parse_calendar_date_hint(value: Any, now_iso: str) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip().lower()
    parsed = _try_parse_iso(raw)
    if parsed is not None:
        return parsed.date()
    now = _try_parse_iso(now_iso)
    if now is None:
        return None
    if raw == "today":
        return now.date()
    if raw == "tomorrow":
        return (now + timedelta(days=1)).date()
    weekdays = {
        "monday": 0,
        "tuesday": 1,
        "wednesday": 2,
        "thursday": 3,
        "friday": 4,
        "saturday": 5,
        "sunday": 6,
    }
    match = re.search(
        r"\b(?P<modifier>this|next)?\s*"
        r"(?P<day>monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
        raw,
    )
    if match is None:
        return None
    target = weekdays[match.group("day")]
    delta = (target - now.weekday()) % 7
    if delta == 0:
        delta = 7
    if match.group("modifier") == "next":
        delta += 7
    return (now + timedelta(days=delta)).date()


def _search_calendar_events(
    world: LifeWorld,
    kw: dict[str, Any],
    details: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    details = details or {}
    query_raw = (
        kw.get("query")
        or details.get("query")
        or kw.get("title")
        or details.get("title")
        or kw.get("event_name")
        or details.get("event_name")
        or ""
    )
    query = str(query_raw).strip().lower()
    date_raw = (
        kw.get("date") or details.get("date") or kw.get("when") or details.get("when")
    )
    parsed_date = _parse_calendar_date_hint(date_raw, world.now_iso)
    date_filter = parsed_date.isoformat() if parsed_date is not None else None
    calendar_hint = (
        kw.get("calendarId")
        or details.get("calendarId")
        or kw.get("calendar_id")
        or details.get("calendar_id")
        or kw.get("calendar")
        or details.get("calendar")
    )

    time_range = kw.get("time_range") or details.get("time_range") or {}
    if not isinstance(time_range, dict):
        time_range = {}
    start = (
        kw.get("start")
        or details.get("start")
        or kw.get("startAt")
        or details.get("startAt")
        or kw.get("timeMin")
        or details.get("timeMin")
        or kw.get("startDate")
        or details.get("startDate")
        or time_range.get("start")
    )
    end = (
        kw.get("end")
        or details.get("end")
        or kw.get("endAt")
        or details.get("endAt")
        or kw.get("timeMax")
        or details.get("timeMax")
        or kw.get("endDate")
        or details.get("endDate")
        or time_range.get("end")
    )

    def matches(event: Any) -> bool:
        if getattr(event, "status", None) == "cancelled":
            return False
        if not _calendar_hint_matches(getattr(event, "calendar_id", ""), calendar_hint):
            return False
        title = str(getattr(event, "title", "")).lower()
        if query and not (
            query in title
            or title in query
            or _meaningful_title_tokens(query).issubset(_meaningful_title_tokens(title))
            or _meaningful_title_tokens(title).issubset(_meaningful_title_tokens(query))
        ):
            return False
        event_start = str(getattr(event, "start", ""))
        event_end = str(getattr(event, "end", ""))
        if date_filter and event_start[:10] != date_filter:
            return False
        if isinstance(start, str) and event_end < start:
            return False
        if isinstance(end, str) and event_start > end:
            return False
        return True

    return [
        {
            "id": event.id,
            "calendar_id": event.calendar_id,
            "title": event.title,
            "start": event.start,
            "end": event.end,
            "status": event.status,
        }
        for event in sorted(
            (event for event in world.calendar_events.values() if matches(event)),
            key=lambda event: (event.start, event.id),
        )
    ]


# ---------------------------------------------------------------------------
# Registry — every action name the executor knows
# ---------------------------------------------------------------------------


_ACTION_HANDLERS: dict[
    str, Callable[[LifeWorld, dict[str, Any], str], dict[str, Any]]
] = {
    # Fine-grained vocabulary (inline conformance corpus)
    "CALENDAR.create": _h_calendar_create,
    "CALENDAR.reschedule": _h_calendar_reschedule,
    "CALENDAR.cancel": _h_calendar_cancel,
    "MAIL.send": _h_mail_send,
    "MAIL.archive": _h_mail_archive,
    "MAIL.archive_thread": _h_mail_archive_thread,
    "MAIL.mark_read": _h_mail_mark_read,
    "MAIL.star": _h_mail_star,
    "MAIL.trash": _h_mail_trash,
    "MESSAGE.send": _h_message_send_simple,
    "CONTACTS.add": _h_contact_add,
    "CONTACTS.update": _h_contact_update,
    "CONTACTS.delete": _h_contact_delete,
    "REMINDER.create": _h_reminder_create,
    "REMINDER.complete": _h_reminder_complete,
    "NOTE.create": _h_note_create,
    # Umbrella vocabulary (static scenarios + Eliza adapter)
    "CALENDAR": _u_calendar,
    "CALENDAR_SOURCES": _u_calendar_sources,
    "MESSAGE": _u_message,
    "ENTITY": _u_entity,
    "LIFE_CREATE": _u_life_create,
    "LIFE_COMPLETE": _u_life_complete,
    "LIFE_SNOOZE": _u_life_snooze,
    "LIFE_REVIEW": _u_life_review,
    "LIFE_DELETE": _u_life_delete,
    "LIFE_UPDATE": _u_life_update,
    "LIFE_SKIP": _u_life_skip,
    # `LIFE` (no suffix) is a generic catchall the LLM occasionally emits;
    # treat as read-only review.
    "LIFE": _u_life_review,
    "HEALTH": _u_health,
    # MONEY_* family.
    # Read-only verbs share `_u_money_readonly`; the cancel verb mutates state.
    "MONEY": _u_money_readonly,
    "MONEY_DASHBOARD": _u_money_readonly,
    "MONEY_LIST_TRANSACTIONS": _u_money_readonly,
    "MONEY_LIST_SOURCES": _u_money_readonly,
    "MONEY_RECURRING_CHARGES": _u_money_readonly,
    "MONEY_SPENDING_SUMMARY": _u_money_readonly,
    "MONEY_SUBSCRIPTION_STATUS": _u_money_readonly,
    "MONEY_SUBSCRIPTION_AUDIT": _u_money_subscription_audit,
    "MONEY_SUBSCRIPTION_CANCEL": _u_money_subscription_cancel,
    "BOOK_TRAVEL": _u_book_travel,
    # One handler preserves rule identity and permission linkage across every
    # specialized BLOCK surface.
    "BLOCK": _u_block,
    "BLOCK_BLOCK": _u_block,
    "BLOCK_UNBLOCK": _u_block,
    "BLOCK_LIST_ACTIVE": _u_block,
    "BLOCK_RELEASE": _u_block,
    "BLOCK_STATUS": _u_block,
    "BLOCK_REQUEST_PERMISSION": _u_block,
    "SCHEDULED_TASK_CREATE": _u_scheduled_task_create,
    "SCHEDULED_TASK_SNOOZE": _u_scheduled_task_mutate,
    "SCHEDULED_TASK_UPDATE": _u_scheduled_task_mutate,
    "SCHEDULED_TASKS": _u_scheduled_tasks,
    "SCHEDULED_TASKS_ACKNOWLEDGE": _u_scheduled_task_state,
    "SCHEDULED_TASKS_CANCEL": _u_scheduled_task_state,
    "SCHEDULED_TASKS_COMPLETE": _u_scheduled_task_state,
    "SCHEDULED_TASKS_CREATE": _u_scheduled_task_create,
    "SCHEDULED_TASKS_DISMISS": _u_scheduled_task_state,
    "SCHEDULED_TASKS_GET": _u_scheduled_tasks_readonly,
    "SCHEDULED_TASKS_HISTORY": _u_scheduled_tasks_readonly,
    "SCHEDULED_TASKS_LIST": _u_scheduled_tasks_readonly,
    "SCHEDULED_TASKS_REOPEN": _u_scheduled_task_state,
    "SCHEDULED_TASKS_SKIP": _u_scheduled_task_state,
    "SCHEDULED_TASKS_SNOOZE": _u_scheduled_task_mutate,
    "SCHEDULED_TASKS_UPDATE": _u_scheduled_task_mutate,
    # Conversational terminal sentinels are valid assistant outcomes. They
    # have no LifeWorld side effect and should not be reported as executor
    # coverage gaps.
    "REPLY": lambda _world, kw, _name: {
        "ok": True,
        "effect": "none",
        "terminal": True,
        "reply": kw,
    },
    # Promoted CALENDAR_* names (the manifest exporter promotes
    # subactions into top-level action names). Each promoted name carries
    # `subaction` in its kwargs already, so route to `_u_calendar` unchanged.
    "CALENDAR_CREATE_EVENT": _u_calendar,
    "CALENDAR_UPDATE_EVENT": _u_calendar,
    "CALENDAR_DELETE_EVENT": _u_calendar,
    "CALENDAR_PROPOSE_TIMES": _u_calendar,
    "CALENDAR_SEARCH_EVENTS": _u_calendar,
    "CALENDAR_CHECK_AVAILABILITY": _u_calendar,
    "CALENDAR_NEXT_EVENT": _u_calendar,
    "CALENDAR_UPDATE_PREFERENCES": _u_calendar,
    "CALENDAR_FEED": _u_calendar,
    "CALENDAR_TRIP_WINDOW": _u_calendar,
    "CALENDAR_BULK_RESCHEDULE": _u_calendar,
    # P1-5: contact-create promoted aliases. _normalize_action already injects
    # subaction=create before dispatch, so routing to _u_entity is sufficient.
    "ENTITY_CREATE_CONTACT": _u_entity,
    "CONTACT_CREATE": _u_entity,
    # Promoted MESSAGE_* names mirror the same top-level manifest shape.
    "MESSAGE_SEND": _u_message,
    "MESSAGE_DRAFT_REPLY": _u_message,
    "MESSAGE_MANAGE": _u_message,
    "MESSAGE_TRIAGE": _u_message,
    "MESSAGE_SEARCH_INBOX": _u_message,
    "MESSAGE_LIST_CHANNELS": _u_message,
    "MESSAGE_READ_CHANNEL": _u_message,
    "MESSAGE_READ_WITH_CONTACT": _u_message,
}


# ---------------------------------------------------------------------------
# Tool-call extraction + runner internals
# ---------------------------------------------------------------------------


def _extract_actions_from_turn(turn: MessageTurn) -> list[Action]:
    """Pull `Action(name, kwargs)` objects out of an assistant `MessageTurn`'s `tool_calls`."""
    if not turn.tool_calls:
        return []
    out: list[Action] = []
    for call in turn.tool_calls:
        # Two flavors supported: OpenAI-style `{"function": {"name", "arguments"}}`
        # and a flat `{"name", "arguments" | "kwargs"}` shape used by PerfectAgent.
        if "function" in call and isinstance(call["function"], dict):
            name = call["function"].get("name", "")
            raw_args = call["function"].get("arguments", {})
        else:
            name = call.get("name", "")
            raw_args = call.get("arguments", call.get("kwargs", {}))
        if isinstance(raw_args, str):
            try:
                raw_args = json.loads(raw_args)
            except json.JSONDecodeError:
                raw_args = {}
        if not isinstance(raw_args, dict):
            raw_args = {}
        out.append(Action(name=name, kwargs=raw_args))
    return out


def _replay_ground_truth(scenario: Scenario, world_factory: WorldFactory) -> str:
    """Produce the expected post-state hash by replaying ground_truth on a fresh world.

    Used to compute the ground-truth state hash without requiring scenarios
    to encode it explicitly.
    """
    expected_world = world_factory(scenario.world_seed, scenario.now_iso)
    for action in scenario.ground_truth_actions:
        _execute_action(action, expected_world)
    return state_hash(expected_world)


def _workload_sha256(scenarios: list[Scenario], seeds: int) -> str:
    """Fingerprint the exact authored workload and seed expansion for publication."""
    payload = {
        "schema_version": 3,
        "seeds_per_scenario": seeds,
        "scenarios": [
            {
                "id": scenario.id,
                "name": scenario.name,
                "domain": scenario.domain.value,
                "mode": scenario.mode.value,
                "persona": {
                    "id": scenario.persona.id,
                    "name": scenario.persona.name,
                    "traits": scenario.persona.traits,
                    "background": scenario.persona.background,
                    "communication_style": scenario.persona.communication_style,
                    "patience_turns": scenario.persona.patience_turns,
                },
                "instruction": scenario.instruction,
                "ground_truth_actions": [
                    {"name": action.name, "kwargs": action.kwargs}
                    for action in scenario.ground_truth_actions
                ],
                "required_outputs": scenario.required_outputs,
                "static_rubric": scenario.static_rubric,
                "soft_kwargs": scenario.soft_kwargs,
                "first_question_fallback": (
                    {
                        "canned_answer": scenario.first_question_fallback.canned_answer,
                        "applies_when": scenario.first_question_fallback.applies_when,
                    }
                    if scenario.first_question_fallback is not None
                    else None
                ),
                "world_seed": scenario.world_seed,
                "max_turns": scenario.max_turns,
                "description": scenario.description,
                "now_iso": scenario.now_iso,
                "success_criteria": scenario.success_criteria,
                "world_assertions": scenario.world_assertions,
                "disruptions": [
                    {
                        "at_turn": disruption.at_turn,
                        "kind": disruption.kind,
                        "payload": disruption.payload,
                        "note_for_user": disruption.note_for_user,
                    }
                    for disruption in scenario.disruptions
                ],
                "expected_world_mutation": scenario.expected_world_mutation,
                "tier": scenario.tier,
                "opening_mode": scenario.opening_mode,
                "opening_challenge": scenario.opening_challenge,
                "trusted_evidence_requirement": (
                    {
                        "contract_id": scenario.trusted_evidence_requirement.contract_id,
                        "contract_version": (
                            scenario.trusted_evidence_requirement.contract_version
                        ),
                        "contract_sha256": (
                            scenario.trusted_evidence_requirement.contract_sha256
                        ),
                        "required_assertion_ids": list(
                            scenario.trusted_evidence_requirement.required_assertion_ids
                        ),
                        "allowed_actions": [
                            {
                                "name": policy.name,
                                "discriminator_field": policy.discriminator_field,
                                "allowed_discriminators": list(
                                    policy.allowed_discriminators
                                ),
                                "risk": policy.risk,
                                "required_kwargs": list(policy.required_kwargs),
                                "max_calls": policy.max_calls,
                            }
                            for policy in (
                                scenario.trusted_evidence_requirement.allowed_actions
                            )
                        ],
                        "terminal_attestation_required": (
                            scenario.trusted_evidence_requirement.terminal_attestation_required
                        ),
                    }
                    if scenario.trusted_evidence_requirement is not None
                    else None
                ),
            }
            for scenario in scenarios
        ],
    }
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


class LifeOpsBenchRunner:
    """Orchestrates LifeOpsBench runs across a set of scenarios.

    The agent function takes `(history, tool_manifest)` and returns the next
    assistant `MessageTurn`. The world factory yields a fresh `LifeWorld`
    seeded deterministically per scenario+seed.
    """

    def __init__(
        self,
        agent_fn: AgentFn | None = None,
        world_factory: WorldFactory | None = None,
        evaluator_model: str = "gemma-4-31b",
        judge_model: str = "claude-opus-4-7",
        evaluator_provider: str | None = None,
        judge_provider: str | None = None,
        agent_model_name: str | None = None,
        agent_adapter: str | None = None,
        agent_provider: str | None = None,
        scenarios: list[Scenario] | None = None,
        concurrency: int = 4,
        seeds: int = 1,
        max_cost_usd: float = 10.0,
        per_scenario_timeout_s: int = 300,
        simulated_user_client: BaseClient | None = None,
        judge_client: BaseClient | None = None,
        evaluator: LifeOpsEvaluator | None = None,
        live_judge_min_turn: int = 5,
        abort_on_budget_exceeded: bool = True,
        agent_factory: AgentFactory | None = None,
        trusted_tool_executor: TrustedToolExecutor | None = None,
        trusted_evidence_verifier: TrustedEvidenceVerifier | None = None,
        static_grading_mode: StaticGradingMode = "semantic",
    ) -> None:
        if agent_fn is None and agent_factory is None:
            raise ValueError("LifeOpsBenchRunner requires agent_fn or agent_factory")
        if world_factory is None:
            raise ValueError("LifeOpsBenchRunner requires world_factory")
        if concurrency <= 0:
            raise ValueError("LifeOpsBenchRunner concurrency must be positive")
        if seeds <= 0:
            raise ValueError("LifeOpsBenchRunner seeds must be positive")
        if (trusted_tool_executor is None) != (trusted_evidence_verifier is None):
            raise ValueError(
                "trusted_tool_executor and trusted_evidence_verifier must be "
                "configured together"
            )
        if static_grading_mode not in {"semantic", "offline_conformance"}:
            raise ValueError(
                "static_grading_mode must be 'semantic' or 'offline_conformance'"
            )
        self.agent_fn = agent_fn
        self.agent_factory = agent_factory
        self.world_factory = world_factory
        self.evaluator_model = evaluator_model
        self.judge_model = judge_model
        self.evaluator_provider = evaluator_provider
        self.judge_provider = judge_provider
        self.agent_model_name = agent_model_name
        self.agent_adapter = agent_adapter
        self.agent_provider = agent_provider
        self.concurrency = concurrency
        self.seeds = seeds
        self.max_cost_usd = max_cost_usd
        self.per_scenario_timeout_s = per_scenario_timeout_s
        self.live_judge_min_turn = live_judge_min_turn
        self.abort_on_budget_exceeded = abort_on_budget_exceeded
        self.trusted_tool_executor = trusted_tool_executor
        self.trusted_evidence_verifier = trusted_evidence_verifier
        self.static_grading_mode = static_grading_mode

        if scenarios is not None:
            self.scenarios = scenarios
        else:
            from .scenarios import ALL_SCENARIOS

            self.scenarios = ALL_SCENARIOS

        # Semantic STATIC runs use the same two-model evaluator boundary as
        # LIVE runs: one model renders persona turns and the independent judge
        # grades natural-language criteria. Explicit offline conformance is
        # the only path that omits these clients.
        if evaluator is not None:
            self.evaluator: LifeOpsEvaluator | None = evaluator
        elif simulated_user_client is not None and judge_client is not None:
            self.evaluator = LifeOpsEvaluator(
                simulated_user_client=simulated_user_client,
                judge_client=judge_client,
                simulated_user_provider=evaluator_provider,
                judge_provider=judge_provider,
            )
        else:
            self.evaluator = None

        self._agent_spent_usd = 0.0
        self._eval_spent_usd = 0.0
        self._spent_lock = asyncio.Lock()
        # Set to True the first time `_charge` raises CostBudgetExceeded so
        # subsequent scenarios can short-circuit when
        # ``abort_on_budget_exceeded`` is on. Avoids racing many in-flight
        # scenarios past the cap before the gather sees the first failure.
        self._budget_exhausted = False
        # Failure artifacts retain every fully assembled turn and evaluator
        # exchange completed before a timeout or provider exception.
        self._partial_turns: dict[tuple[str, int], list[TurnResult]] = {}
        self._partial_evaluator_traces: dict[
            tuple[str, int], list[EvaluatorTraceEntry]
        ] = {}

    async def run_all(self) -> BenchmarkResult:
        """Run every configured scenario across `seeds` repetitions and aggregate."""
        return await self.run_filtered()

    async def run_filtered(
        self,
        domain: Domain | None = None,
        mode: ScenarioMode | None = None,
    ) -> BenchmarkResult:
        """Run scenarios filtered by domain and/or mode."""
        scenarios = [
            s
            for s in self.scenarios
            if (domain is None or s.domain == domain)
            and (mode is None or s.mode == mode)
        ]
        if not scenarios:
            raise ValueError(
                "No LifeOpsBench scenarios matched filters "
                f"(domain={domain}, mode={mode})"
            )
        evaluator_required = any(
            scenario.mode is ScenarioMode.LIVE
            or (
                scenario.mode is ScenarioMode.STATIC
                and self.static_grading_mode == "semantic"
                and (
                    scenario.opening_mode == "simulated"
                    or _static_semantic_expectations(scenario)
                )
            )
            for scenario in scenarios
        )
        if evaluator_required and self.evaluator is None:
            raise RuntimeError(
                "selected scenarios require the independent evaluator/judge "
                "boundary; configure simulated_user_client and judge_client, "
                "or explicitly select static_grading_mode='offline_conformance' "
                "for non-publishable harness conformance"
            )
        if self.static_grading_mode == "offline_conformance":
            rubric_scenarios = [
                scenario.id
                for scenario in scenarios
                if scenario.mode is ScenarioMode.STATIC and scenario.static_rubric
            ]
            if rubric_scenarios:
                raise RuntimeError(
                    "offline conformance cannot grade authored static_rubric "
                    f"criteria: {', '.join(rubric_scenarios[:5])}"
                )

        expected_keys = [
            (scenario.id, scenario.world_seed + seed_offset)
            for scenario in scenarios
            for seed_offset in range(self.seeds)
        ]
        if len(set(expected_keys)) != len(expected_keys):
            raise ValueError(
                "LifeOpsBench workload contains duplicate (scenario_id, seed) pairs"
            )

        semaphore = asyncio.Semaphore(self.concurrency)
        tasks: list[Awaitable[ScenarioResult]] = []
        for scenario in scenarios:
            for seed_offset in range(self.seeds):
                seed = scenario.world_seed + seed_offset
                tasks.append(self._run_one_guarded(semaphore, scenario, seed))

        results = await asyncio.gather(*tasks)
        completed_keys = [(result.scenario_id, result.seed) for result in results]
        if completed_keys != expected_keys:
            raise RuntimeError(
                "LifeOpsBench completed workload does not match the scheduled "
                f"workload: expected={expected_keys!r}, completed={completed_keys!r}"
            )
        scenarios_by_id = {s.id: s for s in scenarios}
        bench_result = compile_benchmark_result(
            list(results),
            scenarios_by_id,
            seeds=self.seeds,
            model_name=self.evaluator_model,
            judge_model_name=self.judge_model,
            timestamp=datetime.now(timezone.utc).isoformat(),
            trusted_evidence_verifier=self.trusted_evidence_verifier,
        )
        # Attach the agent / eval cost split. ``compile_benchmark_result``
        # only sees per-turn agent cost, so fold the eval ledger in here so
        # the headline matches the wall budget.
        bench_result.agent_cost_usd = self._agent_spent_usd
        bench_result.eval_cost_usd = self._eval_spent_usd
        bench_result.total_cost_usd = self._agent_spent_usd + self._eval_spent_usd
        bench_result.expected_run_count = len(expected_keys)
        bench_result.completed_run_count = len(completed_keys)
        bench_result.successful_run_count = sum(
            result.error is None
            and result.terminated_reason not in {"error", "timeout", "cost_exceeded"}
            for result in results
        )
        bench_result.complete = (
            bench_result.completed_run_count == bench_result.expected_run_count
            and bench_result.successful_run_count == bench_result.expected_run_count
        )
        bench_result.workload_sha256 = _workload_sha256(scenarios, self.seeds)
        bench_result.agent_model_name = self.agent_model_name
        bench_result.agent_adapter = self.agent_adapter
        bench_result.agent_provider = self.agent_provider
        bench_result.evaluator_provider = self.evaluator_provider
        bench_result.judge_provider = self.judge_provider
        bench_result.static_grading_mode = self.static_grading_mode
        static_ids = {
            scenario.id
            for scenario in scenarios
            if scenario.mode is ScenarioMode.STATIC
        }
        bench_result.static_run_count = sum(
            result.scenario_id in static_ids for result in results
        )
        bench_result.unpriced_agent_call_count = sum(
            turn.cost_usd is None for result in results for turn in result.turns
        )
        bench_result.unpriced_eval_call_count = sum(
            entry.cost_usd is None
            for result in results
            for entry in result.evaluator_trace
        )
        semantic_static_ids = {
            scenario.id
            for scenario in scenarios
            if _static_semantic_expectations(scenario)
        }
        bench_result.semantic_static_run_count = sum(
            result.scenario_id in semantic_static_ids for result in results
        )
        bench_result.semantic_static_judged_count = sum(
            result.scenario_id in semantic_static_ids
            and result.static_grading_mode == "semantic"
            and _has_complete_static_semantic_trace(
                result,
                scenarios_by_id[result.scenario_id],
            )
            for result in results
        )
        return bench_result

    async def _run_one_guarded(
        self,
        semaphore: asyncio.Semaphore,
        scenario: Scenario,
        seed: int,
    ) -> ScenarioResult:
        async with semaphore:
            # Short-circuit any scenario that hasn't started its agent_fn yet
            # once another scenario has tripped the cost cap and abort is on.
            # This keeps the run from racing pending scenarios past the cap
            # in the time between the first failure and the gather collecting
            # results.
            if self.abort_on_budget_exceeded and self._budget_exhausted:
                return self._failure_result(
                    scenario,
                    seed,
                    "cost_exceeded",
                    "skipped — cumulative cost cap "
                    f"${self.max_cost_usd:.4f} already exceeded",
                )
            run_key = (scenario.id, seed)
            self._partial_turns[run_key] = []
            self._partial_evaluator_traces[run_key] = []
            try:
                result = await asyncio.wait_for(
                    self.run_one(scenario, seed),
                    timeout=self.per_scenario_timeout_s,
                )
                self._partial_turns.pop(run_key, None)
                self._partial_evaluator_traces.pop(run_key, None)
                return result
            # error-policy:J1 scenario boundary preserves partial evidence on timeout.
            except asyncio.TimeoutError:
                logger.warning(
                    "Scenario %s seed=%d timed out after %ds",
                    scenario.id,
                    seed,
                    self.per_scenario_timeout_s,
                )
                return self._failure_result(
                    scenario,
                    seed,
                    "timeout",
                    "timed out",
                    turns=self._partial_turns.pop(run_key, []),
                    evaluator_trace=self._partial_evaluator_traces.pop(run_key, []),
                )
            # error-policy:J1 scenario boundary records a typed cost failure.
            except CostBudgetExceeded as exc:
                logger.error(
                    "Cost budget exceeded on %s seed=%d: %s", scenario.id, seed, exc
                )
                return self._failure_result(
                    scenario,
                    seed,
                    "cost_exceeded",
                    str(exc),
                    turns=self._partial_turns.pop(run_key, []),
                    evaluator_trace=self._partial_evaluator_traces.pop(run_key, []),
                )
            # error-policy:J1 outer scenario boundary retains diagnostics and fails.
            except Exception as exc:
                logger.exception("Scenario %s seed=%d errored", scenario.id, seed)
                return self._failure_result(
                    scenario,
                    seed,
                    "error",
                    str(exc),
                    turns=self._partial_turns.pop(run_key, []),
                    evaluator_trace=self._partial_evaluator_traces.pop(run_key, []),
                )

    async def run_one(self, scenario: Scenario, seed: int) -> ScenarioResult:
        """Run a single scenario at a single seed and return its result.

        Both modes honor ``Scenario.opening_mode``. In semantic runs,
        ``simulated`` asks the persona model to render a fresh, in-character
        opening from the hidden goal; explicit offline conformance uses the
        authored goal because it has no model boundary. STATIC ends after the
        optional first-question fallback and then receives exactly one
        independent semantic grade. LIVE continues with simulated user turns,
        periodic satisfaction judging, and scripted world disruptions.
        """
        if scenario.mode is ScenarioMode.LIVE and self.evaluator is None:
            raise RuntimeError(
                f"scenario {scenario.id} is LIVE but no evaluator was wired; "
                "construct LifeOpsBenchRunner with simulated_user_client and judge_client."
            )
        if (
            scenario.mode is ScenarioMode.STATIC
            and self.static_grading_mode == "semantic"
            and (
                scenario.opening_mode == "simulated"
                or _static_semantic_expectations(scenario)
            )
            and self.evaluator is None
        ):
            raise RuntimeError(
                f"scenario {scenario.id} requires semantic STATIC evaluation but "
                "no evaluator/judge was wired; configure both clients or "
                "explicitly use offline_conformance"
            )
        if (
            scenario.mode is ScenarioMode.STATIC
            and self.static_grading_mode == "offline_conformance"
            and scenario.static_rubric
        ):
            raise RuntimeError(
                f"scenario {scenario.id} has authored static_rubric criteria "
                "that offline conformance cannot grade"
            )
        scenario_evaluator = (
            self.evaluator.fork() if self.evaluator is not None else None
        )
        run_key = (scenario.id, seed)
        turns = self._partial_turns.setdefault(run_key, [])
        if scenario_evaluator is not None:
            self._partial_evaluator_traces[run_key] = scenario_evaluator.trace

        world = self.world_factory(seed, scenario.now_iso)
        run_id = secrets.token_hex(16)
        run_nonce = secrets.token_hex(32)
        run_started_at = datetime.now(timezone.utc)
        seen_receipt_ids: set[str] = set()
        seen_tool_call_ids: set[str] = set()
        policy_call_counts: dict[int, int] = {}
        request_ordinal = 0
        use_simulated_opening = scenario.opening_mode == "simulated" and (
            scenario.mode is ScenarioMode.LIVE or self.static_grading_mode == "semantic"
        )
        if use_simulated_opening:
            pre_opening_eval_cost = scenario_evaluator.cost_usd  # type: ignore[union-attr]
            opening_turn = await scenario_evaluator.simulate_user_turn(  # type: ignore[union-attr]
                scenario,
                [],
                world,
            )
            opening_text = opening_turn.content.strip()
            if _opening_leaks_hidden_goal(opening_text, scenario.instruction):
                raise ValueError(
                    "simulated-user opening exposed the hidden goal verbatim"
                )
            history = [
                MessageTurn(
                    role="user",
                    content=(
                        _benchmark_clock_context(scenario.now_iso)
                        + "\n\n"
                        + opening_text
                    ),
                )
            ]
            await self._charge(
                scenario_evaluator.cost_usd - pre_opening_eval_cost,  # type: ignore[union-attr]
                scenario.id,
                seed,
                bucket="eval",
            )
        else:
            history = [
                MessageTurn(
                    role="user",
                    content=_initial_user_content(scenario),
                )
            ]
        terminated_reason: str = "max_turns"

        # Pre-bucket disruptions by the turn they fire after.
        disruptions_by_turn: dict[int, list[Disruption]] = {}
        for d in scenario.disruptions:
            disruptions_by_turn.setdefault(d.at_turn, []).append(d)

        # Per-scenario agents (PerfectAgent/WrongAgent) need a fresh instance
        # per scenario because they hold scenario-specific state (action index,
        # ground-truth lookup). A factory wins over a singleton agent_fn.
        active_agent_fn: AgentFn = (
            self.agent_factory(scenario) if self.agent_factory is not None else self.agent_fn  # type: ignore[assignment]
        )

        requirement = scenario.trusted_evidence_requirement
        for turn_number in range(1, scenario.max_turns + 1):
            tool_manifest = build_tool_manifest(world, requirement)
            agent_turn = await active_agent_fn(list(history), tool_manifest)
            if agent_turn.role != "assistant":
                raise ValueError(
                    "agent adapter crossed the role boundary: expected an "
                    f"assistant turn, received {agent_turn.role!r}"
                )
            history.append(agent_turn)

            agent_actions = _extract_actions_from_turn(agent_turn)
            tool_call_ids = [
                _extract_tool_call_id(
                    agent_turn,
                    action,
                    action_index,
                )
                or f"runner-{run_id}-{turn_number}-{action_index}"
                for action_index, action in enumerate(agent_actions)
            ]
            if requirement is not None:
                for tool_call_id in tool_call_ids:
                    validate_tool_call_id(tool_call_id)
                    if tool_call_id in seen_tool_call_ids:
                        raise ValueError(
                            "agent reused tool_call_id "
                            f"{tool_call_id!r} within one evidence-gated run"
                        )
                    seen_tool_call_ids.add(tool_call_id)
            external_execution_enabled = (
                requirement is not None
                and self.trusted_tool_executor is not None
                and self.trusted_evidence_verifier is not None
            )
            canonical_actions = [_normalize_action(action) for action in agent_actions]
            # A batch that violates the evidence contract is denied whole:
            # the shadow pass exists so a later unauthorized call cannot leave
            # an earlier one partially committed. The denial is reported back
            # as a tool result the model can react to — an out-of-contract call
            # is scenario signal about the model, not a harness crash.
            policy_denial: str | None = None
            if external_execution_enabled:
                shadow = deepcopy(world)
                next_policy_counts = dict(policy_call_counts)
                for canonical_action in canonical_actions:
                    try:
                        validate_action_policy(
                            canonical_action,
                            requirement,
                            next_policy_counts,
                        )
                    except EvidenceVerificationError as exc:
                        # error-policy:J3 the contract rejected untrusted model
                        # output; surface the refusal instead of dispatching.
                        policy_denial = str(exc)
                        break
                    _execute_action(canonical_action, shadow)
                if policy_denial is None:
                    policy_call_counts = next_policy_counts

            tool_results: list[dict[str, Any]] = []
            turn_verified_receipts: list[VerifiedEvidenceReceipt] = []
            for action_index, action in enumerate(canonical_actions):
                # Execution failures don't crash the run — we surface them as
                # tool-error messages and let scoring penalize via state mismatch.
                tool_call_id = tool_call_ids[action_index]
                if policy_denial is not None:
                    denial_payload = mark_deterministic_lifeworld_result(
                        {"error": "policy_denied", "message": policy_denial}
                    )
                    tool_results.append(
                        {
                            "name": action.name,
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(denial_payload),
                            "payload": denial_payload,
                        }
                    )
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps(denial_payload),
                            name=action.name,
                            tool_call_id=tool_call_id,
                        )
                    )
                    continue
                try:
                    if external_execution_enabled:
                        request_ordinal += 1
                        context = TrustedExecutionContext(
                            run_id=run_id,
                            run_nonce=run_nonce,
                            run_started_at=run_started_at,
                            scenario_id=scenario.id,
                            seed=seed,
                            tool_call_id=tool_call_id,
                            request_ordinal=request_ordinal,
                            action=action,
                            contract_id=requirement.contract_id,
                            contract_version=requirement.contract_version,
                            contract_sha256=requirement.contract_sha256,
                            requested_at=datetime.now(timezone.utc),
                        )
                        execution = await self.trusted_tool_executor.execute(context)
                        receipt = self.trusted_evidence_verifier.verify(
                            context,
                            execution,
                            requirement,
                        )
                        if receipt.receipt_id in seen_receipt_ids:
                            raise RuntimeError(
                                "trusted executor reused receipt_id "
                                f"{receipt.receipt_id!r} within one run"
                            )
                        seen_receipt_ids.add(receipt.receipt_id)
                        turn_verified_receipts.append(receipt)
                        result_payload = mark_authenticated_external_result(
                            execution.payload,
                            receipt,
                        )
                        if receipt.success:
                            # The deterministic world is a scoring shadow only;
                            # authenticated artifacts, not this replay, establish
                            # that the provider-side operation really occurred.
                            try:
                                _execute_action(action, world)
                            except UnsupportedAction as exc:
                                raise RuntimeError(
                                    "authenticated action has no LifeWorld shadow "
                                    f"implementation: {action.name}"
                                ) from exc
                    else:
                        result_payload = _execute_action(action, world)
                        result_payload = mark_deterministic_lifeworld_result(
                            result_payload
                        )
                    tool_results.append(
                        {
                            "name": action.name,
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(result_payload),
                            "payload": result_payload,
                        }
                    )
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps(result_payload),
                            name=action.name,
                            tool_call_id=tool_call_id,
                        )
                    )
                except UnsupportedAction as exc:
                    logger.warning(
                        "Unsupported action in scenario %s: %s", scenario.id, exc
                    )
                    error_payload = {"error": "unsupported_action", "message": str(exc)}
                    error_payload = mark_deterministic_lifeworld_result(error_payload)
                    tool_results.append(
                        {
                            "name": action.name,
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(error_payload),
                            "payload": error_payload,
                        }
                    )
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps(error_payload),
                            name=action.name,
                            tool_call_id=tool_call_id,
                        )
                    )
                except (KeyError, ValueError, TypeError, PermissionError) as exc:
                    logger.warning(
                        "Action %s failed in scenario %s: %s",
                        action.name,
                        scenario.id,
                        exc,
                    )
                    # A PermissionError is the world enforcing a confirmation or
                    # authorization gate (e.g. BLOCK/unblock without
                    # confirmed=True). Production surfaces that to the model as a
                    # denied result it can react to, so the deterministic shadow
                    # must too — a refused tool call is scenario signal, never a
                    # harness crash.
                    error_payload = {
                        "error": (
                            "permission_denied"
                            if isinstance(exc, PermissionError)
                            else "execution_failed"
                        ),
                        "message": str(exc),
                    }
                    error_payload = mark_deterministic_lifeworld_result(error_payload)
                    tool_results.append(
                        {
                            "name": action.name,
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(error_payload),
                            "payload": error_payload,
                        }
                    )
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps(error_payload),
                            name=action.name,
                            tool_call_id=tool_call_id,
                        )
                    )

            # Per-turn cost / latency are nullable on MessageTurn — `None`
            # means the provider didn't expose the number (unpriced model,
            # pre-flight error). Per AGENTS.md Cmd #8 we keep the None
            # through to the TurnResult rather than masking with 0.0. The
            # budget charge uses 0.0 locally because there is no real spend
            # to charge against when the value is unknown.
            agent_cost_raw = getattr(agent_turn, "cost_usd", None)
            agent_cost: float | None = (
                float(agent_cost_raw)
                if isinstance(agent_cost_raw, (int, float))
                else None
            )
            latency_raw = getattr(agent_turn, "latency_ms", None)
            latency_value: int | None = (
                int(latency_raw) if isinstance(latency_raw, (int, float)) else None
            )

            # Cache telemetry: adapters set these as attributes on the
            # MessageTurn when the provider reported them. `None` means the
            # provider did not report — we keep it as None so downstream
            # aggregators can distinguish "no data" from "zero hits".
            input_tokens_val = int(getattr(agent_turn, "input_tokens", 0) or 0)
            cache_read_attr = getattr(agent_turn, "cache_read_input_tokens", None)
            cache_creation_attr = getattr(
                agent_turn, "cache_creation_input_tokens", None
            )
            cache_read = (
                int(cache_read_attr)
                if isinstance(cache_read_attr, (int, float))
                else None
            )
            cache_creation = (
                int(cache_creation_attr)
                if isinstance(cache_creation_attr, (int, float))
                else None
            )
            # cache_supported defaults to True (every provider in scope —
            # Cerebras gpt-oss-120b, OpenAI, Anthropic — supports prompt
            # caching). Adapters explicitly override to False when on a
            # local-tier provider that does not.
            cache_supported_attr = getattr(agent_turn, "cache_supported", True)
            cache_supported = bool(cache_supported_attr)
            turn_result = TurnResult(
                turn_number=turn_number,
                agent_message=agent_turn.content,
                agent_actions=agent_actions,
                user_response="",
                latency_ms=latency_value,
                input_tokens=input_tokens_val,
                output_tokens=int(getattr(agent_turn, "output_tokens", 0) or 0),
                cost_usd=agent_cost,
                tool_results=tool_results,
                cache_read_input_tokens=cache_read,
                cache_creation_input_tokens=cache_creation,
                cache_hit_pct=compute_cache_hit_pct(
                    input_tokens_val, cache_read, cache_creation
                ),
                cache_supported=cache_supported,
                model_tier=getattr(agent_turn, "model_tier", None),
                prompt_cache_key=getattr(agent_turn, "prompt_cache_key", None),
                # Attested provenance only: the adapter stamps model_name on
                # the MessageTurn when the provider reported it. Backfilling
                # from the config-declared agent_model_name would fabricate
                # per-turn attribution; unattributed turns stay None and the
                # run-level BenchmarkResult.agent_model_name carries the
                # configured identity separately.
                model_name=agent_turn.model_name,
                verified_evidence=turn_verified_receipts,
            )
            # The provider response and every resulting tool effect are already
            # facts at this point. Retain them before budget enforcement or an
            # evaluator call can fail so diagnostics never erase a real effect.
            turns.append(turn_result)
            await self._charge(
                agent_cost if agent_cost is not None else 0.0,
                scenario.id,
                seed,
                bucket="agent",
            )

            # Terminal detection: assistant turn with no tool_calls signals
            # the agent is done responding. Tool-call-only turns continue the
            # loop so multi-step plans can execute one tool per turn.
            agent_terminal = not agent_actions

            if scenario.mode is ScenarioMode.STATIC:
                if agent_terminal:
                    # Plain text means the agent is responding. Apply the
                    # first-question fallback once if it's a clarifier; else
                    # terminate.
                    pre_eval_cost = (
                        scenario_evaluator.cost_usd
                        if scenario_evaluator is not None
                        else 0.0
                    )
                    user_turn = await self._next_static_user_turn(
                        scenario,
                        agent_turn,
                        turn_number,
                        evaluator=scenario_evaluator,
                    )
                    if scenario_evaluator is not None:
                        await self._charge(
                            scenario_evaluator.cost_usd - pre_eval_cost,
                            scenario.id,
                            seed,
                            bucket="eval",
                        )
                    if user_turn is None:
                        terminated_reason = "respond"
                        break
                    history.append(user_turn)
                    turn_result.user_response = user_turn.content
            else:
                # LIVE mode. Apply scripted disruptions queued for this turn
                # BEFORE judging or asking the simulated user — the judge
                # should see the new world state and the simulated user can
                # surface the change naturally.
                disruption_note = await self._apply_disruptions(
                    disruptions_by_turn.get(turn_number, []), world
                )

                pre_eval_cost = scenario_evaluator.cost_usd  # type: ignore[union-attr]
                if turn_number >= self.live_judge_min_turn:
                    satisfied, _reason = await scenario_evaluator.judge_satisfaction(  # type: ignore[union-attr]
                        scenario,
                        history,
                        world,
                        evidence_verification=verify_result_trusted_evidence(
                            scenario,
                            turns,
                            seed=seed,
                            verifier=self.trusted_evidence_verifier,
                        ),
                    )
                    await self._charge(
                        scenario_evaluator.cost_usd - pre_eval_cost,  # type: ignore[union-attr]
                        scenario.id,
                        seed,
                        bucket="eval",
                    )
                    pre_eval_cost = scenario_evaluator.cost_usd  # type: ignore[union-attr]
                    if satisfied:
                        terminated_reason = "satisfied"
                        break

                # Always advance the conversation by one user turn in LIVE
                # mode (judge said NO, or we haven't started judging yet).
                user_turn = await scenario_evaluator.simulate_user_turn(  # type: ignore[union-attr]
                    scenario, history, world
                )
                if disruption_note:
                    user_turn = MessageTurn(
                        role="user",
                        content=f"{disruption_note}\n\n{user_turn.content}",
                    )
                history.append(user_turn)
                turn_result.user_response = user_turn.content
                await self._charge(
                    scenario_evaluator.cost_usd - pre_eval_cost,  # type: ignore[union-attr]
                    scenario.id,
                    seed,
                    bucket="eval",
                )

        # Compute the ground-truth post-state by replaying scenario actions on
        # a fresh world. If the executor doesn't support every gt action, the
        # replay raises and we mark the scenario as non-matchable.
        try:
            expected_hash = _replay_ground_truth(scenario, self.world_factory)
            state_match = state_hash(world) == expected_hash
        except UnsupportedAction as exc:
            logger.warning(
                "Cannot compute expected state hash for %s: %s", scenario.id, exc
            )
            state_match = False

        if (
            scenario.mode is ScenarioMode.STATIC
            and self.static_grading_mode == "semantic"
            and _static_semantic_expectations(scenario)
        ):
            pre_eval_cost = scenario_evaluator.cost_usd  # type: ignore[union-attr]
            await scenario_evaluator.judge_static_semantics(  # type: ignore[union-attr]
                scenario,
                history,
            )
            await self._charge(
                scenario_evaluator.cost_usd - pre_eval_cost,  # type: ignore[union-attr]
                scenario.id,
                seed,
                bucket="eval",
            )

        # Literal matching exists only for the explicitly named offline
        # conformance lane. Semantic and LIVE results never route their
        # natural-language expectations through this heuristic.
        substring_matches = (
            output_substring_match(history, scenario.required_outputs)
            if (
                scenario.mode is ScenarioMode.STATIC
                and self.static_grading_mode == "offline_conformance"
            )
            else []
        )
        result = ScenarioResult(
            scenario_id=scenario.id,
            seed=seed,
            static_grading_mode=(
                self.static_grading_mode
                if scenario.mode is ScenarioMode.STATIC
                else None
            ),
            turns=turns,
            state_hash_match=state_match,
            output_substring_matches=substring_matches,
            total_score=0.0,
            max_score=1.0,
            terminated_reason=terminated_reason,  # type: ignore[arg-type]
            # Skip None per-turn values when aggregating — "unpriced" /
            # "no timing data" is distinct from "$0" / "0 ms" (AGENTS.md
            # Cmd #8). Invariant: ``total_cost_usd ==
            # sum(t.cost_usd for t in turns if t.cost_usd is not None)``.
            total_cost_usd=sum(t.cost_usd for t in turns if t.cost_usd is not None),
            total_latency_ms=sum(
                t.latency_ms for t in turns if t.latency_ms is not None
            ),
            error=None,
            evaluator_trace=(
                list(scenario_evaluator.trace) if scenario_evaluator is not None else []
            ),
        )
        result.total_score = score_scenario(
            result,
            scenario,
            trusted_evidence_verifier=self.trusted_evidence_verifier,
        )
        self._partial_turns.pop(run_key, None)
        self._partial_evaluator_traces.pop(run_key, None)
        return result

    async def _apply_disruptions(
        self,
        disruptions: list[Disruption],
        world: LifeWorld,
    ) -> str:
        """Mutate ``world`` per each scripted disruption; return a user-facing note.

        REALM-Bench-style perturbations: a new urgent email lands mid-flow, a
        meeting moves, a reminder fires. Returns a short natural-language note
        (``""`` if no disruptions or no notes) that gets prepended to the
        next simulated user turn so the persona organically surfaces the
        change.

        Invalid kinds, payloads, and missing targets raise. Emitting the note
        without applying its world mutation would create a false trajectory in
        which the user describes a change that never happened.
        """
        notes: list[str] = []
        for d in disruptions:
            if d.kind == "new_message":
                msg = EmailMessage(
                    id=d.payload["message_id"],
                    thread_id=d.payload["thread_id"],
                    folder="inbox",
                    from_email=d.payload["from_email"],
                    to_emails=list(d.payload.get("to_emails", ["owner@example.test"])),
                    cc_emails=[],
                    subject=d.payload["subject"],
                    body_plain=d.payload.get("body", ""),
                    sent_at=world.now_iso,
                    received_at=world.now_iso,
                    is_read=False,
                    is_starred=False,
                    labels=list(d.payload.get("labels", [])),
                    attachments=[],
                )
                world.add(EntityKind.EMAIL, msg)
                if d.payload["thread_id"] not in world.email_threads:
                    world.add(
                        EntityKind.EMAIL_THREAD,
                        EmailThread(
                            id=d.payload["thread_id"],
                            subject=d.payload["subject"],
                            message_ids=[d.payload["message_id"]],
                            participants=[d.payload["from_email"]],
                            last_activity_at=world.now_iso,
                        ),
                    )
            elif d.kind == "calendar_change":
                action = d.payload.get("action", "cancel")
                event_id = d.payload["event_id"]
                if action == "cancel":
                    world.cancel_event(event_id)
                elif action == "move":
                    world.move_event(
                        event_id,
                        start=d.payload["start"],
                        end=d.payload["end"],
                    )
                else:
                    raise ValueError(f"unknown calendar_change action: {action!r}")
            elif d.kind == "reminder_due":
                reminder = Reminder(
                    id=d.payload["reminder_id"],
                    list_id=d.payload["list_id"],
                    title=d.payload["title"],
                    notes=d.payload.get("notes", ""),
                    due_at=d.payload.get("due_at", world.now_iso),
                    completed_at=None,
                    priority=d.payload.get("priority", "high"),
                    tags=list(d.payload.get("tags", [])),
                )
                world.add(EntityKind.REMINDER, reminder)
            elif d.kind == "rule_change":
                # The note is the complete effect for a conversational rule change.
                pass
            else:
                raise ValueError(f"unknown disruption kind: {d.kind!r}")

            if d.note_for_user:
                notes.append(d.note_for_user)

        return "\n".join(notes)

    async def _next_static_user_turn(
        self,
        scenario: Scenario,
        agent_turn: MessageTurn,
        turn_number: int,
        *,
        evaluator: LifeOpsEvaluator | None,
    ) -> MessageTurn | None:
        """STATIC mode: only respond on the FIRST agent turn if the fallback applies; otherwise terminate.

        Explicit offline-conformance runs have no evaluator, so they use the
        punctuation gate and canned fact source. Publishable semantic runs ask
        the persona model to apply ``applies_when`` and answer in character.
        """
        if turn_number != 1:
            return None
        if evaluator is not None:
            return await evaluator.apply_first_question_fallback(
                scenario, agent_turn.content
            )
        fallback = scenario.first_question_fallback
        if fallback is None:
            return None
        if "?" not in (agent_turn.content or ""):
            return None
        return MessageTurn(role="user", content=fallback.canned_answer)

    async def _charge(
        self,
        cost_usd: float,
        scenario_id: str,
        seed: int,
        bucket: str = "agent",
    ) -> None:
        """Add ``cost_usd`` to the named bucket and enforce the global cap.

        Buckets are ``"agent"`` and ``"eval"`` so the runner can report a split
        in ``BenchmarkResult.{agent_cost_usd, eval_cost_usd}``. The cost cap is
        applied to the combined total — operators care about wall-spend.
        """
        if cost_usd <= 0:
            return
        async with self._spent_lock:
            if bucket == "agent":
                self._agent_spent_usd += cost_usd
            elif bucket == "eval":
                self._eval_spent_usd += cost_usd
            else:
                raise ValueError(f"unknown cost bucket: {bucket!r}")
            total = self._agent_spent_usd + self._eval_spent_usd
            if total > self.max_cost_usd:
                self._budget_exhausted = True
                raise CostBudgetExceeded(
                    f"spent ${total:.4f} exceeded cap "
                    f"${self.max_cost_usd:.4f} on {scenario_id}#{seed} (bucket={bucket})"
                )

    def _failure_result(
        self,
        scenario: Scenario,
        seed: int,
        reason: str,
        message: str,
        *,
        turns: list[TurnResult] | None = None,
        evaluator_trace: list[EvaluatorTraceEntry] | None = None,
    ) -> ScenarioResult:
        retained_turns = list(turns or [])
        return ScenarioResult(
            scenario_id=scenario.id,
            seed=seed,
            static_grading_mode=(
                self.static_grading_mode
                if scenario.mode is ScenarioMode.STATIC
                else None
            ),
            turns=retained_turns,
            state_hash_match=False,
            output_substring_matches=[False] * len(scenario.required_outputs),
            total_score=0.0,
            max_score=1.0,
            terminated_reason=reason,  # type: ignore[arg-type]
            total_cost_usd=sum(
                turn.cost_usd for turn in retained_turns if turn.cost_usd is not None
            ),
            total_latency_ms=sum(
                turn.latency_ms
                for turn in retained_turns
                if turn.latency_ms is not None
            ),
            error=message,
            evaluator_trace=list(evaluator_trace or []),
        )

    @staticmethod
    def _serialize_result_value(obj: Any) -> Any:
        """Convert nested result dataclasses and enums into JSON values."""
        if hasattr(obj, "__dataclass_fields__"):
            return {
                key: LifeOpsBenchRunner._serialize_result_value(value)
                for key, value in obj.__dict__.items()
            }
        if isinstance(obj, list):
            return [LifeOpsBenchRunner._serialize_result_value(item) for item in obj]
        if isinstance(obj, dict):
            return {
                key: LifeOpsBenchRunner._serialize_result_value(value)
                for key, value in obj.items()
            }
        if hasattr(obj, "value"):
            return obj.value
        return obj

    @staticmethod
    def save_results(
        result: BenchmarkResult,
        output_dir: str = "lifeops_bench_results",
    ) -> str:
        """Serialize a BenchmarkResult to JSON under `output_dir` and return the path."""
        if not result.complete:
            raise RuntimeError(
                "refusing to publish incomplete LifeOpsBench result: "
                f"successful={result.successful_run_count}/"
                f"{result.expected_run_count}, completed={result.completed_run_count}"
            )
        if (
            result.expected_run_count <= 0
            or result.completed_run_count != result.expected_run_count
            or result.successful_run_count != result.expected_run_count
            or not re.fullmatch(r"[0-9a-f]{64}", result.workload_sha256)
        ):
            raise RuntimeError(
                "refusing to publish LifeOpsBench result with invalid completeness "
                "or workload provenance"
            )
        if not all(
            (
                result.agent_model_name,
                result.agent_adapter,
                result.agent_provider,
            )
        ):
            raise RuntimeError(
                "refusing to publish LifeOpsBench result without acting-agent "
                "provenance"
            )
        if result.static_run_count and result.static_grading_mode != "semantic":
            raise RuntimeError(
                "refusing to publish STATIC LifeOpsBench results from the "
                "offline_conformance lane"
            )
        if result.semantic_static_judged_count != result.semantic_static_run_count:
            raise RuntimeError(
                "refusing to publish LifeOpsBench result without complete, "
                "valid semantic judge coverage: "
                f"judged={result.semantic_static_judged_count}/"
                f"{result.semantic_static_run_count}"
            )
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe = (
            re.sub(r"[^A-Za-z0-9_.-]+", "-", result.agent_model_name).strip("-")
            or "model"
        )
        path = os.path.join(output_dir, f"lifeops_{safe}_{timestamp}.json")

        with open(path, "w") as fh:
            json.dump(
                LifeOpsBenchRunner._serialize_result_value(result),
                fh,
                indent=2,
                default=str,
            )
        logger.info("Results saved to %s", path)
        return path

    @staticmethod
    def save_diagnostic_results(
        result: BenchmarkResult,
        output_dir: str = "lifeops_bench_results",
    ) -> str:
        """Persist an incomplete run as explicitly non-publishable evidence.

        Provider failures, timeouts, and harness errors are evidence too. They
        live under a diagnostic subdirectory so result collectors cannot
        mistake them for publishable benchmark artifacts.
        """
        if result.complete:
            raise RuntimeError(
                "save_diagnostic_results accepts only incomplete benchmark runs"
            )
        diagnostic_dir = os.path.join(output_dir, "diagnostics")
        os.makedirs(diagnostic_dir, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        safe = (
            re.sub(
                r"[^A-Za-z0-9_.-]+",
                "-",
                result.agent_model_name or "unknown-model",
            ).strip("-")
            or "unknown-model"
        )
        path = os.path.join(
            diagnostic_dir,
            f"lifeops_diagnostic_{safe}_{timestamp}.json",
        )
        reasons = [
            "incomplete workload: "
            f"successful={result.successful_run_count}/"
            f"{result.expected_run_count}, "
            f"completed={result.completed_run_count}",
            *[
                f"{scenario.scenario_id}#{scenario.seed}: "
                f"{scenario.terminated_reason}: {scenario.error}"
                for scenario in result.scenarios
                if scenario.error is not None
            ],
        ]
        payload = LifeOpsBenchRunner._serialize_result_value(result)
        if not isinstance(payload, dict):
            raise RuntimeError("serialized benchmark diagnostic must be an object")
        payload["artifact_tier"] = "diagnostic_nonpublishable"
        payload["publishable"] = False
        payload["nonpublishable_reasons"] = reasons
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, default=str)
        logger.warning("Non-publishable diagnostic results saved to %s", path)
        return path

    @staticmethod
    def save_conformance_results(
        result: BenchmarkResult,
        output_dir: str = "lifeops_bench_results",
    ) -> str:
        """Persist an explicitly non-publishable offline-conformance artifact."""
        if result.static_grading_mode != "offline_conformance":
            raise RuntimeError(
                "save_conformance_results requires offline_conformance mode"
            )
        if not result.complete:
            raise RuntimeError(
                "refusing to save incomplete LifeOpsBench conformance result"
            )
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(
            output_dir,
            f"lifeops_conformance_{timestamp}.json",
        )
        with open(path, "w") as fh:
            json.dump(
                LifeOpsBenchRunner._serialize_result_value(result),
                fh,
                indent=2,
                default=str,
            )
        logger.info("Non-publishable conformance results saved to %s", path)
        return path

    @staticmethod
    def print_summary(result: BenchmarkResult) -> None:
        """Print a human-readable summary."""
        print("\n" + "=" * 60)
        print("  LifeOpsBench Results Summary")
        print("=" * 60)
        evaluator_label = (
            f"{result.evaluator_provider} → {result.model_name}"
            if result.evaluator_provider
            else result.model_name
        )
        judge_label = (
            f"{result.judge_provider} → {result.judge_model_name}"
            if result.judge_provider
            else result.judge_model_name
        )
        agent_label = (
            f"{result.agent_provider} → {result.agent_model_name}"
            if result.agent_provider
            else result.agent_model_name
        )
        if result.agent_adapter:
            agent_label = f"{result.agent_adapter} / {agent_label}"
        print(f"  Agent:              {agent_label}")
        print(f"  Evaluator:          {evaluator_label}")
        print(f"  Judge:              {judge_label}")
        print(f"  Seeds per scenario: {result.seeds}")
        print(f"  Scenarios run:      {len(result.scenarios)}")
        print(f"  pass@1:             {result.pass_at_1:.3f}")
        print(f"  pass@k:             {result.pass_at_k:.3f}")
        print(f"  Known cost:         ${result.total_cost_usd:.4f}")
        print(f"    agent:            ${result.agent_cost_usd:.4f}")
        print(f"    eval:             ${result.eval_cost_usd:.4f}")
        if result.unpriced_agent_call_count or result.unpriced_eval_call_count:
            print(
                "  Unpriced calls:     "
                f"{result.unpriced_agent_call_count} agent + "
                f"{result.unpriced_eval_call_count} evaluator/judge"
            )
        print(f"  Total latency:      {result.total_latency_ms / 1000:.2f}s")
        print()
        print("  Mean score per domain:")
        for domain, score in sorted(result.mean_score_per_domain.items()):
            print(f"    {domain:<12} {score:.3f}")
        print("=" * 60 + "\n")


def _extract_tool_call_id(
    agent_turn: MessageTurn,
    action: Action,
    action_index: int,
) -> str | None:
    """Correlate an extracted action with the same-position raw tool call."""
    if not agent_turn.tool_calls:
        return None
    if action_index >= len(agent_turn.tool_calls):
        return None
    call = agent_turn.tool_calls[action_index]
    name = (
        call.get("function", {}).get("name")
        if isinstance(call.get("function"), dict)
        else call.get("name")
    )
    if name == action.name:
        call_id = call.get("id")
        return call_id if isinstance(call_id, str) and call_id else None
    return None
