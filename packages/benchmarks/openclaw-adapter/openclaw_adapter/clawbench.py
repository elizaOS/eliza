"""ClawBench agent function backed by the OpenClaw harness."""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


def build_clawbench_agent_fn(
    *,
    client: OpenClawClient | None = None,
    scenario_yaml: dict[str, Any] | None = None,
    model_name: str | None = None,
) -> Callable[[list[dict[str, Any]], dict[str, Any] | None], Awaitable[dict[str, Any]]]:
    bridge = client or OpenClawClient(model=model_name)
    system_prompt = (scenario_yaml or {}).get("system_prompt")

    async def _agent_fn(
        messages: list[dict[str, Any]],
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        text = ""
        for message in reversed(messages):
            if message.get("role") == "user":
                text = str(message.get("content") or "")
                break
        ctx = dict(context or {})
        ctx["messages"] = messages
        if isinstance(system_prompt, str) and system_prompt:
            ctx["system_prompt"] = system_prompt
        try:
            resp = bridge.send_message(text, context=ctx)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[openclaw-clawbench] send_message failed")
            raise RuntimeError("OpenClaw ClawBench send_message failed") from exc
        return {
            "content": resp.text,
            "tool_calls": resp.params.get("tool_calls", []),
            "model_name": model_name,
        }

    return _agent_fn
