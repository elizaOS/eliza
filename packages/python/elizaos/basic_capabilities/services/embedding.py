from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import ModelType, Service, ServiceType

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
        self._cache: dict[str, list[float]] = {}
        self._cache_enabled: bool = True
        self._max_cache_size: int = 1000

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> EmbeddingService:
        service = cls()
        service._runtime = runtime
        runtime.logger.info(
            "Embedding service started",
            src="service:embedding",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        if self._runtime:
            self._runtime.logger.info(
                "Embedding service stopped",
                src="service:embedding",
                agentId=str(self._runtime.agent_id),
            )
        self._cache.clear()
        self._runtime = None

    async def embed(self, text: str) -> list[float]:
        if self._runtime is None:
            raise ValueError("Embedding service not started - no runtime available")

        if self._cache_enabled and text in self._cache:
            return self._cache[text]

        embedding = await self._runtime.use_model(
            ModelType.TEXT_EMBEDDING,
            text=text,
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
        if len(self._cache) >= self._max_cache_size:
            oldest_key = next(iter(self._cache))
            del self._cache[oldest_key]
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
            oldest_key = next(iter(self._cache))
            del self._cache[oldest_key]

    async def similarity(self, text1: str, text2: str) -> float:
        embedding1 = await self.embed(text1)
        embedding2 = await self.embed(text2)

        dot_product = sum(a * b for a, b in zip(embedding1, embedding2, strict=True))
        magnitude1 = sum(a * a for a in embedding1) ** 0.5
        magnitude2 = sum(b * b for b in embedding2) ** 0.5

        if magnitude1 == 0 or magnitude2 == 0:
            return 0.0

        return dot_product / (magnitude1 * magnitude2)
