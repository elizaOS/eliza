import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import TypeVar
from uuid import UUID

logger = logging.getLogger(__name__)

T = TypeVar("T")


@dataclass
class CacheEntry:
    data: object
    timestamp: float
    ttl: float
    access_count: int = 0
    last_accessed: float = 0.0

    def __post_init__(self) -> None:
        if self.last_accessed == 0.0:
            self.last_accessed = self.timestamp


@dataclass
class CacheStats:
    total_entries: int
    hit_rate: float
    miss_rate: float
    memory_usage: int
    oldest_entry: float
    newest_entry: float
    total_hits: int
    total_misses: int


class CacheManager:
    def __init__(
        self,
        max_size: int = 1000,
        default_ttl_ms: int = 300000,
    ) -> None:
        self._cache: dict[str, CacheEntry] = {}
        self._max_size = max_size
        self._default_ttl = default_ttl_ms / 1000.0  # Convert to seconds
        self._hits = 0
        self._misses = 0
        self._evictions = 0
        self._expired = 0
        self._cleanup_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())
        logger.info("CacheManager started")

    async def stop(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        self._cache.clear()
        logger.info("CacheManager stopped")

    async def _cleanup_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(60)  # Cleanup every minute
                self._cleanup()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in cache cleanup: {e}")

    def _cleanup(self) -> None:
        now = datetime.utcnow().timestamp()
        to_delete = []

        for key, entry in self._cache.items():
            if self._is_expired(entry, now):
                to_delete.append(key)

        for key in to_delete:
            del self._cache[key]
            self._expired += 1

        if to_delete:
            logger.debug(f"Cleaned up {len(to_delete)} expired cache entries")

    def _is_expired(self, entry: CacheEntry, now: float | None = None) -> bool:
        if now is None:
            now = datetime.utcnow().timestamp()
        return now - entry.timestamp > entry.ttl

    def _evict_lru(self) -> None:
        if not self._cache:
            return

        oldest_key = min(
            self._cache.keys(),
            key=lambda k: self._cache[k].last_accessed,
        )
        del self._cache[oldest_key]
        self._evictions += 1

    async def get(self, key: str) -> object | None:
        """
        Get a value from the cache.

        Args:
            key: Cache key

        Returns:
            Cached value or None if not found/expired
        """
        entry = self._cache.get(key)

        if entry is None:
            self._misses += 1
            return None

        if self._is_expired(entry):
            del self._cache[key]
            self._expired += 1
            self._misses += 1
            return None

        entry.access_count += 1
        entry.last_accessed = datetime.utcnow().timestamp()
        self._hits += 1

        return entry.data

    async def set(
        self,
        key: str,
        data: object,
        ttl_ms: int | None = None,
    ) -> None:
        now = datetime.utcnow().timestamp()
        ttl = (ttl_ms / 1000.0) if ttl_ms else self._default_ttl

        # Evict if at capacity and key doesn't exist
        if len(self._cache) >= self._max_size and key not in self._cache:
            self._evict_lru()

        self._cache[key] = CacheEntry(
            data=data,
            timestamp=now,
            ttl=ttl,
            access_count=1,
            last_accessed=now,
        )

    async def delete(self, key: str) -> bool:
        """
        Delete a key from the cache.

        Args:
            key: Cache key

        Returns:
            True if key was deleted
        """
        if key in self._cache:
            del self._cache[key]
            return True
        return False

    async def has(self, key: str) -> bool:
        entry = self._cache.get(key)
        if entry is None:
            return False

        if self._is_expired(entry):
            del self._cache[key]
            self._expired += 1
            return False

        return True

    async def clear(self) -> None:
        self._cache.clear()
        self._reset_stats()

    async def get_or_set(
        self,
        key: str,
        fetcher: Callable[[], object],
        ttl_ms: int | None = None,
    ) -> object:
        cached = await self.get(key)
        if cached is not None:
            return cached

        if asyncio.iscoroutinefunction(fetcher):
            data = await fetcher()
        else:
            data = fetcher()

        await self.set(key, data, ttl_ms)
        return data

    async def mget(self, keys: list[str]) -> dict[str, object]:
        """
        Get multiple values from the cache.

        Args:
            keys: List of cache keys

        Returns:
            Dictionary of found key-value pairs
        """
        results = {}
        for key in keys:
            value = await self.get(key)
            if value is not None:
                results[key] = value
        return results

    async def mset(
        self,
        entries: dict[str, object],
        ttl_ms: int | None = None,
    ) -> None:
        for key, value in entries.items():
            await self.set(key, value, ttl_ms)

    async def delete_by_pattern(self, pattern: str) -> int:
        import re

        regex = re.compile(pattern)
        to_delete = [k for k in self._cache.keys() if regex.search(k)]

        for key in to_delete:
            del self._cache[key]

        return len(to_delete)

    def get_stats(self) -> CacheStats:
        total_requests = self._hits + self._misses
        hit_rate = self._hits / total_requests if total_requests > 0 else 0.0
        miss_rate = self._misses / total_requests if total_requests > 0 else 0.0

        oldest = float("inf")
        newest = 0.0
        memory_estimate = 0

        for entry in self._cache.values():
            oldest = min(oldest, entry.timestamp)
            newest = max(newest, entry.timestamp)
            try:
                memory_estimate += len(json.dumps(entry.data)) * 2
            except (TypeError, ValueError):
                memory_estimate += 1000

        return CacheStats(
            total_entries=len(self._cache),
            hit_rate=hit_rate,
            miss_rate=miss_rate,
            memory_usage=memory_estimate,
            oldest_entry=oldest if oldest != float("inf") else 0.0,
            newest_entry=newest,
            total_hits=self._hits,
            total_misses=self._misses,
        )

    def _reset_stats(self) -> None:
        self._hits = 0
        self._misses = 0
        self._evictions = 0
        self._expired = 0

    async def cache_entity(
        self,
        entity_id: UUID,
        entity: object,
        ttl_ms: int = 300000,
    ) -> None:
        await self.set(f"entity:{entity_id}", entity, ttl_ms)

    async def get_cached_entity(self, entity_id: UUID) -> object | None:
        return await self.get(f"entity:{entity_id}")

    async def cache_reminder_recommendation(
        self,
        todo_id: UUID,
        recommendation: object,
        ttl_ms: int = 600000,
    ) -> None:
        await self.set(f"recommendation:{todo_id}", recommendation, ttl_ms)

    async def get_cached_reminder_recommendation(self, todo_id: UUID) -> object | None:
        return await self.get(f"recommendation:{todo_id}")

    async def cache_service_health(
        self,
        service_name: str,
        health: object,
        ttl_ms: int = 30000,
    ) -> None:
        await self.set(f"health:{service_name}", health, ttl_ms)

    async def get_cached_service_health(self, service_name: str) -> object | None:
        return await self.get(f"health:{service_name}")
