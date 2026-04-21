from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

# JSON type aliases matching TypeScript definitions
JsonPrimitive = str | int | float | bool | None
JsonValue = JsonPrimitive | list[Any] | dict[str, Any]
JsonObject = dict[str, JsonValue]


class ExperienceType(StrEnum):
    SUCCESS = "success"  # Agent accomplished something
    FAILURE = "failure"  # Agent failed at something
    DISCOVERY = "discovery"  # Agent discovered new information
    CORRECTION = "correction"  # Agent corrected a mistake
    LEARNING = "learning"  # Agent learned something new
    HYPOTHESIS = "hypothesis"  # Agent formed a hypothesis
    VALIDATION = "validation"  # Agent validated a hypothesis
    WARNING = "warning"  # Agent encountered a warning/limitation


class OutcomeType(StrEnum):
    POSITIVE = "positive"
    NEGATIVE = "negative"
    NEUTRAL = "neutral"
    MIXED = "mixed"


@dataclass
class Experience:
    id: str
    agent_id: str
    type: ExperienceType
    outcome: OutcomeType

    # Context and details
    context: str  # What was happening
    action: str  # What the agent tried to do
    result: str  # What actually happened
    learning: str  # What was learned

    # Categorization
    tags: list[str] = field(default_factory=list)
    domain: str = "general"  # Domain of experience (e.g., 'shell', 'coding', 'system')

    # Related experiences
    related_experiences: list[str] | None = None  # Links to related experiences
    supersedes: str | None = None  # If this experience updates/replaces another

    # Confidence and importance
    confidence: float = 0.5  # 0-1, how confident the agent is in this learning
    importance: float = 0.5  # 0-1, how important this experience is

    # Temporal information
    created_at: int = 0
    updated_at: int = 0
    last_accessed_at: int | None = None
    access_count: int = 0

    # For corrections
    previous_belief: str | None = None  # What the agent previously believed
    corrected_belief: str | None = None  # The corrected understanding

    # Memory integration
    embedding: list[float] | None = None  # For semantic search
    memory_ids: list[str] | None = None  # Related memory IDs


@dataclass
class ExperienceQuery:
    query: str | None = None  # Text query for semantic search
    type: ExperienceType | list[ExperienceType] | None = None
    outcome: OutcomeType | list[OutcomeType] | None = None
    domain: str | list[str] | None = None
    tags: list[str] | None = None
    min_importance: float | None = None
    min_confidence: float | None = None
    time_range_start: int | None = None
    time_range_end: int | None = None
    limit: int | None = None
    include_related: bool = False


@dataclass
class ExperienceAnalysis:
    pattern: str | None = None  # Detected pattern
    frequency: int | None = None  # How often this occurs
    reliability: float | None = None  # How reliable this knowledge is
    alternatives: list[str] = field(default_factory=list)  # Alternative approaches discovered
    recommendations: list[str] = field(default_factory=list)  # Recommendations based on experience


@dataclass
class ExperienceEvent:
    experience_id: str
    event_type: str  # "created" | "accessed" | "updated" | "superseded"
    timestamp: int
    metadata: JsonObject | None = None


@dataclass
class ExperienceMemory:
    """Extended memory with experience tracking fields."""

    experience_id: str
    experience_type: ExperienceType
