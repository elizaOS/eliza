"""
Pure in-memory storage implementation.

All data is ephemeral and lost on process restart or close().
"""

from __future__ import annotations

from typing import Any, Callable

from elizaos_plugin_inmemorydb.types import IStorage


class MemoryStorage(IStorage):
    """
    In-memory storage using dict data structures.

    Completely ephemeral - no persistence whatsoever.
    """

    def __init__(self) -> None:
        self._collections: dict[str, dict[str, Any]] = {}
        self._ready = False

    async def init(self) -> None:
        """Initialize the storage."""
        self._ready = True

    async def close(self) -> None:
        """Close the storage (clears all data)."""
        self._collections.clear()
        self._ready = False

    async def is_ready(self) -> bool:
        """Check if storage is ready."""
        return self._ready

    def _get_collection(self, collection: str) -> dict[str, Any]:
        """Get or create a collection."""
        if collection not in self._collections:
            self._collections[collection] = {}
        return self._collections[collection]

    async def get(self, collection: str, id_: str) -> Any | None:
        """Get an item by collection and id."""
        col = self._get_collection(collection)
        return col.get(id_)

    async def get_all(self, collection: str) -> list[Any]:
        """Get all items in a collection."""
        col = self._get_collection(collection)
        return list(col.values())

    async def get_where(
        self, collection: str, predicate: Callable[[Any], bool]
    ) -> list[Any]:
        """Get items by a filter function."""
        all_items = await self.get_all(collection)
        return [item for item in all_items if predicate(item)]

    async def set(self, collection: str, id_: str, data: Any) -> None:
        """Set an item in a collection."""
        col = self._get_collection(collection)
        col[id_] = data

    async def delete(self, collection: str, id_: str) -> bool:
        """Delete an item from a collection."""
        col = self._get_collection(collection)
        if id_ in col:
            del col[id_]
            return True
        return False

    async def delete_many(self, collection: str, ids: list[str]) -> None:
        """Delete multiple items from a collection."""
        col = self._get_collection(collection)
        for id_ in ids:
            col.pop(id_, None)

    async def delete_where(
        self, collection: str, predicate: Callable[[dict[str, Any]], bool]
    ) -> None:
        """Delete all items in a collection matching a predicate."""
        col = self._get_collection(collection)
        to_delete = [id_ for id_, item in col.items() if predicate(item)]
        for id_ in to_delete:
            del col[id_]

    async def count(
        self,
        collection: str,
        predicate: Callable[[dict[str, Any]], bool] | None = None,
    ) -> int:
        """Count items in a collection."""
        col = self._get_collection(collection)
        if predicate is None:
            return len(col)
        return sum(1 for item in col.values() if predicate(item))

    async def clear(self) -> None:
        """Clear all data from all collections."""
        self._collections.clear()

