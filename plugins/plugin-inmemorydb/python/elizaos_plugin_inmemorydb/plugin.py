from __future__ import annotations

from typing import Any

from elizaos_plugin_inmemorydb.adapter import InMemoryDatabaseAdapter
from elizaos_plugin_inmemorydb.storage import MemoryStorage

_global_storage: MemoryStorage | None = None


def create_database_adapter(agent_id: str) -> InMemoryDatabaseAdapter:
    global _global_storage

    if _global_storage is None:
        _global_storage = MemoryStorage()

    return InMemoryDatabaseAdapter(_global_storage, agent_id)


async def init_plugin(config: dict[str, str], runtime: Any) -> None:
    has_adapter = (
        hasattr(runtime, "adapter")
        and runtime.adapter is not None
        or hasattr(runtime, "database_adapter")
        and runtime.database_adapter is not None
        or (hasattr(runtime, "has_database_adapter") and runtime.has_database_adapter())
    )

    if has_adapter:
        return

    adapter = create_database_adapter(runtime.agent_id)
    await adapter.init()
    runtime.register_database_adapter(adapter)


plugin = {
    "name": "@elizaos/plugin-inmemorydb",
    "description": "Pure in-memory, ephemeral database storage for elizaOS - no persistence",
    "init": init_plugin,
}


