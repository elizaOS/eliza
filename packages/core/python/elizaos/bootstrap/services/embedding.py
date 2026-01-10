"""
Embedding Service - Provides text embedding capabilities.

This service wraps the runtime's embedding model to provide
convenient embedding generation and caching.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import ModelType, Service, ServiceType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


class EmbeddingService(Service):
    """
    Service for generating text embeddings.

    Provides capabilities for:
    - Generating embeddings for text
    - Caching embeddings for reuse
    - Batch embedding generation
    """

    name = "embedding"
    service_type = ServiceType.UNKNOWN  # Plugin service type

    @property
    def capability_description(self) -> str:
        """Get the capability description for this service."""
        return "Text embedding service for generating and caching text embeddings."

    def __init__(self) -> None:
        """Initialize the embedding service."""
        self._runtime: IAgentRuntime | None = None
        self._cache: dict[str, list[float]] = {}
        self._cache_enabled: bool = True
        self._max_cache_size: int = 1000

    async def start(self, runtime: IAgentRuntime) -> None:
        """Start the embedding service."""
        self._runtime = runtime
        runtime.logger.info(
            "Embedding service started",
            src="service:embedding",
            agentId=str(runtime.agent_id),
        )

    async def stop(self) -> None:
        """Stop the embedding service."""
        if self._runtime:
            self._runtime.logger.info(
                "Embedding service stopped",
                src="service:embedding",
                agentId=str(self._runtime.agent_id),
            )
        self._cache.clear()
        self._runtime = None

    async def embed(self, text: str) -> list[float]:
        """
        Generate an embedding for the given text.

        Args:
            text: The text to embed

        Returns:
            The embedding vector

        Raises:
            ValueError: If no runtime is available
        """
        if self._runtime is None:
            raise ValueError("Embedding service not started - no runtime available")

        # Check cache first
        if self._cache_enabled and text in self._cache:
            return self._cache[text]

        # Generate embedding using runtime
        embedding = await self._runtime.use_model(
            ModelType.TEXT_EMBEDDING,
            text=text,
        )

        # Validate result
        if not isinstance(embedding, list):
            raise ValueError(f"Expected list for embedding, got {type(embedding)}")

        # Ensure all elements are floats
        embedding = [float(x) for x in embedding]

        # Cache result
        if self._cache_enabled:
            self._add_to_cache(text, embedding)

        return embedding

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """
        Generate embeddings for multiple texts.

        Args:
            texts: List of texts to embed

        Returns:
            List of embedding vectors
        """
        embeddings: list[list[float]] = []
        for text in texts:
            embedding = await self.embed(text)
            embeddings.append(embedding)
        return embeddings

    def _add_to_cache(self, text: str, embedding: list[float]) -> None:
        """Add an embedding to the cache, managing size."""
        if len(self._cache) >= self._max_cache_size:
            # Remove oldest entry (first key)
            oldest_key = next(iter(self._cache))
            del self._cache[oldest_key]
        self._cache[text] = embedding

    def clear_cache(self) -> None:
        """Clear the embedding cache."""
        self._cache.clear()

    def set_cache_enabled(self, enabled: bool) -> None:
        """Enable or disable caching."""
        self._cache_enabled = enabled
        if not enabled:
            self._cache.clear()

    def set_max_cache_size(self, size: int) -> None:
        """Set the maximum cache size."""
        if size <= 0:
            raise ValueError("Cache size must be positive")
        self._max_cache_size = size
        # Trim cache if needed
        while len(self._cache) > self._max_cache_size:
            oldest_key = next(iter(self._cache))
            del self._cache[oldest_key]

    async def similarity(self, text1: str, text2: str) -> float:
        """
        Calculate cosine similarity between two texts.

        Args:
            text1: First text
            text2: Second text

        Returns:
            Cosine similarity score (0-1)
        """
        embedding1 = await self.embed(text1)
        embedding2 = await self.embed(text2)

        # Calculate cosine similarity
        dot_product = sum(a * b for a, b in zip(embedding1, embedding2, strict=True))
        magnitude1 = sum(a * a for a in embedding1) ** 0.5
        magnitude2 = sum(b * b for b in embedding2) ** 0.5

        if magnitude1 == 0 or magnitude2 == 0:
            return 0.0

        return dot_product / (magnitude1 * magnitude2)

