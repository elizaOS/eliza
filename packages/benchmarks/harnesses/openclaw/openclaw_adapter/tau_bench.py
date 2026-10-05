"""Tau-bench agent backed by the OpenClaw harness.

Drop-in equivalent of :class:`elizaos_tau_bench.eliza_agent.LiteLLMToolCallingAgent`
but routes the agent-side completion through :class:`OpenClawClient`. The
control flow mirrors ``LiteLLMToolCallingAgent.solve`` step-for-step so reward
computation against the upstream ``Env`` is identical.

Each turn uses OpenClaw's embedded runtime with a generated native tool plugin.
The plugin preserves TauBench's benchmark-owned environment boundary while
OpenClaw retains ownership of planning and tool execution.
"""

from __future__ import annotations

from elizaos_tau_bench import (
    strip_cerebras_quirks as _strip_cerebras_quirks,
    scrub_history_for_cerebras as _scrub_history_for_cerebras,
)

from benchmarks.lib import CostAccumulator, cost_from_usage

import json
import logging
from typing import Any, Final

from elizaos_tau_bench.eliza_agent import (
    AgentRunResult,
    BaseTauAgent,
    _message_to_action,
    _normalize_tool_calls_for_history,
)
from elizaos_tau_bench.types import RESPOND_ACTION_NAME, Action
from elizaos_tau_bench.upstream.envs.base import Env

from openclaw_adapter.client import MessageResponse, OpenClawClient

logger = logging.getLogger(__name__)


def _tool_name_from_manifest(tool: dict[str, Any]) -> str | None:
    function = tool.get("function")
    if isinstance(function, dict) and isinstance(function.get("name"), str):
        return function["name"]
    if isinstance(tool.get("name"), str):
        return tool["name"]
    return None


