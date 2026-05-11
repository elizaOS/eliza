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
from datetime import datetime, timedelta, timezone
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
    handler = _ACTION_HANDLERS.get(action.name)
    if handler is None:
        raise UnsupportedAction(
            f"unsupported action in execute path: {action.name} — file gap in LIFEOPS_BENCH_GAPS.md"
        )
    return handler(world, action.kwargs, action.name)


def supported_actions() -> set[str]:
    """Return every action name the executor knows how to apply against a LifeWorld."""
    return set(_ACTION_HANDLERS.keys())


_OPENAI_FUNCTION_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_TOOL_DESCRIPTIONS: dict[str, str] = {
    "CALENDAR": (
        "Read or mutate calendar state. Use subaction=create_event, update_event, "
        "delete_event, propose_times, search_events, check_availability, next_event, "
        "or update_preferences."
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
        "Create personal life records such as reminders, alarms, workouts, or health "
        "metrics. Use subaction=create and put typed fields in details."
    ),
    "LIFE_COMPLETE": "Complete a target, usually a reminder. Include target.",
    "LIFE_SNOOZE": "Snooze a reminder-like target. Include target and minutes.",
    "LIFE_REVIEW": "Review life records without mutating state.",
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
    "BLOCK": "Route a focus-blocking action.",
    "BLOCK_BLOCK": "Create a focus block for apps or websites.",
    "BLOCK_UNBLOCK": "Remove a focus block for apps or websites.",
    "BLOCK_LIST_ACTIVE": "List active focus blocks.",
    "BLOCK_RELEASE": "Release a focus block.",
    "BLOCK_STATUS": "Read focus-block status.",
    "BLOCK_REQUEST_PERMISSION": "Request permission to create or change a focus block.",
    "SCHEDULED_TASK_CREATE": (
        "Create a scheduled task. Include kind, trigger, promptInstructions, and "
        "other structured task fields when known."
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
    "ENTITY": ("subaction", ["add", "set_identity", "log_interaction", "list"]),
    "LIFE_CREATE": ("subaction", ["create"]),
    "LIFE_COMPLETE": ("subaction", ["complete"]),
    "LIFE_SNOOZE": ("subaction", ["snooze"]),
    "LIFE_REVIEW": ("subaction", ["review"]),
    "HEALTH": ("subaction", ["by_metric", "summary", "trends"]),
}


def _tool_parameters_for_action(action_name: str) -> dict[str, Any]:
    """Return a permissive JSON Schema for a LifeOps action.

    The schema intentionally requires only the action discriminator where one
    exists. LifeOps scenarios use a broad, evolving action vocabulary, and a
    too-strict schema would reject valid benchmark kwargs before the executor
    can apply its own deterministic checks.
    """
    schema: dict[str, Any] = {
        "type": "object",
        "properties": {},
        "additionalProperties": True,
    }
    discriminator = _DISCRIMINATORS.get(action_name)
    if discriminator is None:
        return schema
    field, values = discriminator
    schema["properties"] = {
        field: {
            "type": "string",
            "enum": values,
            "description": f"LifeOps {action_name} discriminator.",
        }
    }
    schema["required"] = [field]
    return schema


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
    reminder = world.create_reminder(
        reminder_id=kw["reminder_id"],
        list_id=kw["list_id"],
        title=kw["title"],
        notes=kw.get("notes", ""),
        due_at=kw.get("due_at"),
        priority=kw.get("priority", "none"),
        tags=kw.get("tags"),
    )
    return {"id": reminder.id}


def _h_reminder_complete(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    reminder = world.complete_reminder(kw["reminder_id"])
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
    sub = _required(kw, "subaction", action=name, sub="<missing>")
    details = _details(kw)
    if sub == "create_event":
        calendar_id = details.get("calendarId") or kw.get("calendarId")
        start = details.get("start") or kw.get("start")
        end = details.get("end") or kw.get("end")
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
        event_id = _required(details, "eventId", action=name, sub=sub)
        start = _required(details, "start", action=name, sub=sub)
        end = _required(details, "end", action=name, sub=sub)
        event = world.move_event(event_id, start=start, end=end)
        return {"id": event.id, "start": event.start, "end": event.end}
    if sub == "delete_event":
        event_id = _required(details, "eventId", action=name, sub=sub)
        event = world.cancel_event(event_id)
        return {"id": event.id, "status": event.status}
    if sub in {
        "propose_times",
        "search_events",
        "check_availability",
        "next_event",
        "update_preferences",
    }:
        # Read-only or planner-config subactions; LifeWorld has no place to
        # persist these, so they're no-ops by design. State hash matches
        # because both replays are no-ops.
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
    to_emails = list(kw.get("to_emails") or kw.get("to") or [])
    if not to_emails:
        raise KeyError("MESSAGE/send (gmail) requires to_emails")
    subject = kw.get("subject") or ""
    body = kw.get("body") or kw.get("body_plain") or ""
    from_email = kw.get("from_email") or "me@example.test"
    thread_id = kw.get("threadId") or kw.get("thread_id") or _synthetic_id(
        "thread_auto", {"to": sorted(to_emails), "s": subject}
    )
    message_id = kw.get("messageId") or kw.get("message_id") or _synthetic_id(
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
    target_kind = kw.get("targetKind", "contact")
    text = kw.get("message") or kw.get("text") or ""
    if not text:
        raise KeyError("MESSAGE/send (chat) requires message/text")
    channel = source or "imessage"

    if target_kind == "group":
        room_id = _required(kw, "roomId", action="MESSAGE", sub="send/group")
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
    parent_id = _required(kw, "messageId", action="MESSAGE", sub="draft_reply")
    parent = world.emails.get(parent_id)
    thread_id = parent.thread_id if parent is not None else _synthetic_id(
        "thread_auto", {"p": parent_id}
    )
    body = kw.get("body") or ""
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
    op = _required(kw, "manageOperation", action="MESSAGE", sub="manage")
    msg_id = kw.get("messageId")
    thread_id = kw.get("threadId")
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

    Subactions: add, set_identity, log_interaction, list.
    """
    sub = _required(kw, "subaction", action=name, sub="<missing>")
    if sub == "add":
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
    detail_kind = details.get("kind", "reminder")
    if detail_kind in {"reminder", "alarm"}:
        list_id = details.get("listId") or "list_personal"
        if list_id not in world.reminder_lists:
            raise KeyError(
                f"LIFE_CREATE references unknown reminder list '{list_id}' "
                f"(known: {sorted(world.reminder_lists)})"
            )
        due_at = details.get("due") or details.get("due_at")
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


def _u_life_review(_world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """LIFE_REVIEW is a read-only listing — no-op for state hash purposes."""
    return {"subaction": kw.get("subaction", "review"), "ok": True, "noop": True}


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


def _u_scheduled_task_mutate(
    _world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """SCHEDULED_TASK_SNOOZE/UPDATE — no-op when task id isn't seeded in the world.

    The LLM occasionally references ``task_*`` ids that don't exist in the
    snapshot. Modeling them would require a separate scheduled-task store;
    folding into reminders breaks identity (tasks ≠ reminders). Both
    replays no-op identically so state-hash scoring still works.
    """
    return {"subaction": kw.get("subaction", "update"), "ok": True, "noop": True}


def _u_health(_world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """HEALTH umbrella is read-only in the manifest; no-op for state hash."""
    return {"subaction": kw.get("subaction", "by_metric"), "ok": True, "noop": True}


def _u_money_readonly(_world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """MONEY_* read-only verbs — dashboard, list_transactions, list_sources, etc.

    Every MONEY_* verb that doesn't mutate state lands here. The MONEY umbrella picks
    the right behavior on ``subaction`` so the same handler is shared
    between e.g. ``MONEY``, ``MONEY_DASHBOARD``, ``MONEY_LIST_TRANSACTIONS``.
    """
    return {"subaction": kw.get("subaction", "dashboard"), "ok": True, "noop": True}


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
    """
    return {"subaction": kw.get("subaction", "block"), "ok": True, "noop": True}


def _u_scheduled_task_create(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """SCHEDULED_TASK_CREATE — model as a reminder on list_personal.

    LifeWorld doesn't have a separate scheduled-task store; folding into
    reminders gives state-hash determinism without inventing a new entity
    kind. Split this out if scenarios start needing
    scheduled-task semantics that diverge from reminders.
    """
    if "list_personal" not in world.reminder_lists:
        raise KeyError(
            "SCHEDULED_TASK_CREATE expects a reminder list 'list_personal' in the world"
        )
    title = kw.get("promptInstructions") or kw.get("title") or "Scheduled task"
    raw_trigger = kw.get("trigger")
    trigger = raw_trigger if isinstance(raw_trigger, dict) else {}
    due_at = trigger.get("atIso")
    reminder_id = _synthetic_id(
        "reminder_sched",
        {"t": title, "trig": trigger, "k": kw.get("kind", "reminder")},
    )
    reminder = world.create_reminder(
        reminder_id=reminder_id,
        list_id="list_personal",
        title=title[:120],
        due_at=due_at,
    )
    return {"id": reminder.id, "title": reminder.title}


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
            MessageTurn(role="user", content=scenario.instruction),
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
            for action in agent_actions:
                # Execution failures don't crash the run — we surface them as
                # tool-error messages and let scoring penalize via state mismatch.
                try:
                    result_payload = _execute_action(action, world)
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps(result_payload),
                            name=action.name,
                            tool_call_id=_extract_tool_call_id(agent_turn, action),
                        )
                    )
                except UnsupportedAction as exc:
                    logger.warning("Unsupported action in scenario %s: %s", scenario.id, exc)
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps({"error": "unsupported_action", "message": str(exc)}),
                            name=action.name,
                            tool_call_id=_extract_tool_call_id(agent_turn, action),
                        )
                    )
                except (KeyError, ValueError, TypeError) as exc:
                    logger.warning(
                        "Action %s failed in scenario %s: %s", action.name, scenario.id, exc
                    )
                    history.append(
                        MessageTurn(
                            role="tool",
                            content=json.dumps({"error": "execution_failed", "message": str(exc)}),
                            name=action.name,
                            tool_call_id=_extract_tool_call_id(agent_turn, action),
                        )
                    )

            agent_cost = float(getattr(agent_turn, "cost_usd", 0.0) or 0.0)
            await self._charge(agent_cost, scenario.id, seed, bucket="agent")

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
                latency_ms=int(getattr(agent_turn, "latency_ms", 0) or 0),
                input_tokens=input_tokens_val,
                output_tokens=int(getattr(agent_turn, "output_tokens", 0) or 0),
                cost_usd=agent_cost,
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
                    if satisfied:
                        await self._charge(
                            self.evaluator.cost_usd - pre_eval_cost,  # type: ignore[union-attr]
                            scenario.id,
                            seed,
                            bucket="eval",
                        )
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
            total_cost_usd=sum(t.cost_usd for t in turns),
            total_latency_ms=sum(t.latency_ms for t in turns),
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
