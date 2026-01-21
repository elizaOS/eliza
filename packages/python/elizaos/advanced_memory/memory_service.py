from __future__ import annotations

import heapq
import re
import time
from typing import cast
from uuid import UUID, uuid4

from elizaos.types.model import ModelType
from elizaos.types.primitives import string_to_uuid
from elizaos.types.service import Service

from .prompts import (
    INITIAL_SUMMARIZATION_TEMPLATE,
    LONG_TERM_EXTRACTION_TEMPLATE,
    UPDATE_SUMMARIZATION_TEMPLATE,
)
from .types import (
    LongTermMemory,
    LongTermMemoryCategory,
    MemoryConfig,
    MemoryExtraction,
    SessionSummary,
    SummaryResult,
)

_TABLE_SESSION_SUMMARY = "session_summary"
_TABLE_LONG_TERM_MEMORY = "long_term_memory"
_GLOBAL_LONG_TERM_ROOM_ID = string_to_uuid("advanced-memory:long-term")


def _parse_summary_xml(xml: str) -> SummaryResult:
    summary_match = re.search(r"<text>([\s\S]*?)</text>", xml)
    topics_match = re.search(r"<topics>([\s\S]*?)</topics>", xml)
    key_points_matches = re.findall(r"<point>([\s\S]*?)</point>", xml)

    summary = summary_match.group(1).strip() if summary_match else "Summary not available"
    topics = (
        [t.strip() for t in topics_match.group(1).split(",") if t.strip()] if topics_match else []
    )
    key_points = [p.strip() for p in key_points_matches]
    return SummaryResult(summary=summary, topics=topics, key_points=key_points)


def _parse_memory_extraction_xml(xml: str) -> list[MemoryExtraction]:
    pattern = (
        r"<memory>[\s\S]*?"
        r"<category>(.*?)</category>[\s\S]*?"
        r"<content>(.*?)</content>[\s\S]*?"
        r"<confidence>(.*?)</confidence>[\s\S]*?"
        r"</memory>"
    )
    out: list[MemoryExtraction] = []
    for match in re.finditer(pattern, xml):
        category_str = match.group(1).strip()
        content = match.group(2).strip()
        confidence_str = match.group(3).strip()

        try:
            category = LongTermMemoryCategory(category_str)
        except Exception:
            continue
        try:
            confidence = float(confidence_str)
        except Exception:
            continue
        if content:
            out.append(MemoryExtraction(category=category, content=content, confidence=confidence))
    return out


def _top_k_by_confidence(items: list[LongTermMemory], limit: int) -> list[LongTermMemory]:
    if limit <= 0 or not items:
        return []
    if len(items) <= limit:
        return sorted(items, key=lambda mm: mm.confidence, reverse=True)
    return heapq.nlargest(limit, items, key=lambda mm: mm.confidence)


