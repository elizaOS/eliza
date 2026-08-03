"""Exercises the pinned AgentBench database diagnostic through setup and scoring."""

from __future__ import annotations

import asyncio

from elizaos_agentbench.adapters.db_adapter import DatabaseEnvironmentAdapter
from elizaos_agentbench.types import AgentBenchInfrastructureError, AgentBenchTask
from elizaos_agentbench.upstream_loader import load_db_tasks

_PINNED_TASK_ID = "db-test-0000"
_PINNED_TABLE = "Jiu-Jitsu Championships Results"
_PINNED_LABEL = ["Women +60kg Bronze"]
_PINNED_QUERY = (
    "SELECT [Notes] FROM [Jiu-Jitsu Championships Results] WHERE lower([Method]) = 'decision'"
)


async def verify_database_task_execution(task: AgentBenchTask) -> None:
    """Execute the diagnostic task's real SQLite setup, query, and scorer."""
    if task.id != _PINNED_TASK_ID:
        raise AgentBenchInfrastructureError(
            f"AgentBench database diagnostic changed task: {task.id}"
        )
    if task.metadata.get("table_name") != _PINNED_TABLE:
        raise AgentBenchInfrastructureError("AgentBench database diagnostic table changed")
    if task.metadata.get("label") != _PINNED_LABEL:
        raise AgentBenchInfrastructureError("AgentBench database diagnostic label changed")

    adapter = DatabaseEnvironmentAdapter()
    await adapter.initialize()
    try:
        observation = await adapter.reset(task)
        if _PINNED_TABLE not in observation.get("tables", []):
            raise AgentBenchInfrastructureError(
                "AgentBench database setup did not create the pinned table"
            )
        query_observation, _, _, _ = await adapter.step(_PINNED_QUERY)
        if query_observation.get("success") is not True:
            raise AgentBenchInfrastructureError(
                f"AgentBench database query failed: {query_observation}"
            )
        if not await adapter.evaluate(task, [_PINNED_QUERY]):
            raise AgentBenchInfrastructureError(
                "AgentBench database scorer rejected the pinned expected query"
            )
    finally:
        await adapter.cleanup()


def verify_database_execution() -> None:
    """Load the pinned task and run the executable database diagnostic contract."""
    tasks = load_db_tasks(split="test", limit=1, data_mode="full")
    if len(tasks) != 1:
        raise AgentBenchInfrastructureError(
            f"AgentBench database diagnostic selected {len(tasks)} tasks"
        )
    asyncio.run(verify_database_task_execution(tasks[0]))


if __name__ == "__main__":
    verify_database_execution()
