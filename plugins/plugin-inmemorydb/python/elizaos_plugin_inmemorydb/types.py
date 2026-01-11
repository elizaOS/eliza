"""
Type definitions for plugin-inmemorydb.

Pure in-memory, ephemeral storage - no persistence.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

T = TypeVar("T")


class IStorage(ABC):
    """Storage interface for in-memory data."""

    @abstractmethod
    async def init(self) -> None:
        """Initialize the storage."""
        ...

    @abstractmethod
    async def close(self) -> None:
        """Close the storage (clears all data)."""
        ...

    @abstractmethod
    async def is_ready(self) -> bool:
        """Check if storage is ready."""
        ...

    @abstractmethod
    async def get(self, collection: str, id_: str) -> Any | None:
        """Get an item by collection and id."""
        ...

    @abstractmethod
    async def get_all(self, collection: str) -> list[Any]:
        """Get all items in a collection."""
        ...

    @abstractmethod
    async def get_where(
        self, collection: str, predicate: Callable[[Any], bool]
    ) -> list[Any]:
        """Get items by a filter function."""
        ...

    @abstractmethod
    async def set(self, collection: str, id_: str, data: Any) -> None:
        """Set an item in a collection."""
        ...

    @abstractmethod
    async def delete(self, collection: str, id_: str) -> bool:
        """Delete an item from a collection."""
        ...

    @abstractmethod
    async def delete_many(self, collection: str, ids: list[str]) -> None:
        """Delete multiple items from a collection."""
        ...

    @abstractmethod
    async def delete_where(
        self, collection: str, predicate: Callable[[dict[str, Any]], bool]
    ) -> None:
        """Delete all items in a collection matching a predicate."""
        ...

    @abstractmethod
    async def count(
        self,
        collection: str,
        predicate: Callable[[dict[str, Any]], bool] | None = None,
    ) -> int:
        """Count items in a collection."""
        ...

    @abstractmethod
    async def clear(self) -> None:
        """Clear all data from all collections."""
        ...


class IVectorStorage(ABC):
    """Vector storage interface for HNSW-based similarity search."""

    @abstractmethod
    async def init(self, dimension: int) -> None:
        """Initialize the vector storage."""
        ...

    @abstractmethod
    async def add(self, id_: str, vector: list[float]) -> None:
        """Add a vector with associated id."""
        ...

    @abstractmethod
    async def remove(self, id_: str) -> None:
        """Remove a vector by id."""
        ...

    @abstractmethod
    async def search(
        self, query: list[float], k: int, threshold: float = 0.5
    ) -> list["VectorSearchResult"]:
        """Search for nearest neighbors."""
        ...

    @abstractmethod
    async def clear(self) -> None:
        """Clear all vectors from the index."""
        ...


@dataclass
class VectorSearchResult:
    """Result of a vector similarity search."""

    id: str
    distance: float
    similarity: float


class COLLECTIONS:
    """Collections used by the adapter."""

    AGENTS = "agents"
    ENTITIES = "entities"
    MEMORIES = "memories"
    ROOMS = "rooms"
    WORLDS = "worlds"
    COMPONENTS = "components"
    RELATIONSHIPS = "relationships"
    PARTICIPANTS = "participants"
    TASKS = "tasks"
    CACHE = "cache"
    LOGS = "logs"
    EMBEDDINGS = "embeddings"

