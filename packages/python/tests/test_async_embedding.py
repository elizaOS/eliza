import asyncio
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock

from elizaos.bootstrap.services.embedding import EmbeddingService
from elizaos.types import ModelType
from elizaos.types.events import EventType
from elizaos.types.memory import Memory
from elizaos.types.primitives import Content


class TestAsyncEmbedding(unittest.IsolatedAsyncioTestCase):
    async def test_async_embedding_generation(self):
        # Mock runtime
        runtime = (
            MagicMock()
        )  # Don't use spec=IAgentRuntime to avoid abstract methods issues for now
        runtime.agent_id = uuid.uuid4()
        runtime.logger = MagicMock()

        # Event handling
        events = {}

        def register_event(event, handler):
            if event not in events:
                events[event] = []
            events[event].append(handler)

        async def emit_event(event, payload):
            handlers = events.get(event, [])
            for handler in handlers:
                if asyncio.iscoroutinefunction(handler):
                    await handler(payload)
                else:
                    handler(payload)

        async def use_model(model_type, **kwargs):
            if model_type == ModelType.TEXT_SMALL:
                return "intent"
            if model_type == ModelType.TEXT_EMBEDDING:
                return [0.1] * 384
            return None

        runtime.register_event = register_event
        runtime.emit_event = AsyncMock(side_effect=emit_event)
        runtime.use_model = AsyncMock(side_effect=use_model)

        # Mock adapter
        adapter = AsyncMock()
        runtime.db = adapter
        runtime._adapter = adapter
        service = await EmbeddingService.start(runtime)

        # Setup completion listener
        completed_future = asyncio.Future()

        async def on_completed(payload):
            completed_future.set_result(payload)

        runtime.register_event(
            EventType.Name(EventType.EVENT_TYPE_EMBEDDING_GENERATION_COMPLETED), on_completed
        )

        # Create memory
        memory_id = str(uuid.uuid4())
        memory = Memory(
            id=memory_id,
            content=Content(
                text="A very long message that should trigger intent generation and then embedding."
            ),
            room_id=str(uuid.uuid4()),
            entity_id=str(uuid.uuid4()),
            agent_id=str(runtime.agent_id),
        )

        # Emit request
        # Construct proper EventPayload
        # EventPayload (protobuf) expects 'extra' to be a Struct or map<string, Value>
        # But for python test convenience, we can use a mock that has attributes

        # Actually EventPayload 'extra' field is google.protobuf.Struct usually
        # But here we just need an object with .extra attribute for our code to work
        # Or we can use the actual proto class

        # Let's use a simple Namespace
        from types import SimpleNamespace

        payload = SimpleNamespace(extra={"memory": memory})

        # Manually trigger handler because emit_event in MockRuntime doesn't wait for queue processing
        # In real runtime, emit_event calls handlers. embedding service handler writes to queue.
        # Worker reads from queue.

        event_name = EventType.Name(EventType.EVENT_TYPE_EMBEDDING_GENERATION_REQUESTED)
        await runtime.emit_event(event_name, payload)

        # Wait for completion
        try:
            result = await asyncio.wait_for(completed_future, timeout=5.0)
            self.assertEqual(result["memory_id"], str(memory_id))
        except TimeoutError:
            print("TIMEOUT! Logging errors:")
            for call in runtime.logger.error.call_args_list:
                print(call)
            for call in runtime.logger.warning.call_args_list:
                print(call)
            self.fail("Embedding generation timed out")

        # Verify db update
        runtime._adapter.update_memory.assert_called_once()
        call_args = runtime._adapter.update_memory.call_args
        updated_memory = call_args[0][0]
        self.assertIsNotNone(updated_memory.embedding)
        self.assertEqual(len(updated_memory.embedding), 384)
        # Check intent (metadata update)
        # Verify in custom metadata
        self.assertEqual(updated_memory.metadata.custom.custom_data["intent"], "intent")

        await service.stop()


if __name__ == "__main__":
    unittest.main()
