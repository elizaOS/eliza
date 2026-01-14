import os
from typing import Any

from elizaos.types.plugin import Plugin

from .adapter import LocalDatabaseAdapter
from .storage import JsonFileStorage


async def init_localdb(runtime: Any) -> None:
    if hasattr(runtime, "database_adapter") and runtime.database_adapter is not None:
        return

    data_dir = (
        runtime.get_setting("LOCALDB_DATA_DIR")
        or os.environ.get("LOCALDB_DATA_DIR")
        or "./data"
    )

    storage = JsonFileStorage(data_dir)
    adapter = LocalDatabaseAdapter(storage, runtime.agent_id)
    await adapter.init()
    runtime.register_database_adapter(adapter)


localdb_plugin: Plugin = {
    "name": "@elizaos/plugin-localdb",
    "description": "Simple JSON-based local database storage for elizaOS",
    "init": init_localdb,
}
