"""Corpus-backed LifeWorld builder for private personal-corpus shards.

The loader mirrors the benchmark dataset pattern used elsewhere in the repo:
sample mode is bundled and CI-safe, local mode reads an already-synced corpus
directory, and Hugging Face mode downloads a private snapshot only when the
caller supplies credentials. The builder maps the canonical interchange rows
into LifeWorld entities without mutating the procedural generator path.
"""

from __future__ import annotations

import json
import os
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, cast

from .entities import (
    ChatChannel,
    ChatMessage,
    Contact,
    Conversation,
    EmailMessage,
    EmailThread,
    EntityKind,
)
from .world import LifeWorld

CorpusLoadMode = Literal["sample", "local", "huggingface"]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


SAMPLE_CORPUS_DIR = _repo_root() / "corpus-tools" / "fixtures" / "synthetic"
DEFAULT_HF_REPO_ID = "elizaos/private-lifeops-corpus"


@dataclass(frozen=True)
class CorpusSelector:
    platforms: tuple[str, ...] | None = None
    accounts: tuple[str, ...] | None = None
    thread_ids: tuple[str, ...] | None = None
    max_messages: int | None = None


@dataclass(frozen=True)
class CorpusLoadOptions:
    mode: CorpusLoadMode = "sample"
    local_dir: Path | None = None
    hf_repo_id: str = DEFAULT_HF_REPO_ID
    cache_dir: Path | None = None
    token: str | None = None
    selector: CorpusSelector = CorpusSelector()


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSONL row {path}:{line_number}: {exc}") from exc
            if not isinstance(row, dict):
                raise ValueError(f"corpus row {path}:{line_number} must be an object")
            rows.append(row)
    return rows


def _corpus_dir(options: CorpusLoadOptions) -> Path:
    if options.mode == "sample":
        return SAMPLE_CORPUS_DIR
    if options.mode == "local":
        if options.local_dir is None:
            raise ValueError("local corpus mode requires local_dir")
        return options.local_dir
    token = options.token or os.environ.get("HF_TOKEN")
    if not token:
        raise ValueError("huggingface corpus mode requires HF_TOKEN or options.token")
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise RuntimeError(
            "huggingface corpus mode requires `huggingface_hub`; install the optional dataset dependency"
        ) from exc
    snapshot = snapshot_download(
        repo_id=options.hf_repo_id,
        repo_type="dataset",
        token=token,
        cache_dir=str(options.cache_dir) if options.cache_dir else None,
    )
    return Path(snapshot)


def _selected(row: dict[str, Any], selector: CorpusSelector) -> bool:
    platform = str(row.get("platform", ""))
    account_id = str(row.get("accountId", ""))
    thread_id = str(row.get("threadId", ""))
    if selector.platforms and platform not in selector.platforms:
        return False
    if selector.accounts and account_id not in selector.accounts:
        return False
    if selector.thread_ids and thread_id not in selector.thread_ids:
        return False
    return True


def load_corpus_rows(options: CorpusLoadOptions = CorpusLoadOptions()) -> list[dict[str, Any]]:
    """Load selected canonical corpus rows from sample, local, or HF mode."""

    root = _corpus_dir(options)
    rows: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*.jsonl")):
        rows.extend(row for row in _read_jsonl(path) if _selected(row, options.selector))
    rows.sort(key=lambda row: (int(row["ts"]), str(row["id"])))
    return rows


