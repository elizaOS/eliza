"""LifeWorld executor action semantics."""

from __future__ import annotations
import json
import re
from collections.abc import Callable
from copy import deepcopy
from datetime import timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any
from .world import LifeWorld
from ..types import Action, TrustedEvidenceRequirement
from .action_calendar import (
    _h_calendar_cancel,
    _h_calendar_create,
    _h_calendar_reschedule,
    _u_calendar,
    _u_calendar_sources,
)
from .action_common import UnsupportedAction, _try_parse_iso, logger
from .action_contacts import (
    _h_contact_add,
    _h_contact_delete,
    _h_contact_update,
    _u_entity,
)
from .action_focus import _u_block
from .action_health import _u_health
from .action_messages import (
    _h_mail_archive,
    _h_mail_archive_thread,
    _h_mail_mark_read,
    _h_mail_send,
    _h_mail_star,
    _h_mail_trash,
    _h_message_send_simple,
    _u_message,
)
from .action_money import (
    _u_money_readonly,
    _u_money_subscription_audit,
    _u_money_subscription_cancel,
)
from .action_tasks import (
    _h_note_create,
    _h_reminder_complete,
    _h_reminder_create,
    _u_life_complete,
    _u_life_create,
    _u_life_delete,
    _u_life_review,
    _u_life_skip,
    _u_life_snooze,
    _u_life_update,
    _u_scheduled_task_create,
    _u_scheduled_task_mutate,
    _u_scheduled_task_state,
    _u_scheduled_tasks,
    _u_scheduled_tasks_readonly,
)
from .action_travel import _u_book_travel


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
                        "Exact connector account id copied from a fresh list result."
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
        Path(__file__).resolve().parents[2] / "manifests" / "actions.manifest.json"
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
