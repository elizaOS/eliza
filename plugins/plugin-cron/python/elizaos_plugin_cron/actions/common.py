"""Shared types and helpers for cron actions."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, TypedDict

from elizaos_plugin_cron.service import CronService


class MessageContent(TypedDict, total=False):
    text: str


class Message(TypedDict, total=False):
    content: MessageContent
    room_id: str
    agent_id: str
    options: dict[str, Any]


@dataclass(frozen=True)
class ActionResult:
    success: bool
    text: str
    data: dict[str, Any] | None = None
    error: str | None = None


_UUID_RE = re.compile(
    r"([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})", re.IGNORECASE
)
_QUOTED_RE = re.compile(r"""["']([^"']+)["']""")
_NAMED_RE = re.compile(r"(?i)(?:called|named)\s+(\S+)")


def extract_job_id(text: str, service: CronService) -> str | None:
    """Extract a job ID from text: UUID, quoted name, or 'called/named X'."""
    # UUID
    m = _UUID_RE.search(text)
    if m:
        return m.group(1)

    # Quoted name
    m = _QUOTED_RE.search(text)
    if m:
        job = service.find_job_by_name(m.group(1))
        if job:
            return job.id

    # "called/named X"
    m = _NAMED_RE.search(text)
    if m:
        job = service.find_job_by_name(m.group(1))
        if job:
            return job.id

    return None
