from __future__ import annotations

from collections.abc import Callable
from typing import Any

from elizaos_plugin_inmemorydb.types import IStorage


class MemoryStorage(IStorage):
    def __init__(self) -> None:
        self._collections: dict[str, dict[str, Any]] = {}
        self._ready = False

    async def init(self) -> None:
        self._ready = True

    async def close(self) -> None:
        self._collections.clear()
        self._ready = False

    async def is_ready(self) -> bool:
        return self._ready

    def _get_collection(self, collection: str) -> dict[str, Any]:
        if collection not in self._collections:
            self._collections[collection] = {}
        return self._collections[collection]

    async def get(self, collection: str, id_: str) -> Any | None:
        col = self._get_collection(collection)
        return col.get(id_)

    async def get_all(self, collection: str) -> list[Any]:
        col = self._get_collection(collection)
        return list(col.values())

    async def get_where(self, collection: str, predicate: Callable[[Any], bool]) -> list[Any]:
        all_items = await self.get_all(collection)
        return [item for item in all_items if predicate(item)]

    async def set(self, collection: str, id_: str, data: Any) -> None:
        col = self._get_collection(collection)
        col[id_] = data

    async def delete(self, collection: str, id_: str) -> bool:
        col = self._get_collection(collection)
        if id_ in col:
            del col[id_]
            return True
        return False

    async def delete_many(self, collection: str, ids: list[str]) -> None:
        col = self._get_collection(collection)
        for id_ in ids:
            col.pop(id_, None)

    async def delete_where(
        self, collection: str, predicate: Callable[[dict[str, Any]], bool]
    ) -> None:
        col = self._get_collection(collection)
        to_delete = [id_ for id_, item in col.items() if predicate(item)]
        for id_ in to_delete:
            del col[id_]

    async def count(
        self,
        collection: str,
        predicate: Callable[[dict[str, Any]], bool] | None = None,
    ) -> int:
        col = self._get_collection(collection)
        if predicate is None:
            return len(col)
        return sum(1 for item in col.values() if predicate(item))

    async def clear(self) -> None:
        self._collections.clear()
