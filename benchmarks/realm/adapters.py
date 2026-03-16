"""
In-memory database adapter for REALM benchmark.

This provides a minimal implementation of IDatabaseAdapter
that stores data in memory, suitable for benchmarking without
requiring a real database.
"""

from __future__ import annotations

import uuid
from typing import Any

from elizaos.types.database import AgentRunSummaryResult, IDatabaseAdapter, Log
from elizaos.types.primitives import UUID, as_uuid


class InMemoryDatabaseAdapter(IDatabaseAdapter):
    """
    Minimal in-memory database adapter for benchmark use.
    
    Only implements the methods actually used by the message handling loop.
    """

    def __init__(self) -> None:
        self._memories: dict[str, Any] = {}
        self._agents: dict[str, Any] = {}
        self._rooms: dict[str, Any] = {}
        self._entities: dict[str, Any] = {}
        self._worlds: dict[str, Any] = {}
        self._relationships: dict[str, Any] = {}
        self._tasks: dict[str, Any] = {}
        self._cache: dict[str, Any] = {}
        self._logs: list[Log] = []
        self._components: dict[str, Any] = {}
        self._initialized = False

    @property
    def db(self) -> Any:
        return self._memories

    async def initialize(
        self, config: dict[str, str | int | bool | None] | None = None
    ) -> None:
        _ = config
        self._initialized = True

    async def init(self) -> None:
        self._initialized = True

    async def is_ready(self) -> bool:
        return self._initialized

    async def close(self) -> None:
        self._memories.clear()
        self._agents.clear()
        self._initialized = False

    async def get_connection(self) -> Any:
        return self

    # Agent methods
    async def get_agent(self, agent_id: UUID) -> Any | None:
        return self._agents.get(str(agent_id))

    async def get_agents(self) -> list[Any]:
        return list(self._agents.values())

    async def create_agent(self, agent: Any) -> bool:
        agent_id = getattr(agent, "id", None) or str(uuid.uuid4())
        self._agents[str(agent_id)] = agent
        return True

    async def update_agent(self, agent_id: UUID, agent: Any) -> bool:
        self._agents[str(agent_id)] = agent
        return True

    async def delete_agent(self, agent_id: UUID) -> bool:
        if str(agent_id) in self._agents:
            del self._agents[str(agent_id)]
            return True
        return False

    async def ensure_embedding_dimension(self, dimension: int) -> None:
        _ = dimension

    # Entity methods
    async def get_entities_by_ids(self, entity_ids: list[UUID]) -> list[Any] | None:
        return [self._entities.get(str(eid)) for eid in entity_ids if str(eid) in self._entities]

    async def get_entities_for_room(
        self, room_id: UUID, include_components: bool = False
    ) -> list[Any]:
        _ = include_components
        return list(self._entities.values())

    async def create_entities(self, entities: list[Any]) -> bool:
        for entity in entities:
            entity_id = getattr(entity, "id", None) or str(uuid.uuid4())
            self._entities[str(entity_id)] = entity
        return True

    async def update_entity(self, entity: Any) -> None:
        entity_id = getattr(entity, "id", None)
        if entity_id:
            self._entities[str(entity_id)] = entity

    # Component methods
    async def get_component(
        self,
        entity_id: UUID,
        component_type: str,
        world_id: UUID | None = None,
        source_entity_id: UUID | None = None,
    ) -> Any | None:
        _ = world_id, source_entity_id
        key = f"{entity_id}:{component_type}"
        return self._components.get(key)

    async def get_components(
        self,
        entity_id: UUID,
        world_id: UUID | None = None,
        source_entity_id: UUID | None = None,
    ) -> list[Any]:
        _ = world_id, source_entity_id
        return [v for k, v in self._components.items() if k.startswith(f"{entity_id}:")]

    async def create_component(self, component: Any) -> bool:
        comp_id = getattr(component, "id", None) or str(uuid.uuid4())
        self._components[str(comp_id)] = component
        return True

    async def update_component(self, component: Any) -> None:
        comp_id = getattr(component, "id", None)
        if comp_id:
            self._components[str(comp_id)] = component

    async def delete_component(self, component_id: UUID) -> None:
        if str(component_id) in self._components:
            del self._components[str(component_id)]

    # Memory methods - these are the key ones for message handling
    async def get_memories(self, params: dict[str, Any]) -> list[Any]:
        room_id = params.get("room_id") or params.get("room_id")
        table_name = params.get("tableName") or params.get("table_name")
        
        results = []
        for key, mem in self._memories.items():
            if table_name and not key.startswith(f"{table_name}:"):
                continue
            if room_id:
                mem_room = getattr(mem, "room_id", None)
                if mem_room and str(mem_room) != str(room_id):
                    continue
            results.append(mem)
        
        return results

    async def get_memory_by_id(self, id: UUID) -> Any | None:
        for mem in self._memories.values():
            mem_id = getattr(mem, "id", None)
            if mem_id and str(mem_id) == str(id):
                return mem
        return None

    async def get_memories_by_ids(
        self, ids: list[UUID], table_name: str | None = None
    ) -> list[Any]:
        _ = table_name
        results = []
        id_strs = {str(i) for i in ids}
        for mem in self._memories.values():
            mem_id = getattr(mem, "id", None)
            if mem_id and str(mem_id) in id_strs:
                results.append(mem)
        return results

    async def get_memories_by_room_ids(self, params: dict[str, Any]) -> list[Any]:
        room_ids = params.get("roomIds") or params.get("room_ids", [])
        room_id_strs = {str(r) for r in room_ids}
        
        results = []
        for mem in self._memories.values():
            mem_room = getattr(mem, "room_id", None)
            if mem_room and str(mem_room) in room_id_strs:
                results.append(mem)
        return results

    async def get_cached_embeddings(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        _ = params
        return []

    async def log(self, params: dict[str, Any]) -> None:
        _ = params

    async def get_logs(self, params: dict[str, Any]) -> list[Log]:
        _ = params
        return self._logs

    async def delete_log(self, log_id: UUID) -> None:
        self._logs = [l for l in self._logs if str(getattr(l, "id", "")) != str(log_id)]

    async def search_memories(self, params: dict[str, Any]) -> list[Any]:
        _ = params
        return []

    async def create_memory(self, memory: Any, table_name: str, unique: bool = False) -> UUID:
        _ = unique
        mem_id = getattr(memory, "id", None)
        if not mem_id:
            mem_id = as_uuid(str(uuid.uuid4()))
            if hasattr(memory, "id"):
                memory.id = mem_id
        
        key = f"{table_name}:{mem_id}"
        self._memories[key] = memory
        return mem_id

    async def update_memory(self, memory: Any) -> bool:
        mem_id = memory.get("id") if isinstance(memory, dict) else getattr(memory, "id", None)
        if mem_id:
            for key in list(self._memories.keys()):
                if str(mem_id) in key:
                    self._memories[key] = memory
                    return True
        return False

    async def delete_memory(self, memory_id: UUID) -> None:
        for key in list(self._memories.keys()):
            if str(memory_id) in key:
                del self._memories[key]
                break

    async def delete_many_memories(self, memory_ids: list[UUID]) -> None:
        id_strs = {str(i) for i in memory_ids}
        for key in list(self._memories.keys()):
            for id_str in id_strs:
                if id_str in key:
                    del self._memories[key]
                    break

    async def delete_all_memories(self, room_id: UUID, table_name: str) -> None:
        for key, mem in list(self._memories.items()):
            if not key.startswith(f"{table_name}:"):
                continue
            mem_room = getattr(mem, "room_id", None)
            if mem_room and str(mem_room) == str(room_id):
                del self._memories[key]

    async def count_memories(
        self, room_id: UUID, unique: bool = False, table_name: str | None = None
    ) -> int:
        _ = unique
        count = 0
        for key, mem in self._memories.items():
            if table_name and not key.startswith(f"{table_name}:"):
                continue
            mem_room = getattr(mem, "room_id", None)
            if mem_room and str(mem_room) == str(room_id):
                count += 1
        return count

    # World methods
    async def create_world(self, world: Any) -> UUID:
        world_id = getattr(world, "id", None) or as_uuid(str(uuid.uuid4()))
        self._worlds[str(world_id)] = world
        return world_id

    async def get_world(self, id: UUID) -> Any | None:
        return self._worlds.get(str(id))

    async def remove_world(self, id: UUID) -> None:
        if str(id) in self._worlds:
            del self._worlds[str(id)]

    async def get_all_worlds(self) -> list[Any]:
        return list(self._worlds.values())

    async def update_world(self, world: Any) -> None:
        world_id = getattr(world, "id", None)
        if world_id:
            self._worlds[str(world_id)] = world

    # Room methods
    async def get_rooms_by_ids(self, room_ids: list[UUID]) -> list[Any] | None:
        return [self._rooms.get(str(rid)) for rid in room_ids if str(rid) in self._rooms]

    async def create_rooms(self, rooms: list[Any]) -> list[UUID]:
        ids = []
        for room in rooms:
            room_id = getattr(room, "id", None) or as_uuid(str(uuid.uuid4()))
            self._rooms[str(room_id)] = room
            ids.append(room_id)
        return ids

    async def delete_room(self, room_id: UUID) -> None:
        if str(room_id) in self._rooms:
            del self._rooms[str(room_id)]

    async def delete_rooms_by_world_id(self, world_id: UUID) -> None:
        for rid, room in list(self._rooms.items()):
            room_world = getattr(room, "world_id", None)
            if room_world and str(room_world) == str(world_id):
                del self._rooms[rid]

    async def update_room(self, room: Any) -> None:
        room_id = getattr(room, "id", None)
        if room_id:
            self._rooms[str(room_id)] = room

    # Participant methods
    async def get_rooms_for_participant(self, entity_id: UUID) -> list[UUID]:
        _ = entity_id
        return list(as_uuid(k) for k in self._rooms.keys())

    async def get_rooms_for_participants(self, user_ids: list[UUID]) -> list[UUID]:
        _ = user_ids
        return list(as_uuid(k) for k in self._rooms.keys())

    async def get_rooms_by_world(self, world_id: UUID) -> list[Any]:
        return [
            r for r in self._rooms.values()
            if getattr(r, "world_id", None) and str(getattr(r, "world_id", "")) == str(world_id)
        ]

    async def remove_participant(self, entity_id: UUID, room_id: UUID) -> bool:
        _ = entity_id, room_id
        return True

    async def get_participants_for_entity(self, entity_id: UUID) -> list[Any]:
        _ = entity_id
        return []

    async def get_participants_for_room(self, room_id: UUID) -> list[UUID]:
        _ = room_id
        return []

    async def is_room_participant(self, room_id: UUID, entity_id: UUID) -> bool:
        _ = room_id, entity_id
        return True

    async def add_participants_room(self, entity_ids: list[UUID], room_id: UUID) -> bool:
        _ = entity_ids, room_id
        return True

    async def get_participant_user_state(self, room_id: UUID, entity_id: UUID) -> str | None:
        _ = room_id, entity_id
        return None

    async def set_participant_user_state(
        self, room_id: UUID, entity_id: UUID, state: str | None
    ) -> None:
        _ = room_id, entity_id, state

    # Relationship methods
    async def create_relationship(self, params: dict[str, Any]) -> bool:
        rel_id = params.get("id") or str(uuid.uuid4())
        self._relationships[rel_id] = params
        return True

    async def update_relationship(self, relationship: Any) -> None:
        rel_id = getattr(relationship, "id", None) or relationship.get("id")
        if rel_id:
            self._relationships[str(rel_id)] = relationship

    async def get_relationship(self, params: dict[str, Any]) -> Any | None:
        rel_id = params.get("id")
        if rel_id:
            return self._relationships.get(str(rel_id))
        return None

    async def get_relationships(self, params: dict[str, Any]) -> list[Any]:
        _ = params
        return list(self._relationships.values())

    # Cache methods
    async def get_cache(self, key: str) -> Any | None:
        return self._cache.get(key)

    async def set_cache(self, key: str, value: Any) -> bool:
        self._cache[key] = value
        return True

    async def delete_cache(self, key: str) -> bool:
        if key in self._cache:
            del self._cache[key]
            return True
        return False

    # Task methods
    async def create_task(self, task: Any) -> UUID:
        task_id = getattr(task, "id", None) or as_uuid(str(uuid.uuid4()))
        self._tasks[str(task_id)] = task
        return task_id

    async def get_tasks(self, params: dict[str, Any]) -> list[Any]:
        _ = params
        return list(self._tasks.values())

    async def get_task(self, id: UUID) -> Any | None:
        return self._tasks.get(str(id))

    async def get_tasks_by_name(self, name: str) -> list[Any]:
        return [t for t in self._tasks.values() if getattr(t, "name", None) == name]

    async def update_task(self, id: UUID, task: dict[str, Any]) -> None:
        if str(id) in self._tasks:
            self._tasks[str(id)] = task

    async def delete_task(self, id: UUID) -> None:
        if str(id) in self._tasks:
            del self._tasks[str(id)]

    async def get_memories_by_world_id(self, params: dict[str, Any]) -> list[Any]:
        _ = params
        return []
