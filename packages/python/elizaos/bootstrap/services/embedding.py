from __future__ import annotations

import asyncio
import contextlib
from collections import OrderedDict
from typing import TYPE_CHECKING, Any

from elizaos.types import ModelType, Service, ServiceType
from elizaos.types.events import EventType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


class EmbeddingService(Service):
    name = "embedding"
    service_type = ServiceType.UNKNOWN

    @property
    def capability_description(self) -> str:
        return "Text embedding service for generating and caching text embeddings."

    def __init__(self) -> None:
        self._runtime: IAgentRuntime | None = None
        self._cache: OrderedDict[str, list[float]] = OrderedDict()
        self._cache_enabled: bool = True
        self._max_cache_size: int = 1000
        self._queue_max_size: int = 1000
        self._queue: asyncio.Queue[tuple[str | None, Any]] = asyncio.Queue(
            maxsize=self._queue_max_size
        )
        self._pending_payload_keys: set[str] = set()
        self._worker_task: asyncio.Task | None = None

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> EmbeddingService:
        service = cls()
        service._runtime = runtime

        # Register event handler
        event_name = EventType.Name(EventType.EVENT_TYPE_EMBEDDING_GENERATION_REQUESTED)
        runtime.register_event(event_name, service._handle_embedding_request)

        # Start worker
        service._worker_task = asyncio.create_task(service._worker())

        runtime.logger.info(
            "Embedding service started",
            src="service:embedding",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        if self._worker_task:
            self._worker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker_task
            self._worker_task = None

        if self._runtime:
            self._runtime.logger.info(
                "Embedding service stopped",
                src="service:embedding",
                agentId=str(self._runtime.agent_id),
            )
        self._cache.clear()
        self._pending_payload_keys.clear()
        self._queue = asyncio.Queue(maxsize=self._queue_max_size)
        self._runtime = None

    # Max characters for embedding input (~8K tokens at ~4 chars/token)
    MAX_EMBEDDING_CHARS = 32_000

    async def embed(self, text: str) -> list[float]:
        if self._runtime is None:
            raise ValueError("Embedding service not started - no runtime available")

        if self._cache_enabled and text in self._cache:
            embedding = self._cache.pop(text)
            self._cache[text] = embedding
            return embedding

        # Truncate to stay within embedding model token limits
        embed_text = text
        if len(embed_text) > self.MAX_EMBEDDING_CHARS:
            self._runtime.logger.warning(
                "Truncating embedding input from %d to %d chars",
                len(embed_text),
                self.MAX_EMBEDDING_CHARS,
                src="service:embedding",
            )
            embed_text = embed_text[: self.MAX_EMBEDDING_CHARS]

        embedding = await self._runtime.use_model(
            ModelType.TEXT_EMBEDDING,
            text=embed_text,
        )

        if not isinstance(embedding, list):
            raise ValueError(f"Expected list for embedding, got {type(embedding)}")

        embedding = [float(x) for x in embedding]

        if self._cache_enabled:
            self._add_to_cache(text, embedding)

        return embedding

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        embeddings: list[list[float]] = []
        for text in texts:
            embedding = await self.embed(text)
            embeddings.append(embedding)
        return embeddings

    def _add_to_cache(self, text: str, embedding: list[float]) -> None:
        if text in self._cache:
            self._cache.pop(text)
        elif len(self._cache) >= self._max_cache_size:
            self._cache.popitem(last=False)
        self._cache[text] = embedding

    def clear_cache(self) -> None:
        self._cache.clear()

    def set_cache_enabled(self, enabled: bool) -> None:
        self._cache_enabled = enabled
        if not enabled:
            self._cache.clear()

    def set_max_cache_size(self, size: int) -> None:
        if size <= 0:
            raise ValueError("Cache size must be positive")
        self._max_cache_size = size
        while len(self._cache) > self._max_cache_size:
            self._cache.popitem(last=False)

    async def similarity(self, text1: str, text2: str) -> float:
        embedding1 = await self.embed(text1)
        embedding2 = await self.embed(text2)

        dot_product = sum(a * b for a, b in zip(embedding1, embedding2, strict=True))
        magnitude1 = sum(a * a for a in embedding1) ** 0.5
        magnitude2 = sum(b * b for b in embedding2) ** 0.5

        if magnitude1 == 0 or magnitude2 == 0:
            return 0.0

        return dot_product / (magnitude1 * magnitude2)

    async def _handle_embedding_request(self, payload: Any) -> None:
        """Handle embedding generation request event."""
        payload_key = self._get_payload_key(payload)
        if payload_key is not None:
            if payload_key in self._pending_payload_keys:
                return
            self._pending_payload_keys.add(payload_key)

        try:
            await self._queue.put((payload_key, payload))
        except Exception:
            if payload_key is not None:
                self._pending_payload_keys.discard(payload_key)
            raise

    def _get_payload_key(self, payload: Any) -> str | None:
        memory_data = getattr(payload, "memory", None)
        if memory_data is None:
            extra = getattr(payload, "extra", None)
            if hasattr(extra, "__getitem__"):
                with contextlib.suppress(Exception):
                    if "memory" in extra:
                        memory_data = extra["memory"]
        if memory_data is None and isinstance(payload, dict):
            memory_data = payload.get("memory")
        if memory_data is None:
            return None

        if isinstance(memory_data, dict):
            memory_id = memory_data.get("id")
        else:
            memory_id = getattr(memory_data, "id", None)
        if memory_id is None:
            return None
        return str(memory_id)

    async def _worker(self) -> None:
        """Background worker for processing embedding requests."""
        while True:
            try:
                payload_key, payload = await self._queue.get()
            except asyncio.CancelledError:
                break

            try:
                await self._process_embedding_request(payload)
            except Exception as e:
                if self._runtime:
                    self._runtime.logger.error(f"Error in embedding worker: {e}", exc_info=True)
            finally:
                if payload_key is not None:
                    self._pending_payload_keys.discard(payload_key)
                self._queue.task_done()

    async def _process_embedding_request(self, payload: Any) -> None:
        from elizaos.types.events import EventType
        from elizaos.types.memory import Memory

        # Extract memory from payload
        # Handle both protobuf object and dict/wrapper
        memory_data = None
        if hasattr(payload, "memory"):  # specific payload
            memory_data = payload.memory
        elif hasattr(payload, "extra") and hasattr(
            payload.extra, "__getitem__"
        ):  # generic event payload
            try:
                # Check if 'memory' is in extra
                # payload.extra might be a Struct or dict
                if "memory" in payload.extra:
                    from elizaos.runtime import _struct_value_to_python

                    mem_val = payload.extra["memory"]
                    if hasattr(mem_val, "struct_value"):
                        if mem_val.HasField("struct_value"):
                            memory_data = _struct_value_to_python(mem_val)
                        else:
                            memory_data = mem_val
                    else:
                        memory_data = mem_val
            except Exception:
                pass

        if not memory_data:
            return

        # Convert to Memory object if needed
        if isinstance(memory_data, dict):
            memory = Memory(
                id=memory_data.get("id"),
                content=memory_data.get("content"),
                room_id=memory_data.get("roomId") or memory_data.get("room_id"),
                entity_id=memory_data.get("entityId")
                or memory_data.get("entity_id")
                or memory_data.get("userId")
                or memory_data.get("user_id"),
                agent_id=memory_data.get("agentId") or memory_data.get("agent_id"),
            )
            if "embedding" in memory_data:
                memory.embedding = memory_data["embedding"]
            if "metadata" in memory_data:
                memory.metadata = memory_data["metadata"]
        else:
            memory = memory_data

        if not memory.id:
            return

        if memory.embedding and len(memory.embedding) > 0:
            return

        text = (
            memory.content.text
            if hasattr(memory.content, "text")
            else getattr(memory.content, "text", "")
        )
        if not text:
            return

        embedding_source_text = text

        # Intent generation logic
        if len(text) > 20:
            has_intent = False
            if memory.metadata and isinstance(memory.metadata, dict):
                has_intent = "intent" in memory.metadata

            if not has_intent:
                prompt = (
                    "Analyze the following message and extract the core user intent or a summary "
                    "of what they are asking/saying. Return ONLY the intent text.\n"
                    f'Message:\n"{text}"\n\nIntent:'
                )

                try:
                    output = await self._runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)

                    intent = str(output).strip()
                    if intent:
                        embedding_source_text = intent
                        # Update metadata
                        # Use custom metadata for intent
                        memory.metadata.custom.custom_data["intent"] = intent
                except Exception as e:
                    self._runtime.logger.warning(f"Failed to generate intent: {e}")

        # Generate embedding
        try:
            embedding = await self.embed(embedding_source_text)
            # Protobuf repeated field assignment must extend or use slice
            if hasattr(memory.embedding, "extend"):  # It's a repeated field
                del memory.embedding[:]
                memory.embedding.extend(embedding)
            else:
                # If it's a list (unlikely based on error)
                memory.embedding = embedding

            # Update in DB
            if getattr(self._runtime, "_adapter", None):
                await self._runtime._adapter.update_memory(memory)

            # Emit completion
            await self._runtime.emit_event(
                EventType.Name(EventType.EVENT_TYPE_EMBEDDING_GENERATION_COMPLETED),
                {"source": "embedding_service", "memory_id": str(memory.id)},
            )

        except Exception as e:
            self._runtime.logger.error(f"Failed to generate embedding: {e}")
