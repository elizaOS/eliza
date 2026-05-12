"""ClawBench agent_fn factory backed by hermes-agent.

ClawBench drives a fixed scenario with a sequence of turns and tools defined
in a YAML manifest. The adapter spawns one hermes-agent invocation per turn
and returns the structured response shape ClawBench expects::

    {
        "text": str,
        "tool_calls": [{"id": str, "name": str, "arguments": str|dict}, ...],
        "thought": str | None,
    }
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


def build_clawbench_agent_fn(
    *,
    client: HermesClient | None = None,
    scenario_yaml: dict[str, Any],
    fixtures: dict[str, Any] | None = None,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[Any]]:
    """Build a ClawBench-compatible async agent_fn backed by hermes-agent.

    Args:
        client: Optional preconfigured :class:`HermesClient`.
        scenario_yaml: Parsed ClawBench scenario manifest. Currently the
            adapter only reads ``scenario_yaml.get("system_prompt")`` and
            ``scenario_yaml.get("model_name")`` from it; everything else is
            interpreted by the ClawBench runner upstream.
        fixtures: Reserved for future world-state hooks. Currently unused.

    Returns:
        An async callable matching the ClawBench agent_fn contract.
    """
    del fixtures
    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)

    system_prompt = scenario_yaml.get("system_prompt") if isinstance(scenario_yaml, dict) else None
    if not isinstance(system_prompt, str):
        system_prompt = None
    model_name = scenario_yaml.get("model_name") if isinstance(scenario_yaml, dict) else None
    if not isinstance(model_name, str):
        model_name = None

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        last_user_text = ""
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
                last_user_text = str(content or "")
                break
        if not last_user_text:
            return {"text": "", "tool_calls": [], "thought": None}

        context: dict[str, object] = {}
        if tools:
            context["tools"] = tools
        if system_prompt:
            context["system_prompt"] = system_prompt

        try:
            resp = bridge.send_message(last_user_text, context=context or None)
        except Exception as exc:
            logger.exception("[hermes-clawbench] send_message failed")
            raise RuntimeError("hermes ClawBench send_message failed") from exc

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
                        "arguments": entry.get("arguments", ""),
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
