"""
In-memory database adapter for elizaOS.

A simple, ephemeral in-memory implementation for testing and development.
All data is lost when the process ends or when close() is called.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from elizaos_plugin_inmemorydb.hnsw import EphemeralHNSW
from elizaos_plugin_inmemorydb.types import COLLECTIONS, IStorage


class InMemoryDatabaseAdapter:
    """
    In-memory database adapter.

    Completely ephemeral - all data is lost on restart.
    Perfect for testing, development, and stateless deployments.
    """

    def __init__(self, storage: IStorage, agent_id: str) -> None:
        self._storage = storage
        self._agent_id = agent_id
        self._vector_index = EphemeralHNSW()
        self._embedding_dimension = 384
        self._ready = False

    @property
    def db(self) -> IStorage:
        """Get the underlying storage."""
        return self._storage

    async def initialize(self) -> None:
        """Initialize the adapter."""
        await self.init()

    async def init(self) -> None:
        """Initialize the adapter."""
        await self._storage.init()
        await self._vector_index.init(self._embedding_dimension)
        self._ready = True

    async def is_ready(self) -> bool:
        """Check if the adapter is ready."""
        return self._ready and await self._storage.is_ready()

    async def close(self) -> None:
        """Close the adapter."""
        await self._vector_index.clear()
        await self._storage.close()
        self._ready = False

    async def get_connection(self) -> IStorage:
        """Get the storage connection."""
        return self._storage

    async def ensure_embedding_dimension(self, dimension: int) -> None:
        """Ensure the embedding dimension matches."""
        if self._embedding_dimension != dimension:
            self._embedding_dimension = dimension
            await self._vector_index.init(dimension)

    # ==================== Agent Methods ====================

    async def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        """Get an agent by ID."""
        return await self._storage.get(COLLECTIONS.AGENTS, agent_id)

    async def get_agents(self) -> list[dict[str, Any]]:
        """Get all agents."""
        return await self._storage.get_all(COLLECTIONS.AGENTS)

    async def create_agent(self, agent: dict[str, Any]) -> bool:
        """Create an agent."""
        if not agent.get("id"):
            return False
        await self._storage.set(COLLECTIONS.AGENTS, agent["id"], agent)
        return True

    async def update_agent(self, agent_id: str, agent: dict[str, Any]) -> bool:
        """Update an agent."""
        existing = await self.get_agent(agent_id)
        if not existing:
            return False
        await self._storage.set(COLLECTIONS.AGENTS, agent_id, {**existing, **agent})
        return True

    async def delete_agent(self, agent_id: str) -> bool:
        """Delete an agent."""
        return await self._storage.delete(COLLECTIONS.AGENTS, agent_id)

    # ==================== Entity Methods ====================

    async def get_entities_by_ids(self, entity_ids: list[str]) -> list[dict[str, Any]] | None:
        """Get entities by IDs."""
        entities = []
        for id_ in entity_ids:
            entity = await self._storage.get(COLLECTIONS.ENTITIES, id_)
            if entity:
                entities.append(entity)
        return entities if entities else None

    async def get_entities_for_room(
        self, room_id: str, include_components: bool = False
    ) -> list[dict[str, Any]]:
        """Get entities for a room."""
        participants = await self._storage.get_where(
            COLLECTIONS.PARTICIPANTS,
            lambda p: p.get("roomId") == room_id,
        )

        entity_ids = [p.get("entityId") for p in participants if p.get("entityId")]
        entities = []

        for entity_id in entity_ids:
            entity = await self._storage.get(COLLECTIONS.ENTITIES, entity_id)
            if entity:
                if include_components:
                    components = await self.get_components(entity_id)
                    entity["components"] = components
                entities.append(entity)

        return entities

    async def create_entities(self, entities: list[dict[str, Any]]) -> bool:
        """Create entities."""
        for entity in entities:
            if not entity.get("id"):
                continue
            await self._storage.set(COLLECTIONS.ENTITIES, entity["id"], entity)
        return True

    async def update_entity(self, entity: dict[str, Any]) -> None:
        """Update an entity."""
        if not entity.get("id"):
            return
        await self._storage.set(COLLECTIONS.ENTITIES, entity["id"], entity)

    # ==================== Component Methods ====================

    async def get_component(
        self,
        entity_id: str,
        type_: str,
        world_id: str | None = None,
        source_entity_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Get a component."""
        components = await self._storage.get_where(
            COLLECTIONS.COMPONENTS,
            lambda c: (
                c.get("entityId") == entity_id
                and c.get("type") == type_
                and (world_id is None or c.get("worldId") == world_id)
                and (source_entity_id is None or c.get("sourceEntityId") == source_entity_id)
            ),
        )
        return components[0] if components else None

    async def get_components(
        self,
        entity_id: str,
        world_id: str | None = None,
        source_entity_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get components for an entity."""
        return await self._storage.get_where(
            COLLECTIONS.COMPONENTS,
            lambda c: (
                c.get("entityId") == entity_id
                and (world_id is None or c.get("worldId") == world_id)
                and (source_entity_id is None or c.get("sourceEntityId") == source_entity_id)
            ),
        )

    async def create_component(self, component: dict[str, Any]) -> bool:
        """Create a component."""
        if not component.get("id"):
            return False
        await self._storage.set(COLLECTIONS.COMPONENTS, component["id"], component)
        return True

    async def update_component(self, component: dict[str, Any]) -> None:
        """Update a component."""
        if not component.get("id"):
            return
        await self._storage.set(COLLECTIONS.COMPONENTS, component["id"], component)

    async def delete_component(self, component_id: str) -> None:
        """Delete a component."""
        await self._storage.delete(COLLECTIONS.COMPONENTS, component_id)

    # ==================== Memory Methods ====================

    async def get_memories(
        self,
        *,
        entity_id: str | None = None,
        agent_id: str | None = None,
        count: int | None = None,
        offset: int | None = None,
        unique: bool | None = None,
        table_name: str,
        start: int | None = None,
        end: int | None = None,
        room_id: str | None = None,
        world_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get memories with filters."""
        memories = await self._storage.get_where(
            COLLECTIONS.MEMORIES,
            lambda m: (
                (entity_id is None or m.get("entityId") == entity_id)
                and (agent_id is None or m.get("agentId") == agent_id)
                and (room_id is None or m.get("roomId") == room_id)
                and (world_id is None or m.get("worldId") == world_id)
                and (
                    table_name is None
                    or (m.get("metadata") or {}).get("type") == table_name
                )
                and (start is None or (m.get("createdAt") or 0) >= start)
                and (end is None or (m.get("createdAt") or 0) <= end)
                and (unique is None or not unique or m.get("unique"))
            ),
        )

        # Sort by createdAt descending
        memories.sort(key=lambda m: m.get("createdAt") or 0, reverse=True)

        # Apply offset and count
        if offset:
            memories = memories[offset:]
        if count:
            memories = memories[:count]

        return memories

    async def get_memory_by_id(self, id_: str) -> dict[str, Any] | None:
        """Get a memory by ID."""
        return await self._storage.get(COLLECTIONS.MEMORIES, id_)

    async def get_memories_by_ids(
        self, memory_ids: list[str], table_name: str | None = None
    ) -> list[dict[str, Any]]:
        """Get memories by IDs."""
        memories = []
        for id_ in memory_ids:
            memory = await self._storage.get(COLLECTIONS.MEMORIES, id_)
            if memory:
                if table_name and (memory.get("metadata") or {}).get("type") != table_name:
                    continue
                memories.append(memory)
        return memories

    async def search_memories(
        self,
        *,
        table_name: str,
        embedding: list[float],
        match_threshold: float | None = None,
        count: int | None = None,
        unique: bool | None = None,
        query: str | None = None,
        room_id: str | None = None,
        world_id: str | None = None,
        entity_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Search memories by vector similarity."""
        threshold = match_threshold or 0.5
        k = count or 10

        # Use HNSW index for vector search
        results = await self._vector_index.search(embedding, k * 2, threshold)

        # Get memories and filter by additional criteria
        memories = []
        for result in results:
            memory = await self._storage.get(COLLECTIONS.MEMORIES, result.id)
            if not memory:
                continue

            # Apply filters
            if table_name and (memory.get("metadata") or {}).get("type") != table_name:
                continue
            if room_id and memory.get("roomId") != room_id:
                continue
            if world_id and memory.get("worldId") != world_id:
                continue
            if entity_id and memory.get("entityId") != entity_id:
                continue
            if unique and not memory.get("unique"):
                continue

            memory["similarity"] = result.similarity
            memories.append(memory)

        return memories[:k]

    async def create_memory(
        self, memory: dict[str, Any], table_name: str, unique: bool = False
    ) -> str:
        """Create a memory."""
        id_ = memory.get("id") or str(uuid.uuid4())
        now = int(datetime.now().timestamp() * 1000)

        stored_memory = {
            **memory,
            "id": id_,
            "agentId": memory.get("agentId") or self._agent_id,
            "unique": unique or memory.get("unique"),
            "createdAt": memory.get("createdAt") or now,
            "metadata": {
                **(memory.get("metadata") or {}),
                "type": table_name,
            },
        }

        await self._storage.set(COLLECTIONS.MEMORIES, id_, stored_memory)

        # Index embedding if present
        embedding = memory.get("embedding")
        if embedding and len(embedding) > 0:
            await self._vector_index.add(id_, embedding)

        return id_

    async def update_memory(self, memory: dict[str, Any]) -> bool:
        """Update a memory."""
        id_ = memory.get("id")
        if not id_:
            return False

        existing = await self.get_memory_by_id(id_)
        if not existing:
            return False

        updated = {
            **existing,
            **memory,
            "metadata": {**(existing.get("metadata") or {}), **(memory.get("metadata") or {})},
        }

        await self._storage.set(COLLECTIONS.MEMORIES, id_, updated)

        # Update embedding index if changed
        embedding = memory.get("embedding")
        if embedding and len(embedding) > 0:
            await self._vector_index.add(id_, embedding)

        return True

    async def delete_memory(self, memory_id: str) -> None:
        """Delete a memory."""
        await self._storage.delete(COLLECTIONS.MEMORIES, memory_id)
        await self._vector_index.remove(memory_id)

    async def delete_many_memories(self, memory_ids: list[str]) -> None:
        """Delete multiple memories."""
        for id_ in memory_ids:
            await self.delete_memory(id_)

    async def count_memories(
        self, room_id: str, unique: bool = False, table_name: str | None = None
    ) -> int:
        """Count memories."""
        return await self._storage.count(
            COLLECTIONS.MEMORIES,
            lambda m: (
                m.get("roomId") == room_id
                and (not unique or m.get("unique"))
                and (table_name is None or (m.get("metadata") or {}).get("type") == table_name)
            ),
        )

    # ==================== World Methods ====================

    async def create_world(self, world: dict[str, Any]) -> str:
        """Create a world."""
        id_ = world.get("id") or str(uuid.uuid4())
        await self._storage.set(COLLECTIONS.WORLDS, id_, {**world, "id": id_})
        return id_

    async def get_world(self, id_: str) -> dict[str, Any] | None:
        """Get a world."""
        return await self._storage.get(COLLECTIONS.WORLDS, id_)

    async def remove_world(self, id_: str) -> None:
        """Remove a world."""
        await self._storage.delete(COLLECTIONS.WORLDS, id_)

    async def get_all_worlds(self) -> list[dict[str, Any]]:
        """Get all worlds."""
        return await self._storage.get_all(COLLECTIONS.WORLDS)

    async def update_world(self, world: dict[str, Any]) -> None:
        """Update a world."""
        if not world.get("id"):
            return
        await self._storage.set(COLLECTIONS.WORLDS, world["id"], world)

    # ==================== Room Methods ====================

    async def get_rooms_by_ids(self, room_ids: list[str]) -> list[dict[str, Any]] | None:
        """Get rooms by IDs."""
        rooms = []
        for id_ in room_ids:
            room = await self._storage.get(COLLECTIONS.ROOMS, id_)
            if room:
                rooms.append(room)
        return rooms if rooms else None

    async def create_rooms(self, rooms: list[dict[str, Any]]) -> list[str]:
        """Create rooms."""
        ids = []
        for room in rooms:
            id_ = room.get("id") or str(uuid.uuid4())
            await self._storage.set(COLLECTIONS.ROOMS, id_, {**room, "id": id_})
            ids.append(id_)
        return ids

    async def delete_room(self, room_id: str) -> None:
        """Delete a room."""
        await self._storage.delete(COLLECTIONS.ROOMS, room_id)
        await self._storage.delete_where(
            COLLECTIONS.PARTICIPANTS,
            lambda p: p.get("roomId") == room_id,
        )
        await self._storage.delete_where(
            COLLECTIONS.MEMORIES,
            lambda m: m.get("roomId") == room_id,
        )

    async def update_room(self, room: dict[str, Any]) -> None:
        """Update a room."""
        if not room.get("id"):
            return
        await self._storage.set(COLLECTIONS.ROOMS, room["id"], room)

    async def get_rooms_for_participant(self, entity_id: str) -> list[str]:
        """Get rooms for a participant."""
        participants = await self._storage.get_where(
            COLLECTIONS.PARTICIPANTS,
            lambda p: p.get("entityId") == entity_id,
        )
        return [p.get("roomId") for p in participants if p.get("roomId")]

    async def get_rooms_by_world(self, world_id: str) -> list[dict[str, Any]]:
        """Get rooms by world."""
        return await self._storage.get_where(
            COLLECTIONS.ROOMS,
            lambda r: r.get("worldId") == world_id,
        )

    # ==================== Participant Methods ====================

    async def add_participants_room(self, entity_ids: list[str], room_id: str) -> bool:
        """Add participants to a room."""
        for entity_id in entity_ids:
            exists = await self.is_room_participant(room_id, entity_id)
            if not exists:
                id_ = str(uuid.uuid4())
                participant = {
                    "id": id_,
                    "entityId": entity_id,
                    "roomId": room_id,
                }
                await self._storage.set(COLLECTIONS.PARTICIPANTS, id_, participant)
        return True

    async def remove_participant(self, entity_id: str, room_id: str) -> bool:
        """Remove a participant from a room."""
        participants = await self._storage.get_where(
            COLLECTIONS.PARTICIPANTS,
            lambda p: p.get("entityId") == entity_id and p.get("roomId") == room_id,
        )
        if not participants:
            return False
        for p in participants:
            if p.get("id"):
                await self._storage.delete(COLLECTIONS.PARTICIPANTS, p["id"])
        return True

    async def is_room_participant(self, room_id: str, entity_id: str) -> bool:
        """Check if an entity is a participant in a room."""
        participants = await self._storage.get_where(
            COLLECTIONS.PARTICIPANTS,
            lambda p: p.get("roomId") == room_id and p.get("entityId") == entity_id,
        )
        return len(participants) > 0

    async def get_participants_for_room(self, room_id: str) -> list[str]:
        """Get participants for a room."""
        participants = await self._storage.get_where(
            COLLECTIONS.PARTICIPANTS,
            lambda p: p.get("roomId") == room_id,
        )
        return [p.get("entityId") for p in participants if p.get("entityId")]

    # ==================== Relationship Methods ====================

    async def create_relationship(
        self,
        source_entity_id: str,
        target_entity_id: str,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        """Create a relationship."""
        id_ = str(uuid.uuid4())
        relationship = {
            "id": id_,
            "sourceEntityId": source_entity_id,
            "targetEntityId": target_entity_id,
            "tags": tags or [],
            "metadata": metadata or {},
            "createdAt": datetime.now().isoformat(),
        }
        await self._storage.set(COLLECTIONS.RELATIONSHIPS, id_, relationship)
        return True

    async def get_relationship(
        self, source_entity_id: str, target_entity_id: str
    ) -> dict[str, Any] | None:
        """Get a relationship."""
        relationships = await self._storage.get_where(
            COLLECTIONS.RELATIONSHIPS,
            lambda r: (
                r.get("sourceEntityId") == source_entity_id
                and r.get("targetEntityId") == target_entity_id
            ),
        )
        return relationships[0] if relationships else None

    async def get_relationships(
        self, entity_id: str, tags: list[str] | None = None
    ) -> list[dict[str, Any]]:
        """Get relationships for an entity."""
        return await self._storage.get_where(
            COLLECTIONS.RELATIONSHIPS,
            lambda r: (
                (r.get("sourceEntityId") == entity_id or r.get("targetEntityId") == entity_id)
                and (
                    tags is None
                    or len(tags) == 0
                    or any(tag in (r.get("tags") or []) for tag in tags)
                )
            ),
        )

    # ==================== Cache Methods ====================

    async def get_cache(self, key: str) -> Any | None:
        """Get a cached value."""
        cached = await self._storage.get(COLLECTIONS.CACHE, key)
        if not cached:
            return None

        # Check expiration
        expires_at = cached.get("expiresAt")
        if expires_at and int(datetime.now().timestamp() * 1000) > expires_at:
            await self.delete_cache(key)
            return None

        return cached.get("value")

    async def set_cache(self, key: str, value: Any) -> bool:
        """Set a cached value."""
        await self._storage.set(COLLECTIONS.CACHE, key, {"value": value})
        return True

    async def delete_cache(self, key: str) -> bool:
        """Delete a cached value."""
        return await self._storage.delete(COLLECTIONS.CACHE, key)

    # ==================== Task Methods ====================

    async def create_task(self, task: dict[str, Any]) -> str:
        """Create a task."""
        id_ = task.get("id") or str(uuid.uuid4())
        await self._storage.set(COLLECTIONS.TASKS, id_, {**task, "id": id_})
        return id_

    async def get_tasks(
        self,
        room_id: str | None = None,
        tags: list[str] | None = None,
        entity_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get tasks."""
        return await self._storage.get_where(
            COLLECTIONS.TASKS,
            lambda t: (
                (room_id is None or t.get("roomId") == room_id)
                and (entity_id is None or t.get("entityId") == entity_id)
                and (
                    tags is None
                    or len(tags) == 0
                    or any(tag in (t.get("tags") or []) for tag in tags)
                )
            ),
        )

    async def get_task(self, id_: str) -> dict[str, Any] | None:
        """Get a task."""
        return await self._storage.get(COLLECTIONS.TASKS, id_)

    async def update_task(self, id_: str, task: dict[str, Any]) -> None:
        """Update a task."""
        existing = await self.get_task(id_)
        if not existing:
            return
        await self._storage.set(COLLECTIONS.TASKS, id_, {**existing, **task})

    async def delete_task(self, id_: str) -> None:
        """Delete a task."""
        await self._storage.delete(COLLECTIONS.TASKS, id_)

    # ==================== Log Methods ====================

    async def log(
        self, body: dict[str, Any], entity_id: str, room_id: str, type_: str
    ) -> None:
        """Create a log entry."""
        id_ = str(uuid.uuid4())
        log = {
            "id": id_,
            "entityId": entity_id,
            "roomId": room_id,
            "body": body,
            "type": type_,
            "createdAt": datetime.now().isoformat(),
        }
        await self._storage.set(COLLECTIONS.LOGS, id_, log)

    async def get_logs(
        self,
        entity_id: str | None = None,
        room_id: str | None = None,
        type_: str | None = None,
        count: int | None = None,
        offset: int | None = None,
    ) -> list[dict[str, Any]]:
        """Get logs."""
        logs = await self._storage.get_where(
            COLLECTIONS.LOGS,
            lambda l: (
                (entity_id is None or l.get("entityId") == entity_id)
                and (room_id is None or l.get("roomId") == room_id)
                and (type_ is None or l.get("type") == type_)
            ),
        )

        logs.sort(key=lambda l: l.get("createdAt") or "", reverse=True)

        if offset:
            logs = logs[offset:]
        if count:
            logs = logs[:count]

        return logs

    async def delete_log(self, log_id: str) -> None:
        """Delete a log."""
        await self._storage.delete(COLLECTIONS.LOGS, log_id)






