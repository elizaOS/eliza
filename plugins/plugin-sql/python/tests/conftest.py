"""Pytest configuration and fixtures for plugin-sql tests."""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio

if TYPE_CHECKING:
    from elizaos_plugin_sql.adapters.postgres import PostgresAdapter
    from elizaos_plugin_sql.migration_service import MigrationService

# UUID validation pattern
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def as_uuid(id_str: str | uuid.UUID) -> str:
    """Convert string or UUID to validated UUID string."""
    if isinstance(id_str, uuid.UUID):
        return str(id_str)
    if isinstance(id_str, str):
        if not _UUID_PATTERN.match(id_str):
            raise ValueError(f"Invalid UUID format: {id_str}")
        return id_str
    raise TypeError(f"Expected str or UUID, got {type(id_str).__name__}")


@pytest.fixture
def agent_id() -> str:
    return as_uuid(str(uuid.uuid4()))


def get_database_url() -> str:
    # Check for CI environment variable first
    env_url = os.environ.get("DATABASE_URL")
    if env_url:
        return env_url
    return ""


@pytest_asyncio.fixture
async def postgres_connection_string() -> AsyncGenerator[str, None]:
    env_url = get_database_url()
    if env_url:
        # Use environment-provided database (CI)
        yield env_url
    else:
        # Use testcontainers for local development
        from testcontainers.postgres import PostgresContainer

        with PostgresContainer("postgres:16-alpine") as postgres:
            # Get connection URL and convert to asyncpg format
            url = postgres.get_connection_url()
            # Convert from psycopg2 to asyncpg format
            async_url = url.replace("psycopg2", "asyncpg")
            yield async_url


@pytest_asyncio.fixture
async def postgres_adapter(
    postgres_connection_string: str, agent_id: str
) -> AsyncGenerator[PostgresAdapter, None]:
    from elizaos_plugin_sql.adapters.postgres import PostgresAdapter

    adapter = PostgresAdapter(
        connection_string=postgres_connection_string,
        agent_id=agent_id,
    )
    await adapter.initialize()
    yield adapter
    await adapter.close()


@pytest_asyncio.fixture
async def migration_service(
    postgres_adapter: PostgresAdapter,
) -> AsyncGenerator[MigrationService, None]:
    from elizaos_plugin_sql.migration_service import MigrationService

    service = MigrationService(postgres_adapter.db)
    await service.initialize()
    yield service
