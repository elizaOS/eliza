from __future__ import annotations

import pytest

from elizaos.advanced_memory.types import LongTermMemoryCategory
from elizaos.runtime import AgentRuntime
from elizaos.types.agent import Character
from elizaos.types.components import ProviderResult
from elizaos.types.memory import Memory
from elizaos.types.primitives import Content, as_uuid


@pytest.mark.asyncio
async def test_memory_provider_formats_long_term_memories() -> None:
    runtime = AgentRuntime(
        character=Character(name="AdvMemoryBehavior", bio="Test", advancedMemory=True),
        plugins=[],
    )
    await runtime.initialize()

    svc = runtime.get_service("memory")
    assert svc is not None

    entity_id = as_uuid("12345678-1234-1234-1234-123456789201")
    room_id = as_uuid("12345678-1234-1234-1234-123456789202")
    agent_id = runtime.agent_id

    await svc.store_long_term_memory(
        agent_id=agent_id,
        entity_id=entity_id,
        category=LongTermMemoryCategory.SEMANTIC,
        content="User likes concise answers",
        confidence=0.9,
        source="test",
        metadata={"x": 1},
    )

    msg = Memory(
        id=as_uuid("12345678-1234-1234-1234-123456789203"),
        entity_id=entity_id,
        room_id=room_id,
        content=Content(text="hi"),
    )

    provider = next(p for p in runtime.providers if p.name == "LONG_TERM_MEMORY")
    result: ProviderResult = await provider.get(runtime, msg, await runtime.compose_state(msg))
    assert result.text and "What I Know About You" in result.text
