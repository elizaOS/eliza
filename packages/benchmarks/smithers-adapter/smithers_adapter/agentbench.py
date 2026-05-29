"""AgentBench agent_fn factory backed by the Smithers harness.

Mirrors ``hermes_adapter.agentbench`` / ``openclaw_adapter.agentbench``: threads
``(prompt, observation)`` through :class:`SmithersClient.send_message` and
returns the action string the AgentBench runner executes.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Awaitable, Callable

from smithers_adapter.client import SmithersClient

logger = logging.getLogger(__name__)


def _extract_command_from_response_text(text: str) -> str:
    if not text:
        return ""
    cmd_match = re.search(r"<command>(.*?)</command>", text, re.DOTALL)
    if cmd_match:
        return cmd_match.group(1).strip()
    fence_match = re.search(r"```(?:bash|sh|sql)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if fence_match:
        return fence_match.group(1).strip()
    return text.strip()


def build_agentbench_agent_fn(
    *,
    client: SmithersClient | None = None,
    environment: str | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
) -> Callable[[str, dict[str, Any] | None], Awaitable[dict[str, Any]]]:
    """Build an async AgentBench-compatible callable backed by Smithers."""
    bridge = client or SmithersClient()
    bridge.wait_until_ready(timeout=120)

    async def _agent_fn(prompt: str, observation: dict[str, Any] | None = None) -> dict[str, Any]:
        context: dict[str, object] = {"benchmark": "agentbench"}
        if environment:
            context["environment"] = environment
        if isinstance(observation, dict) and observation:
            context["observation"] = observation
        if system_prompt:
            context["system_prompt"] = system_prompt

        try:
            resp = bridge.send_message(prompt, context=context)
        except Exception as exc:
            logger.exception("[smithers-agentbench] send_message failed")
            raise RuntimeError("smithers AgentBench send_message failed") from exc

        action = ""
        if isinstance(resp.params, dict):
            command_raw = resp.params.get("command")
            if isinstance(command_raw, str) and command_raw.strip():
                action = command_raw.strip()
        if not action:
            action = _extract_command_from_response_text(resp.text or "")

        result: dict[str, Any] = {"action": action, "text": resp.text, "thought": resp.thought}
        if model_name:
            result["model_name"] = model_name
        return result

    return _agent_fn


__all__ = ["build_agentbench_agent_fn"]
