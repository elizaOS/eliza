"""Personality capability -- character management and evolution.

Provides character modification, per-user preferences, character evolution
evaluation, and safe file management with backups.
"""

from .actions import modify_character_action
from .evaluators import character_evolution_evaluator
from .providers import user_personality_provider
from .services import CharacterFileManager
from .types import MAX_PREFS_PER_USER, PERSONALITY_SERVICE_TYPE, USER_PREFS_TABLE

__all__ = [
    # Action
    "modify_character_action",
    # Evaluator
    "character_evolution_evaluator",
    # Provider
    "user_personality_provider",
    # Service
    "CharacterFileManager",
    # Types / constants
    "MAX_PREFS_PER_USER",
    "PERSONALITY_SERVICE_TYPE",
    "USER_PREFS_TABLE",
]
