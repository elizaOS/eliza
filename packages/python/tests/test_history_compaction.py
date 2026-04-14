from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from elizaos.features.advanced_memory.actions.reset_session import (
    reset_session_action as advanced_reset_session_action,
)
from elizaos.features.advanced_memory.actions.reset_session import (
    reset_session_action as basic_capabilities_reset_session_action,
)
from elizaos.features.basic_capabilities.providers.recent_messages import (
    recent_messages_provider as basic_capabilities_recent_messages_provider,
)
from elizaos.features.basic_capabilities.providers.recent_messages import (
    recent_messages_provider as basic_recent_messages_provider,
)
from elizaos.types import Content, Memory, as_uuid


@dataclass
class FakeRoom:
    id: object
    world_id: object | None
    metadata: dict[str, object]


class FakeRuntime:
    def __init__(self, room: FakeRoom, *, role: str = "OWNER") -> None:
        self.room = room
        self.updated_room: FakeRoom | None = None
        self.get_room = AsyncMock(return_value=room)
        self.update_room = AsyncMock(side_effect=self._update_room)
        self.get_memories = AsyncMock(return_value=[])
        self.get_entity = AsyncMock(return_value=SimpleNamespace(name="User"))
        self.agent_id = as_uuid("91000000-0000-0000-0000-000000000001")
        self.character = SimpleNamespace(name="CompactionAgent")
        self.get_world = AsyncMock(
            return_value=SimpleNamespace(
                metadata={"roles": {"91000000-0000-0000-0000-000000000002": role}}
            )
        )

    async def _update_room(self, room: FakeRoom) -> None:
        self.updated_room = room
        self.room = room


def _message() -> Memory:
    return Memory(
        id=as_uuid("91000000-0000-0000-0000-000000000010"),
        entity_id=as_uuid("91000000-0000-0000-0000-000000000002"),
        room_id=as_uuid("91000000-0000-0000-0000-000000000003"),
        content=Content(text="start over", source="test"),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action_under_test",
    [basic_capabilities_reset_session_action, advanced_reset_session_action],
)
async def test_reset_session_action_updates_room_metadata(action_under_test: object) -> None:
    room = FakeRoom(
        id=as_uuid("91000000-0000-0000-0000-000000000003"),
        world_id=as_uuid("91000000-0000-0000-0000-000000000004"),
        metadata={
            "lastCompactionAt": 1000,
            "compactionHistory": [{"timestamp": 1000, "triggeredBy": "old", "reason": "manual"}],
        },
    )
    runtime = FakeRuntime(room)

    result = await action_under_test.handler(runtime, _message(), None, None, None, None)

    assert result.success is True
    assert runtime.updated_room is not None
    assert runtime.updated_room.metadata["lastCompactionAt"] >= 1000
    assert len(runtime.updated_room.metadata["compactionHistory"]) == 2
    assert result.values["previousCompactionAt"] == 1000


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "provider_under_test",
    [basic_capabilities_recent_messages_provider, basic_recent_messages_provider],
)
async def test_recent_messages_provider_uses_last_compaction_boundary(
    provider_under_test: object,
) -> None:
    room = FakeRoom(
        id=as_uuid("91000000-0000-0000-0000-000000000003"),
        world_id=None,
        metadata={"lastCompactionAt": 4242},
    )
    runtime = FakeRuntime(room)

    result = await provider_under_test.get(runtime, _message(), None)

    assert result.values["roomId"] == str(_message().room_id)
    call_kwargs = runtime.get_memories.call_args.kwargs
    assert call_kwargs.get("start") == 4242
