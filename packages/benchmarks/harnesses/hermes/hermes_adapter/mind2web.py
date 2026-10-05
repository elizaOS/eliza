"""Mind2Web agent_fn factory backed by hermes-agent.

Mind2Web is a single-step browser action benchmark: for each step the
runner provides a list of candidate DOM elements, a target micro-action
description, and the full plan. The agent must return ONE action shaped
as ``{operation, element_id, value, reasoning}``. This adapter wraps
:class:`HermesClient` and parses the assistant's JSON response into that
shape.

Mirrors the OpenClaw and Eliza Mind2Web factories — the runner owns task
iteration and scoring; this module is the thin per-step bridge.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Awaitable, Callable

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


_VALID_OPERATIONS = {"CLICK", "TYPE", "SELECT", "HOVER", "ENTER"}

_DEFAULT_SYSTEM_PROMPT = (
    "Predict exactly one Mind2Web browser action. Respond with strict JSON "
    "only; do not use markdown or prose. Keys: operation, element_id, "
    "value, reasoning."
)


def _extract_action_json(text: str) -> dict[str, Any]:
    if not text:
        return {}
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 3 and lines[-1].strip() == "```":
            stripped = "\n".join(lines[1:-1]).strip()
    try:
        payload = json.loads(stripped)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", stripped)
    if match:
        try:
            payload = json.loads(match.group(0))
            if isinstance(payload, dict):
                return payload
        except json.JSONDecodeError:
            return {}
    return {}


def _xtag(text: str, tag: str) -> str:
    if not text:
        return ""
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return m.group(1).strip() if m else ""


def _coerce_action(
    params: dict[str, Any],
    text: str,
) -> dict[str, str]:
    operation = str(params.get("operation") or "").upper().strip()
    element_id = str(params.get("element_id") or "").strip()
    value = str(params.get("value") or "").strip()

    if not operation:
        operation = _xtag(text, "operation").upper()
    if not element_id:
        element_id = _xtag(text, "element_id")
    if not value:
        value = _xtag(text, "value")

    if not operation or not element_id:
        json_payload = _extract_action_json(text)
        if isinstance(json_payload, dict):
            operation = operation or str(json_payload.get("operation") or "").upper()
            element_id = element_id or str(json_payload.get("element_id") or "")
            value = value or str(json_payload.get("value") or "")

    if operation not in _VALID_OPERATIONS:
        operation = "CLICK"

    return {
        "operation": operation,
        "element_id": element_id or "unknown",
        "value": value,
    }


def build_mind2web_agent_fn(
    *,
    client: HermesClient | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
) -> Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]:
    """Build an async Mind2Web-compatible callable.

    Returned signature::

        async def agent_fn(prompt: str, step_context: dict) -> dict

    The returned dict shape::

        {
            "operation": "CLICK"|"TYPE"|"SELECT"|"HOVER"|"ENTER",
            "element_id": <backend_node_id or "unknown">,
            "value": <typed value or "">,
            "reasoning": <thought or "">,
            "text": <raw assistant content>,
            "model_name": <when provided>,
        }
    """
    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)
    effective_system_prompt = system_prompt or _DEFAULT_SYSTEM_PROMPT

    async def _agent_fn(
        prompt: str,
        step_context: dict[str, Any],
    ) -> dict[str, Any]:
        context: dict[str, object] = {
            "benchmark": "mind2web",
            "system_prompt": effective_system_prompt,
        }
        if isinstance(step_context, dict):
            for k, v in step_context.items():
                if k not in context:
                    context[k] = v

        try:
            resp = bridge.send_message(prompt, context=context)
        except Exception as exc:
            logger.exception("[hermes-mind2web] send_message failed")
            raise RuntimeError("hermes Mind2Web send_message failed") from exc

        params_dict = resp.params if isinstance(resp.params, dict) else {}
        action = _coerce_action(params_dict, resp.text or "")
        result: dict[str, Any] = {
            **action,
            "reasoning": resp.thought or "",
            "text": resp.text,
        }
        if model_name:
            result["model_name"] = model_name
        return result

    return _agent_fn


__all__ = ["build_mind2web_agent_fn"]
