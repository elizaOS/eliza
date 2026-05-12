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
import hashlib
import json
import logging
import os
import re
from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from .clients.base import BaseClient
from .evaluator import LifeOpsEvaluator
from .lifeworld import EntityKind, LifeWorld
from .lifeworld.entities import Contact, EmailMessage, EmailThread, Reminder
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
    MessageTurn,
    Scenario,
    ScenarioMode,
    ScenarioResult,
    TurnResult,
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
    return (
        f"Current benchmark time: {scenario.now_iso}. "
        "Interpret relative dates against this timestamp, not the wall-clock date.\n\n"
        f"{scenario.instruction}"
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
        raw = kwargs.get("action")
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
    "MESSAGE": (
        "Send, draft, search, triage, or manage messages and email. Use operation=send, "
        "draft_reply, manage, triage, search_inbox, list_channels, read_channel, or "
        "read_with_contact. Use source=gmail for email."
    ),
    "ENTITY": (
        "Manage people and identity records. Use subaction=add, set_identity, "
        "log_interaction, or list."
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
    "ENTITY": ("subaction", ["create", "add", "create_contact", "set_identity", "log_interaction", "list"]),
    "LIFE_CREATE": ("subaction", ["create"]),
    "LIFE_UPDATE": ("subaction", ["update"]),
    "LIFE_DELETE": ("subaction", ["delete"]),
    "LIFE_COMPLETE": ("subaction", ["complete"]),
    "LIFE_SKIP": ("subaction", ["skip"]),
    "LIFE_SNOOZE": ("subaction", ["snooze"]),
    "LIFE_REVIEW": ("subaction", ["review"]),
    "LIFE_UPDATE": ("subaction", ["update"]),
    "SCHEDULED_TASK_UPDATE": ("subaction", ["update"]),
    "SCHEDULED_TASK_SNOOZE": ("subaction", ["snooze"]),
    # All six spellings used across scenarios, scorer, and TS backend:
    # - "trend" (singular) appears in health_batch_001 GT scenarios
    # - "trends" (plural) appears in older runner fixture
    # - "today" / "status" / "summary" match the TS health.ts surface
    "HEALTH": ("subaction", ["by_metric", "summary", "trends", "trend", "today", "status"]),
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

    if action_name == "LIFE_CREATE":
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
                "Example: [{\"name\": \"passenger_1\", \"seat_class\": \"economy\"}]. "
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
    manifest_path = Path(__file__).resolve().parents[1] / "manifests" / "actions.manifest.json"
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    actions = raw.get("actions") if isinstance(raw, dict) else None
    if not isinstance(actions, list):
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


def build_tool_manifest(_world: LifeWorld) -> list[dict[str, Any]]:
    """Build the OpenAI-compatible tool manifest for the current LifeOps world.

    Only OpenAI-compatible function names are exposed. The runner still
    executes legacy dotted actions such as ``CALENDAR.create`` when adapters
    produce them, but those names are not valid function identifiers for
    Cerebras/OpenAI-style tool schemas.
    """
    tools: list[dict[str, Any]] = []
    for action_name in sorted(supported_actions()):
        if _OPENAI_FUNCTION_NAME_RE.fullmatch(action_name) is None:
            continue
        registry_tool = _registry_tool_for_action(action_name)
        if registry_tool is not None:
            tools.append(registry_tool)
            continue
        tools.append(
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
            }
        )
    return tools


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _required(
    kwargs: dict[str, Any], key: str, *, action: str, sub: str
) -> Any:
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
            item.strip()
            for item in value
            if isinstance(item, str) and item.strip()
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


def _h_calendar_create(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
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


def _h_calendar_reschedule(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    event = world.move_event(kw["event_id"], start=kw["start"], end=kw["end"])
    return {"id": event.id, "start": event.start, "end": event.end}


def _h_calendar_cancel(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
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
    msg = world.archive_email(kw["message_id"])
    return {"id": msg.id, "folder": msg.folder}


def _h_mail_mark_read(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    msg = world.mark_read(kw["message_id"])
    return {"id": msg.id, "is_read": msg.is_read}


def _h_mail_star(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    msg = world.star_email(kw["message_id"], starred=kw.get("starred", True))
    return {"id": msg.id, "is_starred": msg.is_starred}


def _h_mail_trash(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    msg = world.trash_email(kw["message_id"])
    return {"id": msg.id, "folder": msg.folder}


def _h_message_send_simple(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
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


def _h_contact_update(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    contact_id = kw["id"]
    patches = {k: v for k, v in kw.items() if k != "id"}
    updated = world.update(EntityKind.CONTACT, contact_id, **patches)
    return {"id": updated.id}


def _h_contact_delete(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    world.delete(EntityKind.CONTACT, kw["id"])
    return {"id": kw["id"], "deleted": True}


def _h_reminder_create(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
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


def _h_reminder_complete(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    reminder_id = kw.get("reminder_id") or kw.get("reminderId") or kw.get("id") or kw.get("target")
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
            or _synthetic_id("event_auto", {"t": title, "s": start, "e": end, "c": calendar_id})
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
                    "noop": True,
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
    if sub in {"propose_times", "update_preferences"}:
        # Planner-config subactions; LifeWorld has no place to persist these,
        # so they're no-ops by design. State hash matches because both replays
        # are no-ops.
        return {"subaction": sub, "ok": True, "noop": True}
    raise UnsupportedAction(
        f"unsupported action in execute path: CALENDAR/{sub} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


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
    if op in {
        "triage",
        "search_inbox",
        "list_channels",
        "read_channel",
        "read_with_contact",
    }:
        return {"operation": op, "source": source, "ok": True, "noop": True}
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
    thread_id = kw.get("threadId") or kw.get("thread_id") or _synthetic_id(
        "thread_auto", {"to": sorted(to_emails), "s": subject}
    )
    message_id = kw.get("messageId") or kw.get("message_id") or kw.get("id") or _synthetic_id(
        "email_auto", {"th": thread_id, "b": body, "s": subject}
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
        # Drafts on chat channels aren't modeled — treat as no-op so state
        # match still works. Add a non-mail draft store if scenarios need one.
        return {"operation": "draft_reply", "source": source, "ok": True, "noop": True}
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
    thread_id = parent.thread_id if parent is not None else _synthetic_id(
        "thread_auto", {"p": parent_id}
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
    msg = world.create_draft_email(
        message_id=draft_id,
        thread_id=thread_id,
        from_email=from_email,
        to_emails=to_emails,
        subject=subject,
        body_plain=body,
    )
    return {"id": msg.id, "folder": msg.folder, "thread_id": msg.thread_id}


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
    msg_id = kw.get("messageId") or kw.get("message_id") or kw.get("id") or kw.get("target")
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
        )
        world.add(EntityKind.CONTACT, contact)
        return {"id": contact.id}
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
    if sub in {"log_interaction", "list"}:
        # No interaction-log entity in LifeWorld; treat list/log_interaction
        # as read-only no-ops so state hash matches.
        return {"subaction": sub, "ok": True, "noop": True}
    raise UnsupportedAction(
        f"unsupported action in execute path: ENTITY/{sub} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


def _u_life_create(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """LIFE_CREATE umbrella — covers reminders, alarms, workouts, health metrics."""
    sub = _required(kw, "subaction", action=name, sub="<missing>")
    if sub != "create":
        raise UnsupportedAction(
            f"unsupported action in execute path: LIFE_CREATE/{sub} — file gap in LIFEOPS_BENCH_GAPS.md"
        )
    title = kw.get("title") or "Untitled"
    details = _details(kw)
    detail_kind = details.get("kind") or kw.get("kind") or "reminder"
    if detail_kind in {"reminder", "alarm"}:
        list_id = (
            details.get("listId")
            or details.get("list_id")
            or kw.get("listId")
            or kw.get("list_id")
            or "list_personal"
        )
        if list_id not in world.reminder_lists:
            raise KeyError(
                f"LIFE_CREATE references unknown reminder list '{list_id}' "
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
        reminder_id = _synthetic_id(
            "reminder_auto",
            {"t": title, "l": list_id, "d": due_at, "kind": detail_kind},
        )
        reminder = world.create_reminder(
            reminder_id=reminder_id,
            list_id=list_id,
            title=title,
            due_at=due_at,
        )
        return {"id": reminder.id, "title": reminder.title}
    if detail_kind == "workout":
        # Persist as a Note so the world hash captures the workout entry.
        note_id = _synthetic_id(
            "note_workout",
            {
                "t": title,
                "d": details.get("distanceKm"),
                "m": details.get("durationMinutes"),
                "o": details.get("occurredAtIso"),
            },
        )
        body = json.dumps(
            {k: details[k] for k in sorted(details) if k != "kind"},
            sort_keys=True,
            default=str,
        )
        note = world.create_note(
            note_id=note_id,
            title=title,
            body_markdown=body,
            tags=["workout"],
        )
        return {"id": note.id, "kind": "workout"}
    if detail_kind == "health_metric":
        metric_type = _required(details, "metric", action=name, sub="create/health_metric")
        value = float(_required(details, "value", action=name, sub="create/health_metric"))
        metric_id = _synthetic_id(
            "hm_auto",
            {"m": metric_type, "v": value, "o": details.get("occurredAtIso")},
        )
        metric = world.log_health_metric(
            metric_id=metric_id,
            metric_type=metric_type,
            value=value,
            recorded_at=details.get("occurredAtIso"),
        )
        return {"id": metric.id, "metric": metric.metric_type, "value": metric.value}
    raise UnsupportedAction(
        f"unsupported action in execute path: LIFE_CREATE/create/{detail_kind} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


def _u_life_complete(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    sub = kw.get("subaction", "complete")
    target = _required(kw, "target", action=name, sub=sub)
    if target.startswith("reminder_"):
        reminder = world.complete_reminder(target)
        return {"id": reminder.id, "completed_at": reminder.completed_at}
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
    new_due = _shift_iso(base, minutes=minutes)
    reminder = world.snooze_reminder(target, new_due_at=new_due)
    return {"id": reminder.id, "due_at": reminder.due_at}


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
    if isinstance(list_id, str) and list_id in world.reminder_lists:
        updated = world.touch_reminder_list_reviewed(list_id)
        return {"subaction": sub, "ok": True, "list_id": list_id, "last_reviewed_at": updated.last_reviewed_at}
    # No list_id provided or list not in seed — still stamp all known lists.
    for lid in list(world.reminder_lists):
        world.touch_reminder_list_reviewed(lid)
    return {"subaction": sub, "ok": True, "last_reviewed_at": world.now_iso}


def _u_life_delete(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """LIFE_DELETE — id-based deletion of reminders / alarms.

    When ``target`` is a real ``reminder_*`` id, delete it. When the LLM
    targets an "alarm definition" by title (no real id in LifeWorld), this
    is a no-op — alarm definitions aren't a modeled entity kind, and the
    state-hash match holds because both replays no-op identically.
    """
    target = kw.get("target")
    if isinstance(target, str) and target.startswith("reminder_") and target in world.reminders:
        world.delete(EntityKind.REMINDER, target)
        return {"id": target, "deleted": True}
    return {
        "subaction": kw.get("subaction", "delete"),
        "ok": True,
        "noop": True,
        "reason": "no concrete id; alarm definitions not modeled",
    }


def _u_life_update(_world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """LIFE_UPDATE on alarm/reminder definitions — no-op (definitions not modeled)."""
    return {"subaction": kw.get("subaction", "update"), "ok": True, "noop": True}


def _u_life_skip(_world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """LIFE_SKIP — skip one occurrence; modeled as a no-op (no skip log entity)."""
    return {"subaction": kw.get("subaction", "skip"), "ok": True, "noop": True}


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
    raw = kw.get("trigger")
    trigger = dict(raw) if isinstance(raw, dict) else {}
    at = (
        kw.get("atIso")
        or kw.get("at_iso")
        or kw.get("dueAt")
        or kw.get("due_at")
        or kw.get("due")
    )
    if isinstance(at, str) and at:
        trigger.setdefault("atIso", at)
    return trigger


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
    """Apply SCHEDULED_TASK_UPDATE/SNOOZE to the benchmark task store.

    Some static scenarios target production task ids that are not pre-seeded
    in LifeWorld. We materialize a placeholder before applying the mutation so
    the final hash records the id and structural update instead of granting a
    free no-op match.
    """
    task_id = _scheduled_task_id(kw)
    if not task_id:
        raise KeyError(f"{name} needs taskId/task_id/id/target")
    existing = world.scheduled_tasks.get(task_id)
    if existing is None:
        existing = world.create_scheduled_task(
            task_id=task_id,
            kind=str(kw.get("kind") or "unknown"),
            prompt_instructions=str(
                kw.get("promptInstructions")
                or kw.get("prompt_instructions")
                or kw.get("title")
                or "Unseeded scheduled task"
            ),
            trigger={},
            metadata={"materialized_from": name},
        )

    if name.endswith("SNOOZE"):
        minutes_raw = kw.get("minutes") or kw.get("durationMinutes") or kw.get("duration")
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
        existing = world.create_scheduled_task(
            task_id=task_id,
            kind=str(kw.get("kind") or "unknown"),
            prompt_instructions=str(
                kw.get("promptInstructions")
                or kw.get("prompt_instructions")
                or kw.get("title")
                or "Unseeded scheduled task"
            ),
            trigger=_scheduled_task_trigger(kw),
            metadata={"materialized_from": name},
        )
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


def _u_scheduled_tasks(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    op = str(kw.get("operation") or kw.get("action") or kw.get("subaction") or "list")
    op = {
        "ack": "acknowledge",
        "create_task": "create",
        "list_tasks": "list",
    }.get(op, op)
    if op == "create":
        return _u_scheduled_task_create(world, kw, "SCHEDULED_TASK_CREATE")
    if op in {"update", "snooze"}:
        return _u_scheduled_task_mutate(
            world, kw, f"SCHEDULED_TASK_{op.upper()}"
        )
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


def _u_health(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """HEALTH umbrella — read-only for state-hash purposes.

    ``by_metric`` subaction returns deduplicated data points from world health
    metrics, preferring the most specific source when multiple sources overlap
    on the same (metric_type, date) key:

      - For sleep metrics: oura > apple-health > fitbit > manual
      - For steps / other activity metrics: apple-health > oura > fitbit > manual

    The ``source_used`` metadata field indicates which source won the
    deduplication. All other subactions (summary, trends, today, status) are
    pure no-ops for state-hash purposes.
    """
    subaction = kw.get("subaction", "by_metric")
    if subaction != "by_metric":
        return {"subaction": subaction, "ok": True, "noop": True}

    metric_type = (kw.get("metric") or "").strip().lower()

    # Source priority: higher index = higher priority (preferred winner).
    # Sleep metrics: Oura Ring is the gold standard for sleep tracking.
    # Activity metrics (steps, calories, …): Apple Health (HealthKit) has
    # broader device support and is the default on-device aggregator.
    _SLEEP_SOURCE_PRIORITY: list[str] = [
        "manual", "fitbit", "apple-health", "oura"
    ]
    _ACTIVITY_SOURCE_PRIORITY: list[str] = [
        "manual", "fitbit", "oura", "apple-health"
    ]
    is_sleep_metric = metric_type in {"sleep_hours", "sleep"}
    source_priority = _SLEEP_SOURCE_PRIORITY if is_sleep_metric else _ACTIVITY_SOURCE_PRIORITY

    def _source_rank(src: str) -> int:
        try:
            return source_priority.index(src)
        except ValueError:
            return -1  # unknown sources lose to all known ones

    # Collect matching metrics, optionally filtered by metric_type.
    raw_metrics = list(world.health_metrics.values())
    if metric_type:
        raw_metrics = [m for m in raw_metrics if m.metric_type == metric_type]

    # Dedup by (metric_type, date-bucket) — keep the highest-priority source.
    # Use the date portion of `recorded_at` as the bucket so intraday samples
    # from different sources for the same calendar day are collapsed.
    best: dict[tuple[str, str], Any] = {}
    for m in raw_metrics:
        date_bucket = m.recorded_at[:10]  # YYYY-MM-DD prefix
        key = (m.metric_type, date_bucket)
        existing = best.get(key)
        if existing is None or _source_rank(m.source) > _source_rank(existing.source):
            best[key] = m

    data_points = [
        {
            "id": m.id,
            "metric_type": m.metric_type,
            "value": m.value,
            "recorded_at": m.recorded_at,
            "source": m.source,
        }
        for m in sorted(best.values(), key=lambda x: x.recorded_at)
    ]

    # Surface the dominant source so the scorer / agent can inspect provenance.
    sources_used = sorted({m["source"] for m in data_points})
    source_used = sources_used[0] if len(sources_used) == 1 else "multi"

    return {
        "subaction": "by_metric",
        "ok": True,
        "metric": metric_type or "all",
        "data": data_points,
        "count": len(data_points),
        "source_used": source_used,
    }


def _u_money_readonly(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """MONEY_* read-only verbs — dashboard, list_transactions, list_sources, etc.

    Every MONEY_* verb that doesn't mutate state lands here. The MONEY umbrella picks
    the right behavior on ``subaction`` so the same handler is shared
    between e.g. ``MONEY``, ``MONEY_DASHBOARD``, ``MONEY_LIST_TRANSACTIONS``.

    For ``list_transactions``, apply ``category``, ``start_date`` / ``end_date``,
    and ``merchantContains`` filters so scenarios that pass these params get
    a real filtered result instead of a no-op that masks incorrect agent calls.
    State hash is unchanged (read-only), but the result payload now reflects the
    actual filter — agents that skip filtering get a different (larger) result
    than agents that correctly narrow by category/date.
    """
    subaction = kw.get("subaction", "dashboard")
    if subaction != "list_transactions":
        return {"subaction": subaction, "ok": True, "noop": True}

    # --- list_transactions: filter transactions by category / date range ---
    transactions = list(world.transactions.values())

    category = (kw.get("category") or "").strip().lower()
    start_date: str | None = kw.get("start_date") or kw.get("startDate") or None  # type: ignore[assignment]
    end_date: str | None = kw.get("end_date") or kw.get("endDate") or None  # type: ignore[assignment]
    merchant_contains: str = (kw.get("merchantContains") or kw.get("merchant") or "").strip().lower()
    only_debits: bool = bool(kw.get("onlyDebits") or kw.get("only_debits"))
    window_days: int | None = None
    raw_window = kw.get("windowDays") or kw.get("window_days")
    if isinstance(raw_window, (int, float)) and raw_window > 0:
        window_days = int(raw_window)

    # Resolve window_days into a start_date when no explicit start_date given.
    if window_days is not None and start_date is None:
        from datetime import datetime, timedelta, timezone as _tz
        now_dt = datetime.fromisoformat(world.now_iso.replace("Z", "+00:00"))
        start_dt = now_dt - timedelta(days=window_days)
        start_date = start_dt.isoformat()

    filtered = []
    for txn in transactions:
        if category and txn.category.lower() != category:
            continue
        if merchant_contains and merchant_contains not in txn.merchant.lower():
            continue
        if only_debits and txn.amount_cents >= 0:
            continue
        posted = txn.posted_at
        if start_date and posted < start_date:
            continue
        if end_date and posted > end_date:
            continue
        filtered.append(
            {
                "id": txn.id,
                "merchant": txn.merchant,
                "category": txn.category,
                "amount_cents": txn.amount_cents,
                "posted_at": txn.posted_at,
                "is_pending": txn.is_pending,
            }
        )

    filtered.sort(key=lambda t: t["posted_at"], reverse=True)
    return {
        "subaction": "list_transactions",
        "ok": True,
        "transactions": filtered,
        "count": len(filtered),
    }


def _u_money_subscription_audit(
    _world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """MONEY_SUBSCRIPTION_AUDIT — read-only no-op."""
    return {"subaction": kw.get("subaction", "audit"), "ok": True, "noop": True}


def _u_money_subscription_cancel(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """Cancel a subscription. Resolves by serviceSlug first, then serviceName.

    """
    if not bool(kw.get("confirmed", False)):
        return {"subaction": "cancel", "ok": True, "noop": True, "reason": "unconfirmed"}
    slug = (kw.get("serviceSlug") or "").lower()
    service_name = (kw.get("serviceName") or "").lower()
    target_id: str | None = None
    for sid, sub in world.subscriptions.items():
        sub_name = sub.name.lower()
        if slug and sub_name.replace(" ", "-").replace("+", "-plus") == slug:
            target_id = sid
            break
        if service_name and service_name == sub_name:
            target_id = sid
            break
    if target_id is None:
        for sid, sub in world.subscriptions.items():
            sub_name = sub.name.lower()
            if service_name and (service_name in sub_name or sub_name in service_name):
                target_id = sid
                break
    if target_id is None:
        raise KeyError(
            f"MONEY_SUBSCRIPTION_CANCEL: no subscription matched name='{kw.get('serviceName')}' "
            f"slug='{kw.get('serviceSlug')}' (have {sorted(world.subscriptions)})"
        )
    sub = world.cancel_subscription(target_id)
    return {"id": sub.id, "status": sub.status}


def _u_book_travel(_world: LifeWorld, _kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """BOOK_TRAVEL returns offers without booking — no state mutation."""
    return {"action": "BOOK_TRAVEL", "ok": True, "noop": True}


def _u_block(_world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """BLOCK_* family — focus blocks (apps + websites).

    The same handler honors both
    ``packageNames`` (app blocks) and ``hostnames`` (website blocks) so
    every BLOCK_* verb (BLOCK, BLOCK_BLOCK, BLOCK_LIST_ACTIVE,
    BLOCK_RELEASE, BLOCK_STATUS, BLOCK_UNBLOCK, BLOCK_REQUEST_PERMISSION)
    routes here.

    Focus-block sessions are not yet modeled in LifeWorld — every BLOCK_*
    is a read-only no-op for state-hash purposes.

    Kwarg canonicalization (P2-6): agents emit app target under several
    spellings. Normalize all variants to ``bundle_id`` internally so the
    scorer can compare consistently regardless of which name was used:

      - ``app_name``   → ``bundle_id``
      - ``identifier`` → ``bundle_id``
      - ``name``       → ``bundle_id`` (when not already a bundle-id form)
    """
    # Resolve bundle_id from whichever kwarg spelling the agent chose.
    bundle_id: str | None = (
        kw.get("bundle_id")
        or kw.get("app_name")
        or kw.get("identifier")
        or kw.get("name")
        or None
    )
    result: dict[str, Any] = {"subaction": kw.get("subaction", "block"), "ok": True, "noop": True}
    if bundle_id is not None:
        result["bundle_id"] = bundle_id
    return result


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
    task_id = _scheduled_task_id(kw) or _synthetic_id(
        "task_auto",
        {
            "k": kw.get("kind", "reminder"),
            "p": prompt,
            "trig": trigger,
            "subject": kw.get("subject"),
            "output": kw.get("output"),
        },
    )
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


def _duration_minutes(kw: dict[str, Any], details: dict[str, Any], fallback: int) -> int:
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
        match = re.fullmatch(r"\s*(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours)?\s*", raw)
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
                    wanted_tokens.issubset(
                        _meaningful_title_tokens(event.title)
                    )
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
    return datetime(parsed_date.year, parsed_date.month, parsed_date.day, tzinfo=timezone.utc)


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
        kw.get("date")
        or details.get("date")
        or kw.get("when")
        or details.get("when")
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
    # BLOCK_* family.
    # All BLOCK_* verbs share one handler — focus-block sessions aren't
    # modeled in LifeWorld yet, so every BLOCK_* is a read-only no-op.
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
    "REPLY": lambda _world, kw, _name: {"ok": True, "noop": True, "reply": kw},
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
        evaluator_model: str = "gpt-oss-120b",
        judge_model: str = "claude-opus-4-7",
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
    ) -> None:
        if agent_fn is None and agent_factory is None:
            raise ValueError("LifeOpsBenchRunner requires agent_fn or agent_factory")
        if world_factory is None:
            raise ValueError("LifeOpsBenchRunner requires world_factory")
        self.agent_fn = agent_fn
        self.agent_factory = agent_factory
        self.world_factory = world_factory
        self.evaluator_model = evaluator_model
        self.judge_model = judge_model
        self.concurrency = concurrency
        self.seeds = seeds
        self.max_cost_usd = max_cost_usd
        self.per_scenario_timeout_s = per_scenario_timeout_s
        self.live_judge_min_turn = live_judge_min_turn
        self.abort_on_budget_exceeded = abort_on_budget_exceeded

        if scenarios is not None:
            self.scenarios = scenarios
        else:
            from .scenarios import ALL_SCENARIOS

            self.scenarios = ALL_SCENARIOS

        # The evaluator is required only for LIVE scenarios. STATIC-only runs
        # may construct the runner without clients (back-compat). When LIVE
        # scenarios are scheduled and no evaluator is wired, we fail loudly
        # at run time rather than silently skipping the live judge.
        if evaluator is not None:
            self.evaluator: LifeOpsEvaluator | None = evaluator
        elif simulated_user_client is not None and judge_client is not None:
            self.evaluator = LifeOpsEvaluator(
                simulated_user_client=simulated_user_client,
                judge_client=judge_client,
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
            logger.warning(
                "No scenarios matched filters (domain=%s, mode=%s)", domain, mode
            )

        semaphore = asyncio.Semaphore(self.concurrency)
        tasks: list[Awaitable[ScenarioResult]] = []
        for scenario in scenarios:
            for seed_offset in range(self.seeds):
                seed = scenario.world_seed + seed_offset
                tasks.append(self._run_one_guarded(semaphore, scenario, seed))

        results = await asyncio.gather(*tasks)
        scenarios_by_id = {s.id: s for s in scenarios}
        bench_result = compile_benchmark_result(
            list(results),
            scenarios_by_id,
            seeds=self.seeds,
            model_name=self.evaluator_model,
            judge_model_name=self.judge_model,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        # Attach the agent / eval cost split. ``compile_benchmark_result``
        # only sees per-turn agent cost, so fold the eval ledger in here so
        # the headline matches the wall budget.
        bench_result.agent_cost_usd = self._agent_spent_usd
        bench_result.eval_cost_usd = self._eval_spent_usd
        bench_result.total_cost_usd = self._agent_spent_usd + self._eval_spent_usd
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
            try:
                return await asyncio.wait_for(
                    self.run_one(scenario, seed),
                    timeout=self.per_scenario_timeout_s,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "Scenario %s seed=%d timed out after %ds",
                    scenario.id,
                    seed,
                    self.per_scenario_timeout_s,
                )
                return self._failure_result(scenario, seed, "timeout", "timed out")
            except CostBudgetExceeded as exc:
                logger.error("Cost budget exceeded on %s seed=%d: %s", scenario.id, seed, exc)
                return self._failure_result(scenario, seed, "cost_exceeded", str(exc))
            except Exception as exc:  # noqa: BLE001 - boundary translates to typed result
                logger.exception("Scenario %s seed=%d errored", scenario.id, seed)
                return self._failure_result(scenario, seed, "error", str(exc))

    async def run_one(self, scenario: Scenario, seed: int) -> ScenarioResult:
        """Run a single scenario at a single seed and return its result.

        STATIC mode opens with the persona's instruction and ends as soon as
        the agent responds with no tool calls (after one optional first-question
        fallback). LIVE mode adds a simulated-user turn on every executor reply
        and consults the judge starting at ``live_judge_min_turn`` to decide
        whether the persona's goal is satisfied. LIVE scenarios may also carry
        ``Disruption`` entries that mutate the world after the named turn.
        """
        if scenario.mode is ScenarioMode.LIVE and self.evaluator is None:
            raise RuntimeError(
                f"scenario {scenario.id} is LIVE but no evaluator was wired; "
                "construct LifeOpsBenchRunner with simulated_user_client and judge_client."
            )

        world = self.world_factory(seed, scenario.now_iso)
        history: list[MessageTurn] = [
            MessageTurn(role="user", content=_initial_user_content(scenario)),
        ]
        turns: list[TurnResult] = []
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

        for turn_number in range(1, scenario.max_turns + 1):
            tool_manifest = build_tool_manifest(world)
            agent_turn = await active_agent_fn(list(history), tool_manifest)
            history.append(agent_turn)

            agent_actions = _extract_actions_from_turn(agent_turn)
            tool_results: list[dict[str, Any]] = []
            for action in agent_actions:
                # Execution failures don't crash the run — we surface them as
                # tool-error messages and let scoring penalize via state mismatch.
                tool_call_id = _extract_tool_call_id(agent_turn, action)
                try:
                    result_payload = _execute_action(action, world)
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
                    logger.warning("Unsupported action in scenario %s: %s", scenario.id, exc)
                    error_payload = {"error": "unsupported_action", "message": str(exc)}
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
                except (KeyError, ValueError, TypeError) as exc:
                    logger.warning(
                        "Action %s failed in scenario %s: %s", action.name, scenario.id, exc
                    )
                    error_payload = {"error": "execution_failed", "message": str(exc)}
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
            await self._charge(
                agent_cost if agent_cost is not None else 0.0,
                scenario.id,
                seed,
                bucket="agent",
            )

            latency_raw = getattr(agent_turn, "latency_ms", None)
            latency_value: int | None = (
                int(latency_raw)
                if isinstance(latency_raw, (int, float))
                else None
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
                int(cache_read_attr) if isinstance(cache_read_attr, (int, float)) else None
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
                model_name=getattr(agent_turn, "model_name", None),
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
                    user_turn = await self._next_static_user_turn(
                        scenario, agent_turn, turn_number
                    )
                    if user_turn is None:
                        terminated_reason = "respond"
                        turns.append(turn_result)
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

                pre_eval_cost = self.evaluator.cost_usd  # type: ignore[union-attr]
                if turn_number >= self.live_judge_min_turn:
                    satisfied, _reason = await self.evaluator.judge_satisfaction(  # type: ignore[union-attr]
                        scenario, history, world
                    )
                    await self._charge(
                        self.evaluator.cost_usd - pre_eval_cost,  # type: ignore[union-attr]
                        scenario.id,
                        seed,
                        bucket="eval",
                    )
                    pre_eval_cost = self.evaluator.cost_usd  # type: ignore[union-attr]
                    if satisfied:
                        terminated_reason = "satisfied"
                        turns.append(turn_result)
                        break

                # Always advance the conversation by one user turn in LIVE
                # mode (judge said NO, or we haven't started judging yet).
                user_turn = await self.evaluator.simulate_user_turn(  # type: ignore[union-attr]
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
                    self.evaluator.cost_usd - pre_eval_cost,  # type: ignore[union-attr]
                    scenario.id,
                    seed,
                    bucket="eval",
                )

            turns.append(turn_result)

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

        substring_matches = output_substring_match(history, scenario.required_outputs)
        result = ScenarioResult(
            scenario_id=scenario.id,
            seed=seed,
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
            total_cost_usd=sum(
                t.cost_usd for t in turns if t.cost_usd is not None
            ),
            total_latency_ms=sum(
                t.latency_ms for t in turns if t.latency_ms is not None
            ),
            error=None,
        )
        result.total_score = score_scenario(result, scenario)
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

        Failures here are logged and swallowed: a disruption that can't apply
        (e.g. an event_id that doesn't exist in the seed) shouldn't crash the
        whole live run. The note is still emitted so the persona at least
        mentions what was supposed to happen.
        """
        notes: list[str] = []
        for d in disruptions:
            try:
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
                    # Pure conversational perturbation — no world mutation.
                    pass
                else:
                    raise ValueError(f"unknown disruption kind: {d.kind!r}")
            except (KeyError, ValueError, TypeError) as exc:
                logger.warning("Disruption %s failed to apply: %s", d.kind, exc)

            if d.note_for_user:
                notes.append(d.note_for_user)

        return "\n".join(notes)

    async def _next_static_user_turn(
        self,
        scenario: Scenario,
        agent_turn: MessageTurn,
        turn_number: int,
    ) -> MessageTurn | None:
        """STATIC mode: only respond on the FIRST agent turn if the fallback applies; otherwise terminate.

        STATIC-only runs may construct the runner without an evaluator — in
        that case we apply the scenario's fallback directly so the conformance
        suite doesn't require live LLM clients.
        """
        if turn_number != 1:
            return None
        if self.evaluator is not None:
            return await self.evaluator.apply_first_question_fallback(
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

    @staticmethod
    def _failure_result(
        scenario: Scenario,
        seed: int,
        reason: str,
        message: str,
    ) -> ScenarioResult:
        return ScenarioResult(
            scenario_id=scenario.id,
            seed=seed,
            turns=[],
            state_hash_match=False,
            output_substring_matches=[False] * len(scenario.required_outputs),
            total_score=0.0,
            max_score=1.0,
            terminated_reason=reason,  # type: ignore[arg-type]
            total_cost_usd=0.0,
            total_latency_ms=0,
            error=message,
        )

    @staticmethod
    def save_results(
        result: BenchmarkResult,
        output_dir: str = "lifeops_bench_results",
    ) -> str:
        """Serialize a BenchmarkResult to JSON under `output_dir` and return the path."""
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(result.model_name)).strip("-") or "model"
        path = os.path.join(output_dir, f"lifeops_{safe}_{timestamp}.json")

        def _serialize(obj: Any) -> Any:
            if hasattr(obj, "__dataclass_fields__"):
                return {k: _serialize(v) for k, v in obj.__dict__.items()}
            if isinstance(obj, list):
                return [_serialize(item) for item in obj]
            if isinstance(obj, dict):
                return {k: _serialize(v) for k, v in obj.items()}
            if hasattr(obj, "value"):
                return obj.value
            return obj

        with open(path, "w") as fh:
            json.dump(_serialize(result), fh, indent=2, default=str)
        logger.info("Results saved to %s", path)
        return path

    @staticmethod
    def print_summary(result: BenchmarkResult) -> None:
        """Print a human-readable summary."""
        print("\n" + "=" * 60)
        print("  LifeOpsBench Results Summary")
        print("=" * 60)
        print(f"  Model:              {result.model_name}")
        print(f"  Judge:              {result.judge_model_name}")
        print(f"  Seeds per scenario: {result.seeds}")
        print(f"  Scenarios run:      {len(result.scenarios)}")
        print(f"  pass@1:             {result.pass_at_1:.3f}")
        print(f"  pass@k:             {result.pass_at_k:.3f}")
        print(f"  Total cost:         ${result.total_cost_usd:.4f}")
        print(f"    agent:            ${result.agent_cost_usd:.4f}")
        print(f"    eval:             ${result.eval_cost_usd:.4f}")
        print(f"  Total latency:      {result.total_latency_ms / 1000:.2f}s")
        print()
        print("  Mean score per domain:")
        for domain, score in sorted(result.mean_score_per_domain.items()):
            print(f"    {domain:<12} {score:.3f}")
        print("=" * 60 + "\n")


def _extract_tool_call_id(agent_turn: MessageTurn, action: Action) -> str | None:
    """Find the tool_call_id matching `action.name` in the assistant turn."""
    if not agent_turn.tool_calls:
        return None
    for call in agent_turn.tool_calls:
        name = (
            call.get("function", {}).get("name")
            if isinstance(call.get("function"), dict)
            else call.get("name")
        )
        if name == action.name:
            return call.get("id")
    return None
