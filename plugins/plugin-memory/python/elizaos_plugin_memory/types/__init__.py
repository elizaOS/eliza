"""Type definitions for the Memory Plugin."""

from enum import Enum
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from uuid import UUID


class LongTermMemoryCategory(str, Enum):
    """Categories of long-term memory based on cognitive science."""

    EPISODIC = "episodic"  # Specific events, experiences, and interactions
    SEMANTIC = "semantic"  # General facts, concepts, and knowledge
    PROCEDURAL = "procedural"  # Skills, workflows, and how-to knowledge


@dataclass
class LongTermMemory:
    """Long-term memory entry."""

    id: UUID
    agent_id: UUID
    entity_id: UUID
    category: LongTermMemoryCategory
    content: str
    created_at: datetime
    updated_at: datetime
    metadata: dict[str, object] = field(default_factory=dict)
    embedding: Optional[list[float]] = None
    confidence: float = 1.0
    source: Optional[str] = None
    last_accessed_at: Optional[datetime] = None
    access_count: int = 0
    similarity: Optional[float] = None


@dataclass
class SessionSummary:
    """Short-term memory session summary."""

    id: UUID
    agent_id: UUID
    room_id: UUID
    summary: str
    message_count: int
    last_message_offset: int
    start_time: datetime
    end_time: datetime
    created_at: datetime
    updated_at: datetime
    entity_id: Optional[UUID] = None
    topics: list[str] = field(default_factory=list)
    metadata: dict[str, object] = field(default_factory=dict)
    embedding: Optional[list[float]] = None


@dataclass
class MemoryConfig:
    """Configuration for memory plugin."""

    # Short-term memory settings
    short_term_summarization_threshold: int = 16
    short_term_retain_recent: int = 6
    short_term_summarization_interval: int = 10

    # Long-term memory settings
    long_term_extraction_enabled: bool = True
    long_term_vector_search_enabled: bool = False
    long_term_confidence_threshold: float = 0.85
    long_term_extraction_threshold: int = 30
    long_term_extraction_interval: int = 10

    # Summarization settings
    summary_model_type: str = "TEXT_LARGE"
    summary_max_tokens: int = 2500
    summary_max_new_messages: int = 20


@dataclass
class MemoryExtraction:
    """Memory extraction result from evaluator."""

    category: LongTermMemoryCategory
    content: str
    confidence: float
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass
class SummaryResult:
    """Summary generation result."""

    summary: str
    topics: list[str]
    key_points: list[str]


