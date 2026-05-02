from __future__ import annotations

from types import SimpleNamespace
from typing import cast

import pytest

from elizaos.features.advanced_capabilities.evaluators.relationship_extraction import (
    _handle_admin_updates,
)
from elizaos.types import Content, IAgentRuntime, Memory, as_uuid


class FakeLogger:
    def __init__(self) -> None:
        self.infos: list[str] = []
        self.warnings: list[str] = []

    def info(self, message: str) -> None:
        self.infos.append(message)

    def warning(self, message: str) -> None:
        self.warnings.append(message)


class FakeRuntime:
    def __init__(self, admin: object, room_entities: list[object]) -> None:
        self.agent_id = as_uuid("40000000-0000-0000-0000-000000000001")
        self.logger = FakeLogger()
        self._admin = admin
        self._room_entities = room_entities
        self.updated_entities: list[object] = []

    async def get_entity(self, entity_id: object) -> object | None:
        if entity_id == getattr(self._admin, "id", None):
            return self._admin
        return None

    async def get_entities_for_room(self, _room_id: object) -> list[object]:
        return self._room_entities

    async def update_entity(self, entity: object) -> None:
        self.updated_entities.append(entity)


def _message(text: str, entity_id: str) -> Memory:
    return Memory(
        entity_id=entity_id,
        room_id=as_uuid("40000000-0000-0000-0000-000000000002"),
        content=Content(text=text),
        created_at=0,
    )


@pytest.mark.asyncio
async def test_admin_updates_allow_only_safe_fields() -> None:
    admin = SimpleNamespace(
        id=as_uuid("40000000-0000-0000-0000-000000000010"),
        metadata={"isAdmin": True},
    )
    target = SimpleNamespace(
        id=as_uuid("40000000-0000-0000-0000-000000000011"),
        names=["Ada Lovelace"],
        metadata={},
    )
    runtime = FakeRuntime(admin, [target])

    await _handle_admin_updates(
        cast(IAgentRuntime, runtime),
        _message("set Ada Lovelace notes to prefers async updates", admin.id),
    )

    assert runtime.updated_entities == [target]
    assert target.metadata["notes"] == "prefers async updates"
    assert runtime.logger.infos


@pytest.mark.asyncio
async def test_admin_updates_reject_sensitive_fields() -> None:
    admin = SimpleNamespace(
        id=as_uuid("40000000-0000-0000-0000-000000000020"),
        metadata={"isAdmin": True},
    )
    target = SimpleNamespace(
        id=as_uuid("40000000-0000-0000-0000-000000000021"),
        names=["Ada Lovelace"],
        metadata={},
    )
    runtime = FakeRuntime(admin, [target])

    await _handle_admin_updates(
        cast(IAgentRuntime, runtime),
        _message("set Ada Lovelace privateData to true", admin.id),
    )

    assert runtime.updated_entities == []
    assert target.metadata == {}
    assert runtime.logger.warnings
