"""Tau-bench agent backed by the OpenClaw harness.

Drop-in equivalent of :class:`elizaos_tau_bench.eliza_agent.LiteLLMToolCallingAgent`
but routes the agent-side completion through :class:`OpenClawClient`. The
control flow mirrors ``LiteLLMToolCallingAgent.solve`` step-for-step so reward
computation against the upstream ``Env`` is identical.

For benchmark runs we use OpenClaw's ``direct_openai_compatible`` mode (set
via ``OPENCLAW_DIRECT_OPENAI_COMPAT=1`` or the constructor flag) so the
adapter hits the Cerebras OpenAI-compatible endpoint directly without
needing the OpenClaw Node binary at every turn.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Final, Optional

from openclaw_adapter.client import MessageResponse, OpenClawClient

from elizaos_tau_bench.eliza_agent import AgentRunResult, BaseTauAgent
from elizaos_tau_bench.types import Action, RESPOND_ACTION_NAME
from elizaos_tau_bench.upstream.envs.base import Env

logger = logging.getLogger(__name__)


_CEREBRAS_PRICING: Final[dict[str, dict[str, float]]] = {
    "gpt-oss-120b": {"input_per_million_usd": 0.35, "output_per_million_usd": 0.75},
}


def _compute_cost_usd(
    model: str | None, prompt_tokens: int, completion_tokens: int
) -> float:
    if not model:
        return 0.0
    bare = model.rsplit("/", 1)[-1]
    pricing = _CEREBRAS_PRICING.get(bare)
    if pricing is None:
        return 0.0
    return (
        (prompt_tokens / 1_000_000.0) * pricing["input_per_million_usd"]
        + (completion_tokens / 1_000_000.0) * pricing["output_per_million_usd"]
    )


def _strip_cerebras_quirks(message: dict[str, Any]) -> dict[str, Any]:
    for key in ("reasoning_content", "provider_specific_fields"):
        message.pop(key, None)
    return message


def _scrub_history_for_cerebras(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
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


def _message_to_action(message: dict[str, Any]) -> Action:
    tool_calls = message.get("tool_calls")
    if tool_calls and len(tool_calls) > 0:
        tc = tool_calls[0]
        if isinstance(tc, dict):
            fn = tc.get("function") or {}
            name = fn.get("name") or ""
            args_raw = fn.get("arguments")
        else:
            fn = getattr(tc, "function", None)
            name = getattr(fn, "name", "") if fn is not None else ""
            args_raw = getattr(fn, "arguments", "") if fn is not None else ""
        if isinstance(args_raw, str):
            try:
                kwargs = json.loads(args_raw or "{}")
            except json.JSONDecodeError:
                kwargs = {}
        elif isinstance(args_raw, dict):
            kwargs = dict(args_raw)
        else:
            kwargs = {}
        if name:
            return Action(name=str(name), kwargs=kwargs)
    return Action(
        name=RESPOND_ACTION_NAME,
        kwargs={"content": message.get("content") or ""},
    )


def _normalize_tool_calls_for_history(
    raw_tool_calls: list[Any] | None,
) -> list[dict[str, Any]]:
    if not raw_tool_calls:
        return []
    out: list[dict[str, Any]] = []
    for tc in raw_tool_calls:
        if not isinstance(tc, dict):
            continue
        if "function" in tc and isinstance(tc["function"], dict):
            fn = tc["function"]
            fn_name = fn.get("name") or ""
            fn_args = fn.get("arguments")
        else:
            fn_name = tc.get("name") or ""
            fn_args = tc.get("arguments")
        tc_id = tc.get("id") or f"call_{len(out)}"
        if not fn_name:
            continue
        if isinstance(fn_args, dict):
            args_str = json.dumps(fn_args)
        elif isinstance(fn_args, str):
            args_str = fn_args or "{}"
        else:
            args_str = "{}"
        out.append(
            {
                "id": str(tc_id),
                "type": "function",
                "function": {"name": fn_name, "arguments": args_str},
            }
        )
    return out


def _detect_direct_mode_default() -> bool:
    return os.environ.get("OPENCLAW_DIRECT_OPENAI_COMPAT", "").strip() == "1"


class OpenClawTauAgent(BaseTauAgent):
    """Tau-bench agent that drives an upstream ``Env`` via the OpenClaw client.

    Identical control flow to :class:`LiteLLMToolCallingAgent` — only the
    per-turn chat completion is delegated to ``OpenClawClient``.
    """

    def __init__(
        self,
        model: str = "gpt-oss-120b",
        provider: str = "cerebras",
        temperature: float = 0.0,
        client: OpenClawClient | None = None,
        direct_openai_compatible: Optional[bool] = None,
    ) -> None:
        self.model = model
        self.provider = provider
        self.temperature = temperature
        if client is not None:
            self.client = client
        else:
            direct = (
                bool(direct_openai_compatible)
                if direct_openai_compatible is not None
                else _detect_direct_mode_default()
            )
            self.client = OpenClawClient(
                provider=provider,
                model=model,
                temperature=temperature,
                direct_openai_compatible=direct,
            )

    def solve(self, env: Env, task_index: int, max_num_steps: int = 30) -> AgentRunResult:
        reset = env.reset(task_index=task_index)
        obs = reset.observation
        info: dict[str, Any] = reset.info.model_dump()
        reward = 0.0
        total_cost = 0.0
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
                _strip_cerebras_quirks(next_message)

                usage = response.params.get("usage") if isinstance(response.params, dict) else None
                if isinstance(usage, dict):
                    prompt_tokens = int(usage.get("prompt_tokens") or usage.get("promptTokens") or 0)
                    completion_tokens = int(
                        usage.get("completion_tokens") or usage.get("completionTokens") or 0
                    )
                    total_cost += _compute_cost_usd(self.model, prompt_tokens, completion_tokens)

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
            logger.exception("[openclaw-tau] solve loop failed: %s", e)
            return AgentRunResult(
                reward=reward,
                messages=messages,
                info=info,
                actions_taken=actions_taken,
                num_tool_calls=num_tool_calls,
                num_turns=len(messages),
                agent_cost=total_cost,
                error=str(e),
            )

        return AgentRunResult(
            reward=reward,
            messages=messages,
            info=info,
            actions_taken=actions_taken,
            num_tool_calls=num_tool_calls,
            num_turns=len(messages),
            agent_cost=total_cost,
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
            response.params.get("tool_calls") if isinstance(response.params, dict) else None
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
