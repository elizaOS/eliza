from __future__ import annotations

import pytest

from elizaos.runtime import AgentRuntime
from elizaos.types.agent import Character


@pytest.mark.asyncio
async def test_advanced_memory_autoloads_when_enabled() -> None:
    runtime = AgentRuntime(
        character=Character(name="AdvMemoryOn", bio="Test", advancedMemory=True),
        plugins=[],
    )
    await runtime.initialize()
    assert runtime.get_service("memory") is not None
    assert any(p.name == "LONG_TERM_MEMORY" for p in runtime.providers)
    assert any(e.name == "MEMORY_SUMMARIZATION" for e in runtime.evaluators)


@pytest.mark.asyncio
async def test_advanced_memory_not_loaded_when_disabled() -> None:
    runtime = AgentRuntime(
        character=Character(name="AdvMemoryOff", bio="Test", advancedMemory=False),
        plugins=[],
    )
    await runtime.initialize()
    assert runtime.get_service("memory") is None
