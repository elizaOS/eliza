"""
PostgreSQL database adapter.

This module provides a PostgreSQL adapter using asyncpg.
"""

from __future__ import annotations

from elizaos.types import UUID
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from elizaos_plugin_sql.adapters.base import BaseSQLAdapter


class PostgresAdapter(BaseSQLAdapter):
    """
    PostgreSQL database adapter.

    Uses asyncpg for async PostgreSQL connections with optional
    pgvector support for vector similarity search.
    """

    def __init__(
        self,
        connection_string: str,
        agent_id: UUID,
        pool_size: int = 5,
        max_overflow: int = 10,
    ) -> None:
        """
        Initialize the PostgreSQL adapter.

        Args:
            connection_string: PostgreSQL connection string
                (e.g., postgresql+asyncpg://user:pass@localhost/db)
            agent_id: Agent UUID
            pool_size: Connection pool size
            max_overflow: Maximum overflow connections
        """
        super().__init__(agent_id)
        self._connection_string = connection_string
        self._pool_size = pool_size
        self._max_overflow = max_overflow

    async def _create_engine(self) -> AsyncEngine:
        """Create the SQLAlchemy async engine for PostgreSQL."""
        return create_async_engine(
            self._connection_string,
            pool_size=self._pool_size,
            max_overflow=self._max_overflow,
            echo=False,
        )

    async def init(self) -> None:
        """Initialize database tables and extensions."""
        if not self._engine:
            raise RuntimeError("Database engine not created")

        # Enable pgvector extension if available
        from sqlalchemy import text

        async with self._engine.begin() as conn:
            try:
                await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            except Exception:
                # pgvector not available - will use ARRAY for embeddings
                pass

        # Create tables
        await super().init()

    async def search_memories(self, params: dict[str, object]) -> list[dict[str, object]]:
        """
        Search memories using vector similarity.

        If pgvector is available, uses cosine similarity search.
        Otherwise, falls back to basic filtering.
        """
        # For production, implement pgvector-based similarity search
        # This is a placeholder that returns empty results
        return []
