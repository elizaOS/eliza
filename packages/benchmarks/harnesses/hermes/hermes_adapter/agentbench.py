"""AgentBench agent_fn factory backed by hermes-agent.

AgentBench drives the agent through a multi-step environment (OS, DB, KG,
lateral thinking) where every step is one assistant turn. The runner builds
a prompt with the environment observation + action contract, the agent
returns a single command/SQL/answer, and the runner steps the env.

This factory mirrors the OpenClaw and Eliza AgentBench bridges: it threads
``(prompt, observation)`` through :class:`HermesClient.send_message` and
returns the action string the runner should execute.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Awaitable, Callable

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


def _extract_command_from_response_text(text: str) -> str:
    if not text:
        return ""
    cmd_match = re.search(r"<command>(.*?)</command>", text, re.DOTALL)
    if cmd_match:
        return cmd_match.group(1).strip()
    fence_match = re.search(
        r"```(?:bash|sh|sql)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE
    )
    if fence_match:
        return fence_match.group(1).strip()
    return text.strip()


def build_agentbench_agent_fn(
    *,
    client: HermesClient | None = None,
    environment: str | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
) -> Callable[[str, dict[str, Any] | None], Awaitable[dict[str, Any]]]:
    """Build an async AgentBench-compatible callable.

    Returned signature::

        async def agent_fn(prompt: str, observation: dict | None) -> dict

    The returned dict shape::

        {
            "action": <extracted command string>,
            "text": <raw assistant content>,
            "thought": <reasoning or None>,
            "model_name": <when provided>,
        }
    """
    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)

    async def _agent_fn(
        prompt: str,
        observation: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
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
            logger.exception("[hermes-agentbench] send_message failed")
            raise RuntimeError("hermes AgentBench send_message failed") from exc

        action = ""
        if isinstance(resp.params, dict):
            command_raw = resp.params.get("command")
            if isinstance(command_raw, str) and command_raw.strip():
                action = command_raw.strip()
        if not action:
            action = _extract_command_from_response_text(resp.text or "")

        result: dict[str, Any] = {
            "action": action,
            "text": resp.text,
            "thought": resp.thought,
        }
        if model_name:
            result["model_name"] = model_name
        return result

    return _agent_fn


__all__ = ["build_agentbench_agent_fn"]
