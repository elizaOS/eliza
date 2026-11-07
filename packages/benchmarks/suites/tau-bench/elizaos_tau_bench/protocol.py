"""Tau provider history normalization; transcripts stay complete."""

from __future__ import annotations
from typing import Any


def strip_cerebras_quirks(message: dict[str, Any]) -> dict[str, Any]:
    for key in ("reasoning_content", "provider_specific_fields"):
        message.pop(key, None)
    return message


def scrub_history_for_cerebras(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.get("role") == "assistant":
            scrubbed = dict(m)
            scrubbed.pop("reasoning_content", None)
            scrubbed.pop("provider_specific_fields", None)
            out.append(scrubbed)
        else:
            out.append(m)
    return out
