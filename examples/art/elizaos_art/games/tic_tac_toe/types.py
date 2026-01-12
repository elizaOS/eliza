"""
Type definitions for Tic-Tac-Toe.
"""

from dataclasses import dataclass
from enum import IntEnum

from elizaos_art.base import State


class TicTacToeAction(IntEnum):
    """Position on the board (0-8)."""

    POS_0 = 0  # Top-left
    POS_1 = 1  # Top-center
    POS_2 = 2  # Top-right
    POS_3 = 3  # Middle-left
    POS_4 = 4  # Center
    POS_5 = 5  # Middle-right
    POS_6 = 6  # Bottom-left
    POS_7 = 7  # Bottom-center
    POS_8 = 8  # Bottom-right

    @classmethod
    def from_string(cls, s: str) -> "TicTacToeAction":
        """Parse action from string."""
        s = s.strip()
        # Try numeric
        try:
            num = int(s)
            if 0 <= num <= 8:
                return cls(num)
        except ValueError:
            pass

        # Try coordinate like "1,1" or "row 0 col 0"
        import re

        match = re.search(r"(\d)[,\s]+(\d)", s)
        if match:
            row, col = int(match.group(1)), int(match.group(2))
            if 0 <= row <= 2 and 0 <= col <= 2:
                return cls(row * 3 + col)

        raise ValueError(f"Invalid action: {s}")

    def to_coords(self) -> tuple[int, int]:
        """Convert to (row, col)."""
        return divmod(self.value, 3)

    @classmethod
    def from_coords(cls, row: int, col: int) -> "TicTacToeAction":
        """Create from (row, col)."""
        return cls(row * 3 + col)


class Player(IntEnum):
    """Player markers."""

    EMPTY = 0
    X = 1
    O = 2

    def symbol(self) -> str:
        """Get display symbol."""
        return {Player.EMPTY: ".", Player.X: "X", Player.O: "O"}[self]

    def opponent(self) -> "Player":
        """Get the opponent."""
        if self == Player.X:
            return Player.O
        elif self == Player.O:
            return Player.X
        return Player.EMPTY


@dataclass(frozen=True)
class TicTacToeState(State):
    """
    State of a Tic-Tac-Toe game.

    Board is 9 cells (0-8), each can be EMPTY, X, or O.
    """

    board: tuple[int, ...]  # 9 integers (Player values)
    current_player: int  # Player.X or Player.O
    winner: int | None  # None if ongoing, Player value if won, 0 for draw
    move_count: int

    def __post_init__(self) -> None:
        """Validate board."""
        if len(self.board) != 9:
            raise ValueError("Board must have 9 cells")

    def get_cell(self, row: int, col: int) -> int:
        """Get value at (row, col)."""
        return self.board[row * 3 + col]

    def to_prompt(self) -> str:
        """Convert state to prompt string."""
        lines = ["Current Tic-Tac-Toe board:"]
        lines.append("```")
        lines.append("   0   1   2")
        for row in range(3):
            row_str = f"{row}  "
            for col in range(3):
                cell = Player(self.get_cell(row, col))
                row_str += f" {cell.symbol()} "
                if col < 2:
                    row_str += "|"
            lines.append(row_str)
            if row < 2:
                lines.append("   ---+---+---")
        lines.append("```")
        current = Player(self.current_player)
        lines.append(f"You are playing: {current.symbol()}")
        lines.append(f"Move {self.move_count + 1}")
        return "\n".join(lines)

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "board": list(self.board),
            "current_player": self.current_player,
            "winner": self.winner,
            "move_count": self.move_count,
        }

    def is_terminal(self) -> bool:
        """Check if game is over."""
        return self.winner is not None

    def render(self) -> str:
        """Render board for display."""
        lines = []
        lines.append("     0   1   2")
        lines.append("   ┌───┬───┬───┐")
        for row in range(3):
            row_str = f" {row} │"
            for col in range(3):
                cell = Player(self.get_cell(row, col))
                symbol = cell.symbol() if cell != Player.EMPTY else " "
                row_str += f" {symbol} │"
            lines.append(row_str)
            if row < 2:
                lines.append("   ├───┼───┼───┤")
        lines.append("   └───┴───┴───┘")

        current = Player(self.current_player)
        if self.winner is None:
            lines.append(f"Current player: {current.symbol()}")
        elif self.winner == 0:
            lines.append("Result: Draw!")
        else:
            lines.append(f"Winner: {Player(self.winner).symbol()}!")

        return "\n".join(lines)


@dataclass
class TicTacToeConfig:
    """Configuration for Tic-Tac-Toe."""

    agent_player: int = 1  # Player.X (agent goes first by default)
    opponent_type: str = "random"  # "random", "optimal", "minimax"