def _iso_from_ms(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


def _recipient_address(recipient: dict[str, Any]) -> str:
    return str(recipient.get("address") or recipient.get("id") or "unknown@example.test")


def _contact_id(handle: str) -> str:
    return "corpus-contact-" + "".join(ch if ch.isalnum() else "-" for ch in handle.lower()).strip("-")


def _name_parts(display: str) -> tuple[str, str]:
    parts = [part for part in display.split(" ") if part]
    if not parts:
        return "Unknown", "Contact"
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _add_contact(world: LifeWorld, *, handle: str, display: str) -> None:
    contact_id = _contact_id(handle)
    if contact_id in world.contacts:
        return
    given, family = _name_parts(display)
    primary_email = handle if "@" in handle else f"{contact_id}@example.test"
    world.add(
        EntityKind.CONTACT,
        Contact(
            id=contact_id,
            display_name=display,
            given_name=given,
            family_name=family,
            primary_email=primary_email,
            relationship="acquaintance",
            tags=["corpus"],
        ),
    )


def _email_message(row: dict[str, Any], owner_email: str) -> EmailMessage:
    direction = str(row["direction"])
    recipients = [
        _recipient_address(recipient)
        for recipient in row.get("recipients", [])
        if isinstance(recipient, dict)
    ]
    sender = str(row["senderId"])
    sent_at = _iso_from_ms(int(row["ts"]))
    return EmailMessage(
        id=str(row["id"]),
        thread_id=str(row["threadId"]),
        folder="sent" if direction == "out" else "inbox",
        from_email=owner_email if direction == "out" else sender,
        to_emails=recipients if direction == "out" else [owner_email],
        cc_emails=[],
        subject=str(row.get("subject") or "(no subject)"),
        body_plain=str(row["text"]),
        sent_at=sent_at,
        received_at=None if direction == "out" else sent_at,
        is_read="UNREAD" not in [str(label).upper() for label in row.get("labels", [])],
        is_starred="IMPORTANT" in [str(label).upper() for label in row.get("labels", [])],
        labels=[str(label) for label in row.get("labels", [])],
        attachments=[
            str(attachment.get("filename"))
            for attachment in row.get("attachments", [])
            if isinstance(attachment, dict) and attachment.get("filename")
        ],
    )


# Explicit map from corpus `platform` strings to valid ``ChatChannel`` literals.
# ``gmail`` is intentionally absent: gmail rows are routed to the email path and
# never reach ``_chat_channel``. ``x`` (Twitter/X) has no dedicated ChatChannel,
# so it is folded into ``telegram`` to preserve prior behaviour.
_PLATFORM_TO_CHAT_CHANNEL: dict[str, ChatChannel] = {
    "x": "telegram",
    "telegram": "telegram",
    "discord": "discord",
    "imessage": "imessage",
    "signal": "signal",
}


def _chat_channel(platform: str) -> ChatChannel:
    try:
        return _PLATFORM_TO_CHAT_CHANNEL[platform]
    except KeyError as exc:
        raise ValueError(
            f"unknown corpus platform {platform!r}; "
            f"expected one of {sorted(_PLATFORM_TO_CHAT_CHANNEL)}"
        ) from exc


def _chat_message(row: dict[str, Any], owner_email: str) -> ChatMessage:
    direction = str(row["direction"])
    channel = _chat_channel(str(row["platform"]))
    sent_at = _iso_from_ms(int(row["ts"]))
    recipients = [
        _recipient_address(recipient)
        for recipient in row.get("recipients", [])
        if isinstance(recipient, dict)
    ]
    return ChatMessage(
        id=str(row["id"]),
        channel=cast(ChatChannel, channel),
        conversation_id=str(row["threadId"]),
        from_handle=owner_email if direction == "out" else str(row["senderId"]),
        to_handles=recipients,
        text=str(row["text"]),
        sent_at=sent_at,
        is_read=direction == "out",
        is_outgoing=direction == "out",
        attachments=[
            str(attachment.get("filename"))
            for attachment in row.get("attachments", [])
            if isinstance(attachment, dict) and attachment.get("filename")
        ],
    )


def generate_corpus_world(
    *,
    seed: int,
    now_iso: str,
    options: CorpusLoadOptions = CorpusLoadOptions(),
    owner_email: str = "owner@example.test",
    owner_name: str = "Owner",
) -> LifeWorld:
    """Build a deterministic LifeWorld from canonical corpus rows."""

    rows = load_corpus_rows(options)
    if options.selector.max_messages is not None:
        rng = random.Random(seed)
        rows = sorted(
            rng.sample(rows, k=min(len(rows), options.selector.max_messages)),
            key=lambda row: (int(row["ts"]), str(row["id"])),
        )

    world = LifeWorld(seed=seed, now_iso=now_iso)
    _add_contact(world, handle=owner_email, display=owner_name)

    email_threads: dict[str, list[EmailMessage]] = {}
    conversations: dict[str, list[ChatMessage]] = {}
    for row in rows:
        sender = str(row["senderId"])
        _add_contact(world, handle=sender, display=str(row.get("senderDisplay") or sender))
        for recipient in row.get("recipients", []):
            if isinstance(recipient, dict):
                _add_contact(
                    world,
                    handle=_recipient_address(recipient),
                    display=str(recipient.get("display") or recipient.get("id") or "Unknown"),
                )

        if row.get("platform") == "gmail":
            message = _email_message(row, owner_email)
            world.add(EntityKind.EMAIL, message)
            email_threads.setdefault(message.thread_id, []).append(message)
        else:
            message = _chat_message(row, owner_email)
            world.add(EntityKind.CHAT_MESSAGE, message)
            conversations.setdefault(message.conversation_id, []).append(message)

    for thread_id, messages in sorted(email_threads.items()):
        first = min(messages, key=lambda message: message.sent_at)
        last = max(messages, key=lambda message: message.sent_at)
        participants = sorted(
            {message.from_email for message in messages}
            | {email for message in messages for email in message.to_emails}
        )
        world.add(
            EntityKind.EMAIL_THREAD,
            EmailThread(
                id=thread_id,
                subject=first.subject,
                message_ids=[
                    message.id
                    for message in sorted(messages, key=lambda message: message.sent_at)
                ],
                participants=participants,
                last_activity_at=last.sent_at,
            ),
        )

    for conversation_id, messages in sorted(conversations.items()):
        first = min(messages, key=lambda message: message.sent_at)
        last = max(messages, key=lambda message: message.sent_at)
        participants = sorted(
            {message.from_handle for message in messages}
            | {handle for message in messages for handle in message.to_handles}
        )
        world.add(
            EntityKind.CONVERSATION,
            Conversation(
                id=conversation_id,
                channel=first.channel,
                participants=participants,
                title=conversation_id,
                last_activity_at=last.sent_at,
                is_group=len(participants) > 2,
            ),
        )

    return world
