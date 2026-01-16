from __future__ import annotations

import pytest

from elizaos.runtime import AgentRuntime
from elizaos.types.agent import Character


@pytest.mark.asyncio
async def test_advanced_planning_autoloads_when_enabled() -> None:
    runtime = AgentRuntime(
        character=Character(name="AdvPlanningOn", bio="Test", advancedPlanning=True),
        plugins=[],
    )
    await runtime.initialize()
    assert runtime.get_service("planning") is not None


@pytest.mark.asyncio
async def test_advanced_planning_not_loaded_when_disabled() -> None:
    runtime = AgentRuntime(
        character=Character(name="AdvPlanningOff", bio="Test", advancedPlanning=False),
        plugins=[],
    )
    await runtime.initialize()
    assert runtime.get_service("planning") is None
