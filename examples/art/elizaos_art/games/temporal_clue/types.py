"""
Type definitions for Temporal Clue puzzles.

Temporal Clue puzzles require reasoning about the order of events.
Given clues about which events happened before/after others,
determine the correct chronological ordering.
"""

from dataclasses import dataclass, field
from enum import IntEnum, Enum
from typing import ClassVar

from elizaos_art.base import Action, State


class Difficulty(Enum):
    """Puzzle difficulty levels."""

    EASY = "easy"  # 3-4 events, simple clues
    MEDIUM = "medium"  # 5-6 events, some transitive reasoning
    HARD = "hard"  # 7-8 events, complex relationships


class TemporalClueAction(IntEnum):
    """
    Actions for solving temporal clue puzzles.

    The action value represents the position (0-7) to place the next event.
    """

    POS_0 = 0
    POS_1 = 1
    POS_2 = 2
    POS_3 = 3
    POS_4 = 4
    POS_5 = 5
    POS_6 = 6
    POS_7 = 7
    SUBMIT = 8  # Submit current ordering as final answer

    @classmethod
    def from_position(cls, pos: int) -> "TemporalClueAction":
        """Create action from position."""
        if 0 <= pos <= 7:
            return cls(pos)
        raise ValueError(f"Invalid position: {pos}")


@dataclass
class TemporalClue:
    """A clue about temporal relationships."""

    event_a: str
    event_b: str
    relation: str  # "before", "after", "immediately_before", "immediately_after"

    def to_text(self) -> str:
        """Convert to human-readable text."""
        if self.relation == "before":
            return f"{self.event_a} happened before {self.event_b}"
        elif self.relation == "after":
            return f"{self.event_a} happened after {self.event_b}"
        elif self.relation == "immediately_before":
            return f"{self.event_a} happened immediately before {self.event_b}"
        elif self.relation == "immediately_after":
            return f"{self.event_a} happened immediately after {self.event_b}"
        return f"{self.event_a} {self.relation} {self.event_b}"


@dataclass(frozen=True)
class TemporalClueState(State):
    """
    State of a Temporal Clue puzzle.

    Events need to be arranged in chronological order based on clues.
    """

    events: tuple[str, ...]  # Events to order
    clues: tuple[TemporalClue, ...]  # Temporal clues
    current_ordering: tuple[str | None, ...]  # Current arrangement (None = empty slot)
    unplaced_events: tuple[str, ...]  # Events not yet placed
    correct_ordering: tuple[str, ...]  # The true ordering (hidden from player)
    submitted: bool = False
    is_correct: bool = False

    MAX_EVENTS: ClassVar[int] = 8

    def to_prompt(self) -> str:
        """Convert state to prompt string."""
        lines = ["# Temporal Clue Puzzle"]
        lines.append("")
        lines.append("Order these events chronologically based on the clues:")
        lines.append("")

        lines.append("## Events")
        for i, event in enumerate(self.events):
            lines.append(f"  {i + 1}. {event}")

        lines.append("")
        lines.append("## Clues")
        for clue in self.clues:
            lines.append(f"  - {clue.to_text()}")

        lines.append("")
        lines.append("## Current Ordering (earliest to latest)")
        lines.append("```")
        for i, event in enumerate(self.current_ordering):
            if event:
                lines.append(f"  {i + 1}. {event}")
            else:
                lines.append(f"  {i + 1}. [empty]")
        lines.append("```")

        if self.unplaced_events:
            lines.append("")
            lines.append(f"## Unplaced Events: {', '.join(self.unplaced_events)}")

        lines.append("")
        if self.unplaced_events:
            lines.append("Place the next event by selecting a position (0-7), or SUBMIT if done.")
        else:
            lines.append("All events placed. Use SUBMIT to check your answer.")

        return "\n".join(lines)

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "events": list(self.events),
            "clues": [
                {"event_a": c.event_a, "event_b": c.event_b, "relation": c.relation}
                for c in self.clues
            ],
            "current_ordering": [e if e else None for e in self.current_ordering],
            "unplaced_events": list(self.unplaced_events),
            "submitted": self.submitted,
            "is_correct": self.is_correct,
        }

    def is_terminal(self) -> bool:
        """Check if puzzle is complete."""
        return self.submitted

    def render(self) -> str:
        """Render puzzle for display."""
        lines = []
        lines.append("╔═══════════════════════════════════════════════╗")
        lines.append("║         TEMPORAL CLUE PUZZLE                  ║")
        lines.append("╠═══════════════════════════════════════════════╣")

        for clue in self.clues:
            text = clue.to_text()[:45]
            lines.append(f"║ • {text:<43} ║")

        lines.append("╠═══════════════════════════════════════════════╣")
        lines.append("║ Current Order (1=earliest):                   ║")

        for i, event in enumerate(self.current_ordering):
            if event:
                display = event[:40]
                lines.append(f"║   {i + 1}. {display:<40} ║")

        if self.unplaced_events:
            lines.append("╠═══════════════════════════════════════════════╣")
            lines.append("║ Unplaced:                                     ║")
            for event in self.unplaced_events:
                display = event[:43]
                lines.append(f"║   - {display:<41} ║")

        lines.append("╚═══════════════════════════════════════════════╝")

        if self.submitted:
            if self.is_correct:
                lines.append("✅ CORRECT!")
            else:
                lines.append("❌ INCORRECT")
                lines.append("Correct order was:")
                for i, event in enumerate(self.correct_ordering):
                    lines.append(f"  {i + 1}. {event}")

        return "\n".join(lines)


@dataclass
class TemporalClueConfig:
    """Configuration for Temporal Clue puzzles."""

    difficulty: Difficulty = Difficulty.MEDIUM
    num_events: int = 5  # Number of events to order
    custom_scenarios: list[dict] | None = None  # Custom puzzle scenarios


# Pre-defined puzzle scenarios
PUZZLE_SCENARIOS = {
    "morning_routine": {
        "events": [
            "Wake up",
            "Brush teeth",
            "Eat breakfast",
            "Get dressed",
            "Leave for work",
        ],
        "correct_order": [0, 3, 1, 2, 4],  # Wake, Dressed, Brush, Eat, Leave
    },
    "project_development": {
        "events": [
            "Gather requirements",
            "Design architecture",
            "Write code",
            "Run tests",
            "Deploy to production",
            "Monitor performance",
        ],
        "correct_order": [0, 1, 2, 3, 4, 5],
    },
    "cooking_dinner": {
        "events": [
            "Preheat oven",
            "Chop vegetables",
            "Season the meat",
            "Put dish in oven",
            "Set the table",
            "Serve dinner",
        ],
        "correct_order": [0, 1, 2, 3, 4, 5],
    },
    "historical_events": {
        "events": [
            "World War I ends",
            "Great Depression begins",
            "World War II begins",
            "Moon landing",
            "Internet created",
            "First iPhone",
        ],
        "correct_order": [0, 1, 2, 3, 4, 5],
    },
}
