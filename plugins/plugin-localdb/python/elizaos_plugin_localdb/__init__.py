"""elizaOS localdb plugin (Python)."""

from elizaos_plugin_localdb.hnsw import SimpleHNSW
from elizaos_plugin_localdb.plugin import localdb_plugin
from elizaos_plugin_localdb.storage import JSONStorage, JsonFileStorage

__version__ = "1.0.0"

__all__ = [
    "JsonFileStorage",
    "JSONStorage",
    "SimpleHNSW",
    "localdb_plugin",
]
