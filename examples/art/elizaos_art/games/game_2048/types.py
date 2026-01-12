"""
Type definitions for the 2048 game.
"""

from dataclasses import dataclass, field
from enum import IntEnum
from typing import ClassVar

from elizaos_art.base import Action, State


class Game2048Action(IntEnum):
    """Actions available in 2048."""

    UP = 0
    DOWN = 1
    LEFT = 2
    RIGHT = 3

    @classmethod
    def from_string(cls, s: str) -> "Game2048Action":
        """Parse action from string."""
        s = s.strip().upper()
        mapping = {
            "UP": cls.UP,
            "U": cls.UP,
            "0": cls.UP,
            "DOWN": cls.DOWN,
            "D": cls.DOWN,
            "1": cls.DOWN,
            "LEFT": cls.LEFT,
            "L": cls.LEFT,
            "2": cls.LEFT,
            "RIGHT": cls.RIGHT,
            "R": cls.RIGHT,
            "3": cls.RIGHT,
        }
        if s in mapping:
            return mapping[s]
        raise ValueError(f"Invalid action: {s}")

    def to_arrow(self) -> str:
        """Convert to arrow symbol."""
        arrows = {
            Game2048Action.UP: "↑",
            Game2048Action.DOWN: "↓",
            Game2048Action.LEFT: "←",
            Game2048Action.RIGHT: "→",
        }
        return arrows[self]


@dataclass(frozen=True)
class Game2048State(State):
    """
    State of a 2048 game.

    The board is represented as a tuple of 16 integers (4x4 grid).
    Values are powers of 2 (0 means empty).
    """

    board: tuple[int, ...]  # 16 integers, row-major order
    score: int
    max_tile: int
    move_count: int
    game_over: bool = False

    # Class constants
    SIZE: ClassVar[int] = 4

    def __post_init__(self) -> None:
        """Validate board size."""
        if len(self.board) != self.SIZE * self.SIZE:
            raise ValueError(f"Board must have {self.SIZE * self.SIZE} cells")

    def get_cell(self, row: int, col: int) -> int:
        """Get value at (row, col)."""
        return self.board[row * self.SIZE + col]

    def to_prompt(self) -> str:
        """Convert state to prompt string."""
        lines = ["Current 2048 board:"]
        lines.append("```")
        for row in range(self.SIZE):
            row_values = []
            for col in range(self.SIZE):
                val = self.get_cell(row, col)
                row_values.append(str(val) if val > 0 else ".")
            lines.append(" ".join(f"{v:>4}" for v in row_values))
        lines.append("```")
        lines.append(f"Score: {self.score}")
        lines.append(f"Max tile: {self.max_tile}")
        lines.append(f"Moves: {self.move_count}")
        return "\n".join(lines)

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "board": list(self.board),
            "score": self.score,
            "max_tile": self.max_tile,
            "move_count": self.move_count,
            "game_over": self.game_over,
        }

    def is_terminal(self) -> bool:
        """Check if game is over."""
        return self.game_over

    def render(self) -> str:
        """Render board for display."""
        lines = []
        lines.append("┌" + "─────┬" * 3 + "─────┐")
        for row in range(self.SIZE):
            row_str = "│"
            for col in range(self.SIZE):
                val = self.get_cell(row, col)
                if val == 0:
                    row_str += "     │"
                else:
                    row_str += f"{val:^5}│"
            lines.append(row_str)
            if row < self.SIZE - 1:
                lines.append("├" + "─────┼" * 3 + "─────┤")
        lines.append("└" + "─────┴" * 3 + "─────┘")
        lines.append(f"Score: {self.score}  Max: {self.max_tile}  Moves: {self.move_count}")
        return "\n".join(lines)


@dataclass
class Game2048Config:
    """Configuration for 2048 game."""

    target_tile: int = 2048
    max_moves: int = 10000
    reward_type: str = "score"  # "score", "max_tile", "combined"
    spawn_4_probability: float = 0.1  # Probability of spawning 4 vs 2