def _recover_text_tool_calls(
    text: str, tools_info: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    allowed_names = {
        name
        for tool in tools_info
        for name in [_tool_name_from_manifest(tool)]
        if name is not None
    }
    if not allowed_names:
        return []
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`").strip()
        if stripped.lower().startswith("json"):
            stripped = stripped[4:].strip()
    try:
        candidate = json.loads(stripped)
    except json.JSONDecodeError:
        return []
    records = candidate if isinstance(candidate, list) else [candidate]
    out: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        function = record.get("function")
        source = function if isinstance(function, dict) else record
        name_raw = (
            source.get("name")
            or source.get("action")
            or source.get("tool")
            or source.get("tool_name")
            or source.get("function_name")
        )
        if not isinstance(name_raw, str) or name_raw not in allowed_names:
            continue
        args = (
            source.get("arguments")
            if "arguments" in source
            else source.get("parameters", source.get("args", {}))
        )
        if isinstance(args, str):
            args = json.loads(args)
        if not isinstance(args, dict):
            raise TypeError("Tau tool arguments must be a JSON object")
        out.append(
            {
                "id": str(record.get("id") or f"text_call_{len(out)}"),
                "type": "function",
                "function": {"name": name_raw, "arguments": json.dumps(args)},
            }
        )
    return out


class OpenClawTauAgent(BaseTauAgent):
    """Tau-bench agent that drives an upstream ``Env`` via the OpenClaw client.

    Identical control flow to :class:`LiteLLMToolCallingAgent` — only the
    per-turn chat completion is delegated to ``OpenClawClient``.
    """

    def __init__(
        self,
        model: str = "gemma-4-31b",
        provider: str = "cerebras",
        temperature: float = 0.0,
        client: OpenClawClient | None = None,
        direct_openai_compatible: bool | None = None,
    ) -> None:
        self.model = model
        self.provider = provider
        self.temperature = temperature
        if client is not None:
            self.client = client
        else:
            if direct_openai_compatible:
                raise ValueError(
                    "TauBench publication requires OpenClaw's embedded runtime; "
                    "direct_openai_compatible is non-publishable"
                )
            self.client = OpenClawClient(
                provider=provider,
                model=model,
                temperature=temperature,
            )

    def solve(
        self, env: Env, task_index: int, max_num_steps: int = 30
    ) -> AgentRunResult:
        reset = env.reset(task_index=task_index)
        obs = reset.observation
        info: dict[str, Any] = reset.info.model_dump()
        reward = 0.0
        costs = CostAccumulator()
        num_tool_calls = 0
        actions_taken: list[Action] = []

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": env.wiki},
            {"role": "user", "content": obs},
        ]
        tools_info = list(env.tools_info)

        try:
            for _step_i in range(max_num_steps):
                response = self._one_turn(messages, tools_info)
                next_message = self._response_to_assistant_message(response)
                if not next_message.get("tool_calls") and isinstance(
                    next_message.get("content"), str
                ):
                    recovered = _recover_text_tool_calls(
                        str(next_message["content"]), tools_info
                    )
                    if recovered:
                        next_message["tool_calls"] = recovered
                        next_message["content"] = None
                _strip_cerebras_quirks(next_message)

                usage = (
                    response.params.get("usage")
                    if isinstance(response.params, dict)
                    else None
                )
                costs.add(cost_from_usage(self.model, usage))

                action = _message_to_action(next_message)
                actions_taken.append(action)

                env_response = env.step(action)
                reward = env_response.reward
                info = {**info, **env_response.info.model_dump()}

                if action.name != RESPOND_ACTION_NAME:
                    num_tool_calls += 1
                    tcs = next_message.get("tool_calls") or []
                    if tcs:
                        next_message["tool_calls"] = tcs[:1]
                        tc = next_message["tool_calls"][0]
                        messages.extend(
                            [
                                next_message,
                                {
                                    "role": "tool",
                                    "tool_call_id": tc["id"],
                                    "name": tc["function"]["name"],
                                    "content": env_response.observation,
                                },
                            ]
                        )
                    else:
                        messages.append(next_message)
                        messages.append(
                            {"role": "user", "content": env_response.observation}
                        )
                else:
                    messages.extend(
                        [
                            next_message,
                            {"role": "user", "content": env_response.observation},
                        ]
                    )

                if env_response.done:
                    break
        except Exception as e:
            logger.exception("[openclaw-tau] solve loop failed")
            return AgentRunResult(
                reward=reward,
                messages=messages,
                info={**info, **costs.metadata()},
                actions_taken=actions_taken,
                num_tool_calls=num_tool_calls,
                num_turns=len(messages),
                agent_cost=costs.total,
                error=str(e),
            )

        return AgentRunResult(
            reward=reward,
            messages=messages,
            info={**info, **costs.metadata()},
            actions_taken=actions_taken,
            num_tool_calls=num_tool_calls,
            num_turns=len(messages),
            agent_cost=costs.total,
        )

    def _one_turn(
        self,
        messages: list[dict[str, Any]],
        tools_info: list[dict[str, Any]],
    ) -> MessageResponse:
        context: dict[str, object] = {
            "messages": _scrub_history_for_cerebras(messages),
        }
        if tools_info:
            context["tools"] = tools_info
            context["tool_choice"] = "auto"
        if self.temperature is not None:
            context["temperature"] = float(self.temperature)
        last_user = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                last_user = str(m.get("content") or "")
                break
        return self.client.send_message(last_user, context=context)

    @staticmethod
    def _response_to_assistant_message(response: MessageResponse) -> dict[str, Any]:
        tool_calls = _normalize_tool_calls_for_history(
            response.params.get("tool_calls")
            if isinstance(response.params, dict)
            else None
        )
        msg: dict[str, Any] = {
            "role": "assistant",
            "content": response.text or "",
        }
        if tool_calls:
            msg["tool_calls"] = tool_calls
            if not msg["content"]:
                msg["content"] = None
        return msg


__all__ = ["OpenClawTauAgent"]
