"""
Research Storage Service

Manages storage and retrieval of market research data using a cache system.
Research results are stored with expiration tracking to ensure freshness.
"""

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol

logger = logging.getLogger(__name__)

# Cache key prefix for research data
RESEARCH_CACHE_PREFIX = "polymarket_research:"

# Default research expiry time (24 hours in seconds)
DEFAULT_RESEARCH_EXPIRY_SECS = 24 * 60 * 60


class ResearchStatus(str, Enum):
    """Status of market research."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"


@dataclass(frozen=True)
class ResearchSource:
    """A source used in research."""

    title: str
    url: str
    snippet: str | None = None


@dataclass(frozen=True)
class ResearchRecommendation:
    """Trading recommendation from research."""

    should_trade: bool
    direction: str | None  # "YES" or "NO"
    confidence: int  # 0-100
    reasoning: str


@dataclass(frozen=True)
class ResearchResult:
    """Completed research result."""

    summary: str
    text: str
    recommendation: ResearchRecommendation | None = None
    sources: list[ResearchSource] = field(default_factory=list)
    sources_count: int = 0


@dataclass
class MarketResearch:
    """Market research data stored in cache."""

    market_id: str
    market_question: str
    status: ResearchStatus
    task_id: str | None = None
    research_id: str | None = None
    started_at: int | None = None
    completed_at: int | None = None
    expires_at: int | None = None
    result: ResearchResult | None = None
    error_message: str | None = None


class CacheProtocol(Protocol):
    """Protocol for cache implementations."""

    async def get(self, key: str) -> MarketResearch | None:
        """Get value from cache."""
        ...

    async def set(self, key: str, value: MarketResearch) -> None:
        """Set value in cache."""
        ...

    async def delete(self, key: str) -> None:
        """Delete value from cache."""
        ...


class InMemoryCache:
    """Simple in-memory cache implementation."""

    def __init__(self) -> None:
        self._data: dict[str, MarketResearch] = {}

    async def get(self, key: str) -> MarketResearch | None:
        return self._data.get(key)

    async def set(self, key: str, value: MarketResearch) -> None:
        self._data[key] = value

    async def delete(self, key: str) -> None:
        self._data.pop(key, None)


class ResearchStorageService:
    """
    Service for managing market research storage.

    Provides methods to store, retrieve, and manage research data
    for Polymarket markets. Supports caching with expiration.
    """

    def __init__(
        self,
        cache: CacheProtocol | None = None,
        expiry_secs: int = DEFAULT_RESEARCH_EXPIRY_SECS,
    ) -> None:
        """
        Initialize the research storage service.

        Args:
            cache: Cache implementation (defaults to in-memory)
            expiry_secs: Research expiry time in seconds (default: 24 hours)
        """
        self._cache = cache or InMemoryCache()
        self._expiry_secs = expiry_secs

    def _get_cache_key(self, market_id: str) -> str:
        """Generate cache key for a market."""
        return f"{RESEARCH_CACHE_PREFIX}{market_id}"

    async def get_market_research(self, market_id: str) -> MarketResearch | None:
        """
        Get research for a specific market.

        Returns None if no research exists.
        Returns with EXPIRED status if research is stale.

        Args:
            market_id: The market condition ID

        Returns:
            MarketResearch or None
        """
        key = self._get_cache_key(market_id)
        research = await self._cache.get(key)

        if research is None:
            return None

        # Check if research has expired
        if (
            research.status == ResearchStatus.COMPLETED
            and research.expires_at
            and time.time() > research.expires_at
        ):
            logger.debug(f"Research for market {market_id} has expired")
            # Return with expired status (don't modify cached version)
            return MarketResearch(
                market_id=research.market_id,
                market_question=research.market_question,
                status=ResearchStatus.EXPIRED,
                task_id=research.task_id,
                research_id=research.research_id,
                started_at=research.started_at,
                completed_at=research.completed_at,
                expires_at=research.expires_at,
                result=research.result,
                error_message=research.error_message,
            )

        return research

    async def get_research_by_token_id(self, token_id: str) -> MarketResearch | None:
        """
        Get research by token ID (looks up via market-token mapping).

        Args:
            token_id: The token ID

        Returns:
            MarketResearch or None
        """
        mapping_key = f"{RESEARCH_CACHE_PREFIX}token:{token_id}"
        market_id_research = await self._cache.get(mapping_key)

        if market_id_research is None:
            return None

        # The mapping stores market_id as a simple string in the research object
        return await self.get_market_research(market_id_research.market_id)

    async def mark_research_in_progress(
        self,
        market_id: str,
        market_question: str,
        task_id: str,
    ) -> None:
        """
        Mark research as in progress.

        Args:
            market_id: The market condition ID
            market_question: The market question text
            task_id: The async task ID
        """
        key = self._get_cache_key(market_id)
        research = MarketResearch(
            market_id=market_id,
            market_question=market_question,
            status=ResearchStatus.IN_PROGRESS,
            task_id=task_id,
            started_at=int(time.time()),
        )
        await self._cache.set(key, research)
        logger.info(f"Marked research IN_PROGRESS for market: {market_id}")

    async def store_research_result(
        self,
        market_id: str,
        result: ResearchResult,
        research_id: str,
    ) -> None:
        """
        Store completed research results.

        Args:
            market_id: The market condition ID
            result: The research result
            research_id: OpenAI research ID
        """
        key = self._get_cache_key(market_id)
        existing = await self.get_market_research(market_id)

        if existing is None:
            logger.warning(f"Cannot store result - no existing research for market {market_id}")
            return

        now = int(time.time())
        research = MarketResearch(
            market_id=existing.market_id,
            market_question=existing.market_question,
            status=ResearchStatus.COMPLETED,
            task_id=existing.task_id,
            research_id=research_id,
            started_at=existing.started_at,
            completed_at=now,
            expires_at=now + self._expiry_secs,
            result=result,
        )
        await self._cache.set(key, research)
        logger.info(f"Stored COMPLETED research for market: {market_id}")

    async def mark_research_failed(
        self,
        market_id: str,
        error_message: str,
    ) -> None:
        """
        Mark research as failed.

        Args:
            market_id: The market condition ID
            error_message: The error message
        """
        key = self._get_cache_key(market_id)
        existing = await self.get_market_research(market_id)

        research = MarketResearch(
            market_id=market_id,
            market_question=existing.market_question if existing else "Unknown",
            status=ResearchStatus.FAILED,
            task_id=existing.task_id if existing else None,
            started_at=existing.started_at if existing else None,
            completed_at=int(time.time()),
            error_message=error_message,
        )
        await self._cache.set(key, research)
        logger.error(f"Marked research FAILED for market {market_id}: {error_message}")

    async def delete_research(self, market_id: str) -> None:
        """
        Delete research for a market.

        Args:
            market_id: The market condition ID
        """
        key = self._get_cache_key(market_id)
        await self._cache.delete(key)
        logger.debug(f"Deleted research for market: {market_id}")

    async def store_token_mapping(self, token_id: str, market_id: str) -> None:
        """
        Store token-to-market mapping for token ID lookups.

        Args:
            token_id: The token ID
            market_id: The market condition ID
        """
        mapping_key = f"{RESEARCH_CACHE_PREFIX}token:{token_id}"
        # Store a minimal research object with just the market_id
        mapping = MarketResearch(
            market_id=market_id,
            market_question="",
            status=ResearchStatus.PENDING,
        )
        await self._cache.set(mapping_key, mapping)

    async def is_research_available(self, market_id: str) -> bool:
        """
        Check if research is available and current for trading decisions.

        Args:
            market_id: The market condition ID

        Returns:
            True if completed research exists
        """
        research = await self.get_market_research(market_id)
        return research is not None and research.status == ResearchStatus.COMPLETED

    async def is_research_in_progress(self, market_id: str) -> bool:
        """
        Check if research is currently in progress.

        Args:
            market_id: The market condition ID

        Returns:
            True if research is in progress
        """
        research = await self.get_market_research(market_id)
        return research is not None and research.status == ResearchStatus.IN_PROGRESS

    async def get_research_elapsed_minutes(self, market_id: str) -> int | None:
        """
        Get elapsed time since research started (in minutes).

        Args:
            market_id: The market condition ID

        Returns:
            Elapsed minutes or None if not started
        """
        research = await self.get_market_research(market_id)
        if research is None or research.started_at is None:
            return None
        return int((time.time() - research.started_at) / 60)
