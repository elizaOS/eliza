"""Unavailable Card Game infrastructure must never produce a passing score."""

import asyncio

import pytest

from elizaos_agentbench.adapters.card_game_adapter import CardGameAdapter
from elizaos_agentbench.types import AgentBenchEnvironment, AgentBenchTask


@pytest.mark.parametrize("sdk_exists", [False, True])
def test_missing_server_bridge_remains_unsupported(monkeypatch, tmp_path, sdk_exists):
    sdk = tmp_path / "sdk"
    if sdk_exists:
        sdk.write_bytes(b"fixture only")
    monkeypatch.setenv("AGENTBENCH_CARD_GAME_BIN", str(sdk))
    task = AgentBenchTask(
        id="card-bridge-contract",
        environment=AgentBenchEnvironment.CARD_GAME,
        description="Complete a social deduction game",
        initial_state={"game_index": 1},
        goal="Win the game",
        max_steps=10,
    )

    async def exercise():
        adapter = CardGameAdapter()
        await adapter.initialize()
        observation = await adapter.reset(task)
        assert observation["skipped"] is True
        assert "server bridge" in observation["reason"]
        _, reward, done, info = await adapter.step("mission[success]")
        assert reward == 0
        assert done and info["skipped"]
        assert await adapter.evaluate(task, ["mission[success]"]) is False
        await adapter.cleanup()

    asyncio.run(exercise())
