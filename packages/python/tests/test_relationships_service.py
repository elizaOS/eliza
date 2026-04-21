from __future__ import annotations

from types import SimpleNamespace

import pytest

from elizaos.features.advanced_capabilities.services.relationships import RelationshipsService
from elizaos.types import as_uuid


class FakeLogger:
    def info(self, *args: object, **kwargs: object) -> None:
        pass


class FakeRuntime:
    def __init__(self, entities: dict[object, object]) -> None:
        self.agent_id = as_uuid("40000000-0000-0000-0000-000000000001")
        self.logger = FakeLogger()
        self._entities = entities

    async def get_entity(self, entity_id: object) -> object | None:
        return self._entities.get(entity_id)


@pytest.mark.asyncio
async def test_relationships_service_search_contacts_honors_search_term() -> None:
    entity_id = as_uuid("40000000-0000-0000-0000-000000000010")
    runtime = FakeRuntime(
        {
            entity_id: SimpleNamespace(
                name="Ada Lovelace",
                names=["Ada Lovelace", "Ada"],
            )
        }
    )
    service = await RelationshipsService.start(runtime)  # type: ignore[arg-type]

    await service.add_contact(entity_id, categories=["friend"])

    results = await service.search_contacts(search_term="ada")

    assert [contact.entity_id for contact in results] == [entity_id]
