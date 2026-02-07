from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from uuid import UUID


class LongTermMemoryCategory(str, Enum):
    EPISODIC = "episodic"
    SEMANTIC = "semantic"
    PROCEDURAL = "procedural"


@dataclass
class MemoryConfig:
    short_term_summarization_threshold: int = 16
    short_term_retain_recent: int = 6
    short_term_summarization_interval: int = 10
    long_term_extraction_enabled: bool = True
    long_term_vector_search_enabled: bool = False
    long_term_confidence_threshold: float = 0.85
    long_term_extraction_threshold: int = 30
    long_term_extraction_interval: int = 10
    summary_model_type: str = "TEXT_LARGE"
    summary_max_tokens: int = 2500
    summary_max_new_messages: int = 20


@dataclass
class LongTermMemory:
    id: UUID
    agent_id: UUID
    entity_id: UUID
    category: LongTermMemoryCategory
    content: str
    confidence: float = 1.0
    source: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class SessionSummary:
    id: UUID
    agent_id: UUID
    room_id: UUID
    entity_id: UUID | None
    summary: str
    message_count: int
    last_message_offset: int
    topics: list[str] = field(default_factory=list)
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class SummaryResult:
    summary: str
    topics: list[str]
    key_points: list[str]


@dataclass
class MemoryExtraction:
    category: LongTermMemoryCategory
    content: str
    confidence: float
