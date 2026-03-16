from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos.advanced_memory.memory_service import MemoryService
from elizaos.advanced_memory.types import LongTermMemoryCategory
from elizaos.basic_capabilities.services.embedding import (
    EmbeddingService as BasicEmbeddingService,
)
from elizaos.bootstrap.services.embedding import (
    EmbeddingService as BootstrapEmbeddingService,
)
from elizaos.types import ModelType


def _mock_runtime() -> MagicMock:
    runtime = MagicMock()
    runtime.agent_id = uuid.uuid4()
    runtime.logger = MagicMock()

    async def use_model(model_type, **_kwargs):
        if model_type == ModelType.TEXT_EMBEDDING:
            return [0.1, 0.2, 0.3]
        return "ok"

    runtime.use_model = AsyncMock(side_effect=use_model)
    return runtime


@pytest.mark.asyncio
async def test_embedding_services_use_lru_eviction() -> None:
    for service_cls in (BasicEmbeddingService, BootstrapEmbeddingService):
        runtime = _mock_runtime()
        service = service_cls()
        service._runtime = runtime
        service.set_max_cache_size(2)

        await service.embed("a")
        await service.embed("b")
        await service.embed("a")
        await service.embed("c")

        assert list(service._cache.keys()) == ["a", "c"]


@pytest.mark.asyncio
async def test_bootstrap_embedding_queue_deduplicates_and_clears_on_stop() -> None:
    service = BootstrapEmbeddingService()
    service._runtime = _mock_runtime()

    payload = SimpleNamespace(extra={"memory": {"id": "memory-1"}})

    await service._handle_embedding_request(payload)
    await service._handle_embedding_request(payload)

    assert service._queue.qsize() == 1
    assert service._pending_payload_keys == {"memory-1"}

    await service.stop()

    assert service._queue.qsize() == 0
    assert service._pending_payload_keys == set()


@pytest.mark.asyncio
async def test_advanced_memory_fallback_storage_is_bounded() -> None:
    service = MemoryService(runtime=None)
    agent_id = uuid.uuid4()

    for index in range(service._MAX_LOCAL_SESSION_SUMMARIES + 25):
        await service.store_session_summary(
            agent_id=agent_id,
            room_id=uuid.uuid4(),
            summary=f"summary-{index}",
            message_count=index,
            last_message_offset=index,
        )

    assert len(service._session_summaries) == service._MAX_LOCAL_SESSION_SUMMARIES

    for index in range(service._MAX_LOCAL_EXTRACTION_CHECKPOINTS + 25):
        await service.set_last_extraction_checkpoint(uuid.uuid4(), uuid.uuid4(), index)

    assert len(service._extraction_checkpoints) == service._MAX_LOCAL_EXTRACTION_CHECKPOINTS

    for _ in range(service._MAX_LOCAL_LONG_TERM_ENTITIES + 25):
        entity_id = uuid.uuid4()
        await service.store_long_term_memory(
            agent_id=agent_id,
            entity_id=entity_id,
            category=LongTermMemoryCategory.SEMANTIC,
            content=f"entity-{entity_id}",
            confidence=0.9,
        )

    assert len(service._long_term) == service._MAX_LOCAL_LONG_TERM_ENTITIES

    hot_entity_id = uuid.uuid4()
    for index in range(service._MAX_LOCAL_LONG_TERM_PER_ENTITY + 25):
        await service.store_long_term_memory(
            agent_id=agent_id,
            entity_id=hot_entity_id,
            category=LongTermMemoryCategory.SEMANTIC,
            content=f"fact-{index}",
            confidence=float(index),
        )

    retained = service._long_term[str(hot_entity_id)]
    assert len(retained) == service._MAX_LOCAL_LONG_TERM_PER_ENTITY
    assert retained[0].content == "fact-25"
    assert retained[-1].content == f"fact-{service._MAX_LOCAL_LONG_TERM_PER_ENTITY + 24}"
