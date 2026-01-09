"""Pytest configuration and fixtures for plugin-sql tests."""

from __future__ import annotations

import os
import uuid
from typing import TYPE_CHECKING, AsyncGenerator

import pytest
import pytest_asyncio
from elizaos.types import as_uuid

if TYPE_CHECKING:
    from elizaos_plugin_sql.adapters.postgres import PostgresAdapter
    from elizaos_plugin_sql.migration_service import MigrationService


@pytest.fixture
def agent_id() -> str:
    """Generate a test agent ID."""
    return as_uuid(str(uuid.uuid4()))


def get_database_url() -> str:
    """Get database URL from environment or start testcontainer."""
    # Check for CI environment variable first
    env_url = os.environ.get("DATABASE_URL")
    if env_url:
        return env_url
    return ""


@pytest_asyncio.fixture
async def postgres_connection_string() -> AsyncGenerator[str, None]:
    """Get PostgreSQL connection string - from env or testcontainer."""
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
) -> AsyncGenerator["PostgresAdapter", None]:
    """Create a PostgreSQL adapter connected to database."""
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
    postgres_adapter: "PostgresAdapter",
) -> AsyncGenerator["MigrationService", None]:
    """Create a migration service connected to PostgreSQL."""
    from elizaos_plugin_sql.migration_service import MigrationService

    service = MigrationService(postgres_adapter.db)
    await service.initialize()
    yield service

