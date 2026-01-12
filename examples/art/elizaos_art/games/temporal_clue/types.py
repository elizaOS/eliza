"""
Type definitions for Temporal Clue puzzles.
"""

from dataclasses import dataclass, field
from enum import IntEnum

from elizaos_art.base import State


class Difficulty(IntEnum):
    """Puzzle difficulty levels."""

    EASY = 0      # 3-4 events, simple relations
    MEDIUM = 1    # 5-6 events, mixed relations
    HARD = 2      # 7-8 events, complex chains


class TemporalRelation(IntEnum):
    """Types of temporal relationships."""

    BEFORE = 0      # A happened before B
    AFTER = 1       # A happened after B
    SAME_TIME = 2   # A and B happened simultaneously
    JUST_BEFORE = 3 # A happened immediately before B
    JUST_AFTER = 4  # A happened immediately after B


@dataclass(frozen=True)
class TemporalClue:
    """A single temporal clue about events."""

    event_a: str
    relation: TemporalRelation
    event_b: str

    def to_natural_language(self) -> str:
        """Convert to natural language description."""
        templates = {
            TemporalRelation.BEFORE: f"{self.event_a} happened before {self.event_b}",
            TemporalRelation.AFTER: f"{self.event_a} happened after {self.event_b}",
            TemporalRelation.SAME_TIME: f"{self.event_a} happened at the same time as {self.event_b}",
            TemporalRelation.JUST_BEFORE: f"{self.event_a} happened immediately before {self.event_b}",
            TemporalRelation.JUST_AFTER: f"{self.event_a} happened immediately after {self.event_b}",
        }
        return templates[self.relation]


@dataclass
class TemporalCluePuzzle:
    """A complete temporal reasoning puzzle."""

    puzzle_id: str
    events: list[str]
    clues: list[TemporalClue]
    solution: list[str]  # Events in correct temporal order
    difficulty: Difficulty

    def to_dict(self) -> dict:
        return {
            "puzzle_id": self.puzzle_id,
            "events": self.events,
            "clues": [
                {
                    "event_a": c.event_a,
                    "relation": c.relation.name,
                    "event_b": c.event_b,
                }
                for c in self.clues
            ],
            "solution": self.solution,
            "difficulty": self.difficulty.name,
        }


class TemporalClueAction(IntEnum):
    """
    Actions represent placing events in order.
    Each action selects an event for the next position.
    """

    EVENT_0 = 0
    EVENT_1 = 1
    EVENT_2 = 2
    EVENT_3 = 3
    EVENT_4 = 4
    EVENT_5 = 5
    EVENT_6 = 6
    EVENT_7 = 7
    SUBMIT = 8  # Submit current ordering

    @classmethod
    def for_event_index(cls, idx: int) -> "TemporalClueAction":
        """Get action for event index."""
        if 0 <= idx <= 7:
            return cls(idx)
        raise ValueError(f"Invalid event index: {idx}")


@dataclass(frozen=True)
class TemporalClueState(State):
    """
    State of a Temporal Clue puzzle.

    The agent builds an ordering by placing events one at a time.
    """

    puzzle: TemporalCluePuzzle
    current_ordering: tuple[str, ...]  # Events placed so far (in order)
    remaining_events: tuple[str, ...]  # Events not yet placed
    attempts: int
    max_attempts: int
    game_over: bool
    solved: bool

    def to_prompt(self) -> str:
        """Convert to prompt string."""
        lines = ["=== TEMPORAL CLUE PUZZLE ==="]
        lines.append(f"Difficulty: {self.puzzle.difficulty.name}")
        lines.append("")

        lines.append("CLUES:")
        for i, clue in enumerate(self.puzzle.clues, 1):
            lines.append(f"  {i}. {clue.to_natural_language()}")

        lines.append("")
        lines.append("EVENTS to order (earliest to latest):")
        for event in self.puzzle.events:
            status = "✓" if event in self.current_ordering else "?"
            lines.append(f"  [{status}] {event}")

        lines.append("")
        if self.current_ordering:
            lines.append(f"Current ordering: {' → '.join(self.current_ordering)}")
        else:
            lines.append("Current ordering: (empty)")

        if self.remaining_events:
            lines.append(f"Remaining: {', '.join(self.remaining_events)}")

        lines.append(f"Attempts: {self.attempts}/{self.max_attempts}")

        return "\n".join(lines)

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "puzzle": self.puzzle.to_dict(),
            "current_ordering": list(self.current_ordering),
            "remaining_events": list(self.remaining_events),
            "attempts": self.attempts,
            "max_attempts": self.max_attempts,
            "game_over": self.game_over,
            "solved": self.solved,
        }

    def is_terminal(self) -> bool:
        return self.game_over

    def render(self) -> str:
        """Render for display."""
        return self.to_prompt()


@dataclass
class TemporalClueConfig:
    """Configuration for Temporal Clue puzzles."""

    difficulty: Difficulty = Difficulty.MEDIUM
    max_attempts: int = 3
    partial_credit: bool = True  # Give partial reward for partial ordering


# Event themes for puzzle generation
EVENT_THEMES: dict[str, list[str]] = {
    "daily_routine": [
        "Wake up",
        "Eat breakfast",
        "Take shower",
        "Get dressed",
        "Leave for work",
        "Arrive at office",
        "Have lunch",
        "Return home",
    ],
    "history": [
        "Roman Empire falls",
        "Columbus sails",
        "French Revolution",
        "Industrial Revolution",
        "World War I",
        "Moon landing",
        "Internet invented",
        "Smartphones appear",
    ],
    "cooking": [
        "Preheat oven",
        "Chop vegetables",
        "Mix ingredients",
        "Season the dish",
        "Put in oven",
        "Check temperature",
        "Remove from oven",
        "Let it cool",
    ],
    "project": [
        "Define requirements",
        "Create design",
        "Start development",
        "Run tests",
        "Fix bugs",
        "Deploy to staging",
        "User acceptance",
        "Release to production",
    ],
}
