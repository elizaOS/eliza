import asyncio
import math
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock

from elizaos.features.basic_capabilities.services.embedding import EmbeddingService
from elizaos.types import ModelType
from elizaos.types.events import EventType
from elizaos.types.memory import Memory
from elizaos.types.primitives import Content

# Mock vector for "hello world" - simple 384 dim vector
MOCK_VECTOR_HELLO = [0.1] * 384
# Mock vector for something else - orthogonal or different
MOCK_VECTOR_OTHER = [-0.1] * 384


class MockRuntime(MagicMock):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.agent_id = uuid.uuid4()
        self.logger = MagicMock()
        self.events = {}
        self._adapter = AsyncMock()
        self._models = {}

        # Setup model mock
        async def use_model_side_effect(model_type, **kwargs):
            if model_type == ModelType.TEXT_EMBEDDING:
                text = kwargs.get("text", "")
                if "hello" in text.lower():
                    return MOCK_VECTOR_HELLO
                return MOCK_VECTOR_OTHER
            if model_type == ModelType.TEXT_SMALL:
                return "intent"
            return None

        self.use_model = AsyncMock(side_effect=use_model_side_effect)

    def register_event(self, event, handler):
        if event not in self.events:
            self.events[event] = []
        self.events[event].append(handler)

    async def emit_event(self, event, payload):
        handlers = self.events.get(event, [])
        for handler in handlers:
            if asyncio.iscoroutinefunction(handler):
                await handler(payload)
            else:
                handler(payload)


def dot_product(v1: list[float], v2: list[float]) -> float:
    return sum(x * y for x, y in zip(v1, v2, strict=False))


def magnitude(v: list[float]) -> float:
    return math.sqrt(sum(x * x for x in v))


def cosine_similarity(v1: list[float], v2: list[float]) -> float:
    m1 = magnitude(v1)
    m2 = magnitude(v2)
    if m1 == 0 or m2 == 0:
        return 0.0
    return dot_product(v1, v2) / (m1 * m2)


class VerifyMemoryArchitecture(unittest.IsolatedAsyncioTestCase):
    async def test_end_to_end_memory_flow(self):
        print("\n=== Starting Architectural Verification ===")

        # 1. Setup
        runtime = MockRuntime()
        service = await EmbeddingService.start(runtime)

        # --- TEST CASE 1: Short Message (Direct Embedding) ---
        print("\n[Test 1] Short Message (< 20 chars) -> Direct Embedding")

        short_id = str(uuid.uuid4())
        short_memory = Memory(
            id=short_id,
            content=Content(text="Hello World"),  # < 20 chars
            room_id=str(uuid.uuid4()),
            entity_id=str(uuid.uuid4()),
            agent_id=str(runtime.agent_id),
        )

        # Reset Update Memory Mock
        runtime._adapter.update_memory.reset_mock()

        # Trigger
        from types import SimpleNamespace

        payload = SimpleNamespace(extra={"memory": short_memory})
        await self._run_pipeline(runtime, payload)

        # Verify
        runtime._adapter.update_memory.assert_called_once()
        stored_short = runtime._adapter.update_memory.call_args[0][0]

        # "Hello World" contains "hello" -> MOCK_VECTOR_HELLO
        sim = cosine_similarity(list(stored_short.embedding), MOCK_VECTOR_HELLO)
        self.assertAlmostEqual(
            sim, 1.0, places=4, msg="Short message should use direct embedding (Hello)"
        )
        print(f"    -> Verified: Short message embedding matches content (sim={sim:.4f})")

        # --- TEST CASE 2: Long Message (Intent Embedding) ---
        print("\n[Test 2] Long Message (> 20 chars) -> Intent Embedding")

        long_id = str(uuid.uuid4())
        # "Hello World" repeated to be long, but also contains "hello"
        # However, the logic generates INTENT.
        # Mock returns "intent" as intent text.
        # "intent" does NOT contain "hello", so mock returns MOCK_VECTOR_OTHER.
        long_memory = Memory(
            id=long_id,
            content=Content(text="Hello World " * 5),
            room_id=str(uuid.uuid4()),
            entity_id=str(uuid.uuid4()),
            agent_id=str(runtime.agent_id),
        )

        runtime._adapter.update_memory.reset_mock()

        payload_long = SimpleNamespace(extra={"memory": long_memory})
        await self._run_pipeline(runtime, payload_long)

        runtime._adapter.update_memory.assert_called_once()
        stored_long = runtime._adapter.update_memory.call_args[0][0]

        # Expect MOCK_VECTOR_OTHER because embedding was on "intent"
        sim_intent = cosine_similarity(list(stored_long.embedding), MOCK_VECTOR_OTHER)
        self.assertAlmostEqual(
            sim_intent, 1.0, places=4, msg="Long message should use intent embedding"
        )

        # Verify metadata
        self.assertEqual(stored_long.metadata.custom.custom_data["intent"], "intent")
        print(f"    -> Verified: Long message uses intent embedding (sim={sim_intent:.4f})")
        print("    -> Verified: Intent metadata stored")

        # 4. Verify Retrieval & Similarity
        print("\n[3] Verifying Retrieval & Similarity logic...")
        # "Hello there" -> MOCK_VECTOR_HELLO
        # "General Kenobi" -> MOCK_VECTOR_OTHER
        score = await service.similarity("Hello there", "General Kenobi")

        # Expected: dot(HELLO, OTHER)
        # 384 * (0.1 * -0.1) = 384 * -0.01 = -3.84
        # Mag(HELLO) = sqrt(384 * 0.01) = sqrt(3.84) ~= 1.9596
        # Mag(OTHER) = sqrt(384 * 0.01) = sqrt(3.84) ~= 1.9596
        # Cos = -3.84 / (1.9596 * 1.9596) = -3.84 / 3.84 = -1.0
        expected_sim = cosine_similarity(MOCK_VECTOR_HELLO, MOCK_VECTOR_OTHER)
        self.assertAlmostEqual(score, expected_sim, places=4)
        print(f"    -> Similarity calculation verified: {score:.4f} (expected {expected_sim:.4f})")

        await service.stop()
        print("=== Verification Complete ===")

    async def _run_pipeline(self, runtime, payload):
        event_name = EventType.Name(EventType.EVENT_TYPE_EMBEDDING_GENERATION_REQUESTED)
        completion_future = asyncio.Future()

        async def on_complete(p):
            if not completion_future.done():
                completion_future.set_result(p)

        # We need to register/unregister to avoid duplicate calls if running multiple times
        # But MockRuntime implementation appends.
        # For simplicity, just append and ensure we trigger the right future?
        # A new future is needed for each run.
        # Let's clear mocks events for clean slate or just handle it.
        # We can just register a new one.

        runtime.register_event(
            EventType.Name(EventType.EVENT_TYPE_EMBEDDING_GENERATION_COMPLETED), on_complete
        )

        await runtime.emit_event(event_name, payload)

        try:
            await asyncio.wait_for(completion_future, timeout=2.0)
        except TimeoutError:
            self.fail("Async pipeline timed out")


if __name__ == "__main__":
    unittest.main()
