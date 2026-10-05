"""Tau-bench agent backed by hermes-agent.

Drop-in equivalent of :class:`elizaos_tau_bench.eliza_agent.LiteLLMToolCallingAgent`
but routes the agent-side completion through :class:`HermesClient`.

The control flow mirrors ``LiteLLMToolCallingAgent.solve`` exactly — same
upstream ``Env`` reset / step loop, same message-building, and same
``_message_to_action`` semantics. Each completion runs through the isolated
native Hermes subprocess client.

Cerebras quirk: ``gpt-oss-120b`` returns a ``reasoning_content`` field on
assistant turns, then rejects subsequent requests that include that field
on prior assistant messages. We strip ``reasoning_content`` and
``provider_specific_fields`` from assistant messages before feeding them
back into the next call.
"""

from __future__ import annotations

from elizaos_tau_bench import (
    strip_cerebras_quirks as _strip_cerebras_quirks,
    scrub_history_for_cerebras as _scrub_history_for_cerebras,
)

from benchmarks.lib import CostAccumulator, cost_from_usage

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

from hermes_adapter.client import HermesClient, MessageResponse

logger = logging.getLogger(__name__)


# Per-million-token USD pricing for Cerebras gpt-oss-120b. Mirrors the
# ``_CEREBRAS_PRICING`` constant in ``hermes_adapter.lifeops_bench`` so
# tau-bench's per-trial ``agent_cost`` is consistent with lifeops-bench
# numbers when both hit the same provider.


class HermesTauAgent(BaseTauAgent):
    """Tau-bench agent that drives an upstream ``Env`` via hermes-agent.

    Mirrors :class:`LiteLLMToolCallingAgent.solve` step-for-step; only the
    chat-completions call is replaced.
    """

    def __init__(
        self,
        model: str = "gemma-4-31b",
        provider: str = "cerebras",
        temperature: float = 0.0,
        client: HermesClient | None = None,
        mode: str | None = None,
    ) -> None:
        self.model = model
        self.provider = provider
        self.temperature = temperature
        if client is not None:
            self.client = client
        else:
            chosen_mode = mode
            if chosen_mode is None:
                chosen_mode = "subprocess"
            self.client = HermesClient(
                provider=provider,
                model=model,
                mode=chosen_mode,
                temperature=temperature,
            )

    # ------------------------------------------------------------------
    # BaseTauAgent
    # ------------------------------------------------------------------

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
                _strip_cerebras_quirks(next_message)

                # Token accounting
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
                        # Trim to single tool call per upstream parity
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
                        # Recovered text tool call had no structured calls;
                        # treat as plain assistant turn so the env can still
                        # advance via the user simulator.
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
            logger.exception("[hermes-tau] solve loop failed")
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

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _one_turn(
        self,
        messages: list[dict[str, Any]],
        tools_info: list[dict[str, Any]],
    ) -> MessageResponse:
        """Send one chat-completions request via the hermes bridge."""
        # We bypass HermesClient's prompt-flattening by passing the full
        # message list under context["messages"]. The empty ``text`` here is
        # only used as a fallback by subprocess mode.
        context: dict[str, object] = {
            "messages": _scrub_history_for_cerebras(messages),
        }
        if tools_info:
            context["tools"] = tools_info
            context["tool_choice"] = "auto"
        if self.temperature is not None:
            context["temperature"] = float(self.temperature)
        # Use the last user-ish text as a bare fallback prompt.
        last_user = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                last_user = str(m.get("content") or "")
                break
        return self.client.send_message(last_user, context=context)

    @staticmethod
    def _response_to_assistant_message(response: MessageResponse) -> dict[str, Any]:
        """Build an OpenAI chat-completions-shape assistant message."""
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


__all__ = ["HermesTauAgent"]
