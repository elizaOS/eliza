"""
elizaOS LocalDB Plugin definition.
"""

import os
from typing import Any

from elizaos.types.plugin import Plugin

from .adapter import LocalDatabaseAdapter
from .storage import JsonFileStorage


async def init_localdb(runtime: Any) -> None:
    """
    Initialize the local database plugin.

    Args:
        runtime: The agent runtime instance
    """
    # Check if adapter already exists
    if hasattr(runtime, "database_adapter") and runtime.database_adapter is not None:
        return

    # Get data directory from settings or environment
    data_dir = (
        runtime.get_setting("LOCALDB_DATA_DIR")
        or os.environ.get("LOCALDB_DATA_DIR")
        or "./data"
    )

    # Create storage and adapter
    storage = JsonFileStorage(data_dir)
    adapter = LocalDatabaseAdapter(storage, runtime.agent_id)

    # Initialize
    await adapter.init()

    # Register adapter
    runtime.register_database_adapter(adapter)


# Plugin definition
localdb_plugin: Plugin = {
    "name": "@elizaos/plugin-localdb",
    "description": "Simple JSON-based local database storage for elizaOS",
    "init": init_localdb,
}
