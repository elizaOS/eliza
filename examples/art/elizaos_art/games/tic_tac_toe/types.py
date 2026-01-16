"""
Type definitions for Tic-Tac-Toe game.
"""

from dataclasses import dataclass
from enum import IntEnum
from typing import ClassVar

from elizaos_art.base import Action, State


class Player(IntEnum):
    """Players in Tic-Tac-Toe."""

    EMPTY = 0
    X = 1
    O = 2

    def __str__(self) -> str:
        if self == Player.EMPTY:
            return "."
        return self.name

    def opponent(self) -> "Player":
        """Get the opponent player."""
        if self == Player.X:
            return Player.O
        elif self == Player.O:
            return Player.X
        return Player.EMPTY


class TicTacToeAction(IntEnum):
    """
    Actions are positions 0-8 on the 3x3 board.

    Board layout:
    0 | 1 | 2
    ---------
    3 | 4 | 5
    ---------
    6 | 7 | 8
    """

    POS_0 = 0
    POS_1 = 1
    POS_2 = 2
    POS_3 = 3
    POS_4 = 4
    POS_5 = 5
    POS_6 = 6
    POS_7 = 7
    POS_8 = 8

    @classmethod
    def from_position(cls, row: int, col: int) -> "TicTacToeAction":
        """Convert (row, col) to action."""
        return cls(row * 3 + col)

    @classmethod
    def from_coords(cls, row: int, col: int) -> "TicTacToeAction":
        """Convert (row, col) to action. Alias for from_position."""
        return cls.from_position(row, col)

    def to_position(self) -> tuple[int, int]:
        """Convert action to (row, col)."""
        return (self.value // 3, self.value % 3)

    def to_coords(self) -> tuple[int, int]:
        """Convert action to (row, col). Alias for to_position."""
        return self.to_position()

    @classmethod
    def from_string(cls, s: str) -> "TicTacToeAction":
        """Parse action from string."""
        s = s.strip().upper()

        # Try direct number
        try:
            pos = int(s)
            if 0 <= pos <= 8:
                return cls(pos)
        except ValueError:
            pass

        # Try row,col format
        if "," in s:
            parts = s.split(",")
            if len(parts) == 2:
                try:
                    row, col = int(parts[0].strip()), int(parts[1].strip())
                    if 0 <= row <= 2 and 0 <= col <= 2:
                        return cls.from_position(row, col)
                except ValueError:
                    pass

        raise ValueError(f"Invalid action: {s}")


@dataclass(frozen=True)
class TicTacToeState(State):
    """
    State of a Tic-Tac-Toe game.

    Board is represented as 9 integers (3x3 grid).
    """

    board: tuple[int, ...]  # 9 integers: 0=empty, 1=X, 2=O
    current_player: int  # Player value (1 for X, 2 for O)
    winner: int | None = None  # None = no winner yet; 1 = X won; 2 = O won
    is_draw: bool = False  # True when game ended in draw (check this, not winner)
    move_count: int = 0

    SIZE: ClassVar[int] = 3

    def __post_init__(self) -> None:
        """Validate board and normalize winner/is_draw fields."""
        if len(self.board) != self.SIZE * self.SIZE:
            raise ValueError(f"Board must have {self.SIZE * self.SIZE} cells")
        
        # Defense-in-depth: convert winner=0 to proper is_draw representation
        # This handles any code path that accidentally passes winner=0 for draws
        # (e.g., from _check_winner which uses 0 internally for draws)
        if self.winner == 0:
            object.__setattr__(self, "winner", None)
            object.__setattr__(self, "is_draw", True)

    def get_cell(self, row: int, col: int) -> Player:
        """Get player at (row, col)."""
        return Player(self.board[row * self.SIZE + col])

    def to_prompt(self) -> str:
        """Convert state to prompt string."""
        lines = ["Current Tic-Tac-Toe board:"]
        lines.append("```")

        for row in range(self.SIZE):
            row_str = ""
            for col in range(self.SIZE):
                cell = self.get_cell(row, col)
                row_str += f" {cell} "
                if col < self.SIZE - 1:
                    row_str += "|"
            lines.append(row_str)
            if row < self.SIZE - 1:
                lines.append("-----------")

        lines.append("```")
        lines.append("")
        lines.append("Board positions (0-8):")
        lines.append("```")
        lines.append(" 0 | 1 | 2")
        lines.append("-----------")
        lines.append(" 3 | 4 | 5")
        lines.append("-----------")
        lines.append(" 6 | 7 | 8")
        lines.append("```")
        # Convert int to Player enum for display (shows "X" or "O" instead of "1" or "2")
        lines.append(f"You are playing as: {Player(self.current_player)}")

        return "\n".join(lines)

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        # current_player and winner are already int values (not Player enums)
        # so no need to access .value
        return {
            "board": list(self.board),
            "current_player": self.current_player,
            "winner": self.winner,
            "is_draw": self.is_draw,
            "move_count": self.move_count,
        }

    def is_terminal(self) -> bool:
        """Check if game is over."""
        return self.winner is not None or self.is_draw

    def render(self) -> str:
        """Render board for display."""
        lines = []
        lines.append("┌───┬───┬───┐")

        for row in range(self.SIZE):
            row_str = "│"
            for col in range(self.SIZE):
                cell = self.get_cell(row, col)
                if cell == Player.EMPTY:
                    row_str += f" {row * 3 + col} │"  # Show position number
                else:
                    row_str += f" {cell} │"
            lines.append(row_str)
            if row < self.SIZE - 1:
                lines.append("├───┼───┼───┤")

        lines.append("└───┴───┴───┘")

        # Display game result or current player
        # Note: winner is 1 (X) or 2 (O), never 0; draws use is_draw flag
        if self.winner:
            lines.append(f"Winner: {Player(self.winner)}!")
        elif self.is_draw:
            lines.append("It's a draw!")
        else:
            lines.append(f"Current player: {Player(self.current_player)}")

        return "\n".join(lines)


@dataclass
class TicTacToeConfig:
    """Configuration for Tic-Tac-Toe game."""

    # Which player the AI plays as
    ai_player: Player = Player.X

    # Opponent type: "none", "random", "heuristic", "optimal", "minimax"
    # - "none": No automatic opponent (for interactive/human play)
    # - "random": Random valid moves
    # - "heuristic": Simple priority-based strategy (center > corners > edges)
    # - "optimal" / "minimax": Perfect play using minimax algorithm
    opponent: str = "random"
