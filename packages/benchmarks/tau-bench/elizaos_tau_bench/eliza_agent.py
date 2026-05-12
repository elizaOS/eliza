"""Tau-bench agents without the Python Eliza runtime.

The legacy in-process ``elizaos.AgentRuntime`` implementation has been removed
from benchmarks. Eliza-backed runs now route through ``eliza_adapter.tau_bench``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from elizaos_tau_bench.executor import ToolExecutor
from elizaos_tau_bench.types import ConversationTurn, TauBenchTask, ToolCall

logger = logging.getLogger(__name__)

# Compatibility flag for older callers. Python Eliza runtime support is gone.
ELIZAOS_AVAILABLE = False


class ElizaOSTauAgent:
    """Compatibility wrapper backed by the TypeScript bridge.

    The class name is preserved for imports, but it no longer uses Python
    ``elizaos``. It delegates to ``eliza_adapter.tau_bench.ElizaTauAgent``.
    """

    def __init__(
        self,
        executor: ToolExecutor,
        max_turns: int = 15,
        client: object | None = None,
        **_ignored: object,
    ) -> None:
        from eliza_adapter.tau_bench import ElizaTauAgent

        self._agent = ElizaTauAgent(
            executor=executor,
            max_turns=max_turns,
            client=client,  # type: ignore[arg-type]
        )

    async def initialize(self) -> None:
        await self._agent.initialize()

    async def process_task(
        self, task: TauBenchTask
    ) -> tuple[list[ToolCall], str, list[ConversationTurn]]:
        return await self._agent.process_task(task)

    async def close(self) -> None:
        await self._agent.close()


class MockTauAgent:
    """Deterministic mock agent for harness validation."""

    def __init__(
        self,
        executor: ToolExecutor,
        max_turns: int = 15,
    ) -> None:
        self.executor = executor
        self.max_turns = max_turns
        self.conversation: list[ConversationTurn] = []

    async def initialize(self) -> None:
        return None

    async def process_task(
        self, task: TauBenchTask
    ) -> tuple[list[ToolCall], str, list[ConversationTurn]]:
        """Process task using mock responses based on expected calls."""
        tool_calls_made: list[ToolCall] = []
        self.conversation = [
            ConversationTurn(role="user", content=task.user_instruction)
        ]

        for expected_call in task.expected_tool_calls:
            tool_call = ToolCall(
                tool_name=expected_call.tool_name,
                arguments=dict(expected_call.arguments),
            )
            executed_call = await self.executor.execute(tool_call)
            tool_calls_made.append(executed_call)

            self.conversation.append(
                ConversationTurn(
                    role="assistant",
                    content=f"Calling {tool_call.tool_name}...",
                    tool_call=executed_call,
                )
            )
            self.conversation.append(
                ConversationTurn(
                    role="tool",
                    content=json.dumps(executed_call.result, default=str),
                )
            )

        final_response = (
            task.ground_truth_response
            or "I've completed the requested action. Is there anything else I can help you with?"
        )
        self.conversation.append(
            ConversationTurn(role="assistant", content=final_response)
        )
        return tool_calls_made, final_response, self.conversation

    async def close(self) -> None:
        return None


def create_tau_agent(
    executor: ToolExecutor,
    max_turns: int = 15,
    use_mock: bool = False,
    runtime: Any | None = None,
    model_plugin: Any | None = None,
    model_provider: str | None = None,
    temperature: float = 0.0,
    trajectory: Any | None = None,
) -> ElizaOSTauAgent | MockTauAgent:
    """Create a Tau-bench agent.

    Mock mode remains local. Non-mock mode returns a bridge-backed compatibility
    wrapper; the ignored parameters are accepted for old call sites.
    """
    _ = runtime, model_plugin, model_provider, temperature, trajectory
    if use_mock:
        return MockTauAgent(executor=executor, max_turns=max_turns)
    return ElizaOSTauAgent(executor=executor, max_turns=max_turns)


def get_model_provider_plugin(_provider: str | None = None) -> None:
    """Compatibility stub for the removed Python model plugin path."""
    return None


def create_tau_bench_plugin() -> None:
    """Compatibility stub for the removed Python Eliza plugin."""
    return None


__all__ = [
    "ELIZAOS_AVAILABLE",
    "ElizaOSTauAgent",
    "MockTauAgent",
    "create_tau_agent",
    "create_tau_bench_plugin",
    "get_model_provider_plugin",
]
