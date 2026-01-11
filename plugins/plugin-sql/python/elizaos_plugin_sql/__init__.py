"""
elizaOS SQL Plugin - PostgreSQL and PGLite database adapters for elizaOS.

This package provides database adapters for elizaOS agents using
PostgreSQL (production) and PGLite (development).
"""

from elizaos_plugin_sql.adapters.base import BaseSQLAdapter
from elizaos_plugin_sql.adapters.pglite import PGLiteAdapter
from elizaos_plugin_sql.adapters.postgres import PostgresAdapter
from elizaos_plugin_sql.migration_service import MigrationService, derive_schema_name
from elizaos_plugin_sql.plugin import sql_plugin
from elizaos_plugin_sql.schema import (
    AgentTable,
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

__version__ = "1.0.0"

__all__ = [
    # Adapters
    "PostgresAdapter",
    "PGLiteAdapter",
    "BaseSQLAdapter",
    # Migration
    "MigrationService",
    "derive_schema_name",
    # Schema tables
    "AgentTable",
    "CacheTable",
    "ComponentTable",
    "EmbeddingTable",
    "EntityTable",
    "LogTable",
    "MemoryTable",
    "ParticipantTable",
    "RelationshipTable",
    "RoomTable",
    "TaskTable",
    "WorldTable",
    # Plugin
    "sql_plugin",
]
