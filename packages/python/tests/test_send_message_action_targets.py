from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos.advanced_capabilities.actions.send_message import (
    send_message_action as advanced_send_message_action,
)
from elizaos.advanced_capabilities.actions.send_message import (
    send_message_action as basic_capabilities_send_message_action,
)
from elizaos.types.memory import Memory
from elizaos.types.primitives import Content, as_uuid


def _make_runtime() -> MagicMock:
    runtime = MagicMock()
    runtime.agent_id = as_uuid("42345678-1234-1234-1234-123456789001")
    runtime.create_memory = AsyncMock()
    runtime.emit_event = AsyncMock()
    runtime.send_message_to_target = AsyncMock()
    runtime.get_room = AsyncMock(return_value=None)
    runtime.get_rooms = AsyncMock(return_value=[])
    runtime.get_entities_for_room = AsyncMock(return_value=[])
    return runtime


def _make_message() -> Memory:
    return Memory(
        id=as_uuid("42345678-1234-1234-1234-123456789010"),
        entity_id=as_uuid("42345678-1234-1234-1234-123456789011"),
        room_id=as_uuid("42345678-1234-1234-1234-123456789012"),
        content=Content(text="fallback", source="telegram"),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action_under_test",
    [basic_capabilities_send_message_action, advanced_send_message_action],
)
async def test_send_message_uses_room_target_parameters(action_under_test: object) -> None:
    runtime = _make_runtime()
    message = _make_message()
    target_room_id = "42345678-1234-1234-1234-123456789099"

    result = await action_under_test.handler(
        runtime,
        message,
        None,
        SimpleNamespace(
            parameters={
                "targetType": "room",
                "target": target_room_id,
                "source": "discord",
                "text": "ship it",
            }
        ),
        None,
        None,
    )

    assert result.success is True
    assert result.values["targetType"] == "room"
    assert result.values["targetRoomId"] == target_room_id
    runtime.create_memory.assert_awaited_once()
    create_kwargs = runtime.create_memory.await_args.kwargs
    assert create_kwargs["room_id"] == as_uuid(target_room_id)

    runtime.send_message_to_target.assert_awaited_once()
    send_target = runtime.send_message_to_target.await_args.args[0]
    assert str(send_target.room_id) == target_room_id
    assert send_target.source == "discord"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action_under_test",
    [basic_capabilities_send_message_action, advanced_send_message_action],
)
async def test_send_message_resolves_user_target_from_room_entities(
    action_under_test: object,
) -> None:
    runtime = _make_runtime()
    message = _make_message()
    target_entity_id = as_uuid("42345678-1234-1234-1234-123456789088")
    runtime.get_entities_for_room = AsyncMock(
        return_value=[SimpleNamespace(id=target_entity_id, names=["Alice"])]
    )

    result = await action_under_test.handler(
        runtime,
        message,
        None,
        SimpleNamespace(
            parameters={
                "targetType": "user",
                "target": "alice",
                "source": "discord",
                "text": "hello",
            }
        ),
        None,
        None,
    )

    assert result.success is True
    assert result.values["targetType"] == "user"
    assert result.values["targetEntityId"] == target_entity_id
    runtime.send_message_to_target.assert_awaited_once()
    send_target = runtime.send_message_to_target.await_args.args[0]
    assert str(send_target.entity_id) == target_entity_id
