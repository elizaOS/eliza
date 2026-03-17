import asyncio
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock

from elizaos.bootstrap.services.embedding import EmbeddingService
from elizaos.types import ModelType


class TestAsyncEmbedding(unittest.IsolatedAsyncioTestCase):
    async def test_async_embedding_generation(self):
        # Mock runtime
        runtime = MagicMock()
        runtime.agent_id = uuid.uuid4()
        runtime.logger = MagicMock()

        async def use_model(model_type, **kwargs):
            if model_type == ModelType.TEXT_EMBEDDING:
                return [0.1] * 384
            return None

        runtime.use_model = AsyncMock(side_effect=use_model)

        # Mock adapter
        adapter = AsyncMock()
        runtime.db = adapter
        runtime._adapter = adapter
        service = await EmbeddingService.start(runtime)

        # Test embedding generation via embed()
        result = await service.embed("A very long message that should trigger embedding.")
        self.assertIsNotNone(result)
        self.assertEqual(len(result), 384)
        self.assertAlmostEqual(result[0], 0.1)

        # Verify caching works
        result2 = await service.embed("A very long message that should trigger embedding.")
        self.assertEqual(result, result2)
        # use_model should have been called only once due to caching
        self.assertEqual(runtime.use_model.await_count, 1)

        await service.stop()

    async def test_handle_embedding_request_deduplicates(self):
        """Test that _handle_embedding_request deduplicates by memory id."""
        runtime = MagicMock()
        runtime.agent_id = uuid.uuid4()
        runtime.logger = MagicMock()
        runtime.use_model = AsyncMock(return_value=[0.1] * 384)

        service = await EmbeddingService.start(runtime)

        from types import SimpleNamespace

        payload = SimpleNamespace(extra={"memory": {"id": "memory-1"}})

        await service._handle_embedding_request(payload)
        await service._handle_embedding_request(payload)

        # Should only queue once due to deduplication
        self.assertEqual(service._queue.qsize(), 1)
        self.assertEqual(service._pending_payload_keys, {"memory-1"})

        await service.stop()


if __name__ == "__main__":
    unittest.main()
