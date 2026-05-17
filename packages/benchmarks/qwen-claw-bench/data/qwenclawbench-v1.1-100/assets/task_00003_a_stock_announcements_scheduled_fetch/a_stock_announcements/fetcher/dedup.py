"""
Deduplication store backed by a JSON file.

Keeps a rolling window of seen announcement hashes to avoid
storing duplicates across overlapping fetch windows.
"""

import json
import time
import logging
from pathlib import Path
from typing import Set

logger = logging.getLogger(__name__)

# Keep hashes for 7 days to handle overlapping windows
MAX_AGE_SECONDS = 7 * 24 * 3600


class DeduplicationStore:
    """Simple hash-based deduplication with TTL expiry."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._store: dict = {}  # hash -> timestamp
        self._load()

    def _load(self):
        if self.db_path.exists():
            try:
                with open(self.db_path, "r") as f:
                    self._store = json.load(f)
                self._prune()
            except (json.JSONDecodeError, IOError) as e:
                logger.warning("Failed to load dedup DB, starting fresh: %s", e)
                self._store = {}

    def _save(self):
        try:
            with open(self.db_path, "w") as f:
                json.dump(self._store, f)
        except IOError as e:
            logger.error("Failed to save dedup DB: %s", e)

    def _prune(self):
        """Remove entries older than MAX_AGE_SECONDS."""
        now = time.time()
        before = len(self._store)
        self._store = {
            k: v for k, v in self._store.items()
            if now - v < MAX_AGE_SECONDS
        }
        pruned = before - len(self._store)
        if pruned:
            logger.info("Pruned %d expired dedup entries", pruned)

    def seen(self, hash_key: str) -> bool:
        return hash_key in self._store

    def mark(self, hash_key: str):
        self._store[hash_key] = time.time()
        self._save()

    def count(self) -> int:
        return len(self._store)
