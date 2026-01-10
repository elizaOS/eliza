"""
JSON file-based storage implementation for Python.
"""

import json
import os
import shutil
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, TypeVar

T = TypeVar("T")


class JSONStorage:
    """
    File-based JSON storage.
    Each item is stored as a separate JSON file in a directory hierarchy.
    """

    def __init__(self, data_dir: str):
        """
        Initialize the storage.

        Args:
            data_dir: Directory for storing data files
        """
        self.data_dir = Path(data_dir)
        self._ready = False

    async def init(self) -> None:
        """Initialize the storage, creating the data directory if needed."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._ready = True

    async def close(self) -> None:
        """Close the storage."""
        self._ready = False

    def is_ready(self) -> bool:
        """Check if storage is ready."""
        return self._ready

    def _get_collection_dir(self, collection: str) -> Path:
        """Get the directory path for a collection."""
        return self.data_dir / collection

    def _get_file_path(self, collection: str, item_id: str) -> Path:
        """Get the file path for an item."""
        # Sanitize id to be filesystem-safe
        safe_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in item_id)
        return self._get_collection_dir(collection) / f"{safe_id}.json"

    async def get(self, collection: str, item_id: str) -> Optional[Dict[str, Any]]:
        """Get an item by collection and id."""
        file_path = self._get_file_path(collection, item_id)
        try:
            if not file_path.exists():
                return None
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return None

    async def get_all(self, collection: str) -> List[Dict[str, Any]]:
        """Get all items in a collection."""
        collection_dir = self._get_collection_dir(collection)
        items: List[Dict[str, Any]] = []
        
        if not collection_dir.exists():
            return items

        for file_path in collection_dir.glob("*.json"):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    items.append(json.load(f))
            except (json.JSONDecodeError, IOError):
                continue

        return items

    async def get_where(
        self,
        collection: str,
        predicate: Callable[[Dict[str, Any]], bool],
    ) -> List[Dict[str, Any]]:
        """Get items matching a predicate."""
        all_items = await self.get_all(collection)
        return [item for item in all_items if predicate(item)]

    async def set(
        self,
        collection: str,
        item_id: str,
        data: Dict[str, Any],
    ) -> None:
        """Set an item in a collection."""
        collection_dir = self._get_collection_dir(collection)
        collection_dir.mkdir(parents=True, exist_ok=True)
        
        file_path = self._get_file_path(collection, item_id)
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)

    async def delete(self, collection: str, item_id: str) -> bool:
        """Delete an item from a collection."""
        file_path = self._get_file_path(collection, item_id)
        try:
            if not file_path.exists():
                return False
            file_path.unlink()
            return True
        except IOError:
            return False

    async def delete_many(self, collection: str, ids: List[str]) -> None:
        """Delete multiple items from a collection."""
        for item_id in ids:
            await self.delete(collection, item_id)

    async def delete_where(
        self,
        collection: str,
        predicate: Callable[[Dict[str, Any]], bool],
    ) -> None:
        """Delete all items matching a predicate."""
        collection_dir = self._get_collection_dir(collection)
        
        if not collection_dir.exists():
            return

        for file_path in collection_dir.glob("*.json"):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    item = json.load(f)
                if predicate(item):
                    file_path.unlink()
            except (json.JSONDecodeError, IOError):
                continue

    async def count(
        self,
        collection: str,
        predicate: Optional[Callable[[Dict[str, Any]], bool]] = None,
    ) -> int:
        """Count items in a collection."""
        if predicate is None:
            collection_dir = self._get_collection_dir(collection)
            if not collection_dir.exists():
                return 0
            return len(list(collection_dir.glob("*.json")))

        items = await self.get_all(collection)
        return len([item for item in items if predicate(item)])

    async def save_raw(self, filename: str, data: str) -> None:
        """Save raw data to a file (for HNSW index)."""
        file_path = self.data_dir / filename
        file_path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(data)

    async def load_raw(self, filename: str) -> Optional[str]:
        """Load raw data from a file (for HNSW index)."""
        file_path = self.data_dir / filename
        try:
            if not file_path.exists():
                return None
            with open(file_path, "r", encoding="utf-8") as f:
                return f.read()
        except IOError:
            return None

