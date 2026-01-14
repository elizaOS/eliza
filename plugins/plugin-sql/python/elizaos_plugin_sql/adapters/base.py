from __future__ import annotations

import uuid
from abc import abstractmethod
from datetime import UTC, datetime
from typing import Any

from elizaos.types import (
    UUID,
    IDatabaseAdapter,
    Log,
    as_uuid,
)
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
)

from elizaos_plugin_sql.schema import (
    AgentTable,
    Base,
    CacheTable,
    ComponentTable,
    EmbeddingTable,
    EntityTable,
    LogTable,
    MemoryTable,
    ParticipantTable,
    RelationshipTable,
    RoomTable,
    TaskTable,
    WorldTable,
)


class BaseSQLAdapter(IDatabaseAdapter):
    def __init__(self, agent_id: UUID) -> None:
        self._agent_id = agent_id
        self._engine: AsyncEngine | None = None
        self._session_factory: async_sessionmaker[AsyncSession] | None = None
        self._embedding_dimension: int = 384

    @property
    def db(self) -> AsyncEngine:
        if not self._engine:
            raise RuntimeError("Database not initialized")
        return self._engine

    @abstractmethod
    async def _create_engine(self) -> AsyncEngine: ...

    async def initialize(self, config: dict[str, str | int | bool | None] | None = None) -> None:
        _ = config
        self._engine = await self._create_engine()
        self._session_factory = async_sessionmaker(
            self._engine, class_=AsyncSession, expire_on_commit=False
        )
        await self.init()

    async def init(self) -> None:
        if not self._engine:
            raise RuntimeError("Database engine not created")

        from elizaos_plugin_sql.migration_service import MigrationService

        migration_service = MigrationService(self._engine)
        await migration_service.initialize()

        async with self._engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def is_ready(self) -> bool:
        if not self._engine:
            return False
        try:
            async with self._engine.connect() as conn:
                await conn.execute(select(1))
            return True
        except Exception:
            return False

    async def close(self) -> None:
        if self._engine:
            await self._engine.dispose()
            self._engine = None

    async def get_connection(self) -> AsyncSession:
        if not self._session_factory:
            raise RuntimeError("Database not initialized")
        return self._session_factory()

    def _get_session(self) -> AsyncSession:
        if not self._session_factory:
            raise RuntimeError("Database not initialized")
        return self._session_factory()

    async def get_agent(self, agent_id: UUID) -> dict[str, Any] | None:
        async with self._get_session() as session:
            result = await session.execute(select(AgentTable).where(AgentTable.id == agent_id))
            agent = result.scalar_one_or_none()
            if agent:
                return self._agent_to_dict(agent)
            return None

    async def get_agents(self) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            result = await session.execute(select(AgentTable))
            agents = result.scalars().all()
            return [self._agent_to_dict(a) for a in agents]

    async def create_agent(self, agent: dict[str, Any]) -> bool:
        async with self._get_session() as session:
            try:
                db_agent = AgentTable(
                    id=agent.get("id") or uuid.uuid4(),
                    name=agent["name"],
                    username=agent.get("username"),
                    bio=agent.get("bio"),
                    system=agent.get("system"),
                    settings=agent.get("settings"),
                    secrets=agent.get("secrets"),
                    enabled=agent.get("enabled", True),
                    status=agent.get("status", "active"),
                )
                session.add(db_agent)
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    async def update_agent(self, agent_id: UUID, agent: dict[str, Any]) -> bool:
        async with self._get_session() as session:
            try:
                await session.execute(
                    update(AgentTable)
                    .where(AgentTable.id == agent_id)
                    .values(**{k: v for k, v in agent.items() if k != "id"})
                )
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    async def delete_agent(self, agent_id: UUID) -> bool:
        async with self._get_session() as session:
            try:
                await session.execute(delete(AgentTable).where(AgentTable.id == agent_id))
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    async def ensure_embedding_dimension(self, dimension: int) -> None:
        self._embedding_dimension = dimension

    async def get_entities_by_ids(self, entity_ids: list[UUID]) -> list[dict[str, Any]] | None:
        async with self._get_session() as session:
            result = await session.execute(
                select(EntityTable).where(EntityTable.id.in_(entity_ids))
            )
            entities = result.scalars().all()
            return [self._entity_to_dict(e) for e in entities] if entities else None

    async def get_entities_for_room(
        self, room_id: UUID, include_components: bool = False
    ) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            result = await session.execute(
                select(EntityTable)
                .join(ParticipantTable)
                .where(ParticipantTable.room_id == room_id)
            )
            entities = result.scalars().all()
            return [self._entity_to_dict(e) for e in entities]

    async def create_entities(self, entities: list[dict[str, Any]]) -> bool:
        async with self._get_session() as session:
            try:
                for entity in entities:
                    db_entity = EntityTable(
                        id=entity.get("id") or uuid.uuid4(),
                        agent_id=entity["agentId"],
                        names=entity["names"],
                        entity_metadata=entity.get("metadata", {}),
                    )
                    session.add(db_entity)
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    async def update_entity(self, entity: dict[str, Any]) -> None:
        async with self._get_session() as session:
            await session.execute(
                update(EntityTable)
                .where(EntityTable.id == entity["id"])
                .values(
                    names=entity.get("names"),
                    entity_metadata=entity.get("metadata"),
                )
            )
            await session.commit()

    async def get_component(
        self,
        entity_id: UUID,
        component_type: str,
        world_id: UUID | None = None,
        source_entity_id: UUID | None = None,
    ) -> dict[str, Any] | None:
        async with self._get_session() as session:
            query = select(ComponentTable).where(
                and_(
                    ComponentTable.entity_id == entity_id,
                    ComponentTable.type == component_type,
                )
            )
            if world_id:
                query = query.where(ComponentTable.world_id == world_id)
            if source_entity_id:
                query = query.where(ComponentTable.source_entity_id == source_entity_id)

            result = await session.execute(query)
            component = result.scalar_one_or_none()
            return self._component_to_dict(component) if component else None

    async def get_components(
        self,
        entity_id: UUID,
        world_id: UUID | None = None,
        source_entity_id: UUID | None = None,
    ) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            query = select(ComponentTable).where(ComponentTable.entity_id == entity_id)
            if world_id:
                query = query.where(ComponentTable.world_id == world_id)
            if source_entity_id:
                query = query.where(ComponentTable.source_entity_id == source_entity_id)

            result = await session.execute(query)
            components = result.scalars().all()
            return [self._component_to_dict(c) for c in components]

    async def create_component(self, component: dict[str, Any]) -> bool:
        async with self._get_session() as session:
            try:
                db_component = ComponentTable(
                    id=component.get("id") or uuid.uuid4(),
                    entity_id=component["entityId"],
                    agent_id=component["agentId"],
                    room_id=component["roomId"],
                    world_id=component["worldId"],
                    source_entity_id=component["sourceEntityId"],
                    type=component["type"],
                    data=component.get("data", {}),
                )
                session.add(db_component)
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    async def update_component(self, component: dict[str, Any]) -> None:
        async with self._get_session() as session:
            await session.execute(
                update(ComponentTable)
                .where(ComponentTable.id == component["id"])
                .values(data=component.get("data", {}))
            )
            await session.commit()

    async def delete_component(self, component_id: UUID) -> None:
        async with self._get_session() as session:
            await session.execute(delete(ComponentTable).where(ComponentTable.id == component_id))
            await session.commit()

    # Memory methods
    async def get_memories(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            query = select(MemoryTable)

            if "roomId" in params:
                query = query.where(MemoryTable.room_id == params["roomId"])
            if "entityId" in params:
                query = query.where(MemoryTable.entity_id == params["entityId"])
            if "agentId" in params:
                query = query.where(MemoryTable.agent_id == params["agentId"])
            if "unique" in params and params["unique"]:
                query = query.where(MemoryTable.unique)

            query = query.order_by(MemoryTable.created_at.desc())

            if "count" in params:
                query = query.limit(params["count"])
            if "offset" in params:
                query = query.offset(params["offset"])

            result = await session.execute(query)
            memories = result.scalars().all()
            return [self._memory_to_dict(m) for m in memories]

    async def get_memory_by_id(self, id: UUID) -> dict[str, Any] | None:
        async with self._get_session() as session:
            result = await session.execute(select(MemoryTable).where(MemoryTable.id == id))
            memory = result.scalar_one_or_none()
            return self._memory_to_dict(memory) if memory else None

    async def get_memories_by_ids(
        self, ids: list[UUID], table_name: str | None = None
    ) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            result = await session.execute(select(MemoryTable).where(MemoryTable.id.in_(ids)))
            memories = result.scalars().all()
            return [self._memory_to_dict(m) for m in memories]

    async def get_memories_by_room_ids(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            query = select(MemoryTable).where(MemoryTable.room_id.in_(params["roomIds"]))
            if "limit" in params:
                query = query.limit(params["limit"])

            result = await session.execute(query)
            memories = result.scalars().all()
            return [self._memory_to_dict(m) for m in memories]

    async def get_cached_embeddings(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        # This would require more complex implementation with vector search
        return []

    async def search_memories(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        # This would require pgvector or similar for production
        # For now, return empty - subclasses can override
        return []

    async def create_memory(
        self, memory: dict[str, Any], table_name: str, unique: bool = False
    ) -> UUID:
        async with self._get_session() as session:
            memory_id = memory.get("id") or uuid.uuid4()
            db_memory = MemoryTable(
                id=memory_id,
                entity_id=memory["entityId"],
                agent_id=memory.get("agentId"),
                room_id=memory["roomId"],
                world_id=memory.get("worldId"),
                content=memory["content"],
                unique=unique,
                memory_metadata=memory.get("metadata", {}),
            )
            session.add(db_memory)

            # If embedding is provided, store it
            if "embedding" in memory and memory["embedding"]:
                db_embedding = EmbeddingTable(
                    id=uuid.uuid4(),
                    memory_id=memory_id,
                    embedding=memory["embedding"],
                    dimension=len(memory["embedding"]),
                )
                session.add(db_embedding)

            await session.commit()
            return as_uuid(str(memory_id))

    async def update_memory(self, memory: dict[str, Any]) -> bool:
        async with self._get_session() as session:
            try:
                update_values: dict[str, Any] = {}
                if "content" in memory:
                    update_values["content"] = memory["content"]
                if "metadata" in memory:
                    update_values["memory_metadata"] = memory["metadata"]

                await session.execute(
                    update(MemoryTable)
                    .where(MemoryTable.id == memory["id"])
                    .values(**update_values)
                )
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    async def delete_memory(self, memory_id: UUID) -> None:
        async with self._get_session() as session:
            await session.execute(delete(MemoryTable).where(MemoryTable.id == memory_id))
            await session.commit()

    async def delete_many_memories(self, memory_ids: list[UUID]) -> None:
        async with self._get_session() as session:
            await session.execute(delete(MemoryTable).where(MemoryTable.id.in_(memory_ids)))
            await session.commit()

    async def delete_all_memories(self, room_id: UUID, table_name: str) -> None:
        async with self._get_session() as session:
            await session.execute(delete(MemoryTable).where(MemoryTable.room_id == room_id))
            await session.commit()

    async def count_memories(
        self, room_id: UUID, unique: bool = False, table_name: str | None = None
    ) -> int:
        async with self._get_session() as session:
            query = (
                select(func.count()).select_from(MemoryTable).where(MemoryTable.room_id == room_id)
            )
            if unique:
                query = query.where(MemoryTable.unique)

            result = await session.execute(query)
            return result.scalar() or 0

    # Logging methods
    async def log(self, params: dict[str, Any]) -> None:
        async with self._get_session() as session:
            db_log = LogTable(
                id=uuid.uuid4(),
                entity_id=params["entityId"],
                room_id=params.get("roomId"),
                type=params["type"],
                body=params["body"],
            )
            session.add(db_log)
            await session.commit()

    async def get_logs(self, params: dict[str, Any]) -> list[Log]:
        async with self._get_session() as session:
            query = select(LogTable)

            if "entityId" in params:
                query = query.where(LogTable.entity_id == params["entityId"])
            if "roomId" in params:
                query = query.where(LogTable.room_id == params["roomId"])
            if "type" in params:
                query = query.where(LogTable.type == params["type"])

            query = query.order_by(LogTable.created_at.desc())

            if "count" in params:
                query = query.limit(params["count"])
            if "offset" in params:
                query = query.offset(params["offset"])

            result = await session.execute(query)
            logs = result.scalars().all()
            return [self._log_to_model(log) for log in logs]

    async def delete_log(self, log_id: UUID) -> None:
        async with self._get_session() as session:
            await session.execute(delete(LogTable).where(LogTable.id == log_id))
            await session.commit()

    # World methods
    async def create_world(self, world: dict[str, Any]) -> UUID:
        async with self._get_session() as session:
            world_id = world.get("id") or uuid.uuid4()
            db_world = WorldTable(
                id=world_id,
                name=world.get("name"),
                agent_id=world["agentId"],
                message_server_id=world.get("messageServerId"),
                world_metadata=world.get("metadata", {}),
            )
            session.add(db_world)
            await session.commit()
            return as_uuid(str(world_id))

    async def get_world(self, id: UUID) -> dict[str, Any] | None:
        async with self._get_session() as session:
            result = await session.execute(select(WorldTable).where(WorldTable.id == id))
            world = result.scalar_one_or_none()
            return self._world_to_dict(world) if world else None

    async def remove_world(self, id: UUID) -> None:
        async with self._get_session() as session:
            await session.execute(delete(WorldTable).where(WorldTable.id == id))
            await session.commit()

    async def get_all_worlds(self) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            result = await session.execute(select(WorldTable))
            worlds = result.scalars().all()
            return [self._world_to_dict(w) for w in worlds]

    async def update_world(self, world: dict[str, Any]) -> None:
        async with self._get_session() as session:
            await session.execute(
                update(WorldTable)
                .where(WorldTable.id == world["id"])
                .values(
                    name=world.get("name"),
                    world_metadata=world.get("metadata"),
                )
            )
            await session.commit()

    # Room methods
    async def get_rooms_by_ids(self, room_ids: list[UUID]) -> list[dict[str, Any]] | None:
        async with self._get_session() as session:
            result = await session.execute(select(RoomTable).where(RoomTable.id.in_(room_ids)))
            rooms = result.scalars().all()
            return [self._room_to_dict(r) for r in rooms] if rooms else None

    async def create_rooms(self, rooms: list[dict[str, Any]]) -> list[UUID]:
        async with self._get_session() as session:
            created_ids: list[UUID] = []
            for room in rooms:
                room_id = room.get("id") or uuid.uuid4()
                db_room = RoomTable(
                    id=room_id,
                    name=room.get("name"),
                    agent_id=room.get("agentId"),
                    source=room["source"],
                    type=room["type"],
                    channel_id=room.get("channelId"),
                    message_server_id=room.get("messageServerId"),
                    world_id=room.get("worldId"),
                    room_metadata=room.get("metadata", {}),
                )
                session.add(db_room)
                created_ids.append(as_uuid(str(room_id)))
            await session.commit()
            return created_ids

    async def delete_room(self, room_id: UUID) -> None:
        async with self._get_session() as session:
            await session.execute(delete(RoomTable).where(RoomTable.id == room_id))
            await session.commit()

    async def delete_rooms_by_world_id(self, world_id: UUID) -> None:
        async with self._get_session() as session:
            await session.execute(delete(RoomTable).where(RoomTable.world_id == world_id))
            await session.commit()

    async def update_room(self, room: dict[str, Any]) -> None:
        async with self._get_session() as session:
            await session.execute(
                update(RoomTable)
                .where(RoomTable.id == room["id"])
                .values(
                    name=room.get("name"),
                    room_metadata=room.get("metadata"),
                )
            )
            await session.commit()

    # Participant methods
    async def get_rooms_for_participant(self, entity_id: UUID) -> list[UUID]:
        async with self._get_session() as session:
            result = await session.execute(
                select(ParticipantTable.room_id).where(ParticipantTable.entity_id == entity_id)
            )
            return [as_uuid(str(r[0])) for r in result.fetchall()]

    async def get_rooms_for_participants(self, user_ids: list[UUID]) -> list[UUID]:
        async with self._get_session() as session:
            result = await session.execute(
                select(ParticipantTable.room_id).where(ParticipantTable.entity_id.in_(user_ids))
            )
            return list({as_uuid(str(r[0])) for r in result.fetchall()})

    async def get_rooms_by_world(self, world_id: UUID) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            result = await session.execute(select(RoomTable).where(RoomTable.world_id == world_id))
            rooms = result.scalars().all()
            return [self._room_to_dict(r) for r in rooms]

    async def remove_participant(self, entity_id: UUID, room_id: UUID) -> bool:
        async with self._get_session() as session:
            try:
                await session.execute(
                    delete(ParticipantTable).where(
                        and_(
                            ParticipantTable.entity_id == entity_id,
                            ParticipantTable.room_id == room_id,
                        )
                    )
                )
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    async def get_participants_for_entity(self, entity_id: UUID) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            result = await session.execute(
                select(ParticipantTable).where(ParticipantTable.entity_id == entity_id)
            )
            participants = result.scalars().all()
            return [self._participant_to_dict(p) for p in participants]

    async def get_participants_for_room(self, room_id: UUID) -> list[UUID]:
        async with self._get_session() as session:
            result = await session.execute(
                select(ParticipantTable.entity_id).where(ParticipantTable.room_id == room_id)
            )
            return [as_uuid(str(r[0])) for r in result.fetchall()]

    async def is_room_participant(self, room_id: UUID, entity_id: UUID) -> bool:
        async with self._get_session() as session:
            result = await session.execute(
                select(func.count())
                .select_from(ParticipantTable)
                .where(
                    and_(
                        ParticipantTable.room_id == room_id,
                        ParticipantTable.entity_id == entity_id,
                    )
                )
            )
            return (result.scalar() or 0) > 0

    async def add_participants_room(self, entity_ids: list[UUID], room_id: UUID) -> bool:
        async with self._get_session() as session:
            try:
                for entity_id in entity_ids:
                    participant = ParticipantTable(
                        id=uuid.uuid4(),
                        entity_id=entity_id,
                        room_id=room_id,
                    )
                    session.add(participant)
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    async def get_participant_user_state(self, room_id: UUID, entity_id: UUID) -> str | None:
        async with self._get_session() as session:
            result = await session.execute(
                select(ParticipantTable.user_state).where(
                    and_(
                        ParticipantTable.room_id == room_id,
                        ParticipantTable.entity_id == entity_id,
                    )
                )
            )
            row = result.first()
            return row[0] if row else None

    async def set_participant_user_state(
        self, room_id: UUID, entity_id: UUID, state: str | None
    ) -> None:
        async with self._get_session() as session:
            await session.execute(
                update(ParticipantTable)
                .where(
                    and_(
                        ParticipantTable.room_id == room_id,
                        ParticipantTable.entity_id == entity_id,
                    )
                )
                .values(user_state=state)
            )
            await session.commit()

    # Relationship methods
    async def create_relationship(self, params: dict[str, Any]) -> bool:
        async with self._get_session() as session:
            try:
                db_relationship = RelationshipTable(
                    id=uuid.uuid4(),
                    source_entity_id=params["sourceEntityId"],
                    target_entity_id=params["targetEntityId"],
                    agent_id=self._agent_id,
                    tags=params.get("tags", []),
                    relationship_metadata=params.get("metadata", {}),
                )
                session.add(db_relationship)
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    async def update_relationship(self, relationship: dict[str, Any]) -> None:
        async with self._get_session() as session:
            await session.execute(
                update(RelationshipTable)
                .where(RelationshipTable.id == relationship["id"])
                .values(
                    tags=relationship.get("tags", []),
                    relationship_metadata=relationship.get("metadata", {}),
                )
            )
            await session.commit()

    async def get_relationship(self, params: dict[str, Any]) -> dict[str, Any] | None:
        async with self._get_session() as session:
            result = await session.execute(
                select(RelationshipTable).where(
                    and_(
                        RelationshipTable.source_entity_id == params["sourceEntityId"],
                        RelationshipTable.target_entity_id == params["targetEntityId"],
                    )
                )
            )
            relationship = result.scalar_one_or_none()
            return self._relationship_to_dict(relationship) if relationship else None

    async def get_relationships(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            query = select(RelationshipTable).where(
                or_(
                    RelationshipTable.source_entity_id == params["entityId"],
                    RelationshipTable.target_entity_id == params["entityId"],
                )
            )
            if "tags" in params and params["tags"]:
                # Filter by tags - this requires array overlap
                query = query.where(RelationshipTable.tags.overlap(params["tags"]))

            result = await session.execute(query)
            relationships = result.scalars().all()
            return [self._relationship_to_dict(r) for r in relationships]

    # Cache methods
    async def get_cache(self, key: str) -> Any | None:
        async with self._get_session() as session:
            result = await session.execute(select(CacheTable).where(CacheTable.key == key))
            cache_entry = result.scalar_one_or_none()
            if cache_entry:
                if cache_entry.expires_at and cache_entry.expires_at < datetime.now(UTC):
                    await self.delete_cache(key)
                    return None
                return cache_entry.value
            return None

    async def set_cache(self, key: str, value: Any) -> bool:
        async with self._get_session() as session:
            try:
                # Try to update existing
                result = await session.execute(select(CacheTable).where(CacheTable.key == key))
                existing = result.scalar_one_or_none()
                if existing:
                    await session.execute(
                        update(CacheTable).where(CacheTable.key == key).values(value=value)
                    )
                else:
                    cache_entry = CacheTable(key=key, value=value)
                    session.add(cache_entry)
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    async def delete_cache(self, key: str) -> bool:
        async with self._get_session() as session:
            try:
                await session.execute(delete(CacheTable).where(CacheTable.key == key))
                await session.commit()
                return True
            except Exception:
                await session.rollback()
                return False

    # Task methods
    async def create_task(self, task: dict[str, Any]) -> UUID:
        async with self._get_session() as session:
            task_id = task.get("id") or uuid.uuid4()
            db_task = TaskTable(
                id=task_id,
                name=task["name"],
                description=task.get("description"),
                room_id=task.get("roomId"),
                entity_id=task.get("entityId"),
                world_id=task.get("worldId"),
                status=task.get("status", "pending"),
                task_tags=task.get("tags", []),
                task_metadata=task.get("metadata", {}),
            )
            session.add(db_task)
            await session.commit()
            return as_uuid(str(task_id))

    async def get_tasks(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            query = select(TaskTable)

            if "roomId" in params:
                query = query.where(TaskTable.room_id == params["roomId"])
            if "entityId" in params:
                query = query.where(TaskTable.entity_id == params["entityId"])
            if "tags" in params and params["tags"]:
                query = query.where(TaskTable.task_tags.overlap(params["tags"]))

            result = await session.execute(query)
            tasks = result.scalars().all()
            return [self._task_to_dict(t) for t in tasks]

    async def get_task(self, id: UUID) -> dict[str, Any] | None:
        async with self._get_session() as session:
            result = await session.execute(select(TaskTable).where(TaskTable.id == id))
            task = result.scalar_one_or_none()
            return self._task_to_dict(task) if task else None

    async def get_tasks_by_name(self, name: str) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            result = await session.execute(select(TaskTable).where(TaskTable.name == name))
            tasks = result.scalars().all()
            return [self._task_to_dict(t) for t in tasks]

    async def update_task(self, id: UUID, task: dict[str, Any]) -> None:
        async with self._get_session() as session:
            update_values: dict[str, Any] = {}
            if "name" in task:
                update_values["name"] = task["name"]
            if "description" in task:
                update_values["description"] = task["description"]
            if "roomId" in task:
                update_values["room_id"] = task["roomId"]
            if "entityId" in task:
                update_values["entity_id"] = task["entityId"]
            if "worldId" in task:
                update_values["world_id"] = task["worldId"]
            if "status" in task:
                update_values["status"] = task["status"]
            if "metadata" in task:
                update_values["task_metadata"] = task["metadata"]
            if "tags" in task:
                update_values["task_tags"] = task["tags"]

            await session.execute(
                update(TaskTable).where(TaskTable.id == id).values(**update_values)
            )
            await session.commit()

    async def delete_task(self, id: UUID) -> None:
        async with self._get_session() as session:
            await session.execute(delete(TaskTable).where(TaskTable.id == id))
            await session.commit()

    async def get_memories_by_world_id(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        async with self._get_session() as session:
            query = select(MemoryTable).where(MemoryTable.world_id == params["worldId"])
            if "count" in params:
                query = query.limit(params["count"])

            result = await session.execute(query)
            memories = result.scalars().all()
            return [self._memory_to_dict(m) for m in memories]

    # Helper methods for type conversion
    def _agent_to_dict(self, agent: AgentTable) -> dict[str, Any]:
        return {
            "id": str(agent.id),
            "name": agent.name,
            "username": agent.username,
            "bio": agent.bio,
            "system": agent.system,
            "settings": agent.settings,
            "secrets": agent.secrets,
            "enabled": agent.enabled,
            "status": agent.status,
            "createdAt": int(agent.created_at.timestamp() * 1000),
            "updatedAt": int(agent.updated_at.timestamp() * 1000),
        }

    def _entity_to_dict(self, entity: EntityTable) -> dict[str, Any]:
        return {
            "id": str(entity.id),
            "agentId": str(entity.agent_id),
            "names": entity.names,
            "metadata": entity.entity_metadata,
        }

    def _component_to_dict(self, component: ComponentTable) -> dict[str, Any]:
        return {
            "id": str(component.id),
            "entityId": str(component.entity_id),
            "agentId": str(component.agent_id),
            "roomId": str(component.room_id),
            "worldId": str(component.world_id),
            "sourceEntityId": str(component.source_entity_id),
            "type": component.type,
            "data": component.data,
            "createdAt": int(component.created_at.timestamp() * 1000),
        }

    def _world_to_dict(self, world: WorldTable) -> dict[str, Any]:
        return {
            "id": str(world.id),
            "name": world.name,
            "agentId": str(world.agent_id),
            "messageServerId": str(world.message_server_id) if world.message_server_id else None,
            "metadata": world.world_metadata,
        }

    def _room_to_dict(self, room: RoomTable) -> dict[str, Any]:
        return {
            "id": str(room.id),
            "name": room.name,
            "agentId": str(room.agent_id) if room.agent_id else None,
            "source": room.source,
            "type": room.type,
            "channelId": room.channel_id,
            "messageServerId": str(room.message_server_id) if room.message_server_id else None,
            "worldId": str(room.world_id) if room.world_id else None,
            "metadata": room.room_metadata,
        }

    def _memory_to_dict(self, memory: MemoryTable) -> dict[str, Any]:
        return {
            "id": str(memory.id),
            "entityId": str(memory.entity_id),
            "agentId": str(memory.agent_id) if memory.agent_id else None,
            "roomId": str(memory.room_id),
            "worldId": str(memory.world_id) if memory.world_id else None,
            "content": memory.content,
            "unique": memory.unique,
            "metadata": memory.memory_metadata,
            "createdAt": int(memory.created_at.timestamp() * 1000),
        }

    def _participant_to_dict(self, participant: ParticipantTable) -> dict[str, Any]:
        return {
            "id": str(participant.id),
            "entityId": str(participant.entity_id),
            "roomId": str(participant.room_id),
            "userState": participant.user_state,
        }

    def _relationship_to_dict(self, relationship: RelationshipTable) -> dict[str, Any]:
        return {
            "id": str(relationship.id),
            "sourceEntityId": str(relationship.source_entity_id),
            "targetEntityId": str(relationship.target_entity_id),
            "agentId": str(relationship.agent_id),
            "tags": relationship.tags,
            "metadata": relationship.relationship_metadata,
            "createdAt": relationship.created_at.isoformat() if relationship.created_at else None,
        }

    def _task_to_dict(self, task: TaskTable) -> dict[str, Any]:
        return {
            "id": str(task.id),
            "name": task.name,
            "description": task.description,
            "roomId": str(task.room_id) if task.room_id else None,
            "entityId": str(task.entity_id) if task.entity_id else None,
            "worldId": str(task.world_id) if task.world_id else None,
            "status": task.status,
            "tags": task.task_tags,
            "metadata": task.task_metadata,
            "createdAt": int(task.created_at.timestamp() * 1000),
            "updatedAt": int(task.updated_at.timestamp() * 1000),
        }

    def _log_to_model(self, log: LogTable) -> Log:
        from elizaos.types import BaseLogBody
        from elizaos.types import Log as LogModel

        return LogModel(
            id=as_uuid(str(log.id)),
            entityId=as_uuid(str(log.entity_id)),
            roomId=as_uuid(str(log.room_id)) if log.room_id else None,
            type=str(log.type),
            body=BaseLogBody(**log.body) if log.body else BaseLogBody(),
            createdAt=int(log.created_at.timestamp() * 1000),
        )
