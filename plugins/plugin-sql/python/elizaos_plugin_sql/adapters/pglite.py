from __future__ import annotations

from pathlib import Path

from elizaos.types import UUID
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from elizaos_plugin_sql.adapters.base import BaseSQLAdapter


class PGLiteAdapter(BaseSQLAdapter):
    """SQLite-based adapter using PGLite compatibility layer."""

    def __init__(
        self,
        data_dir: str,
        agent_id: UUID,
        database_name: str = "elizaos.db",
    ) -> None:
        if not data_dir or not data_dir.strip():
            raise ValueError("Data directory path cannot be empty")
        super().__init__(agent_id)
        self._data_dir = Path(data_dir)
        self._database_name = database_name
        self._db_path = self._data_dir / database_name

    async def _create_engine(self) -> AsyncEngine:
        """Create the database engine, ensuring the data directory exists."""
        self._data_dir.mkdir(parents=True, exist_ok=True)

        connection_string = f"sqlite+aiosqlite:///{self._db_path}"

        return create_async_engine(
            connection_string,
            echo=False,
            # SQLite-specific settings
            connect_args={"check_same_thread": False},
        )

    async def search_memories(self, params: dict[str, object]) -> list[dict[str, object]]:
        """
        Search memories.

        SQLite doesn't support vector similarity search natively.
        This returns an empty list - for vector search, use PostgreSQL.
        """
        _ = params  # Parameters not used for SQLite
        return []
