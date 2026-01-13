"""
Type definitions for Codenames game.
"""

from dataclasses import dataclass, field
from enum import IntEnum, Enum
from typing import ClassVar

from elizaos_art.base import Action, State


class CardColor(IntEnum):
    """Card colors in Codenames."""

    RED = 0
    BLUE = 1
    NEUTRAL = 2
    ASSASSIN = 3


class Role(Enum):
    """Roles in Codenames."""

    SPYMASTER = "spymaster"
    GUESSER = "guesser"


class CodenamesAction(IntEnum):
    """
    Actions in Codenames.

    For Spymaster: Give a clue (handled specially)
    For Guesser: Select a word (positions 0-24 for 5x5 board)
    """

    # Word selection actions (0-24)
    WORD_0 = 0
    WORD_1 = 1
    WORD_2 = 2
    WORD_3 = 3
    WORD_4 = 4
    WORD_5 = 5
    WORD_6 = 6
    WORD_7 = 7
    WORD_8 = 8
    WORD_9 = 9
    WORD_10 = 10
    WORD_11 = 11
    WORD_12 = 12
    WORD_13 = 13
    WORD_14 = 14
    WORD_15 = 15
    WORD_16 = 16
    WORD_17 = 17
    WORD_18 = 18
    WORD_19 = 19
    WORD_20 = 20
    WORD_21 = 21
    WORD_22 = 22
    WORD_23 = 23
    WORD_24 = 24

    # Special actions
    PASS = 25  # Guesser passes (ends turn)
    GIVE_CLUE = 26  # Spymaster gives clue (requires clue parameters)

    @classmethod
    def from_word_index(cls, idx: int) -> "CodenamesAction":
        """Create action from word index."""
        if 0 <= idx <= 24:
            return cls(idx)
        raise ValueError(f"Invalid word index: {idx}")


@dataclass
class Clue:
    """A clue given by the spymaster."""

    word: str
    number: int  # Number of words related to clue

    def __str__(self) -> str:
        return f"{self.word.upper()} {self.number}"


@dataclass(frozen=True)
class CodenamesState(State):
    """
    State of a Codenames game.

    The board has 25 words arranged in a 5x5 grid.
    Each word has a color (RED, BLUE, NEUTRAL, ASSASSIN).
    """

    words: tuple[str, ...]  # 25 words
    colors: tuple[int, ...]  # True colors (for spymaster)
    revealed: tuple[bool, ...]  # Which cards have been revealed
    current_team: CardColor  # RED or BLUE
    current_role: Role
    current_clue: Clue | None
    guesses_remaining: int
    red_remaining: int
    blue_remaining: int
    game_over: bool = False
    winner: CardColor | None = None

    SIZE: ClassVar[int] = 5

    def __post_init__(self) -> None:
        """Validate state."""
        if len(self.words) != self.SIZE * self.SIZE:
            raise ValueError(f"Must have {self.SIZE * self.SIZE} words")
        if len(self.colors) != self.SIZE * self.SIZE:
            raise ValueError(f"Must have {self.SIZE * self.SIZE} colors")
        if len(self.revealed) != self.SIZE * self.SIZE:
            raise ValueError(f"Must have {self.SIZE * self.SIZE} revealed states")

    def get_word(self, row: int, col: int) -> str:
        """Get word at (row, col)."""
        return self.words[row * self.SIZE + col]

    def get_color(self, idx: int) -> CardColor:
        """Get true color of word at index."""
        return CardColor(self.colors[idx])

    def is_revealed(self, idx: int) -> bool:
        """Check if word at index is revealed."""
        return self.revealed[idx]

    def to_prompt(self) -> str:
        """Convert state to prompt string."""
        lines = []

        if self.current_role == Role.SPYMASTER:
            lines.append("# Codenames Board (Spymaster View)")
            lines.append("You can see the true colors of all words.")
            lines.append("")
            lines.append("```")
            for row in range(self.SIZE):
                row_parts = []
                for col in range(self.SIZE):
                    idx = row * self.SIZE + col
                    word = self.words[idx]
                    color = CardColor(self.colors[idx])
                    if self.revealed[idx]:
                        row_parts.append(f"[{word}]")  # Revealed
                    else:
                        color_marker = {"RED": "R", "BLUE": "B", "NEUTRAL": "N", "ASSASSIN": "X"}
                        row_parts.append(f"{word}({color_marker[color.name]})")
                lines.append("  ".join(f"{p:15}" for p in row_parts))
            lines.append("```")
            lines.append("")
            lines.append(f"Your team: {self.current_team.name}")
            lines.append(f"Red remaining: {self.red_remaining}, Blue remaining: {self.blue_remaining}")
            lines.append("")
            lines.append("Give a clue: a single word and a number (how many words it relates to).")
        else:
            lines.append("# Codenames Board (Guesser View)")
            lines.append("")
            if self.current_clue:
                lines.append(f"## Clue: {self.current_clue}")
                lines.append(f"Guesses remaining: {self.guesses_remaining}")
            lines.append("")
            lines.append("```")
            for row in range(self.SIZE):
                row_parts = []
                for col in range(self.SIZE):
                    idx = row * self.SIZE + col
                    word = self.words[idx]
                    if self.revealed[idx]:
                        color = CardColor(self.colors[idx])
                        row_parts.append(f"[{color.name[0]}:{word}]")
                    else:
                        row_parts.append(f"{idx}:{word}")
                lines.append("  ".join(f"{p:15}" for p in row_parts))
            lines.append("```")
            lines.append("")
            lines.append(f"Your team: {self.current_team.name}")
            lines.append("")
            lines.append("Select a word by its number, or PASS to end your turn.")

        return "\n".join(lines)

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "words": list(self.words),
            "colors": list(self.colors),
            "revealed": list(self.revealed),
            "current_team": self.current_team.value,
            "current_role": self.current_role.value,
            "current_clue": {"word": self.current_clue.word, "number": self.current_clue.number}
            if self.current_clue
            else None,
            "guesses_remaining": self.guesses_remaining,
            "red_remaining": self.red_remaining,
            "blue_remaining": self.blue_remaining,
            "game_over": self.game_over,
            "winner": self.winner.value if self.winner else None,
        }

    def is_terminal(self) -> bool:
        """Check if game is over."""
        return self.game_over

    def render(self) -> str:
        """Render board for display."""
        lines = []
        lines.append("┌" + "─" * 77 + "┐")

        for row in range(self.SIZE):
            row_str = "│"
            for col in range(self.SIZE):
                idx = row * self.SIZE + col
                word = self.words[idx][:12]  # Truncate long words

                if self.revealed[idx]:
                    color = CardColor(self.colors[idx])
                    markers = {
                        CardColor.RED: "🔴",
                        CardColor.BLUE: "🔵",
                        CardColor.NEUTRAL: "⚪",
                        CardColor.ASSASSIN: "💀",
                    }
                    row_str += f" {markers[color]} {word:12} │"
                else:
                    row_str += f" {idx:2}:{word:11} │"
            lines.append(row_str)
            if row < self.SIZE - 1:
                lines.append("├" + "─" * 77 + "┤")

        lines.append("└" + "─" * 77 + "┘")
        lines.append(f"Turn: {self.current_team.name} | Red: {self.red_remaining} | Blue: {self.blue_remaining}")

        if self.current_clue:
            lines.append(f"Clue: {self.current_clue} | Guesses left: {self.guesses_remaining}")

        if self.game_over:
            lines.append(f"GAME OVER - {self.winner.name if self.winner else 'Draw'} wins!")

        return "\n".join(lines)


