"""
Migration service for elizaOS plugin-sql (Python).

This module provides runtime migration capabilities similar to the TypeScript
RuntimeMigrator, supporting plugin-based schema migrations and automatic
schema detection.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import JSON, BigInteger, Column, Integer, String, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlalchemy.orm import DeclarativeBase


def derive_schema_name(plugin_name: str) -> str:
    """
    Derive a database schema name from a plugin name.

    This matches the TypeScript implementation:
    - @elizaos/plugin-sql uses 'public' schema (core tables)
    - Other plugins: remove npm scope, remove plugin- prefix, normalize

    Args:
        plugin_name: Plugin identifier (e.g., '@your-org/plugin-name')

    Returns:
        Database schema name (e.g., 'name' for '@your-org/plugin-name')
    """
    # Core plugin uses public schema
    if plugin_name == "@elizaos/plugin-sql":
        return "public"

    # Remove npm scope like @elizaos/ or @your-org/
    schema_name = re.sub(r"^@[^/]+/", "", plugin_name)

    # Remove plugin- prefix
    schema_name = re.sub(r"^plugin-", "", schema_name)

    # Convert to lowercase
    schema_name = schema_name.lower()

    # Normalize: replace non-alphanumeric with underscores, collapse multiples
    schema_name = _normalize_schema_name(schema_name)

    # Reserved schema names
    reserved = {"public", "pg_catalog", "information_schema", "migrations"}
    if not schema_name or schema_name in reserved:
        # Fallback to using the full plugin name with safe characters
        schema_name = f"plugin_{_normalize_schema_name(plugin_name.lower())}"

    # Ensure it starts with a letter (PostgreSQL requirement)
    if not schema_name or not schema_name[0].isalpha():
        schema_name = f"p_{schema_name}"

    # Truncate if too long (PostgreSQL identifier limit is 63 chars)
    if len(schema_name) > 63:
        schema_name = schema_name[:63]

    return schema_name


def _normalize_schema_name(input_str: str) -> str:
    """
    Normalize a string to be a valid PostgreSQL identifier.
    Avoids polynomial regex by using string manipulation instead.
    """
    chars: list[str] = []
    prev_was_underscore = False

    for char in input_str:
        if char.isalnum():
            chars.append(char)
            prev_was_underscore = False
        elif not prev_was_underscore:
            chars.append("_")
            prev_was_underscore = True
        # Skip consecutive non-alphanumeric characters

    result = "".join(chars)

    # Trim underscores from start and end
    return result.strip("_")


class MigrationBase(DeclarativeBase):
    pass


class MigrationTable(MigrationBase):
    __tablename__ = "_migrations"

    id = Column(Integer, primary_key=True)
    plugin_name = Column(String(255), nullable=False, index=True)
    hash = Column(String(64), nullable=False)
    created_at = Column(BigInteger, nullable=False)


class JournalTable(MigrationBase):
    __tablename__ = "_journal"

    plugin_name = Column(String(255), primary_key=True)
    version = Column(String(50), nullable=False)
    dialect = Column(String(50), nullable=False, default="postgresql")
    entries = Column(JSON, nullable=False, default=list)


class SnapshotTable(MigrationBase):
    __tablename__ = "_snapshots"

    id = Column(Integer, primary_key=True)
    plugin_name = Column(String(255), nullable=False, index=True)
    idx = Column(Integer, nullable=False)
    snapshot = Column(JSON, nullable=False)
    created_at = Column(BigInteger, nullable=False)

    __table_args__ = (sa.UniqueConstraint("plugin_name", "idx", name="uq_snapshots_plugin_idx"),)


class MigrationService:
    """
    Runtime migration service for Python.

    Provides functionality similar to TypeScript RuntimeMigrator:
    - Plugin-based schema migrations
    - Schema snapshot tracking
    - Migration history tracking
    - Automatic schema detection
    """

    def __init__(self, engine: AsyncEngine) -> None:
        """
        Initialize migration service.

        Args:
            engine: SQLAlchemy async engine
        """
        self.engine = engine

    async def initialize(self) -> None:
        async with self.engine.begin() as conn:
            # Check if we're using PostgreSQL (SQLite doesn't support schemas)
            dialect_name = self.engine.dialect.name

            if dialect_name == "postgresql":
                # Create migrations schema for PostgreSQL
                await conn.execute(text("CREATE SCHEMA IF NOT EXISTS migrations"))

            # Create migration tracking tables using run_sync for SQLAlchemy DDL
            def create_tables(sync_conn: sa.Connection) -> None:
                MigrationBase.metadata.create_all(
                    sync_conn,
                    tables=[
                        MigrationTable.__table__,
                        JournalTable.__table__,
                        SnapshotTable.__table__,
                    ],
                )

            await conn.run_sync(create_tables)

    async def get_last_migration(self, plugin_name: str) -> dict[str, Any] | None:
        """
        Get the last migration for a plugin.

        Args:
            plugin_name: Plugin identifier

        Returns:
            Migration record or None
        """
        async with AsyncSession(self.engine) as session:
            result = await session.execute(
                text("""
                    SELECT id, hash, created_at
                    FROM _migrations
                    WHERE plugin_name = :plugin_name
                    ORDER BY created_at DESC
                    LIMIT 1
                """),
                {"plugin_name": plugin_name},
            )
            row = result.first()
            if row:
                return {
                    "id": row[0],
                    "hash": row[1],
                    "created_at": row[2],
                }
            return None

    async def record_migration(
        self, plugin_name: str, hash_value: str, created_at: int | None = None
    ) -> None:
        """
        Record a migration in the tracking table.

        Args:
            plugin_name: Plugin identifier
            hash_value: Migration hash
            created_at: Timestamp (defaults to now)
        """
        if created_at is None:
            created_at = int(datetime.now().timestamp() * 1000)

        async with AsyncSession(self.engine) as session:
            await session.execute(
                text("""
                    INSERT INTO _migrations (plugin_name, hash, created_at)
                    VALUES (:plugin_name, :hash, :created_at)
                """),
                {
                    "plugin_name": plugin_name,
                    "hash": hash_value,
                    "created_at": created_at,
                },
            )
            await session.commit()

    async def save_snapshot(self, plugin_name: str, idx: int, snapshot: dict[str, Any]) -> None:
        """
        Save a schema snapshot.

        Args:
            plugin_name: Plugin identifier
            idx: Snapshot index
            snapshot: Schema snapshot data
        """
        created_at = int(datetime.now().timestamp())
        dialect_name = self.engine.dialect.name
        snapshot_json = json.dumps(snapshot)
        async with AsyncSession(self.engine) as session:
            if dialect_name == "postgresql":
                # Use CAST instead of :: to avoid conflicts with asyncpg binding syntax
                await session.execute(
                    text("""
                        INSERT INTO _snapshots (plugin_name, idx, snapshot, created_at)
                        VALUES (:plugin_name, :idx, CAST(:snapshot AS jsonb), :created_at)
                        ON CONFLICT (plugin_name, idx)
                        DO UPDATE SET
                            snapshot = CAST(EXCLUDED.snapshot AS jsonb),
                            created_at = EXCLUDED.created_at
                    """),
                    {
                        "plugin_name": plugin_name,
                        "idx": idx,
                        "snapshot": snapshot_json,
                        "created_at": created_at,
                    },
                )
            else:
                # SQLite: Use INSERT OR REPLACE
                await session.execute(
                    text("""
                        INSERT OR REPLACE INTO _snapshots (plugin_name, idx, snapshot, created_at)
                        VALUES (:plugin_name, :idx, :snapshot, :created_at)
                    """),
                    {
                        "plugin_name": plugin_name,
                        "idx": idx,
                        "snapshot": snapshot_json,
                        "created_at": created_at,
                    },
                )
            await session.commit()

    async def get_latest_snapshot(self, plugin_name: str) -> dict[str, Any] | None:
        """
        Get the latest snapshot for a plugin.

        Args:
            plugin_name: Plugin identifier

        Returns:
            Snapshot data or None
        """
        async with AsyncSession(self.engine) as session:
            result = await session.execute(
                text("""
                    SELECT snapshot
                    FROM _snapshots
                    WHERE plugin_name = :plugin_name
                    ORDER BY idx DESC
                    LIMIT 1
                """),
                {"plugin_name": plugin_name},
            )
            row = result.first()
            if row:
                return json.loads(row[0]) if isinstance(row[0], str) else row[0]
            return None

    def hash_snapshot(self, snapshot: dict[str, Any]) -> str:
        """
        Generate a hash for a schema snapshot.

        Args:
            snapshot: Schema snapshot data

        Returns:
            SHA-256 hash as hex string
        """
        snapshot_str = json.dumps(snapshot, sort_keys=True)
        return hashlib.sha256(snapshot_str.encode()).hexdigest()

    async def get_status(self, plugin_name: str) -> dict[str, Any]:
        """
        Get migration status for a plugin.

        Args:
            plugin_name: Plugin identifier

        Returns:
            Status information
        """
        last_migration = await self.get_last_migration(plugin_name)
        latest_snapshot = await self.get_latest_snapshot(plugin_name)

        async with AsyncSession(self.engine) as session:
            # Count snapshots
            result = await session.execute(
                text("""
                    SELECT COUNT(*) FROM _snapshots
                    WHERE plugin_name = :plugin_name
                """),
                {"plugin_name": plugin_name},
            )
            snapshot_count = result.scalar() or 0

        return {
            "hasRun": last_migration is not None,
            "lastMigration": last_migration,
            "snapshots": snapshot_count,
            "latestSnapshot": latest_snapshot,
        }

    async def ensure_schema_exists(self, schema_name: str) -> None:
        """
        Ensure a database schema exists.

        Args:
            schema_name: Schema name to create (must be a valid identifier)

        Raises:
            ValueError: If schema name contains invalid characters
        """
        if schema_name == "public":
            return  # public schema always exists

        # Validate schema name to prevent SQL injection
        # Only allow alphanumeric and underscore
        if not all(c.isalnum() or c == "_" for c in schema_name):
            raise ValueError(f"Invalid schema name: {schema_name}")

        async with self.engine.begin() as conn:
            # Use quoted identifier for safety
            await conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{schema_name}"'))

    async def get_expected_schema_name(self, plugin_name: str) -> str:
        """
        Get the expected schema name for a plugin.

        Args:
            plugin_name: Plugin identifier

        Returns:
            Schema name for the plugin
        """
        return derive_schema_name(plugin_name)
