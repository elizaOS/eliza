"""
elizaOS Atropos TextWorld Environment

A TextWorld environment for training elizaOS agents using text-based games.
Includes integration with the Atropos RL framework for trajectory collection
and model training.
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
    Turn,
    Trajectory,
)
from elizaos_atropos_textworld.environment import TextWorldEnvironment
from elizaos_atropos_textworld.agent import (
    TextWorldAgent,
    ElizaOSAgent,
    create_heuristic_policy,
    create_random_policy,
)
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
    "Turn",
    "Trajectory",
    # Environment
    "TextWorldEnvironment",
    # Agents
    "TextWorldAgent",
    "ElizaOSAgent",
    "create_heuristic_policy",
    "create_random_policy",
    # Generator
    "GameGenerator",
]


def get_atropos_integration():
    """
    Lazy import for Atropos integration (requires atropos extras).
    
    Returns:
        Module with AtroposConfig, TrajectoryCollector, AtroposFormatter,
        generate_training_data, and create_atropos_env_class.
    
    Example:
        >>> atropos = get_atropos_integration()
        >>> config = atropos.AtroposConfig(use_elizaos=True)
        >>> data = await atropos.generate_training_data(100, config)
    """
    from elizaos_atropos_textworld import atropos_integration
    return atropos_integration
