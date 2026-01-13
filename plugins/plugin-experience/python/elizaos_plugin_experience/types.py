from __future__ import annotations

from enum import Enum
from typing import TypeAlias

from pydantic import BaseModel, Field

# NOTE: Avoid recursive JsonValue aliases here to keep Pydantic schema generation reliable.
# Use a broad `object` value type for metadata-like fields.
JsonValue: TypeAlias = object


class ExperienceType(str, Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    DISCOVERY = "discovery"
    CORRECTION = "correction"
    LEARNING = "learning"
    HYPOTHESIS = "hypothesis"
    VALIDATION = "validation"
    WARNING = "warning"


class OutcomeType(str, Enum):
    POSITIVE = "positive"
    NEGATIVE = "negative"
    NEUTRAL = "neutral"
    MIXED = "mixed"


class Experience(BaseModel):
    id: str
    agent_id: str
    type: ExperienceType = ExperienceType.LEARNING
    outcome: OutcomeType = OutcomeType.NEUTRAL

    # Context and details
    context: str
    action: str
    result: str
    learning: str

    # Categorization
    tags: list[str] = Field(default_factory=list)
    domain: str = "general"

    # Related experiences
    related_experiences: list[str] | None = None
    supersedes: str | None = None

    # Confidence and importance
    confidence: float = 0.5
    importance: float = 0.5

    # Temporal information (unix ms)
    created_at: int
    updated_at: int
    last_accessed_at: int | None = None
    access_count: int = 0

    # For corrections
    previous_belief: str | None = None
    corrected_belief: str | None = None

    # Memory integration / similarity
    embedding: list[float] | None = None
    memory_ids: list[str] | None = None


class ExperienceTimeRange(BaseModel):
    start: int | None = None
    end: int | None = None


class ExperienceQuery(BaseModel):
    query: str | None = None
    type: ExperienceType | list[ExperienceType] | None = None
    outcome: OutcomeType | list[OutcomeType] | None = None
    domain: str | list[str] | None = None
    tags: list[str] | None = None
    min_importance: float | None = None
    min_confidence: float | None = None
    time_range: ExperienceTimeRange | None = None
    limit: int | None = None
    include_related: bool | None = None


class ExperienceAnalysis(BaseModel):
    pattern: str | None = None
    frequency: int | None = None
    reliability: float | None = None
    alternatives: list[str] | None = None
    recommendations: list[str] | None = None


class ExperienceEvent(BaseModel):
    experience_id: str
    event_type: str
    timestamp: int
    metadata: dict[str, JsonValue] | None = None
