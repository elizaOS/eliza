"""Memory Service - Manages short-term and long-term memory."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Protocol, Optional
from uuid import UUID, uuid4

from elizaos_plugin_memory.types import (
    LongTermMemory,
    LongTermMemoryCategory,
    MemoryConfig,
    SessionSummary,
)

logger = logging.getLogger(__name__)


class DatabaseAdapter(Protocol):
    """Protocol for database operations."""

    async def insert(self, table: str, data: dict[str, object]) -> None:
        """Insert a record into the database."""
        ...

    async def select(
        self,
        table: str,
        conditions: dict[str, object],
        order_by: Optional[list[tuple[str, str]]] = None,
        limit: Optional[int] = None,
    ) -> list[dict[str, object]]:
        """Select records from the database."""
        ...

    async def update(
        self, table: str, data: dict[str, object], conditions: dict[str, object]
    ) -> None:
        """Update records in the database."""
        ...

    async def delete(self, table: str, conditions: dict[str, object]) -> None:
        """Delete records from the database."""
        ...


class CacheAdapter(Protocol):
    """Protocol for cache operations."""

    async def get(self, key: str) -> Optional[object]:
        """Get a value from cache."""
        ...

    async def set(self, key: str, value: object) -> None:
        """Set a value in cache."""
        ...


class MemoryService:
    """
    Memory Service.

    Manages both short-term (session summaries) and long-term (persistent facts) memory.
    """

    service_type: str = "memory"
    capability_description: str = (
        "Advanced memory management with short-term summarization and long-term persistent facts"
    )

    def __init__(
        self,
        config: Optional[MemoryConfig] = None,
        agent_id: Optional[UUID] = None,
        db: Optional[DatabaseAdapter] = None,
        cache: Optional[CacheAdapter] = None,
    ) -> None:
        """Initialize the memory service."""
        self.config = config or MemoryConfig()
        self.agent_id = agent_id
        self._db = db
        self._cache = cache
        self._session_message_counts: dict[UUID, int] = {}
        self._last_extraction_checkpoints: dict[str, int] = {}

    async def initialize(self, settings: dict[str, str]) -> None:
        """Initialize service from runtime settings."""
        if threshold := settings.get("MEMORY_SUMMARIZATION_THRESHOLD"):
            self.config.short_term_summarization_threshold = int(threshold)

        if retain := settings.get("MEMORY_RETAIN_RECENT"):
            self.config.short_term_retain_recent = int(retain)

        if interval := settings.get("MEMORY_SUMMARIZATION_INTERVAL"):
            self.config.short_term_summarization_interval = int(interval)

        if max_new := settings.get("MEMORY_MAX_NEW_MESSAGES"):
            self.config.summary_max_new_messages = int(max_new)

        long_term_enabled = settings.get("MEMORY_LONG_TERM_ENABLED")
        if long_term_enabled == "false":
            self.config.long_term_extraction_enabled = False
        elif long_term_enabled == "true":
            self.config.long_term_extraction_enabled = True

        if confidence := settings.get("MEMORY_CONFIDENCE_THRESHOLD"):
            self.config.long_term_confidence_threshold = float(confidence)

        if ext_threshold := settings.get("MEMORY_EXTRACTION_THRESHOLD"):
            self.config.long_term_extraction_threshold = int(ext_threshold)

        if ext_interval := settings.get("MEMORY_EXTRACTION_INTERVAL"):
            self.config.long_term_extraction_interval = int(ext_interval)

        logger.debug("MemoryService initialized with config: %s", self.config)

    async def stop(self) -> None:
        """Stop the service."""
        logger.info("MemoryService stopped")

    def get_config(self) -> MemoryConfig:
        """Get current configuration."""
        return MemoryConfig(
            short_term_summarization_threshold=self.config.short_term_summarization_threshold,
            short_term_retain_recent=self.config.short_term_retain_recent,
            short_term_summarization_interval=self.config.short_term_summarization_interval,
            long_term_extraction_enabled=self.config.long_term_extraction_enabled,
            long_term_vector_search_enabled=self.config.long_term_vector_search_enabled,
            long_term_confidence_threshold=self.config.long_term_confidence_threshold,
            long_term_extraction_threshold=self.config.long_term_extraction_threshold,
            long_term_extraction_interval=self.config.long_term_extraction_interval,
            summary_model_type=self.config.summary_model_type,
            summary_max_tokens=self.config.summary_max_tokens,
            summary_max_new_messages=self.config.summary_max_new_messages,
        )

    def update_config(self, **updates: object) -> None:
        """Update configuration."""
        for key, value in updates.items():
            if hasattr(self.config, key):
                setattr(self.config, key, value)

    def increment_message_count(self, room_id: UUID) -> int:
        """Increment and return message count for a room."""
        current = self._session_message_counts.get(room_id, 0)
        new_count = current + 1
        self._session_message_counts[room_id] = new_count
        return new_count

    def reset_message_count(self, room_id: UUID) -> None:
        """Reset message count for a room."""
        self._session_message_counts[room_id] = 0

    def _get_extraction_key(self, entity_id: UUID, room_id: UUID) -> str:
        """Generate cache key for extraction checkpoints."""
        return f"memory:extraction:{entity_id}:{room_id}"

    async def get_last_extraction_checkpoint(
        self, entity_id: UUID, room_id: UUID
    ) -> int:
        """Get the last extraction checkpoint for an entity in a room."""
        key = self._get_extraction_key(entity_id, room_id)

        if key in self._last_extraction_checkpoints:
            return self._last_extraction_checkpoints[key]

        if self._cache:
            try:
                checkpoint = await self._cache.get(key)
                message_count = int(checkpoint) if checkpoint else 0
                self._last_extraction_checkpoints[key] = message_count
                return message_count
            except Exception as e:
                logger.warning("Failed to get extraction checkpoint from cache: %s", e)

        return 0

    async def set_last_extraction_checkpoint(
        self, entity_id: UUID, room_id: UUID, message_count: int
    ) -> None:
        """Set the last extraction checkpoint for an entity in a room."""
        key = self._get_extraction_key(entity_id, room_id)
        self._last_extraction_checkpoints[key] = message_count

        if self._cache:
            try:
                await self._cache.set(key, message_count)
                logger.debug(
                    "Set extraction checkpoint for %s in room %s at count %d",
                    entity_id,
                    room_id,
                    message_count,
                )
            except Exception as e:
                logger.error("Failed to persist extraction checkpoint: %s", e)

    async def should_run_extraction(
        self, entity_id: UUID, room_id: UUID, current_message_count: int
    ) -> bool:
        """Check if long-term extraction should run."""
        threshold = self.config.long_term_extraction_threshold
        interval = self.config.long_term_extraction_interval

        if current_message_count < threshold:
            return False

        last_checkpoint = await self.get_last_extraction_checkpoint(entity_id, room_id)
        current_checkpoint = (current_message_count // interval) * interval
        should_run = current_message_count >= threshold and current_checkpoint > last_checkpoint

        logger.debug(
            "Extraction check: count=%d, threshold=%d, interval=%d, "
            "last_checkpoint=%d, current_checkpoint=%d, should_run=%s",
            current_message_count,
            threshold,
            interval,
            last_checkpoint,
            current_checkpoint,
            should_run,
        )

        return should_run

    async def store_long_term_memory(
        self,
        agent_id: UUID,
        entity_id: UUID,
        category: LongTermMemoryCategory,
        content: str,
        confidence: float = 1.0,
        source: Optional[str] = None,
        metadata: Optional[dict[str, object]] = None,
        embedding: Optional[list[float]] = None,
    ) -> LongTermMemory:
        """Store a long-term memory."""
        now = datetime.now()
        memory_id = uuid4()

        memory = LongTermMemory(
            id=memory_id,
            agent_id=agent_id,
            entity_id=entity_id,
            category=category,
            content=content,
            confidence=confidence,
            source=source,
            metadata=metadata or {},
            embedding=embedding,
            created_at=now,
            updated_at=now,
            access_count=0,
        )

        if self._db:
            await self._db.insert(
                "long_term_memories",
                {
                    "id": str(memory.id),
                    "agent_id": str(memory.agent_id),
                    "entity_id": str(memory.entity_id),
                    "category": memory.category.value,
                    "content": memory.content,
                    "metadata": memory.metadata,
                    "embedding": memory.embedding,
                    "confidence": memory.confidence,
                    "source": memory.source,
                    "access_count": memory.access_count,
                    "created_at": now,
                    "updated_at": now,
                },
            )

        logger.info("Stored long-term memory: %s for entity %s", category, entity_id)
        return memory

    async def get_long_term_memories(
        self,
        entity_id: UUID,
        category: Optional[LongTermMemoryCategory] = None,
        limit: int = 10,
    ) -> list[LongTermMemory]:
        """Retrieve long-term memories for an entity."""
        if not self._db or not self.agent_id:
            return []

        conditions: dict[str, object] = {
            "agent_id": str(self.agent_id),
            "entity_id": str(entity_id),
        }

        if category:
            conditions["category"] = category.value

        results = await self._db.select(
            "long_term_memories",
            conditions,
            order_by=[("confidence", "desc"), ("updated_at", "desc")],
            limit=limit,
        )

        return [
            LongTermMemory(
                id=UUID(str(row["id"])),
                agent_id=UUID(str(row["agent_id"])),
                entity_id=UUID(str(row["entity_id"])),
                category=LongTermMemoryCategory(str(row["category"])),
                content=str(row["content"]),
                metadata=dict(row.get("metadata", {})) if row.get("metadata") else {},
                embedding=list(row["embedding"]) if row.get("embedding") else None,
                confidence=float(row.get("confidence", 1.0)),
                source=str(row["source"]) if row.get("source") else None,
                created_at=row["created_at"] if isinstance(row["created_at"], datetime) else datetime.now(),
                updated_at=row["updated_at"] if isinstance(row["updated_at"], datetime) else datetime.now(),
                last_accessed_at=row.get("last_accessed_at") if isinstance(row.get("last_accessed_at"), datetime) else None,
                access_count=int(row.get("access_count", 0)),
            )
            for row in results
        ]

    async def update_long_term_memory(
        self,
        memory_id: UUID,
        entity_id: UUID,
        **updates: object,
    ) -> None:
        """Update a long-term memory."""
        if not self._db or not self.agent_id:
            return

        update_data: dict[str, object] = {"updated_at": datetime.now()}

        for key in ["content", "metadata", "confidence", "embedding", "last_accessed_at", "access_count"]:
            if key in updates:
                update_data[key] = updates[key]

        await self._db.update(
            "long_term_memories",
            update_data,
            {
                "id": str(memory_id),
                "agent_id": str(self.agent_id),
                "entity_id": str(entity_id),
            },
        )

        logger.info("Updated long-term memory: %s for entity %s", memory_id, entity_id)

    async def delete_long_term_memory(self, memory_id: UUID, entity_id: UUID) -> None:
        """Delete a long-term memory."""
        if not self._db or not self.agent_id:
            return

        await self._db.delete(
            "long_term_memories",
            {
                "id": str(memory_id),
                "agent_id": str(self.agent_id),
                "entity_id": str(entity_id),
            },
        )

        logger.info("Deleted long-term memory: %s for entity %s", memory_id, entity_id)

    async def get_current_session_summary(
        self, room_id: UUID
    ) -> Optional[SessionSummary]:
        """Get the current session summary for a room."""
        if not self._db or not self.agent_id:
            return None

        results = await self._db.select(
            "session_summaries",
            {
                "agent_id": str(self.agent_id),
                "room_id": str(room_id),
            },
            order_by=[("updated_at", "desc")],
            limit=1,
        )

        if not results:
            return None

        row = results[0]
        return SessionSummary(
            id=UUID(str(row["id"])),
            agent_id=UUID(str(row["agent_id"])),
            room_id=UUID(str(row["room_id"])),
            entity_id=UUID(str(row["entity_id"])) if row.get("entity_id") else None,
            summary=str(row["summary"]),
            message_count=int(row["message_count"]),
            last_message_offset=int(row.get("last_message_offset", 0)),
            start_time=row["start_time"] if isinstance(row["start_time"], datetime) else datetime.now(),
            end_time=row["end_time"] if isinstance(row["end_time"], datetime) else datetime.now(),
            topics=list(row.get("topics", [])) if row.get("topics") else [],
            metadata=dict(row.get("metadata", {})) if row.get("metadata") else {},
            embedding=list(row["embedding"]) if row.get("embedding") else None,
            created_at=row["created_at"] if isinstance(row["created_at"], datetime) else datetime.now(),
            updated_at=row["updated_at"] if isinstance(row["updated_at"], datetime) else datetime.now(),
        )

    async def store_session_summary(
        self,
        agent_id: UUID,
        room_id: UUID,
        summary: str,
        message_count: int,
        last_message_offset: int,
        start_time: datetime,
        end_time: datetime,
        entity_id: Optional[UUID] = None,
        topics: Optional[list[str]] = None,
        metadata: Optional[dict[str, object]] = None,
        embedding: Optional[list[float]] = None,
    ) -> SessionSummary:
        """Store a session summary."""
        now = datetime.now()
        summary_id = uuid4()

        session_summary = SessionSummary(
            id=summary_id,
            agent_id=agent_id,
            room_id=room_id,
            entity_id=entity_id,
            summary=summary,
            message_count=message_count,
            last_message_offset=last_message_offset,
            start_time=start_time,
            end_time=end_time,
            topics=topics or [],
            metadata=metadata or {},
            embedding=embedding,
            created_at=now,
            updated_at=now,
        )

        if self._db:
            await self._db.insert(
                "session_summaries",
                {
                    "id": str(session_summary.id),
                    "agent_id": str(session_summary.agent_id),
                    "room_id": str(session_summary.room_id),
                    "entity_id": str(session_summary.entity_id) if session_summary.entity_id else None,
                    "summary": session_summary.summary,
                    "message_count": session_summary.message_count,
                    "last_message_offset": session_summary.last_message_offset,
                    "start_time": session_summary.start_time,
                    "end_time": session_summary.end_time,
                    "topics": session_summary.topics,
                    "metadata": session_summary.metadata,
                    "embedding": session_summary.embedding,
                    "created_at": now,
                    "updated_at": now,
                },
            )

        logger.info("Stored session summary for room %s", room_id)
        return session_summary

    async def update_session_summary(
        self,
        summary_id: UUID,
        room_id: UUID,
        **updates: object,
    ) -> None:
        """Update a session summary."""
        if not self._db or not self.agent_id:
            return

        update_data: dict[str, object] = {"updated_at": datetime.now()}

        for key in ["summary", "message_count", "last_message_offset", "end_time", "topics", "metadata", "embedding"]:
            if key in updates:
                update_data[key] = updates[key]

        await self._db.update(
            "session_summaries",
            update_data,
            {
                "id": str(summary_id),
                "agent_id": str(self.agent_id),
                "room_id": str(room_id),
            },
        )

        logger.info("Updated session summary: %s for room %s", summary_id, room_id)

    async def get_session_summaries(
        self, room_id: UUID, limit: int = 5
    ) -> list[SessionSummary]:
        """Get session summaries for a room."""
        if not self._db or not self.agent_id:
            return []

        results = await self._db.select(
            "session_summaries",
            {
                "agent_id": str(self.agent_id),
                "room_id": str(room_id),
            },
            order_by=[("updated_at", "desc")],
            limit=limit,
        )

        return [
            SessionSummary(
                id=UUID(str(row["id"])),
                agent_id=UUID(str(row["agent_id"])),
                room_id=UUID(str(row["room_id"])),
                entity_id=UUID(str(row["entity_id"])) if row.get("entity_id") else None,
                summary=str(row["summary"]),
                message_count=int(row["message_count"]),
                last_message_offset=int(row.get("last_message_offset", 0)),
                start_time=row["start_time"] if isinstance(row["start_time"], datetime) else datetime.now(),
                end_time=row["end_time"] if isinstance(row["end_time"], datetime) else datetime.now(),
                topics=list(row.get("topics", [])) if row.get("topics") else [],
                metadata=dict(row.get("metadata", {})) if row.get("metadata") else {},
                embedding=list(row["embedding"]) if row.get("embedding") else None,
                created_at=row["created_at"] if isinstance(row["created_at"], datetime) else datetime.now(),
                updated_at=row["updated_at"] if isinstance(row["updated_at"], datetime) else datetime.now(),
            )
            for row in results
        ]

    async def get_formatted_long_term_memories(self, entity_id: UUID) -> str:
        """Get all long-term memories formatted for context."""
        memories = await self.get_long_term_memories(entity_id, None, 20)

        if not memories:
            return ""

        grouped: dict[LongTermMemoryCategory, list[LongTermMemory]] = {}
        for memory in memories:
            if memory.category not in grouped:
                grouped[memory.category] = []
            grouped[memory.category].append(memory)

        sections: list[str] = []
        for category, category_memories in grouped.items():
            category_name = category.value.replace("_", " ").title()
            items = "\n".join(f"- {m.content}" for m in category_memories)
            sections.append(f"**{category_name}**:\n{items}")

        return "\n\n".join(sections)


