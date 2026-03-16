"""
Alembic environment configuration for elizaOS plugin-sql.

This module configures Alembic to work with our SQLAlchemy models
and supports plugin-based schema migrations similar to the TypeScript RuntimeMigrator.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

# Import your models' Base and all models
# Import all models to ensure they're registered with Base
from elizaos_plugin_sql.schema.tables import (  # noqa: F401
    AgentTable,
    Base,
    CacheTable,
    ComponentTable,
    EmbeddingTable,
    EntityTable,
    LogTable,
    MemoryTable,
    ParticipantTable,
    RelationshipTable,
    RoomTable,
    TaskTable,
    WorldTable,
)

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.
    """
    configuration = config.get_section(config.config_ini_section)
    if configuration is None:
        raise ValueError("No configuration section found")

    # Override sqlalchemy.url from environment variable if available
    import os

    postgres_url = os.getenv("POSTGRES_URL") or os.getenv("DATABASE_URL")
    if postgres_url:
        # Convert postgresql:// to postgresql+asyncpg:// if needed
        if postgres_url.startswith("postgresql://"):
            postgres_url = postgres_url.replace("postgresql://", "postgresql+asyncpg://", 1)
        configuration["sqlalchemy.url"] = postgres_url

    connectable = async_engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
