"""
Plugin for in-memory, ephemeral database storage.

This plugin provides a pure in-memory database that is completely ephemeral.
All data is lost when the process restarts or when close() is called.
"""

from elizaos_plugin_inmemorydb.storage import MemoryStorage
from elizaos_plugin_inmemorydb.hnsw import EphemeralHNSW
from elizaos_plugin_inmemorydb.adapter import InMemoryDatabaseAdapter
from elizaos_plugin_inmemorydb.plugin import (
    plugin,
    create_database_adapter,
)
from elizaos_plugin_inmemorydb.types import (
    IStorage,
    IVectorStorage,
    VectorSearchResult,
    COLLECTIONS,
)

__all__ = [
    # Main plugin
    "plugin",
    "create_database_adapter",
    # Storage
    "MemoryStorage",
    "EphemeralHNSW",
    "InMemoryDatabaseAdapter",
    # Types
    "IStorage",
    "IVectorStorage",
    "VectorSearchResult",
    "COLLECTIONS",
]

