"""Derives executor-owned identifiers used by dependent benchmark actions.

Scenarios omit server-assigned identifiers on create calls. The deterministic
LifeWorld executor returns stable receipt identifiers so later turns can model
the same create-then-mutate lineage as a production agent reading tool output.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def _stable_id(prefix: str, payload: dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def scheduled_task_trigger(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Normalize create-time trigger aliases before receipt identity is derived."""
    raw = kwargs.get("trigger")
    trigger = dict(raw) if isinstance(raw, dict) else {}
    at = (
        kwargs.get("atIso")
        or kwargs.get("at_iso")
        or kwargs.get("dueAt")
        or kwargs.get("due_at")
        or kwargs.get("due")
    )
    if isinstance(at, str) and at:
        trigger.setdefault("atIso", at)
    return trigger


def scheduled_task_create_receipt_id(kwargs: dict[str, Any]) -> str:
    """Return the identifier emitted by deterministic scheduled-task creation."""
    prompt = str(
        kwargs.get("promptInstructions")
        or kwargs.get("prompt_instructions")
        or kwargs.get("instructions")
        or kwargs.get("title")
        or "Scheduled task"
    )
    return _stable_id(
        "task_auto",
        {
            "k": kwargs.get("kind", "reminder"),
            "p": prompt,
            "trig": scheduled_task_trigger(kwargs),
            "subject": kwargs.get("subject"),
            "output": kwargs.get("output"),
        },
    )
