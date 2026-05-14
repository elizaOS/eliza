"""Agents that drive an upstream ``Env`` through a multi-turn tau-bench rollout.

Two implementations are provided:

* ``LiteLLMToolCallingAgent`` — wraps an OpenAI-compatible chat-completions
  endpoint via litellm. Equivalent to upstream's ``ToolCallingAgent`` but
  exposed under the ElizaOS API surface and decoupled from upstream's
  ``SolveResult`` so we can report richer per-trial telemetry.

* ``MockTauAgent`` — replays the task's ground-truth ``actions`` then issues a
  RESPOND with a canned message. Only used when ``--mock`` is passed; it does
  not call any LLM and so does not exercise the user simulator either (env is
  reset, ground-truth actions are stepped, env.done is set after the last
  action — sufficient for smoke testing the harness).

The agent loop intentionally mirrors upstream ``ToolCallingAgent.solve`` to
preserve evaluation parity, but works against the ``Env`` *as-is* and returns
the full message list (used by the LLM judge).
"""

from __future__ import annotations

import abc
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Optional

from elizaos_tau_bench.types import (
    Action,
    RESPOND_ACTION_NAME,
)
from elizaos_tau_bench.upstream.envs.base import Env

logger = logging.getLogger(__name__)


@dataclass
class AgentRunResult:
    reward: float
    messages: list[dict[str, Any]]
    info: dict[str, Any]
    actions_taken: list[Action] = field(default_factory=list)
    num_tool_calls: int = 0
    num_turns: int = 0
    agent_cost: float = 0.0
    error: Optional[str] = None


class BaseTauAgent(abc.ABC):
    @abc.abstractmethod
    def solve(self, env: Env, task_index: int, max_num_steps: int = 30) -> AgentRunResult:
        ...


def _message_to_action(message: dict[str, Any]) -> Action:
    tool_calls = message.get("tool_calls")
    if tool_calls and len(tool_calls) > 0 and tool_calls[0].get("function") is not None:
        tc = tool_calls[0]
        fn = tc["function"]
        try:
            kwargs = json.loads(fn.get("arguments") or "{}")
        except json.JSONDecodeError:
            kwargs = {}
        return Action(name=fn["name"], kwargs=kwargs)
    return Action(
        name=RESPOND_ACTION_NAME,
        kwargs={"content": message.get("content") or ""},
    )


class LiteLLMToolCallingAgent(BaseTauAgent):
    """Real LLM agent. Calls a chat-completions model with the env's tools."""

    def __init__(
        self,
        model: str = "gpt-4o",
        provider: str = "openai",
        temperature: float = 0.0,
    ) -> None:
        self.model = model
        self.provider = provider
        self.temperature = temperature

    def solve(self, env: Env, task_index: int, max_num_steps: int = 30) -> AgentRunResult:
        from litellm import completion

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

        try:
            for step_i in range(max_num_steps):
                res = completion(
                    model=self.model,
                    custom_llm_provider=self.provider,
                    messages=messages,
                    tools=env.tools_info,
                    temperature=self.temperature,
                )
                next_message = res.choices[0].message.model_dump()
                step_cost = (
                    res._hidden_params.get("response_cost") if hasattr(res, "_hidden_params") else None
                )
                if step_cost:
                    total_cost += step_cost

                action = _message_to_action(next_message)
                actions_taken.append(action)

                env_response = env.step(action)
                reward = env_response.reward
                info = {**info, **env_response.info.model_dump()}

                if action.name != RESPOND_ACTION_NAME:
                    num_tool_calls += 1
                    # Trim to single tool call per upstream parity
                    tcs = next_message.get("tool_calls") or []
                    if tcs:
                        next_message["tool_calls"] = tcs[:1]
                        tc = next_message["tool_calls"][0]
                        messages.extend([
                            next_message,
                            {
                                "role": "tool",
                                "tool_call_id": tc["id"],
                                "name": tc["function"]["name"],
                                "content": env_response.observation,
                            },
                        ])
                    else:
                        messages.append(next_message)
                else:
                    messages.extend([
                        next_message,
                        {"role": "user", "content": env_response.observation},
                    ])

                if env_response.done:
                    break
        except Exception as e:
            logger.exception("Agent solve loop failed: %s", e)
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


class MockTauAgent(BaseTauAgent):
    """Deterministic mock: replay ground-truth actions, then RESPOND.

    Useful for harness smoke tests when no LLM credentials are available.
    Does not call the user simulator (so does NOT exercise the multi-turn
    LLM loop) — only verifies that env tools execute and reward computation
    matches.
    """

    def __init__(self, final_message: str = "Done. Anything else?") -> None:
        self.final_message = final_message

    def solve(self, env: Env, task_index: int, max_num_steps: int = 30) -> AgentRunResult:
        reset = env.reset(task_index=task_index)
        info: dict[str, Any] = reset.info.model_dump()
        # Replay ground-truth actions deterministically
        actions_taken: list[Action] = []
        reward = 0.0
        num_tool_calls = 0
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": env.wiki},
            {"role": "user", "content": reset.observation},
        ]

        gt_actions = list(env.task.actions)
        for a in gt_actions:
            actions_taken.append(a)
            response = env.step(a)
            reward = response.reward
            info = {**info, **response.info.model_dump()}
            if a.name != RESPOND_ACTION_NAME:
                num_tool_calls += 1
                messages.append({"role": "assistant", "content": f"[mock] tool {a.name}"})
                messages.append({"role": "tool", "name": a.name, "content": response.observation})
            else:
                messages.append({"role": "assistant", "content": a.kwargs.get("content", "")})
                messages.append({"role": "user", "content": response.observation})
            if response.done:
                break

        # Final RESPOND to terminate from user side (only if not already done)
        respond = Action(name=RESPOND_ACTION_NAME, kwargs={"content": self.final_message})
        actions_taken.append(respond)
        final_response = env.step(respond)
        reward = final_response.reward
        info = {**info, **final_response.info.model_dump()}
        messages.append({"role": "assistant", "content": self.final_message})
        messages.append({"role": "user", "content": final_response.observation})

        return AgentRunResult(
            reward=reward,
            messages=messages,
            info=info,
            actions_taken=actions_taken,
            num_tool_calls=num_tool_calls,
            num_turns=len(messages),
        )


def create_tau_agent(
    use_mock: bool = False,
    model: str = "gpt-4o",
    provider: str = "openai",
    temperature: float = 0.0,
) -> BaseTauAgent:
    if use_mock:
        return MockTauAgent()
    return LiteLLMToolCallingAgent(model=model, provider=provider, temperature=temperature)


__all__ = [
    "AgentRunResult",
    "BaseTauAgent",
    "LiteLLMToolCallingAgent",
    "MockTauAgent",
    "create_tau_agent",
]
