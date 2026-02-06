"""Hook mapping resolution and template rendering.

Mappings define how arbitrary webhook payloads are transformed into
wake or agent actions.

Template syntax (Mustache-style):
  - ``{{field}}``            -> data["field"]
  - ``{{nested.field}}``     -> data["nested"]["field"]
  - ``{{array[0].field}}``   -> data["array"][0]["field"]

Unresolved placeholders are left as-is.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Optional

from .types import AppliedMapping, HookMapping, Payload

# Regex for {{placeholder}} tokens
_PLACEHOLDER_RE = re.compile(r"\{\{([^}]+)\}\}")

# Regex for array index notation: e.g. items[0] -> items.0
_ARRAY_INDEX_RE = re.compile(r"\[(\d+)\]")


def _resolve_path(obj: Any, path: str) -> Any:
    """Walk a dotted path (with array-index support) into a nested structure.

    Args:
        obj: The root object to traverse.
        path: A dotted path string.  Array indices like ``[0]`` are normalised
              to dot notation before traversal.

    Returns:
        The resolved value, or ``None`` if the path cannot be followed.
    """
    # Normalise array indexing: messages[0].from -> messages.0.from
    normalised = _ARRAY_INDEX_RE.sub(r".\1", path)
    parts = normalised.split(".")

    current: Any = obj
    for part in parts:
        if current is None:
            return None
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, (list, tuple)):
            try:
                current = current[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return current


def render_template(template: str, data: Payload) -> str:
    """Render a Mustache-style template against a data dict.

    Supports simple, nested, and array-index placeholders.  Unresolved
    placeholders are left verbatim.  Object values are JSON-serialised.

    Args:
        template: The template string containing ``{{placeholder}}`` tokens.
        data: The data dict to resolve placeholders against.

    Returns:
        The rendered string.
    """

    def _replace(match: re.Match[str]) -> str:
        expr = match.group(1)
        path = expr.strip()
        value = _resolve_path(data, path)
        if value is None:
            return f"{{{{{expr}}}}}"
        if isinstance(value, dict) or isinstance(value, list):
            return json.dumps(value, separators=(",", ":"))
        return str(value)

    return _PLACEHOLDER_RE.sub(_replace, template)


def find_mapping(
    mappings: list[HookMapping],
    hook_name: str,
    payload: Payload,
) -> Optional[HookMapping]:
    """Find the first mapping that matches the given hook name or payload source.

    Matching priority:
      1. ``mapping.match.path == hook_name``
      2. ``mapping.match.source == payload["source"]``

    Args:
        mappings: List of configured hook mappings.
        hook_name: The path segment after ``/hooks/``.
        payload: The incoming webhook payload.

    Returns:
        The matching :class:`HookMapping`, or ``None``.
    """
    for mapping in mappings:
        if mapping.match is not None:
            if mapping.match.path and mapping.match.path == hook_name:
                return mapping
            if (
                mapping.match.source
                and isinstance(payload.get("source"), str)
                and payload["source"] == mapping.match.source
            ):
                return mapping
    return None


def apply_mapping(
    mapping: HookMapping,
    hook_name: str,
    payload: Payload,
) -> AppliedMapping:
    """Apply a mapping to a payload, producing the final action parameters.

    For ``wake`` actions: resolves text from ``text_template`` (falling back to
    ``message_template``), or from ``payload["text"]``, or a default string.

    For ``agent`` actions: resolves message from ``message_template`` or
    ``payload["message"]``, and renders the session key template.

    Args:
        mapping: The matched hook mapping.
        hook_name: The incoming hook path name.
        payload: The webhook payload.

    Returns:
        An :class:`AppliedMapping` with the resolved parameters.
    """
    action = mapping.action or "agent"
    wake_mode = mapping.wake_mode or "now"

    if action == "wake":
        text_template = mapping.text_template or mapping.message_template
        if text_template:
            text = render_template(text_template, payload)
        elif isinstance(payload.get("text"), str):
            text = payload["text"]
        else:
            text = f"Webhook received: {hook_name}"

        return AppliedMapping(action="wake", text=text, wake_mode=wake_mode)

    # action == "agent"
    message_template = mapping.message_template
    if message_template:
        message = render_template(message_template, payload)
    elif isinstance(payload.get("message"), str):
        message = payload["message"]
    else:
        message = f"Webhook payload from {hook_name}"

    if mapping.session_key:
        session_key = render_template(mapping.session_key, payload)
    else:
        session_key = f"hook:{hook_name}:{int(time.time() * 1000)}"

    return AppliedMapping(
        action="agent",
        message=message,
        name=mapping.name or hook_name,
        session_key=session_key,
        wake_mode=wake_mode,
        deliver=mapping.deliver if mapping.deliver is not None else True,
        channel=mapping.channel or "last",
        to=mapping.to,
        model=mapping.model,
        thinking=mapping.thinking,
        timeout_seconds=mapping.timeout_seconds,
    )
