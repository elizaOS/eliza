"""
Local JSON-based database adapter for elizaOS (Python).
"""

import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from elizaos.types.database import IDatabaseAdapter

from .hnsw import SimpleHNSW
from .storage import JsonFileStorage


# Collection names
COLLECTIONS = {
    "AGENTS": "agents",
    "ENTITIES": "entities",
    "MEMORIES": "memories",
    "ROOMS": "rooms",
    "WORLDS": "worlds",
    "COMPONENTS": "components",
    "RELATIONSHIPS": "relationships",
    "PARTICIPANTS": "participants",
    "TASKS": "tasks",
    "CACHE": "cache",
    "LOGS": "logs",
    "EMBEDDINGS": "embeddings",
}


class LocalDatabaseAdapter(IDatabaseAdapter):
    """
    Local JSON-based database adapter implementing IDatabaseAdapter.
    """

    def __init__(self, storage: JsonFileStorage, agent_id: str):
        self._storage = storage
        self._agent_id = agent_id
        self._vector_index: Optional[SimpleHNSW] = None
        self._embedding_dimension = 384
        self._ready = False

    @property
    def db(self) -> JsonFileStorage:
        """Database instance."""
        return self._storage

    async def initialize(self, config: Optional[Dict[str, Any]] = None) -> None:
        """Initialize database connection."""
        await self.init()

    async def init(self) -> None:
        """Initialize database connection."""
        await self._storage.init()

        # Initialize HNSW with save/load callbacks
        def save_cb():
            if self._vector_index:
                index = self._vector_index.serialize()
                # Run async in sync context
                import asyncio
                loop = asyncio.get_event_loop()
                loop.create_task(
                    self._storage.save_raw("vectors/hnsw_index.json", json.dumps(index))
                )

        def load_cb() -> Optional[Dict[str, Any]]:
            import asyncio
            try:
                loop = asyncio.get_event_loop()
                data = loop.run_until_complete(
                    self._storage.load_raw("vectors/hnsw_index.json")
                )
                if data:
                    return json.loads(data)
            except Exception:
                pass
            return None

        self._vector_index = SimpleHNSW(save_callback=save_cb, load_callback=load_cb)
        await self._vector_index.init(self._embedding_dimension)
        self._ready = True

    async def is_ready(self) -> bool:
        """Check if the database connection is ready."""
        return self._ready and await self._storage.is_ready()

    async def close(self) -> None:
        """Close database connection."""
        if self._vector_index:
            await self._vector_index.save()
        await self._storage.close()
        self._ready = False

    async def get_connection(self) -> JsonFileStorage:
        """Get database connection."""
        return self._storage

    # ==================== Agent Methods ====================

    async def get_agent(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """Get agent by ID."""
        return await self._storage.get(COLLECTIONS["AGENTS"], agent_id)

    async def get_agents(self) -> List[Dict[str, Any]]:
        """Get all agents."""
        return await self._storage.get_all(COLLECTIONS["AGENTS"])

    async def create_agent(self, agent: Dict[str, Any]) -> bool:
        """Create a new agent."""
        agent_id = agent.get("id")
        if not agent_id:
            return False
        await self._storage.set(COLLECTIONS["AGENTS"], agent_id, agent)
        return True

    async def update_agent(self, agent_id: str, agent: Dict[str, Any]) -> bool:
        """Update an agent."""
        existing = await self.get_agent(agent_id)
        if not existing:
            return False
        await self._storage.set(
            COLLECTIONS["AGENTS"], agent_id, {**existing, **agent}
        )
        return True

    async def delete_agent(self, agent_id: str) -> bool:
        """Delete an agent."""
        return await self._storage.delete(COLLECTIONS["AGENTS"], agent_id)

    async def ensure_embedding_dimension(self, dimension: int) -> None:
        """Ensure embedding dimension is set."""
        if self._embedding_dimension != dimension:
            self._embedding_dimension = dimension
            if self._vector_index:
                await self._vector_index.init(dimension)

    # ==================== Entity Methods ====================

    async def get_entities_by_ids(
        self, entity_ids: List[str]
    ) -> Optional[List[Dict[str, Any]]]:
        """Get entities by IDs."""
        entities = []
        for entity_id in entity_ids:
            entity = await self._storage.get(COLLECTIONS["ENTITIES"], entity_id)
            if entity:
                entities.append(entity)
        return entities if entities else None

    async def get_entities_for_room(
        self, room_id: str, include_components: bool = False
    ) -> List[Dict[str, Any]]:
        """Get entities for room."""
        participants = await self._storage.get_where(
            COLLECTIONS["PARTICIPANTS"], lambda p: p.get("roomId") == room_id
        )
        entity_ids = [p.get("entityId") for p in participants if p.get("entityId")]

        entities = []
        for entity_id in entity_ids:
            entity = await self._storage.get(COLLECTIONS["ENTITIES"], entity_id)
            if entity:
                if include_components:
                    components = await self.get_components(entity_id)
                    entity["components"] = components
                entities.append(entity)

        return entities

    async def create_entities(self, entities: List[Dict[str, Any]]) -> bool:
        """Create new entities."""
        for entity in entities:
            entity_id = entity.get("id")
            if entity_id:
                await self._storage.set(COLLECTIONS["ENTITIES"], entity_id, entity)
        return True

    async def update_entity(self, entity: Dict[str, Any]) -> None:
        """Update entity."""
        entity_id = entity.get("id")
        if entity_id:
            await self._storage.set(COLLECTIONS["ENTITIES"], entity_id, entity)

    # ==================== Component Methods ====================

    async def get_component(
        self,
        entity_id: str,
        component_type: str,
        world_id: Optional[str] = None,
        source_entity_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Get component by ID."""
        components = await self._storage.get_where(
            COLLECTIONS["COMPONENTS"],
            lambda c: (
                c.get("entityId") == entity_id
                and c.get("type") == component_type
                and (world_id is None or c.get("worldId") == world_id)
                and (source_entity_id is None or c.get("sourceEntityId") == source_entity_id)
            ),
        )
        return components[0] if components else None

    async def get_components(
        self,
        entity_id: str,
        world_id: Optional[str] = None,
        source_entity_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Get all components for an entity."""
        return await self._storage.get_where(
            COLLECTIONS["COMPONENTS"],
            lambda c: (
                c.get("entityId") == entity_id
                and (world_id is None or c.get("worldId") == world_id)
                and (source_entity_id is None or c.get("sourceEntityId") == source_entity_id)
            ),
        )

    async def create_component(self, component: Dict[str, Any]) -> bool:
        """Create component."""
        component_id = component.get("id")
        if not component_id:
            return False
        await self._storage.set(COLLECTIONS["COMPONENTS"], component_id, component)
        return True

    async def update_component(self, component: Dict[str, Any]) -> None:
        """Update component."""
        component_id = component.get("id")
        if component_id:
            await self._storage.set(COLLECTIONS["COMPONENTS"], component_id, component)

    async def delete_component(self, component_id: str) -> None:
        """Delete component."""
        await self._storage.delete(COLLECTIONS["COMPONENTS"], component_id)

    # ==================== Memory Methods ====================

    async def get_memories(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Get memories matching criteria."""
        def predicate(m: Dict[str, Any]) -> bool:
            if params.get("entityId") and m.get("entityId") != params["entityId"]:
                return False
            if params.get("agentId") and m.get("agentId") != params["agentId"]:
                return False
            if params.get("roomId") and m.get("roomId") != params["roomId"]:
                return False
            metadata = m.get("metadata", {})
            if params.get("worldId") and metadata.get("worldId") != params["worldId"]:
                return False
            if params.get("tableName") and metadata.get("type") != params["tableName"]:
                return False
            if params.get("start") and (m.get("createdAt", 0) < params["start"]):
                return False
            if params.get("end") and (m.get("createdAt", 0) > params["end"]):
                return False
            if params.get("unique") and not m.get("unique"):
                return False
            return True

        memories = await self._storage.get_where(COLLECTIONS["MEMORIES"], predicate)

        # Sort by createdAt descending
        memories.sort(key=lambda m: m.get("createdAt", 0), reverse=True)

        # Apply offset and count
        offset = params.get("offset", 0)
        count = params.get("count")
        
        if offset:
            memories = memories[offset:]
        if count:
            memories = memories[:count]

        return memories

    async def get_memory_by_id(self, memory_id: str) -> Optional[Dict[str, Any]]:
        """Get memory by ID."""
        return await self._storage.get(COLLECTIONS["MEMORIES"], memory_id)

    async def get_memories_by_ids(
        self, memory_ids: List[str], table_name: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Get memories by IDs."""
        memories = []
        for memory_id in memory_ids:
            memory = await self._storage.get(COLLECTIONS["MEMORIES"], memory_id)
            if memory:
                if table_name and memory.get("metadata", {}).get("type") != table_name:
                    continue
                memories.append(memory)
        return memories

    async def get_memories_by_room_ids(
        self, params: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Get memories by room IDs."""
        room_ids = params.get("roomIds", [])
        table_name = params.get("tableName")
        limit = params.get("limit")

        memories = await self._storage.get_where(
            COLLECTIONS["MEMORIES"],
            lambda m: (
                m.get("roomId") in room_ids
                and (not table_name or m.get("metadata", {}).get("type") == table_name)
            ),
        )

        memories.sort(key=lambda m: m.get("createdAt", 0), reverse=True)

        if limit:
            memories = memories[:limit]

        return memories

    async def get_cached_embeddings(
        self, params: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Get cached embeddings based on query parameters."""
        # Simple implementation
        return []

    async def log(self, params: Dict[str, Any]) -> None:
        """Log an event."""
        log_id = str(uuid.uuid4())
        log_entry = {
            "id": log_id,
            "entityId": params.get("entityId"),
            "roomId": params.get("roomId"),
            "body": params.get("body"),
            "type": params.get("type"),
            "createdAt": datetime.utcnow().isoformat(),
        }
        await self._storage.set(COLLECTIONS["LOGS"], log_id, log_entry)

    async def get_logs(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Get logs based on parameters."""
        def predicate(log: Dict[str, Any]) -> bool:
            if params.get("entityId") and log.get("entityId") != params["entityId"]:
                return False
            if params.get("roomId") and log.get("roomId") != params["roomId"]:
                return False
            if params.get("type") and log.get("type") != params["type"]:
                return False
            return True

        logs = await self._storage.get_where(COLLECTIONS["LOGS"], predicate)

        # Sort by createdAt descending
        logs.sort(key=lambda l: l.get("createdAt", ""), reverse=True)

        offset = params.get("offset", 0)
        count = params.get("count")

        if offset:
            logs = logs[offset:]
        if count:
            logs = logs[:count]

        return logs

    async def delete_log(self, log_id: str) -> None:
        """Delete a log."""
        await self._storage.delete(COLLECTIONS["LOGS"], log_id)

    async def search_memories(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Search memories using vector similarity."""
        if not self._vector_index:
            return []

        embedding = params.get("embedding", [])
        threshold = params.get("match_threshold", 0.5)
        count = params.get("count", 10)

        results = await self._vector_index.search(embedding, count * 2, threshold)

        memories = []
        for result in results:
            memory = await self._storage.get(COLLECTIONS["MEMORIES"], result.id)
            if not memory:
                continue

            # Apply additional filters
            metadata = memory.get("metadata", {})
            if params.get("tableName") and metadata.get("type") != params["tableName"]:
                continue
            if params.get("roomId") and memory.get("roomId") != params["roomId"]:
                continue
            if params.get("worldId") and metadata.get("worldId") != params["worldId"]:
                continue
            if params.get("entityId") and memory.get("entityId") != params["entityId"]:
                continue
            if params.get("unique") and not memory.get("unique"):
                continue

            memory["similarity"] = result.similarity
            memories.append(memory)

        return memories[:count]

    async def create_memory(
        self,
        memory: Dict[str, Any],
        table_name: str,
        unique: bool = False,
    ) -> str:
        """Create a new memory."""
        memory_id = memory.get("id") or str(uuid.uuid4())
        now = int(datetime.utcnow().timestamp() * 1000)

        stored_memory = {
            **memory,
            "id": memory_id,
            "agentId": memory.get("agentId") or self._agent_id,
            "unique": unique or memory.get("unique", False),
            "createdAt": memory.get("createdAt") or now,
            "metadata": {
                **memory.get("metadata", {}),
                "type": table_name,
            },
        }

        await self._storage.set(COLLECTIONS["MEMORIES"], memory_id, stored_memory)

        # Index embedding if present
        embedding = memory.get("embedding")
        if embedding and self._vector_index:
            await self._vector_index.add(memory_id, embedding)
            await self._vector_index.save()

        return memory_id

    async def update_memory(self, memory: Dict[str, Any]) -> bool:
        """Update an existing memory."""
        memory_id = memory.get("id")
        if not memory_id:
            return False

        existing = await self.get_memory_by_id(memory_id)
        if not existing:
            return False

        updated = {
            **existing,
            **memory,
            "metadata": {**existing.get("metadata", {}), **memory.get("metadata", {})},
        }

        await self._storage.set(COLLECTIONS["MEMORIES"], memory_id, updated)

        # Update embedding index if changed
        embedding = memory.get("embedding")
        if embedding and self._vector_index:
            await self._vector_index.add(memory_id, embedding)
            await self._vector_index.save()

        return True

    async def delete_memory(self, memory_id: str) -> None:
        """Delete a memory."""
        await self._storage.delete(COLLECTIONS["MEMORIES"], memory_id)
        if self._vector_index:
            await self._vector_index.remove(memory_id)
            await self._vector_index.save()

    async def delete_many_memories(self, memory_ids: List[str]) -> None:
        """Delete multiple memories."""
        for memory_id in memory_ids:
            await self.delete_memory(memory_id)

    async def delete_all_memories(self, room_id: str, table_name: str) -> None:
        """Delete all memories for a room."""
        memories = await self.get_memories({"roomId": room_id, "tableName": table_name})
        memory_ids = [m.get("id") for m in memories if m.get("id")]
        await self.delete_many_memories(memory_ids)

    async def count_memories(
        self,
        room_id: str,
        unique: bool = False,
        table_name: Optional[str] = None,
    ) -> int:
        """Count memories in a room."""
        return await self._storage.count(
            COLLECTIONS["MEMORIES"],
            lambda m: (
                m.get("roomId") == room_id
                and (not unique or m.get("unique"))
                and (not table_name or m.get("metadata", {}).get("type") == table_name)
            ),
        )

    async def get_memories_by_world_id(
        self, params: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Get memories by world ID."""
        world_id = params.get("worldId")
        table_name = params.get("tableName")
        count = params.get("count")

        memories = await self._storage.get_where(
            COLLECTIONS["MEMORIES"],
            lambda m: (
                m.get("metadata", {}).get("worldId") == world_id
                and (not table_name or m.get("metadata", {}).get("type") == table_name)
            ),
        )

        memories.sort(key=lambda m: m.get("createdAt", 0), reverse=True)

        if count:
            memories = memories[:count]

        return memories

    # ==================== World Methods ====================

    async def create_world(self, world: Dict[str, Any]) -> str:
        """Create a new world."""
        world_id = world.get("id") or str(uuid.uuid4())
        await self._storage.set(COLLECTIONS["WORLDS"], world_id, {**world, "id": world_id})
        return world_id

    async def get_world(self, world_id: str) -> Optional[Dict[str, Any]]:
        """Get a world by ID."""
        return await self._storage.get(COLLECTIONS["WORLDS"], world_id)

    async def remove_world(self, world_id: str) -> None:
        """Remove a world."""
        await self._storage.delete(COLLECTIONS["WORLDS"], world_id)

    async def get_all_worlds(self) -> List[Dict[str, Any]]:
        """Get all worlds."""
        return await self._storage.get_all(COLLECTIONS["WORLDS"])

    async def update_world(self, world: Dict[str, Any]) -> None:
        """Update a world."""
        world_id = world.get("id")
        if world_id:
            await self._storage.set(COLLECTIONS["WORLDS"], world_id, world)

    # ==================== Room Methods ====================

    async def get_rooms_by_ids(
        self, room_ids: List[str]
    ) -> Optional[List[Dict[str, Any]]]:
        """Get rooms by IDs."""
        rooms = []
        for room_id in room_ids:
            room = await self._storage.get(COLLECTIONS["ROOMS"], room_id)
            if room:
                rooms.append(room)
        return rooms if rooms else None

    async def create_rooms(self, rooms: List[Dict[str, Any]]) -> List[str]:
        """Create new rooms."""
        ids = []
        for room in rooms:
            room_id = room.get("id") or str(uuid.uuid4())
            await self._storage.set(COLLECTIONS["ROOMS"], room_id, {**room, "id": room_id})
            ids.append(room_id)
        return ids

    async def delete_room(self, room_id: str) -> None:
        """Delete a room."""
        await self._storage.delete(COLLECTIONS["ROOMS"], room_id)
        # Delete participants
        await self._storage.delete_where(
            COLLECTIONS["PARTICIPANTS"], lambda p: p.get("roomId") == room_id
        )
        # Delete memories
        await self._storage.delete_where(
            COLLECTIONS["MEMORIES"], lambda m: m.get("roomId") == room_id
        )

    async def delete_rooms_by_world_id(self, world_id: str) -> None:
        """Delete all rooms for a world."""
        rooms = await self.get_rooms_by_world(world_id)
        for room in rooms:
            room_id = room.get("id")
            if room_id:
                await self.delete_room(room_id)

    async def update_room(self, room: Dict[str, Any]) -> None:
        """Update a room."""
        room_id = room.get("id")
        if room_id:
            await self._storage.set(COLLECTIONS["ROOMS"], room_id, room)

    async def get_rooms_for_participant(self, entity_id: str) -> List[str]:
        """Get rooms for a participant."""
        participants = await self._storage.get_where(
            COLLECTIONS["PARTICIPANTS"], lambda p: p.get("entityId") == entity_id
        )
        return [p.get("roomId") for p in participants if p.get("roomId")]

    async def get_rooms_for_participants(self, user_ids: List[str]) -> List[str]:
        """Get rooms for multiple participants."""
        participants = await self._storage.get_where(
            COLLECTIONS["PARTICIPANTS"], lambda p: p.get("entityId") in user_ids
        )
        return list(set(p.get("roomId") for p in participants if p.get("roomId")))

    async def get_rooms_by_world(self, world_id: str) -> List[Dict[str, Any]]:
        """Get all rooms for a world."""
        return await self._storage.get_where(
            COLLECTIONS["ROOMS"], lambda r: r.get("worldId") == world_id
        )

    # ==================== Participant Methods ====================

    async def remove_participant(self, entity_id: str, room_id: str) -> bool:
        """Remove a participant from a room."""
        participants = await self._storage.get_where(
            COLLECTIONS["PARTICIPANTS"],
            lambda p: p.get("entityId") == entity_id and p.get("roomId") == room_id,
        )

        if not participants:
            return False

        for p in participants:
            p_id = p.get("id")
            if p_id:
                await self._storage.delete(COLLECTIONS["PARTICIPANTS"], p_id)

        return True

    async def get_participants_for_entity(
        self, entity_id: str
    ) -> List[Dict[str, Any]]:
        """Get all participants for an entity."""
        return await self._storage.get_where(
            COLLECTIONS["PARTICIPANTS"], lambda p: p.get("entityId") == entity_id
        )

    async def get_participants_for_room(self, room_id: str) -> List[str]:
        """Get all participant entity IDs for a room."""
        participants = await self._storage.get_where(
            COLLECTIONS["PARTICIPANTS"], lambda p: p.get("roomId") == room_id
        )
        return [p.get("entityId") for p in participants if p.get("entityId")]

    async def is_room_participant(self, room_id: str, entity_id: str) -> bool:
        """Check if an entity is a participant in a room."""
        participants = await self._storage.get_where(
            COLLECTIONS["PARTICIPANTS"],
            lambda p: p.get("roomId") == room_id and p.get("entityId") == entity_id,
        )
        return len(participants) > 0

    async def add_participants_room(
        self, entity_ids: List[str], room_id: str
    ) -> bool:
        """Add participants to a room."""
        for entity_id in entity_ids:
            exists = await self.is_room_participant(room_id, entity_id)
            if not exists:
                p_id = str(uuid.uuid4())
                await self._storage.set(
                    COLLECTIONS["PARTICIPANTS"],
                    p_id,
                    {"id": p_id, "entityId": entity_id, "roomId": room_id},
                )
        return True

    async def get_participant_user_state(
        self, room_id: str, entity_id: str
    ) -> Optional[str]:
        """Get participant user state."""
        participants = await self._storage.get_where(
            COLLECTIONS["PARTICIPANTS"],
            lambda p: p.get("roomId") == room_id and p.get("entityId") == entity_id,
        )
        if not participants:
            return None
        state = participants[0].get("userState")
        if state in ("FOLLOWED", "MUTED"):
            return state
        return None

    async def set_participant_user_state(
        self, room_id: str, entity_id: str, state: Optional[str]
    ) -> None:
        """Set participant user state."""
        participants = await self._storage.get_where(
            COLLECTIONS["PARTICIPANTS"],
            lambda p: p.get("roomId") == room_id and p.get("entityId") == entity_id,
        )
        for p in participants:
            p_id = p.get("id")
            if p_id:
                await self._storage.set(
                    COLLECTIONS["PARTICIPANTS"], p_id, {**p, "userState": state}
                )

    # ==================== Relationship Methods ====================

    async def create_relationship(self, params: Dict[str, Any]) -> bool:
        """Create a new relationship."""
        rel_id = str(uuid.uuid4())
        relationship = {
            "id": rel_id,
            "sourceEntityId": params.get("sourceEntityId"),
            "targetEntityId": params.get("targetEntityId"),
            "tags": params.get("tags", []),
            "metadata": params.get("metadata", {}),
            "createdAt": datetime.utcnow().isoformat(),
        }
        await self._storage.set(COLLECTIONS["RELATIONSHIPS"], rel_id, relationship)
        return True

    async def get_relationship(
        self, params: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """Get a relationship between two entities."""
        relationships = await self._storage.get_where(
            COLLECTIONS["RELATIONSHIPS"],
            lambda r: (
                r.get("sourceEntityId") == params.get("sourceEntityId")
                and r.get("targetEntityId") == params.get("targetEntityId")
            ),
        )
        return relationships[0] if relationships else None

    async def get_relationships(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Get all relationships for an entity."""
        entity_id = params.get("entityId")
        tags = params.get("tags", [])

        def predicate(r: Dict[str, Any]) -> bool:
            is_involved = (
                r.get("sourceEntityId") == entity_id
                or r.get("targetEntityId") == entity_id
            )
            if not is_involved:
                return False
            if tags:
                r_tags = r.get("tags", [])
                if not any(tag in r_tags for tag in tags):
                    return False
            return True

        return await self._storage.get_where(COLLECTIONS["RELATIONSHIPS"], predicate)

    async def update_relationship(self, relationship: Dict[str, Any]) -> None:
        """Update an existing relationship."""
        existing = await self.get_relationship({
            "sourceEntityId": relationship.get("sourceEntityId"),
            "targetEntityId": relationship.get("targetEntityId"),
        })
        if not existing or not existing.get("id"):
            return

        await self._storage.set(
            COLLECTIONS["RELATIONSHIPS"],
            existing["id"],
            {
                **existing,
                "tags": relationship.get("tags", existing.get("tags")),
                "metadata": {
                    **existing.get("metadata", {}),
                    **relationship.get("metadata", {}),
                },
            },
        )

    # ==================== Cache Methods ====================

    async def get_cache(self, key: str) -> Optional[Any]:
        """Get cached value."""
        cached = await self._storage.get(COLLECTIONS["CACHE"], key)
        if not cached:
            return None

        # Check expiration
        expires_at = cached.get("expiresAt")
        if expires_at and datetime.utcnow().timestamp() * 1000 > expires_at:
            await self.delete_cache(key)
            return None

        return cached.get("value")

    async def set_cache(self, key: str, value: Any) -> bool:
        """Set cached value."""
        await self._storage.set(COLLECTIONS["CACHE"], key, {"value": value})
        return True

    async def delete_cache(self, key: str) -> bool:
        """Delete cached value."""
        return await self._storage.delete(COLLECTIONS["CACHE"], key)

    # ==================== Task Methods ====================

    async def create_task(self, task: Dict[str, Any]) -> str:
        """Create a task."""
        task_id = task.get("id") or str(uuid.uuid4())
        await self._storage.set(COLLECTIONS["TASKS"], task_id, {**task, "id": task_id})
        return task_id

    async def get_tasks(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Get tasks."""

        def predicate(t: Dict[str, Any]) -> bool:
            if params.get("roomId") and t.get("roomId") != params["roomId"]:
                return False
            if params.get("entityId") and t.get("entityId") != params["entityId"]:
                return False
            tags = params.get("tags", [])
            if tags:
                t_tags = t.get("tags", [])
                if not any(tag in t_tags for tag in tags):
                    return False
            return True

        return await self._storage.get_where(COLLECTIONS["TASKS"], predicate)

    async def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Get task by ID."""
        return await self._storage.get(COLLECTIONS["TASKS"], task_id)

    async def get_tasks_by_name(self, name: str) -> List[Dict[str, Any]]:
        """Get tasks by name."""
        return await self._storage.get_where(
            COLLECTIONS["TASKS"], lambda t: t.get("name") == name
        )

    async def update_task(self, task_id: str, task: Dict[str, Any]) -> None:
        """Update a task."""
        existing = await self.get_task(task_id)
        if not existing:
            return
        await self._storage.set(COLLECTIONS["TASKS"], task_id, {**existing, **task})

    async def delete_task(self, task_id: str) -> None:
        """Delete a task."""
        await self._storage.delete(COLLECTIONS["TASKS"], task_id)

