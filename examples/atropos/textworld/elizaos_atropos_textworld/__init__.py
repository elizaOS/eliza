"""
ElizaOS Atropos TextWorld Environment

A TextWorld environment for training ElizaOS agents using text-based games.
"""

from elizaos_atropos_textworld.types import (
    GameType,
    Difficulty,
    GameState,
    StepResult,
    EpisodeResult,
    Room,
    Item,
    Container,
)
from elizaos_atropos_textworld.environment import TextWorldEnvironment
from elizaos_atropos_textworld.agent import TextWorldAgent
from elizaos_atropos_textworld.game_generator import GameGenerator

__version__ = "1.0.0"

__all__ = [
    # Types
    "GameType",
    "Difficulty",
    "GameState",
    "StepResult",
    "EpisodeResult",
    "Room",
    "Item",
    "Container",
    # Environment
    "TextWorldEnvironment",
    # Agent
    "TextWorldAgent",
    # Generator
    "GameGenerator",
]
