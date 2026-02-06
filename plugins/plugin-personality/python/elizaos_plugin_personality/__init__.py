"""Character evolution and self-modification plugin for elizaOS."""

from .service import PersonalityService
from .types import (
    CharacterModification,
    Confidence,
    EvolutionSuggestion,
    ModificationSource,
    ModificationType,
    PersonalityConfig,
    PersonalityStats,
    ValidationResult,
)

__all__ = [
    "PersonalityService",
    "CharacterModification",
    "Confidence",
    "EvolutionSuggestion",
    "ModificationSource",
    "ModificationType",
    "PersonalityConfig",
    "PersonalityStats",
    "ValidationResult",
]
