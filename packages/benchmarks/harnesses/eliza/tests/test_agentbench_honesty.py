"""Actual SQLite outcomes distinguish agent SQL from injected answer keys."""

import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "suites" / "agentbench"))

from eliza_adapter.agentbench import ElizaAgentHarness
from elizaos_agentbench.types import AgentBenchEnvironment, AgentBenchTask


@pytest.mark.asyncio
@pytest.mark.parametrize("mock", [False, True])
@pytest.mark.parametrize("command,expected", [("CLICK(1, 2)", False), ("SELECT 17 + 25", True)])
async def test_only_agent_command_reaches_database(monkeypatch, mock, command, expected):
    if mock:
        monkeypatch.setenv("ELIZA_BENCH_MOCK", "true")
    else:
        monkeypatch.delenv("ELIZA_BENCH_MOCK", raising=False)
    db = sqlite3.connect(":memory:")
    received = []
    rows = []

    class Client:
        def reset(self, **kwargs):
            pass

        def send_message(self, **kwargs):
            return NS(text="", params={"command": command})

    class Environment:
        environment = AgentBenchEnvironment.DATABASE

        async def reset(self, task):
            return "SQLite accepts arithmetic SELECT expressions"

        def get_action_space(self):
            return ["SQL"]

        async def step(self, action):
            received.append(action)
            try:
                rows.extend(db.execute(action).fetchall())
                return str(rows), 0, True, {}
            except sqlite3.Error as error:
                return str(error), 0, True, {"invalid_sql": True}

        async def evaluate(self, task, actions):
            return rows == [(42,)]

    task = AgentBenchTask(
        id="sql-task", environment=AgentBenchEnvironment.DATABASE,
        description="Compute the sum", initial_state={}, goal="Compute 17 plus 25",
        max_steps=1, ground_truth="SELECT 42",
    )
    try:
        result = await ElizaAgentHarness(Client()).run_task(task, Environment())
        assert received == [command]
        assert result.actions == [command]
        assert result.success is expected
    finally:
        db.close()
