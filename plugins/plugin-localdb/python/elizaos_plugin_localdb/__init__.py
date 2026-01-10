"""
elizaOS Plugin LocalDB - Simple JSON-based local database storage.

This package provides a lightweight, file-based database adapter for elizaOS
using plain JSON files for storage. No external database dependencies required.

Features:
- Zero configuration - no database setup required
- JSON file-based storage
- Simple HNSW implementation for vector search
"""

from elizaos_plugin_localdb.storage import JSONStorage
from elizaos_plugin_localdb.hnsw import SimpleHNSW

__version__ = "2.0.0"
__all__ = ["JSONStorage", "SimpleHNSW"]
