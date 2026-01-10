"""
elizaOS LocalDB Plugin - Simple JSON-based database for elizaOS.

This package provides a lightweight, file-based database adapter for elizaOS
using plain JSON files for storage. No external database dependencies required.
"""

from elizaos_plugin_localdb.adapter import LocalDatabaseAdapter
from elizaos_plugin_localdb.storage import JsonFileStorage
from elizaos_plugin_localdb.hnsw import SimpleHNSW
from elizaos_plugin_localdb.plugin import localdb_plugin

__version__ = "1.0.0"

__all__ = [
    "LocalDatabaseAdapter",
    "JsonFileStorage",
    "SimpleHNSW",
    "localdb_plugin",
]

