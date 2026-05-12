"""ClawBench agent_fn factory backed by the OpenClaw CLI.

ClawBench feeds the agent a scenario manifest plus pre-attached fixture
data (inbox, calendar, etc.). The adapter concatenates the scenario prompt
with the fixtures as JSON context and spawns one OpenClaw turn per
``agent_fn`` invocation. The returned shape matches the structure the
``hermes_adapter`` and ``eliza_adapter`` ClawBench factories emit.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Awaitable, Callable

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


def build_clawbench_agent_fn(
    *,
    client: OpenClawClient | None = None,
    scenario_yaml: dict[str, Any],
    fixtures: dict[str, Any] | None = None,
    model_name: str | None = None,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[dict[str, Any]]]:
    """Build a ClawBench-compatible async ``agent_fn`` backed by OpenClaw.

    Args:
        client: Optional preconfigured :class:`OpenClawClient`.
        scenario_yaml: Parsed ClawBench scenario manifest. The factory reads
            ``scenario_yaml.get("prompt")`` (the system message body) and
            ``scenario_yaml.get("system_prompt")`` (optional override).
        fixtures: Pre-attached fixture data injected into the user message as
            ``BENCHMARK CONTEXT`` JSON so OpenClaw can read it without a tool
            round-trip.
        model_name: Optional label propagated into the returned dict for
            attribution.
    """
    bridge = client or OpenClawClient()
    scenario_prompt = scenario_yaml.get("prompt") if isinstance(scenario_yaml, dict) else None
    if not isinstance(scenario_prompt, str):
        scenario_prompt = ""
    system_prompt = scenario_yaml.get("system_prompt") if isinstance(scenario_yaml, dict) else None
    if not isinstance(system_prompt, str):
        system_prompt = None
    fixtures_dict: dict[str, Any] = dict(fixtures or {})

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        last_user_text = _last_user_text(conversation_history)
        composed = _compose_message(
            scenario_prompt=scenario_prompt,
            fixtures=fixtures_dict,
            user_text=last_user_text,
            system_prompt=system_prompt,
        )
        if not composed:
            return {"text": "", "tool_calls": [], "thought": None}

        context: dict[str, object] = {}
        if tools:
            context["tools"] = tools
        try:
            resp = bridge.send_message(composed, context=context or None)
        except Exception as exc:
            logger.exception("[openclaw-clawbench] send_message failed")
            raise RuntimeError("OpenClaw ClawBench send_message failed") from exc

        raw_tool_calls = resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        tool_calls: list[dict[str, Any]] = []
        if isinstance(raw_tool_calls, list):
            for entry in raw_tool_calls:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or "")
                if not name:
                    continue
                tool_calls.append(
                    {
                        "id": str(entry.get("id") or f"call_{len(tool_calls)}"),
                        "name": name,
                        "arguments": entry.get("arguments", {}),
                    }
                )
        result: dict[str, Any] = {
            "text": resp.text,
            "tool_calls": tool_calls,
            "thought": resp.thought,
        }
        if model_name:
            result["model_name"] = model_name
        return result

    return _agent_fn


def _last_user_text(conversation_history: list[Any]) -> str:
    for turn in reversed(conversation_history):
        role = (
            getattr(turn, "role", None)
            or (turn.get("role") if isinstance(turn, dict) else None)
        )
        content = (
            getattr(turn, "content", None)
            or (turn.get("content") if isinstance(turn, dict) else "")
        )
        if role == "user":
            return str(content or "")
    return ""


def _compose_message(
    *,
    scenario_prompt: str,
    fixtures: dict[str, Any],
    user_text: str,
    system_prompt: str | None,
) -> str:
    chunks: list[str] = []
    if system_prompt:
        chunks.append(system_prompt.strip())
    if scenario_prompt.strip():
        chunks.append(scenario_prompt.strip())
    if fixtures:
        chunks.append(
            "BENCHMARK CONTEXT:\n" + json.dumps(fixtures, ensure_ascii=True, indent=2)
        )
    if user_text.strip():
        chunks.append(user_text.strip())
    return "\n\n".join(chunk for chunk in chunks if chunk)


__all__ = ["build_clawbench_agent_fn"]
