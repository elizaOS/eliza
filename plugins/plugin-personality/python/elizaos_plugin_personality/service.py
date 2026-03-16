"""In-memory service for character modification tracking and validation."""

from __future__ import annotations

import json
from collections import deque
from uuid import UUID

from .types import (
    CharacterModification,
    EvolutionSuggestion,
    ModificationType,
    PersonalityConfig,
    PersonalityStats,
    ValidationResult,
)


class PersonalityService:
    """Manages character modifications, evolution suggestions, and safety validation."""

    def __init__(self, config: PersonalityConfig | None = None) -> None:
        self._config = config or PersonalityConfig()
        self._modifications: deque[CharacterModification] = deque(maxlen=1000)
        self._suggestions: deque[EvolutionSuggestion] = deque(maxlen=500)
        self._last_evolution_at_ms: int = 0

    @property
    def config(self) -> PersonalityConfig:
        return self._config

    def record_modification(self, modification: CharacterModification) -> None:
        """Record a character modification (applied or proposed)."""
        self._modifications.append(modification)

    def record_suggestion(self, suggestion: EvolutionSuggestion) -> None:
        """Record an evolution suggestion."""
        self._suggestions.append(suggestion)

    def get_modifications(self, agent_id: str) -> list[CharacterModification]:
        """Get all modifications for an agent."""
        return [m for m in self._modifications if m.agent_id == agent_id]

    def get_pending_suggestions(self, agent_id: str) -> list[EvolutionSuggestion]:
        """Get pending suggestions for an agent."""
        return [s for s in self._suggestions if s.agent_id == agent_id]

    def can_evolve(self, now_ms: int) -> bool:
        """Check if evolution cooldown has elapsed."""
        if not self._config.enable_auto_evolution:
            return False
        # First evolution is always allowed
        if self._last_evolution_at_ms == 0:
            return True
        return (now_ms - self._last_evolution_at_ms) >= self._config.evolution_cooldown_ms

    def mark_evolution(self, now_ms: int) -> None:
        """Mark that evolution was performed."""
        self._last_evolution_at_ms = now_ms

    def validate_modification(self, modification: CharacterModification) -> ValidationResult:
        """Validate a proposed modification for safety."""
        issues: list[str] = []

        # Check confidence threshold
        if not modification.confidence.meets_threshold(
            self._config.modification_confidence_threshold
        ):
            issues.append(
                f"Confidence {modification.confidence.value:.2f} below "
                f"threshold {self._config.modification_confidence_threshold:.2f}"
            )

        # Check for XSS patterns
        value_str = json.dumps(modification.new_value) if modification.new_value is not None else ""
        if "<script" in value_str or "javascript:" in value_str:
            issues.append("Potential XSS content detected")

        # Check field-specific limits
        if modification.modification_type == ModificationType.BIO:
            if isinstance(modification.new_value, list):
                if len(modification.new_value) > self._config.max_bio_elements:
                    issues.append(
                        f"Bio has {len(modification.new_value)} elements, "
                        f"max is {self._config.max_bio_elements}"
                    )

        if modification.modification_type == ModificationType.TOPICS:
            if isinstance(modification.new_value, list):
                if len(modification.new_value) > self._config.max_topics:
                    issues.append(
                        f"Topics has {len(modification.new_value)} elements, "
                        f"max is {self._config.max_topics}"
                    )

        # Check string length
        if isinstance(modification.new_value, str) and len(modification.new_value) > 10_000:
            issues.append("Value exceeds maximum length (10000 chars)")

        if issues:
            return ValidationResult.unsafe_with("Modification failed validation", issues)
        return ValidationResult.safe()

    def mark_applied(self, modification_id: UUID) -> bool:
        """Mark a modification as applied."""
        for m in self._modifications:
            if m.id == modification_id:
                m.applied = True
                return True
        return False

    def stats(self, agent_id: str) -> PersonalityStats:
        """Get modification history stats."""
        mods = self.get_modifications(agent_id)
        applied = sum(1 for m in mods if m.applied)
        pending = sum(1 for s in self._suggestions if s.agent_id == agent_id)
        return PersonalityStats(
            total_modifications=len(mods),
            applied_modifications=applied,
            pending_suggestions=pending,
            last_evolution_at_ms=self._last_evolution_at_ms,
        )