@dataclass
class CodenamesConfig:
    """Configuration for Codenames game."""

    # Which role the AI plays
    ai_role: Role = Role.GUESSER
    ai_team: CardColor = CardColor.RED

    # Word list (default uses common English words)
    word_list: list[str] | None = None

    # Game settings
    red_count: int = 9  # Red team words
    blue_count: int = 8  # Blue team words
    assassin_count: int = 1  # Assassin words


# Default word list for Codenames
DEFAULT_WORD_LIST = [
    "AFRICA", "AGENT", "AIR", "ALIEN", "ALPS", "AMAZON", "AMBULANCE", "AMERICA",
    "ANGEL", "ANTARCTICA", "APPLE", "ARM", "ATLANTIS", "AUSTRALIA", "AZTEC",
    "BACK", "BALL", "BAND", "BANK", "BAR", "BARK", "BAT", "BATTERY", "BEACH",
    "BEAR", "BEAT", "BED", "BEIJING", "BELL", "BELT", "BERLIN", "BERMUDA",
    "BERRY", "BILL", "BLOCK", "BOARD", "BOLT", "BOMB", "BOND", "BOOM", "BOOT",
    "BOTTLE", "BOW", "BOX", "BRIDGE", "BRUSH", "BUCK", "BUFFALO", "BUG",
    "BUGLE", "BUTTON", "CALF", "CANADA", "CAP", "CAPITAL", "CAR", "CARD",
    "CARROT", "CASINO", "CAST", "CAT", "CELL", "CENTAUR", "CENTER", "CHAIR",
    "CHANGE", "CHARGE", "CHECK", "CHEST", "CHICK", "CHINA", "CHOCOLATE",
    "CHURCH", "CIRCLE", "CLIFF", "CLOAK", "CLUB", "CODE", "COLD", "COMIC",
    "COMPOUND", "CONCERT", "CONDUCTOR", "CONTRACT", "COOK", "COPPER", "COTTON",
    "COURT", "COVER", "CRANE", "CRASH", "CRICKET", "CROSS", "CROWN", "CYCLE",
    "CZECH", "DANCE", "DATE", "DAY", "DEATH", "DECK", "DEGREE", "DIAMOND",
    "DICE", "DINOSAUR", "DISEASE", "DOCTOR", "DOG", "DRAFT", "DRAGON", "DRESS",
    "DRILL", "DROP", "DUCK", "DWARF", "EAGLE", "EGYPT", "EMBASSY", "ENGINE",
    "ENGLAND", "EUROPE", "EYE", "FACE", "FAIR", "FALL", "FAN", "FENCE", "FIELD",
    "FIGHTER", "FIGURE", "FILE", "FILM", "FIRE", "FISH", "FLUTE", "FLY", "FOOT",
]
