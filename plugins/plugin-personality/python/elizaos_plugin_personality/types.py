"""Type definitions for the personality/character evolution plugin."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class ModificationType(str, Enum):
    """Category of character modification."""

    BIO = "bio"
    STYLE = "style"
    TOPICS = "topics"
    ADJECTIVES = "adjectives"
    MESSAGE_EXAMPLES = "message_examples"
    LORE = "lore"
    SYSTEM = "system"


class ModificationSource(str, Enum):
    """Who initiated the modification."""

    USER = "user"
    SELF_REFLECTION = "self_reflection"
    EVOLUTION = "evolution"


class Confidence(BaseModel):
    """Clamped confidence value between 0 and 1."""

    value: float = Field(default=0.5, ge=0.0, le=1.0)

    @classmethod
    def of(cls, value: float) -> Confidence:
        return cls(value=max(0.0, min(1.0, value)))

    def meets_threshold(self, threshold: float) -> bool:
        return self.value >= threshold


class CharacterModification(BaseModel):
    """A proposed or applied character modification."""

    id: UUID = Field(default_factory=uuid4)
    agent_id: str
    modification_type: ModificationType
    source: ModificationSource
    field: str
    old_value: Any | None = None
    new_value: Any
    reason: str
    confidence: Confidence
    applied: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class EvolutionSuggestion(BaseModel):
    """An evolution suggestion extracted from conversation analysis."""

    id: UUID = Field(default_factory=uuid4)
    agent_id: str
    modification_type: ModificationType
    field: str
    suggested_value: Any
    reason: str
    confidence: Confidence
    conversation_context: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ValidationResult(BaseModel):
    """Validation result for a proposed modification."""

    is_safe: bool
    reason: str
    issues: list[str] = Field(default_factory=list)

    @classmethod
    def safe(cls) -> ValidationResult:
        return cls(is_safe=True, reason="Modification is safe")

    @classmethod
    def unsafe_with(cls, reason: str, issues: list[str]) -> ValidationResult:
        return cls(is_safe=False, reason=reason, issues=issues)


class PersonalityConfig(BaseModel):
    """Configuration for the personality plugin."""

    enable_auto_evolution: bool = True
    evolution_cooldown_ms: int = 300_000  # 5 minutes
    modification_confidence_threshold: float = 0.7
    max_bio_elements: int = 20
    max_topics: int = 50
    require_admin_approval: bool = False
    validate_modifications: bool = True
    max_backups: int = 10


class PersonalityStats(BaseModel):
    """Statistics for personality modifications."""

    total_modifications: int
    applied_modifications: int
    pending_suggestions: int
    last_evolution_at_ms: int
