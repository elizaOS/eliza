"""
elizaOS SQL Plugin - PostgreSQL and PGLite database adapters for elizaOS.

Exports are loaded lazily so consumers can import specific submodules
without triggering all optional runtime dependencies.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

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

_LAZY_EXPORTS: dict[str, tuple[str, str]] = {
    "BaseSQLAdapter": ("elizaos_plugin_sql.adapters.base", "BaseSQLAdapter"),
    "PostgresAdapter": ("elizaos_plugin_sql.adapters.postgres", "PostgresAdapter"),
    "PGLiteAdapter": ("elizaos_plugin_sql.adapters.pglite", "PGLiteAdapter"),
    "MigrationService": ("elizaos_plugin_sql.migration_service", "MigrationService"),
    "derive_schema_name": ("elizaos_plugin_sql.migration_service", "derive_schema_name"),
    "sql_plugin": ("elizaos_plugin_sql.plugin", "sql_plugin"),
    "AgentTable": ("elizaos_plugin_sql.schema", "AgentTable"),
    "CacheTable": ("elizaos_plugin_sql.schema", "CacheTable"),
    "ComponentTable": ("elizaos_plugin_sql.schema", "ComponentTable"),
    "EmbeddingTable": ("elizaos_plugin_sql.schema", "EmbeddingTable"),
    "EntityTable": ("elizaos_plugin_sql.schema", "EntityTable"),
    "LogTable": ("elizaos_plugin_sql.schema", "LogTable"),
    "MemoryTable": ("elizaos_plugin_sql.schema", "MemoryTable"),
    "ParticipantTable": ("elizaos_plugin_sql.schema", "ParticipantTable"),
    "RelationshipTable": ("elizaos_plugin_sql.schema", "RelationshipTable"),
    "RoomTable": ("elizaos_plugin_sql.schema", "RoomTable"),
    "TaskTable": ("elizaos_plugin_sql.schema", "TaskTable"),
    "WorldTable": ("elizaos_plugin_sql.schema", "WorldTable"),
}


def __getattr__(name: str) -> Any:
    if name not in _LAZY_EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    module_name, attribute_name = _LAZY_EXPORTS[name]
    module = import_module(module_name)
    value = getattr(module, attribute_name)
    globals()[name] = value
    return value
