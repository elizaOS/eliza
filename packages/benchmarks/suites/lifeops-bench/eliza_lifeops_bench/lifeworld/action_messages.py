"""LifeWorld messages action semantics."""

from __future__ import annotations
import re
from datetime import datetime, timedelta, timezone
from typing import Any, cast
from .world import LifeWorld
from .entities import ChatChannel, ChatMessage, EmailFolder, EmailMessage, MessageSource
from .action_common import (
    UnsupportedAction,
    _MESSAGE_SOURCES,
    _contact_matches,
    _positive_limit,
    _required,
    _string_list,
    _synthetic_id,
    _try_parse_iso,
    _validated_message_source,
)


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


_EMAIL_FOLDERS = frozenset({"inbox", "sent", "drafts", "archive", "trash", "spam"})


_GMAIL_QUERY_CLAUSE_RE = re.compile(
    r"(?P<key>from|subject|is):(?:\"(?P<quoted>[^\"]*)\"|(?P<bare>\S+))",
    flags=re.IGNORECASE,
)


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
