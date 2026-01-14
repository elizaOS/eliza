from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar

T = TypeVar("T")


class IStorage(ABC):
    @abstractmethod
    async def init(self) -> None: ...

    @abstractmethod
    async def close(self) -> None: ...

    @abstractmethod
    async def is_ready(self) -> bool: ...

    @abstractmethod
    async def get(self, collection: str, id_: str) -> Any | None: ...

    @abstractmethod
    async def get_all(self, collection: str) -> list[Any]: ...

    @abstractmethod
    async def get_where(self, collection: str, predicate: Callable[[Any], bool]) -> list[Any]: ...

    @abstractmethod
    async def set(self, collection: str, id_: str, data: Any) -> None: ...

    @abstractmethod
    async def delete(self, collection: str, id_: str) -> bool: ...

    @abstractmethod
    async def delete_many(self, collection: str, ids: list[str]) -> None: ...

    @abstractmethod
    async def delete_where(
        self, collection: str, predicate: Callable[[dict[str, Any]], bool]
    ) -> None: ...

    @abstractmethod
    async def count(
        self,
        collection: str,
        predicate: Callable[[dict[str, Any]], bool] | None = None,
    ) -> int: ...

    @abstractmethod
    async def clear(self) -> None: ...


class IVectorStorage(ABC):
    @abstractmethod
    async def init(self, dimension: int) -> None: ...

    @abstractmethod
    async def add(self, id_: str, vector: list[float]) -> None: ...

    @abstractmethod
    async def remove(self, id_: str) -> None: ...

    @abstractmethod
    async def search(
        self, query: list[float], k: int, threshold: float = 0.5
    ) -> list[VectorSearchResult]: ...

    @abstractmethod
    async def clear(self) -> None: ...


@dataclass
class VectorSearchResult:
    id: str
    distance: float
    similarity: float


class COLLECTIONS:
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
