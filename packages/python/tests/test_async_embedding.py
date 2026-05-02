import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock

from elizaos.features.basic_capabilities.services.embedding import EmbeddingService
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

    async def test_embed_caching_different_texts(self):
        runtime = MagicMock()
        runtime.agent_id = uuid.uuid4()
        runtime.logger = MagicMock()

        async def use_model(model_type, **kwargs):
            if model_type == ModelType.TEXT_EMBEDDING:
                return [0.1] * 384
            return None

        runtime.use_model = AsyncMock(side_effect=use_model)

        service = await EmbeddingService.start(runtime)

        result1 = await service.embed("text one")
        result2 = await service.embed("text two")
        self.assertEqual(len(result1), 384)
        self.assertEqual(len(result2), 384)
        self.assertEqual(runtime.use_model.await_count, 2)

        await service.stop()


if __name__ == "__main__":
    unittest.main()