class MemoryService(Service):
    service_type = "memory"

    def __init__(self, runtime=None) -> None:
        super().__init__(runtime=runtime)
        self._config: MemoryConfig = MemoryConfig()
        # Fallback storage for runtimes without a DB adapter (tests/benchmarks).
        self._session_summaries: dict[str, SessionSummary] = {}
        self._long_term: dict[str, list[LongTermMemory]] = {}
        self._extraction_checkpoints: dict[str, int] = {}

    @property
    def capability_description(self) -> str:
        return "Memory management with short-term summarization and long-term persistent facts"

    @classmethod
    async def start(cls, runtime):
        svc = cls(runtime=runtime)
        # read settings
        settings = runtime.character.settings or {}
        if (v := settings.get("MEMORY_SUMMARIZATION_THRESHOLD")) is not None and isinstance(
            v, (int, float, str)
        ):
            svc._config.short_term_summarization_threshold = int(v)
        if (v := settings.get("MEMORY_RETAIN_RECENT")) is not None and isinstance(
            v, (int, float, str)
        ):
            svc._config.short_term_retain_recent = int(v)
        if (v := settings.get("MEMORY_SUMMARIZATION_INTERVAL")) is not None and isinstance(
            v, (int, float, str)
        ):
            svc._config.short_term_summarization_interval = int(v)
        if (v := settings.get("MEMORY_MAX_NEW_MESSAGES")) is not None and isinstance(
            v, (int, float, str)
        ):
            svc._config.summary_max_new_messages = int(v)
        if (v := settings.get("MEMORY_LONG_TERM_ENABLED")) is not None:
            if str(v).lower() == "false":
                svc._config.long_term_extraction_enabled = False
            elif str(v).lower() == "true":
                svc._config.long_term_extraction_enabled = True
        if (v := settings.get("MEMORY_CONFIDENCE_THRESHOLD")) is not None and isinstance(
            v, (int, float, str)
        ):
            svc._config.long_term_confidence_threshold = float(v)
        if (v := settings.get("MEMORY_EXTRACTION_THRESHOLD")) is not None and isinstance(
            v, (int, float, str)
        ):
            svc._config.long_term_extraction_threshold = int(v)
        if (v := settings.get("MEMORY_EXTRACTION_INTERVAL")) is not None and isinstance(
            v, (int, float, str)
        ):
            svc._config.long_term_extraction_interval = int(v)

        runtime.logger.info("MemoryService started successfully", src="service:memory")
        return svc

    async def stop(self) -> None:
        self._session_summaries.clear()
        self._long_term.clear()
        self._extraction_checkpoints.clear()

    def get_config(self) -> MemoryConfig:
        return MemoryConfig(**self._config.__dict__)

    def _checkpoint_key(self, entity_id: UUID, room_id: UUID) -> str:
        return f"memory:extraction:{entity_id}:{room_id}"

    async def get_last_extraction_checkpoint(self, entity_id: UUID, room_id: UUID) -> int:
        runtime = self.runtime
        key = self._checkpoint_key(entity_id, room_id)
        if runtime is not None and getattr(runtime, "_adapter", None) is not None:
            cached = await runtime.get_cache(key)
            if cached is None:
                return 0
            try:
                if isinstance(cached, (int, float, str)):
                    return int(cached)
                return 0
            except Exception:
                return 0
        return int(self._extraction_checkpoints.get(key, 0))

    async def set_last_extraction_checkpoint(
        self, entity_id: UUID, room_id: UUID, message_count: int
    ) -> None:
        runtime = self.runtime
        key = self._checkpoint_key(entity_id, room_id)
        if runtime is not None and getattr(runtime, "_adapter", None) is not None:
            _ = await runtime.set_cache(key, int(message_count))
            return
        self._extraction_checkpoints[key] = int(message_count)

    async def should_run_extraction(
        self, entity_id: UUID, room_id: UUID, current_message_count: int
    ) -> bool:
        threshold = self._config.long_term_extraction_threshold
        interval = self._config.long_term_extraction_interval
        if current_message_count < threshold:
            return False
        last_cp = await self.get_last_extraction_checkpoint(entity_id, room_id)
        current_cp = (current_message_count // interval) * interval
        return current_cp > last_cp

    async def get_current_session_summary(self, room_id: UUID) -> SessionSummary | None:
        runtime = self.runtime
        if runtime is None:
            return None

        # Prefer DB-backed retrieval when available.
        if getattr(runtime, "_adapter", None) is not None:
            # Session summary is stored under the agent entity_id, scoped to the room.
            mems = await runtime.get_memories(
                {
                    "roomId": str(room_id),
                    "entityId": str(runtime.agent_id),
                    "agentId": str(runtime.agent_id),
                    "count": 10,
                }
            )
            for m in mems:
                if not isinstance(m, dict):
                    continue
                meta = m.get("metadata")
                if not isinstance(meta, dict):
                    meta = {}
                if meta.get("type") != _TABLE_SESSION_SUMMARY:
                    continue
                try:
                    return SessionSummary(
                        id=UUID(str(m.get("id"))),
                        agent_id=UUID(str(m.get("agentId") or runtime.agent_id)),
                        room_id=UUID(str(m.get("roomId") or room_id)),
                        entity_id=UUID(str(meta["entityId"])) if meta.get("entityId") else None,
                        summary=str((m.get("content") or {}).get("text") or ""),
                        message_count=int(meta.get("messageCount") or 0),
                        last_message_offset=int(meta.get("lastMessageOffset") or 0),
                        topics=[str(t) for t in (meta.get("topics") or [])],
                        metadata=dict(meta.get("metadata") or {}),
                    )
                except Exception:
                    # Best-effort; ignore corrupt rows.
                    continue

        return self._session_summaries.get(str(room_id))

    async def store_session_summary(
        self,
        agent_id: UUID,
        room_id: UUID,
        summary: str,
        message_count: int,
        last_message_offset: int,
        entity_id: UUID | None = None,
        topics: list[str] | None = None,
        metadata: dict[str, object] | None = None,
    ) -> SessionSummary:
        runtime = self.runtime
        s = SessionSummary(
            id=uuid4(),
            agent_id=agent_id,
            room_id=room_id,
            entity_id=entity_id,
            summary=summary,
            message_count=message_count,
            last_message_offset=last_message_offset,
            topics=topics or [],
            metadata=metadata or {},
        )

        if runtime is not None and getattr(runtime, "_adapter", None) is not None:
            existing = await self.get_current_session_summary(room_id)
            mem = {
                "id": str(existing.id) if existing else str(s.id),
                "entityId": str(runtime.agent_id),
                "agentId": str(runtime.agent_id),
                "roomId": str(room_id),
                "worldId": None,
                "content": {"text": summary},
                "metadata": {
                    "type": _TABLE_SESSION_SUMMARY,
                    "messageCount": int(message_count),
                    "lastMessageOffset": int(last_message_offset),
                    "topics": list(s.topics),
                    "entityId": str(entity_id) if entity_id else None,
                    "metadata": dict(s.metadata),
                },
            }
            if existing:
                _ = await runtime.update_memory(mem)
                return s
            _ = await runtime.create_memory(
                cast(dict[str, object], mem), _TABLE_SESSION_SUMMARY, unique=False
            )
            return s

        self._session_summaries[str(room_id)] = s
        return s

    async def update_session_summary(
        self, summary_id: UUID, room_id: UUID, **updates: object
    ) -> None:
        runtime = self.runtime
        if runtime is not None and getattr(runtime, "_adapter", None) is not None:
            existing = await self.get_current_session_summary(room_id)
            if not existing or existing.id != summary_id:
                return
            # Reuse store_session_summary to persist updated state.
            summary_text = (
                str(updates["summary"])
                if "summary" in updates and isinstance(updates["summary"], str)
                else existing.summary
            )
            msg_count_raw = updates.get("message_count")
            msg_count = (
                int(msg_count_raw)
                if isinstance(msg_count_raw, (int, float, str))
                else existing.message_count
            )
            last_off_raw = updates.get("last_message_offset")
            last_off = (
                int(last_off_raw)
                if isinstance(last_off_raw, (int, float, str))
                else existing.last_message_offset
            )
            topics = (
                [str(t) for t in updates["topics"]]
                if "topics" in updates and isinstance(updates["topics"], list)
                else existing.topics
            )
            meta = (
                {str(k): v for k, v in updates["metadata"].items()}
                if "metadata" in updates and isinstance(updates["metadata"], dict)
                else existing.metadata
            )
            await self.store_session_summary(
                agent_id=existing.agent_id,
                room_id=existing.room_id,
                summary=summary_text,
                message_count=msg_count,
                last_message_offset=last_off,
                entity_id=existing.entity_id,
                topics=topics,
                metadata=meta,
            )
            return

        existing = self._session_summaries.get(str(room_id))
        if not existing or existing.id != summary_id:
            return
        if "summary" in updates and isinstance(updates["summary"], str):
            existing.summary = updates["summary"]
        if "message_count" in updates and isinstance(updates["message_count"], (int, float, str)):
            existing.message_count = int(updates["message_count"])
        if "last_message_offset" in updates and isinstance(
            updates["last_message_offset"], (int, float, str)
        ):
            existing.last_message_offset = int(updates["last_message_offset"])
        if "topics" in updates and isinstance(updates["topics"], list):
            existing.topics = [str(t) for t in updates["topics"]]
        if "metadata" in updates and isinstance(updates["metadata"], dict):
            existing.metadata = {str(k): v for k, v in updates["metadata"].items()}

    async def store_long_term_memory(
        self,
        agent_id: UUID,
        entity_id: UUID,
        category: LongTermMemoryCategory,
        content: str,
        confidence: float = 1.0,
        source: str | None = None,
        metadata: dict[str, object] | None = None,
    ) -> LongTermMemory:
        runtime = self.runtime
        m = LongTermMemory(
            id=uuid4(),
            agent_id=agent_id,
            entity_id=entity_id,
            category=category,
            content=content,
            confidence=float(confidence),
            source=source,
            metadata=metadata or {},
        )

        if runtime is not None and getattr(runtime, "_adapter", None) is not None:
            mem = {
                "id": str(m.id),
                "entityId": str(entity_id),
                "agentId": str(runtime.agent_id),
                "roomId": str(_GLOBAL_LONG_TERM_ROOM_ID),
                "worldId": None,
                "content": {"text": content},
                "metadata": {
                    "type": _TABLE_LONG_TERM_MEMORY,
                    "category": category.value,
                    "confidence": float(m.confidence),
                    "source": m.source,
                    "metadata": dict(m.metadata),
                },
            }
            _ = await runtime.create_memory(
                cast(dict[str, object], mem), _TABLE_LONG_TERM_MEMORY, unique=False
            )
            return m

        self._long_term.setdefault(str(entity_id), []).append(m)
        return m

    async def get_long_term_memories(
        self,
        entity_id: UUID,
        category: LongTermMemoryCategory | None = None,
        limit: int = 25,
    ) -> list[LongTermMemory]:
        if limit <= 0:
            return []
        runtime = self.runtime
        if runtime is not None and getattr(runtime, "_adapter", None) is not None:
            db_mems = await runtime.get_memories(
                {
                    "roomId": str(_GLOBAL_LONG_TERM_ROOM_ID),
                    "entityId": str(entity_id),
                    "agentId": str(runtime.agent_id),
                    "count": 200,
                }
            )
            out: list[LongTermMemory] = []
            for m in db_mems:
                if not isinstance(m, dict):
                    continue
                meta = m.get("metadata")
                if not isinstance(meta, dict):
                    meta = {}
                if meta.get("type") != _TABLE_LONG_TERM_MEMORY:
                    continue
                cat_raw = str(meta.get("category") or "")
                try:
                    cat = LongTermMemoryCategory(cat_raw)
                except Exception:
                    continue
                if category is not None and cat != category:
                    continue
                try:
                    out.append(
                        LongTermMemory(
                            id=UUID(str(m.get("id"))),
                            agent_id=UUID(str(m.get("agentId") or runtime.agent_id)),
                            entity_id=UUID(str(m.get("entityId") or entity_id)),
                            category=cat,
                            content=str((m.get("content") or {}).get("text") or ""),
                            confidence=float(meta.get("confidence") or 1.0),
                            source=str(meta.get("source"))
                            if meta.get("source") is not None
                            else None,
                            metadata=dict(meta.get("metadata") or {}),
                        )
                    )
                except Exception:
                    continue
            return _top_k_by_confidence(out, limit)

        local_mems = self._long_term.get(str(entity_id), [])
        if category is not None:
            local_mems = [m for m in local_mems if m.category == category]
        return _top_k_by_confidence(local_mems, limit)

    async def get_formatted_long_term_memories(self, entity_id: UUID) -> str:
        mems = await self.get_long_term_memories(entity_id, None, 20)
        if not mems:
            return ""
        grouped: dict[LongTermMemoryCategory, list[LongTermMemory]] = {}
        for m in mems:
            grouped.setdefault(m.category, []).append(m)
        sections: list[str] = []
        for cat, items in grouped.items():
            name = cat.value.replace("_", " ").title()
            sections.append(f"**{name}**:\n" + "\n".join(f"- {x.content}" for x in items))
        return "\n\n".join(sections)

    async def summarize_from_messages(
        self, room_id: UUID, agent_id: UUID, agent_name: str, messages: list[object]
    ) -> None:
        # `messages` is a list of elizaos Memory objects; we only use common fields.
        dialogue = []
        for m in messages:
            content = getattr(m, "content", None)
            text = getattr(content, "text", None)
            if not text:
                continue
            sender = agent_name if getattr(m, "entity_id", None) == agent_id else "User"
            dialogue.append(f"{sender}: {text}")
        if not dialogue:
            return

        existing = await self.get_current_session_summary(room_id)
        if existing:
            prompt = UPDATE_SUMMARIZATION_TEMPLATE.format(
                existing_summary=existing.summary,
                existing_topics=", ".join(existing.topics) if existing.topics else "None",
                new_messages="\n".join(dialogue[-self._config.summary_max_new_messages :]),
            )
        else:
            prompt = INITIAL_SUMMARIZATION_TEMPLATE.format(recent_messages="\n".join(dialogue))

        response = await self.runtime.use_model(
            ModelType.TEXT_LARGE,
            {"prompt": prompt, "temperature": 0.2, "maxTokens": self._config.summary_max_tokens},
        )
        parsed = _parse_summary_xml(str(response))
        if existing:
            await self.update_session_summary(
                existing.id,
                room_id,
                summary=parsed.summary,
                message_count=existing.message_count + len(dialogue),
                last_message_offset=existing.last_message_offset + len(dialogue),
                topics=parsed.topics,
                metadata={"keyPoints": parsed.key_points},
            )
        else:
            await self.store_session_summary(
                agent_id=agent_id,
                room_id=room_id,
                entity_id=None,
                summary=parsed.summary,
                message_count=len(dialogue),
                last_message_offset=len(dialogue),
                topics=parsed.topics,
                metadata={"keyPoints": parsed.key_points},
            )

    async def extract_long_term_from_messages(
        self,
        entity_id: UUID,
        room_id: UUID,
        agent_id: UUID,
        agent_name: str,
        messages: list[object],
    ) -> None:
        if not self._config.long_term_extraction_enabled:
            return
        formatted = []
        for m in messages:
            content = getattr(m, "content", None)
            text = getattr(content, "text", None)
            if not text:
                continue
            sender = agent_name if getattr(m, "entity_id", None) == agent_id else "User"
            formatted.append(f"{sender}: {text}")
        existing = await self.get_long_term_memories(entity_id, None, 30)
        existing_text = (
            "\n".join(
                f"[{m.category.value}] {m.content} (confidence: {m.confidence})" for m in existing
            )
            if existing
            else "None yet"
        )
        prompt = LONG_TERM_EXTRACTION_TEMPLATE.format(
            recent_messages="\n".join(formatted[-20:]),
            existing_memories=existing_text,
        )
        response = await self.runtime.use_model(
            ModelType.TEXT_LARGE, {"prompt": prompt, "temperature": 0.3, "maxTokens": 2000}
        )
        extractions = _parse_memory_extraction_xml(str(response))
        for ex in extractions:
            if ex.confidence >= max(self._config.long_term_confidence_threshold, 0.85):
                await self.store_long_term_memory(
                    agent_id=agent_id,
                    entity_id=entity_id,
                    category=ex.category,
                    content=ex.content,
                    confidence=ex.confidence,
                    source="conversation",
                    metadata={"roomId": str(room_id), "extractedAt": int(time.time() * 1000)},
                )
