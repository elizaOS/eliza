"""Exercises the executable AgentBench database diagnostic contract."""

from __future__ import annotations

import pytest

from elizaos_agentbench.preflight import verify_database_task_execution
from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchInfrastructureError,
    AgentBenchTask,
)


def _diagnostic_task(*, label: list[str] | None = None) -> AgentBenchTask:
    table = "Jiu-Jitsu Championships Results"
    return AgentBenchTask(
        id="db-test-0000",
        environment=AgentBenchEnvironment.DATABASE,
        description="What are the Notes when the Method is decision?",
        initial_state={
            "schema": {
                table: [
                    {"name": "Method", "type": "TEXT"},
                    {"name": "Notes", "type": "TEXT"},
                ]
            },
            "data": {
                table: [
                    {"Method": "Decision", "Notes": "Women +60kg Bronze"},
                    {"Method": "Points", "Notes": "Final"},
                ]
            },
        },
        goal="Return the matching Notes value.",
        max_steps=1,
        metadata={
            "table_name": table,
            "label": label if label is not None else ["Women +60kg Bronze"],
        },
    )


@pytest.mark.asyncio
async def test_database_preflight_executes_setup_query_and_scoring() -> None:
    await verify_database_task_execution(_diagnostic_task())


@pytest.mark.asyncio
async def test_database_preflight_rejects_changed_scoring_contract() -> None:
    with pytest.raises(AgentBenchInfrastructureError, match="label changed"):
        await verify_database_task_execution(_diagnostic_task(label=["different"]))
