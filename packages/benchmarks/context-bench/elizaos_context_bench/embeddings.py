"""Embedding support for Context Benchmark.

Provides real embedding functions using either:
1. ElizaOS runtime's embedding model (if available)
2. Sentence-transformers (if installed)
3. Simple hash-based fallback (for testing)
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime


# Type alias for async embedding functions
AsyncEmbeddingFn = Callable[[str], Awaitable[list[float]]]
SyncEmbeddingFn = Callable[[str], list[float]]
EmbeddingFn = SyncEmbeddingFn | AsyncEmbeddingFn


class EmbeddingProvider:
    """Provides embedding functions with caching and lazy initialization."""

    def __init__(
        self,
        model_name: str = "sentence-transformers/all-MiniLM-L6-v2",
        dimension: int = 384,
        use_cache: bool = True,
    ):
        """Initialize embedding provider.

        Args:
            model_name: Name of the sentence-transformers model to use.
            dimension: Embedding dimension (must match model).
            use_cache: Whether to cache embeddings.

        """
        self.model_name = model_name
        self.dimension = dimension
        self.use_cache = use_cache
        self._cache: dict[str, list[float]] = {}
        self._model: object | None = None
        self._model_loaded = False

    def _load_model(self) -> bool:
        """Lazy load the sentence-transformers model.

        Returns:
            True if model loaded successfully, False otherwise.

        """
        if self._model_loaded:
            return self._model is not None

        self._model_loaded = True

        try:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(self.model_name)
            return True
        except ImportError:
            # sentence-transformers not installed
            self._model = None
            return False
        except Exception:
            # Model loading failed
            self._model = None
            return False

    def is_available(self) -> bool:
        """Check if real embeddings are available.

        Returns:
            True if sentence-transformers is available.

        """
        return self._load_model()

    def get_embedding(self, text: str) -> list[float]:
        """Get embedding for text.

        Args:
            text: Text to embed.

        Returns:
            Embedding vector.

        """
        # Check cache first
        if self.use_cache and text in self._cache:
            return self._cache[text]

        # Try to use sentence-transformers
        if self._load_model() and self._model is not None:
            embedding = self._get_st_embedding(text)
        else:
            # Fall back to hash-based pseudo-embeddings
            embedding = self._get_hash_embedding(text)

        # Cache result
        if self.use_cache:
            self._cache[text] = embedding

        return embedding

    def _get_st_embedding(self, text: str) -> list[float]:
        """Get embedding using sentence-transformers.

        Args:
            text: Text to embed.

        Returns:
            Embedding vector.

        """
        # Import here to avoid loading at module level
        import numpy as np

        if self._model is None:
            raise RuntimeError("Model not loaded")

        # Get embedding from model (encode returns numpy array)
        embedding_array = self._model.encode(text, convert_to_numpy=True)  # type: ignore[union-attr]

        # Convert to list and ensure correct type
        if isinstance(embedding_array, np.ndarray):
            return [float(x) for x in embedding_array.tolist()]
        return [float(x) for x in embedding_array]

    def _get_hash_embedding(self, text: str) -> list[float]:
        """Generate pseudo-embeddings using hash-based method.

        This is a fallback when sentence-transformers is not available.
        It produces consistent vectors but without semantic meaning.

        Args:
            text: Text to embed.

        Returns:
            Pseudo-embedding vector.

        """
        # Normalize text
        normalized = text.lower().strip()

        # Create multiple hash values to fill the dimension
        embedding: list[float] = []
        for i in range(self.dimension):
            # Create unique hash for each dimension
            hash_input = f"{normalized}:{i}"
            hash_bytes = hashlib.sha256(hash_input.encode()).digest()
            # Convert first 8 bytes to float in [-1, 1]
            hash_int = int.from_bytes(hash_bytes[:8], "big", signed=True)
            hash_float = hash_int / (2**63)  # Normalize to [-1, 1]
            embedding.append(hash_float)

        # Normalize to unit vector
        norm = math.sqrt(sum(x * x for x in embedding))
        if norm > 0:
            embedding = [x / norm for x in embedding]

        return embedding

    def get_embedding_fn(self) -> SyncEmbeddingFn:
        """Get a sync embedding function.

        Returns:
            Function that takes text and returns embedding.

        """
        return self.get_embedding

    def clear_cache(self) -> None:
        """Clear the embedding cache."""
        self._cache.clear()


def create_eliza_embedding_fn(runtime: "IAgentRuntime") -> AsyncEmbeddingFn | None:
    """Create an async embedding function using Eliza's runtime.

    Args:
        runtime: ElizaOS runtime instance.

    Returns:
        Async embedding function, or None if not available.

    """
    from elizaos.types.model import ModelType

    # Check if embedding model is available
    if not runtime.has_model(ModelType.TEXT_EMBEDDING):
        return None

    async def embed(text: str) -> list[float]:
        """Generate embedding using Eliza runtime.

        Args:
            text: Text to embed.

        Returns:
            Embedding vector.

        """
        result = await runtime.use_model(
            ModelType.TEXT_EMBEDDING,
            {"text": text},
        )
        # Result should be a list of floats
        if isinstance(result, list):
            return [float(x) for x in result]
        raise ValueError(f"Unexpected embedding result type: {type(result)}")

    return embed


def create_sync_wrapper(async_fn: AsyncEmbeddingFn) -> SyncEmbeddingFn:
    """Create a sync wrapper around an async embedding function.

    This is useful when the benchmark suite needs sync embeddings but
    only async functions are available.

    Args:
        async_fn: Async embedding function.

    Returns:
        Sync embedding function.

    """
    import asyncio

    # Cache for embeddings
    cache: dict[str, list[float]] = {}

    def sync_embed(text: str) -> list[float]:
        """Sync wrapper around async embedding function.

        Args:
            text: Text to embed.

        Returns:
            Embedding vector.

        """
        if text in cache:
            return cache[text]

        # Get or create event loop
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop is not None and loop.is_running():
            # We're in an async context - use nest_asyncio or queue
            # For simplicity, use a thread
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(asyncio.run, async_fn(text))
                result = future.result()
        else:
            # Not in async context - can run directly
            result = asyncio.run(async_fn(text))

        cache[text] = result
        return result

    return sync_embed


# Global default provider instance
_default_provider: EmbeddingProvider | None = None


def get_default_embedding_provider() -> EmbeddingProvider:
    """Get the default embedding provider (singleton).

    Returns:
        Default embedding provider.

    """
    global _default_provider
    if _default_provider is None:
        _default_provider = EmbeddingProvider()
    return _default_provider


def get_embedding_fn(
    prefer_real: bool = True,
    runtime: "IAgentRuntime | None" = None,
) -> SyncEmbeddingFn:
    """Get an appropriate embedding function.

    Tries in order:
    1. Eliza runtime embedding (if runtime provided and has model)
    2. Sentence-transformers (if installed)
    3. Hash-based fallback

    Args:
        prefer_real: Whether to prefer real embeddings over hash-based.
        runtime: Optional Eliza runtime for embeddings.

    Returns:
        Sync embedding function.

    """
    # Try Eliza runtime first
    if runtime is not None:
        async_fn = create_eliza_embedding_fn(runtime)
        if async_fn is not None:
            return create_sync_wrapper(async_fn)

    # Try sentence-transformers
    provider = get_default_embedding_provider()
    if prefer_real and provider.is_available():
        return provider.get_embedding_fn()

    # Fall back to hash-based
    return provider.get_embedding_fn()
