"""Tau-bench agent backed by the eliza benchmark server.

Drop-in equivalent of :class:`elizaos_tau_bench.eliza_agent.LiteLLMToolCallingAgent`
but routes the agent-side completion through the eliza TS bench server via
:class:`ElizaClient`. The control flow mirrors
``LiteLLMToolCallingAgent.solve`` step-for-step so reward computation
against the upstream ``Env`` stays identical.

Approach
--------
We re-use ``ElizaClient.send_message`` with ``context={"messages": ...,
"tools": ...}`` — the same shape the lifeops-bench adapter uses
(``bridge.lifeops_message`` is the lifeops-specific superset of this
endpoint and returns identical ``{text, tool_calls, usage}``). This keeps
the adapter symmetric with the hermes / openclaw paths: we ship the OpenAI
chat-completions messages + tool catalog every turn, and read back
``response.params["tool_calls"]`` for the next action. The bench server
owns prompt rendering and provider selection (set via OPENAI_LARGE_MODEL
etc. for plugin-openai).

Note: ``ELIZA_BENCH_SKIP_EMBEDDING=1`` is recommended to keep
plugin-local-inference from being eagerly loaded, which would otherwise
deadlock the bench server boot on CPU-only hosts.
"""

from __future__ import annotations

from elizaos_tau_bench import (
    strip_cerebras_quirks as _strip_cerebras_quirks,
    scrub_history_for_cerebras as _scrub_history_for_cerebras,
)

from benchmarks.lib import CostAccumulator, cost_from_usage

import logging
import os
import uuid
from typing import Any, Final

from elizaos_tau_bench.eliza_agent import (
    AgentRunResult,
    BaseTauAgent,
    _message_to_action,
    _normalize_tool_calls_for_history,
)
from elizaos_tau_bench.types import RESPOND_ACTION_NAME, Action
from elizaos_tau_bench.upstream.envs.base import Env

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


class ElizaTauAgent(BaseTauAgent):
    """Tau-bench agent that drives an upstream ``Env`` via the eliza bench server.

    Identical control flow to :class:`LiteLLMToolCallingAgent`; per-turn
    completions are forwarded to the elizaOS bench server through
    ``runtime.useModel`` and return ``{text, tool_calls, usage}`` for mapping
    into upstream actions. This tests model/tool transport, not the runtime
    planner or child-agent orchestration.
    """

    def __init__(
        self,
        model: str = "gemma-4-31b",
        provider: str = "cerebras",
        temperature: float = 0.0,
        client: ElizaClient | None = None,
        server_manager: Any | None = None,
    ) -> None:
        self.model = model
        self.provider = provider
        self.temperature = temperature
        self._server_manager = server_manager
        if client is not None:
            self.client = client
        else:
            self.client, self._server_manager = _build_default_client()
        self._session_id = f"tau-{uuid.uuid4().hex[:12]}"
        self._reset_done = False
        self.client.wait_until_ready(timeout=120)

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

        # Fresh server session per task — this avoids the runtime carrying
        # stale state across tasks (relevant for retail/airline tools that
        # mutate shared data).
        self._session_id = f"tau-{uuid.uuid4().hex[:12]}"
        self.client.reset(task_id=self._session_id, benchmark="tau_bench")

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
            logger.exception("[eliza-tau] solve loop failed")
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
        self, messages: list[dict[str, Any]], tools_info: list[dict[str, Any]]
    ):
        context: dict[str, object] = {
            "benchmark": "tau_bench",
            "task_id": self._session_id,
            "messages": _scrub_history_for_cerebras(messages),
        }
        if tools_info:
            context["tools"] = tools_info
            context["tool_choice"] = "auto"
        if self.temperature is not None:
            context["temperature"] = float(self.temperature)
        return self.client.send_message(
            next(
                (
                    str(m.get("content") or "")
                    for m in reversed(messages)
                    if m.get("role") == "user"
                ),
                "",
            ),
            context=context,
        )

    @staticmethod
    def _response_to_assistant_message(response) -> dict[str, Any]:
        params = response.params if isinstance(response.params, dict) else {}
        tool_calls = _normalize_tool_calls_for_history(params.get("tool_calls"))
        msg: dict[str, Any] = {
            "role": "assistant",
            "content": response.text or "",
        }
        if tool_calls:
            msg["tool_calls"] = tool_calls
            if not msg["content"]:
                msg["content"] = None
        return msg


def _build_default_client() -> tuple[ElizaClient, Any | None]:
    """Construct an :class:`ElizaClient` and optionally spawn the TS server.

    Mirrors the behaviour of ``eliza_adapter.lifeops_bench.build_lifeops_bench_agent_fn``:
    when no explicit ``ELIZA_BENCH_URL`` is set and the delegate client is
    unavailable, spawn the local TS bench server.
    """
    bridge = ElizaClient()
    server_manager: Any | None = None
    harness = (
        (
            os.environ.get("ELIZA_BENCH_HARNESS")
            or os.environ.get("BENCHMARK_HARNESS")
            or "eliza"
        )
        .strip()
        .lower()
    )
    delegate = getattr(bridge, "_delegate", None)
    if (
        delegate is None
        and not os.environ.get("ELIZA_BENCH_URL")
        and harness in {"", "eliza"}
    ):
        from eliza_adapter.server_manager import ElizaServerManager

        server_manager = ElizaServerManager()
        server_manager.start()
        bridge = server_manager.client
    return bridge, server_manager


__all__ = ["ElizaTauAgent"]
