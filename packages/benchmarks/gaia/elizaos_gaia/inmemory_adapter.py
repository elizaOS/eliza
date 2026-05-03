"""
Minimal in-memory database adapter for canonical Eliza runtime benchmarking.

We intentionally keep this adapter small and dependency-free:
- It persists *message* memories in-process so providers like RECENT_MESSAGES work.
- It implements a handful of other adapter methods used indirectly by some
  bootstrap providers (entities/world) but returns safe defaults.

This is for benchmark execution only; it is not intended as a production DB.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from elizaos.types.memory import Memory, MessageMetadata, MemoryType
from elizaos.types.primitives import UUID, as_uuid


@dataclass
class _StoredMemory:
    memory: Memory
    table_name: str


class InMemoryBenchmarkAdapter:
    """Ephemeral in-memory adapter implementing the minimal DB surface needed."""

    def __init__(self) -> None:
        self._ready = False
        self._memories: dict[str, _StoredMemory] = {}

    # --- Lifecycle / connection -------------------------------------------------

    @property
    def db(self) -> "InMemoryBenchmarkAdapter":
        return self

    async def initialize(self) -> None:
        await self.init()

    async def init(self) -> None:
        self._ready = True

    async def is_ready(self) -> bool:
        return self._ready

    async def close(self) -> None:
        self._memories.clear()
        self._ready = False

    async def get_connection(self) -> "InMemoryBenchmarkAdapter":
        return self

    async def ensure_embedding_dimension(self, _dimension: int) -> None:
        return None

    # --- Memory storage ---------------------------------------------------------

    async def create_memory(self, memory: Memory, table_name: str, unique: bool = False) -> UUID:
        # Ensure ID
        if memory.id is None:
            memory.id = as_uuid(str(uuid.uuid4()))

        # Ensure created_at
        if memory.created_at is None:
            memory.created_at = int(time.time() * 1000)

        # Ensure message metadata exists so consumers can filter by type
        if memory.metadata is None:
            memory.metadata = MessageMetadata(type=MemoryType.MESSAGE)

        memory.unique = bool(unique) if unique is not None else False

        self._memories[str(memory.id)] = _StoredMemory(memory=memory, table_name=table_name)
        return memory.id

    async def update_memory(self, memory: Memory) -> bool:
        if memory.id is None:
            return False
        key = str(memory.id)
        if key not in self._memories:
            return False
        stored = self._memories[key]
        stored.memory = memory
        self._memories[key] = stored
        return True

    async def get_memory_by_id(self, id_: UUID) -> Memory | None:
        stored = self._memories.get(str(id_))
        return stored.memory if stored else None

    async def get_memories(self, params: dict[str, object]) -> list[Memory]:
        """
        Params shape follows AgentRuntime.get_memories() packing:
        - room_id: str
        - limit: int
        - orderBy: str (created_at / created_at)
        - orderDirection: "asc"/"desc"
        - tableName: str
        """
        room_id = params.get("room_id")
        limit = params.get("limit")
        order_dir = params.get("orderDirection")
        table_name = params.get("tableName")

        memories: list[_StoredMemory] = list(self._memories.values())

        if isinstance(table_name, str) and table_name:
            # In Eliza, "messages" is the common tableName
            memories = [m for m in memories if m.table_name == table_name]

        if isinstance(room_id, str) and room_id:
            memories = [m for m in memories if str(m.memory.room_id) == room_id]

        # Default: newest-first (matches recent_messages provider expectations)
        reverse = True
        if isinstance(order_dir, str) and order_dir.lower() == "asc":
            reverse = False

        memories.sort(key=lambda m: int(m.memory.created_at or 0), reverse=reverse)

        if isinstance(limit, int) and limit > 0:
            memories = memories[:limit]

        return [m.memory for m in memories]

    async def get_memories_by_ids(self, ids: list[UUID], _table_name: str | None = None) -> list[Memory]:
        result: list[Memory] = []
        for id_ in ids:
            mem = await self.get_memory_by_id(id_)
            if mem is not None:
                result.append(mem)
        return result

    async def delete_memory(self, memory_id: UUID) -> None:
        self._memories.pop(str(memory_id), None)

    async def delete_many_memories(self, memory_ids: list[UUID]) -> None:
        for memory_id in memory_ids:
            self._memories.pop(str(memory_id), None)

    async def delete_all_memories(self, room_id: UUID, table_name: str) -> None:
        to_delete: list[str] = []
        for key, stored in self._memories.items():
            if str(stored.memory.room_id) == str(room_id) and stored.table_name == table_name:
                to_delete.append(key)
        for key in to_delete:
            self._memories.pop(key, None)

    async def count_memories(self, room_id: UUID, unique: bool = False, table_name: str | None = None) -> int:
        _ = unique
        filtered = [
            s
            for s in self._memories.values()
            if str(s.memory.room_id) == str(room_id)
            and (table_name is None or s.table_name == table_name)
        ]
        return len(filtered)

    # --- Safe defaults for non-memory APIs -------------------------------------
    # These are used by some bootstrap providers but are not needed for GAIA.

    async def get_entities_by_ids(self, _entity_ids: list[UUID]) -> list[object] | None:
        return None

    async def get_entities_for_room(self, _room_id: UUID, _include_components: bool = False) -> list[object]:
        return []

    async def create_entities(self, _entities: list[object]) -> bool:
        return True

    async def update_entity(self, _entity: object) -> None:
        return None

    async def get_rooms_by_ids(self, _room_ids: list[UUID]) -> list[object] | None:
        return None

    async def create_rooms(self, _rooms: list[object]) -> list[UUID]:
        return []

    async def get_rooms_by_world(self, _world_id: UUID) -> list[object]:
        return []

    async def create_world(self, _world: object) -> UUID:
        return as_uuid(str(uuid.uuid4()))

    async def get_world(self, _id: UUID) -> object | None:
        return None

    async def add_participants_room(self, _entity_ids: list[UUID], _room_id: UUID) -> bool:
        return True

    async def is_room_participant(self, _room_id: UUID, _entity_id: UUID) -> bool:
        return False

