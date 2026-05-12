"""AgentBench bridge compatibility helpers.

The Python ``elizaos.AgentRuntime`` harness has been removed from benchmarks.
Eliza-backed AgentBench runs now use ``eliza_adapter.agentbench`` and the
TypeScript benchmark server. This module keeps the environment protocol and
old helper names so imports remain stable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchResult,
    AgentBenchTask,
    ObservationType,
)


class EnvironmentAdapterProtocol(Protocol):
    """Protocol implemented by AgentBench environment adapters."""

    @property
    def environment(self) -> AgentBenchEnvironment:
        ...

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        ...

    async def step(self, action: str) -> tuple[ObservationType, float, bool, dict[str, object]]:
        ...

    async def evaluate(self, task: AgentBenchTask, actions: list[str]) -> bool:
        ...

    def get_action_space(self) -> list[str] | dict[str, object] | str:
        ...

    def parse_action(self, response: str) -> str:
        ...


@dataclass
class BenchmarkDatabaseAdapter:
    """Compatibility placeholder for the removed Python runtime database adapter."""

    name: str = "removed-python-eliza-runtime"


class ElizaAgentHarness:
    """Compatibility placeholder for the removed Python runtime harness."""

    def __init__(self, *_args: object, **_kwargs: object) -> None:
        raise RuntimeError(
            "The Python Eliza AgentBench harness was removed. Use "
            "eliza_adapter.agentbench.ElizaAgentHarness with ElizaServerManager."
        )


def create_benchmark_character() -> dict[str, object]:
    """Return minimal metadata for callers that still display benchmark identity."""
    return {
        "name": "AgentBench",
        "description": "AgentBench evaluation via the Eliza TypeScript bridge",
    }


async def create_benchmark_runtime(*_args: object, **_kwargs: object) -> object:
    """Compatibility stub for the removed Python runtime factory."""
    raise RuntimeError(
        "The Python Eliza AgentBench runtime was removed. Use the TypeScript bridge "
        "via packages/benchmarks/eliza-adapter."
    )


def create_benchmark_plugin() -> None:
    """Compatibility stub for the removed Python plugin."""
    return None


__all__ = [
    "BenchmarkDatabaseAdapter",
    "ElizaAgentHarness",
    "EnvironmentAdapterProtocol",
    "create_benchmark_character",
    "create_benchmark_plugin",
    "create_benchmark_runtime",
]
