"""
Type definitions for the TextWorld environment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, TypeAlias


class GameType(str, Enum):
    """Types of TextWorld games."""

    TREASURE_HUNT = "treasure_hunt"
    COOKING = "cooking"
    COIN_COLLECTOR = "coin_collector"
    SIMPLE = "simple"


class Difficulty(str, Enum):
    """Game difficulty levels."""

    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


# Type aliases
Action: TypeAlias = str
Observation: TypeAlias = str
Reward: TypeAlias = float


@dataclass
class Item:
    """An item in the game world."""

    name: str
    description: str
    takeable: bool = True
    edible: bool = False
    cookable: bool = False
    is_goal: bool = False

    def __str__(self) -> str:
        return self.name


@dataclass
class Container:
    """A container that can hold items."""

    name: str
    description: str
    is_open: bool = False
    locked: bool = False
    key_name: str | None = None
    contents: list[Item] = field(default_factory=list)

    def __str__(self) -> str:
        state = "open" if self.is_open else "closed"
        return f"{self.name} ({state})"


@dataclass
class Room:
    """A room in the game world."""

    name: str
    description: str
    items: list[Item] = field(default_factory=list)
    containers: list[Container] = field(default_factory=list)
    exits: dict[str, str] = field(default_factory=dict)  # direction -> room_name

    def get_full_description(self) -> str:
        """Get full room description including items and exits."""
        parts = [self.description]

        if self.items:
            item_names = ", ".join(str(item) for item in self.items)
            parts.append(f"You can see: {item_names}.")

        if self.containers:
            for container in self.containers:
                parts.append(f"There is a {container}.")
                if container.is_open and container.contents:
                    contents = ", ".join(str(i) for i in container.contents)
                    parts.append(f"The {container.name} contains: {contents}.")

        if self.exits:
            exits_str = ", ".join(self.exits.keys())
            parts.append(f"Exits: {exits_str}.")

        return "\n".join(parts)


@dataclass
class GameState:
    """Current state of a TextWorld game."""

    description: str
    inventory: list[Item]
    current_room: str
    score: int
    max_score: int
    steps: int
    max_steps: int
    admissible_commands: list[str]
    game_over: bool = False
    won: bool = False

    @property
    def inventory_str(self) -> str:
        """Get inventory as string."""
        if not self.inventory:
            return "Your inventory is empty."
        items = ", ".join(str(item) for item in self.inventory)
        return f"You are carrying: {items}."


@dataclass
class StepResult:
    """Result of taking an action."""

    state: GameState
    reward: float
    done: bool
    feedback: str
    info: dict[str, object] = field(default_factory=dict)


@dataclass
class EpisodeResult:
    """Result of a complete episode."""

    score: int
    max_score: int
    steps: int
    max_steps: int
    won: bool
    actions_taken: list[str]

    @property
    def completion_rate(self) -> float:
        """Calculate completion rate."""
        if self.max_score == 0:
            return 0.0
        return self.score / self.max_score

    @property
    def efficiency(self) -> float:
        """Calculate action efficiency (score per step)."""
        if self.steps == 0:
            return 0.0
        return self.score / self.steps


@dataclass
class TrainingStats:
    """Statistics for training sessions."""

    episodes: int = 0
    wins: int = 0
    total_score: int = 0
    total_max_score: int = 0
    total_steps: int = 0

    @property
    def win_rate(self) -> float:
        """Calculate win rate."""
        if self.episodes == 0:
            return 0.0
        return self.wins / self.episodes

    @property
    def avg_completion(self) -> float:
        """Average completion rate."""
        if self.total_max_score == 0:
            return 0.0
        return self.total_score / self.total_max_score

    @property
    def avg_steps(self) -> float:
        """Average steps per episode."""
        if self.episodes == 0:
            return 0.0
        return self.total_steps / self.episodes

    def record_episode(self, result: EpisodeResult) -> None:
        """Record an episode result."""
        self.episodes += 1
        self.total_score += result.score
        self.total_max_score += result.max_score
        self.total_steps += result.steps
        if result.won:
            self.wins += 1

    def __str__(self) -> str:
        return (
            f"Episodes: {self.episodes} | "
            f"Win Rate: {self.win_rate:.1%} | "
            f"Avg Completion: {self.avg_completion:.1%} | "
            f"Avg Steps: {self.avg_steps:.1f}"
        )


# =============================================================================
# Atropos Integration Types
# =============================================================================
#
# These types bridge gameplay and RL training. They're separate from game types
# (GameState, StepResult) because they represent different concepts:
#
# - GameState: What the game engine knows (rooms, items, valid commands)
# - Trajectory: What the training system needs (conversation format, scores)
#
# WHY CONVERSATION FORMAT:
# Modern LLMs are trained on conversations (system/user/assistant turns).
# By representing gameplay as a conversation, we can:
# 1. Use standard chat model training techniques
# 2. Apply chat-specific tokenization (chat templates)
# 3. Transfer learning from pre-trained chat models


@dataclass
class Turn:
    """
    Single turn of gameplay for trajectory recording.
    
    WHY THESE ROLES:
    Chat models understand three roles:
    - "system": Instructions that set up the task (appears once at start)
    - "user": Input from the environment (game descriptions, what player sees)
    - "assistant": Model output (the actions we want to learn)
    
    WHY REWARD FIELD (currently unused):
    This field exists for future per-turn reward shaping. Currently we only
    use final trajectory scores, but per-turn rewards could enable:
    - Credit assignment (which specific action caused the win?)
    - Intermediate feedback (reward for finding items, not just winning)
    
    For now, it defaults to 0.0 and is ignored in scoring.
    """

    role: Literal["system", "user", "assistant"]
    content: str
    reward: float = 0.0  # Reserved for future per-turn reward shaping


@dataclass
class Trajectory:
    """
    Complete game trajectory for Atropos training.
    
    WHY THIS STRUCTURE:
    A trajectory is everything needed to create one training example:
    - turns: The conversation (system setup + alternating user/assistant)
    - final_score: Normalized outcome (0.0 = total failure, 1.0 = perfect)
    - won: Binary success flag (used for win_bonus in scoring)
    - steps: How many turns taken (used for efficiency scoring)
    - max_steps: Game's step limit (for normalizing efficiency)
    - agent_type: Which agent generated this (for analysis)
    - seed: Game seed (for reproducibility and GRPO grouping)
    
    WHY MUTABLE DEFAULTS:
    Using field(default_factory=list) instead of turns=[] because mutable
    defaults in dataclasses are shared across instances (Python gotcha).
    """

    turns: list[Turn] = field(default_factory=list)
    final_score: float = 0.0  # Normalized: score/max_score
    won: bool = False
    steps: int = 0
    max_steps: int = 100
    agent_type: str = "unknown"  # "elizaos", "heuristic", "random", etc.
    seed: int = 0  # Game seed for reproducibility
