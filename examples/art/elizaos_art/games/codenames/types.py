"""
Type definitions for Codenames.
"""

from dataclasses import dataclass, field
from enum import IntEnum
from typing import ClassVar

from elizaos_art.base import State


class CardType(IntEnum):
    """Types of cards in Codenames."""

    RED = 0      # Red team's words
    BLUE = 1     # Blue team's words
    NEUTRAL = 2  # Neutral words (no effect)
    ASSASSIN = 3 # Game-ending bad card


class Team(IntEnum):
    """Teams in Codenames."""

    RED = 0
    BLUE = 1

    def opponent(self) -> "Team":
        return Team.BLUE if self == Team.RED else Team.RED


class Role(IntEnum):
    """Player roles."""

    SPYMASTER = 0  # Gives clues
    GUESSER = 1    # Guesses words


@dataclass(frozen=True)
class WordCard:
    """A word card on the board."""

    word: str
    card_type: CardType
    revealed: bool = False

    def to_dict(self) -> dict:
        return {
            "word": self.word,
            "type": self.card_type.name,
            "revealed": self.revealed,
        }


@dataclass(frozen=True)
class Clue:
    """A clue given by the spymaster."""

    word: str
    number: int  # How many words it relates to

    def __str__(self) -> str:
        return f"{self.word} ({self.number})"


class CodenamesAction(IntEnum):
    """
    Actions are indices into the board (0-24) for guessing,
    or special values for passing.
    """

    # Board positions 0-24
    POS_0 = 0
    POS_1 = 1
    POS_2 = 2
    POS_3 = 3
    POS_4 = 4
    POS_5 = 5
    POS_6 = 6
    POS_7 = 7
    POS_8 = 8
    POS_9 = 9
    POS_10 = 10
    POS_11 = 11
    POS_12 = 12
    POS_13 = 13
    POS_14 = 14
    POS_15 = 15
    POS_16 = 16
    POS_17 = 17
    POS_18 = 18
    POS_19 = 19
    POS_20 = 20
    POS_21 = 21
    POS_22 = 22
    POS_23 = 23
    POS_24 = 24
    PASS = 25  # End guessing phase

    @classmethod
    def from_position(cls, pos: int) -> "CodenamesAction":
        if 0 <= pos <= 24:
            return cls(pos)
        raise ValueError(f"Invalid position: {pos}")

    @classmethod
    def from_word(cls, word: str, board: list["WordCard"]) -> "CodenamesAction":
        """Find action by word."""
        word = word.strip().upper()
        for i, card in enumerate(board):
            if card.word.upper() == word:
                return cls(i)
        raise ValueError(f"Word not found: {word}")


@dataclass(frozen=True)
class CodenamesState(State):
    """
    State of a Codenames game.

    Board is 25 words (5x5 grid).
    """

    board: tuple[WordCard, ...]  # 25 word cards
    current_team: Team
    current_role: Role
    current_clue: Clue | None
    guesses_remaining: int
    red_remaining: int
    blue_remaining: int
    game_over: bool
    winner: Team | None
    move_count: int

    # Standard board size
    SIZE: ClassVar[int] = 5
    TOTAL_CARDS: ClassVar[int] = 25

    def __post_init__(self) -> None:
        if len(self.board) != self.TOTAL_CARDS:
            raise ValueError(f"Board must have {self.TOTAL_CARDS} cards")

    def get_card(self, row: int, col: int) -> WordCard:
        """Get card at (row, col)."""
        return self.board[row * self.SIZE + col]

    def get_unrevealed_words(self) -> list[str]:
        """Get list of unrevealed words."""
        return [card.word for card in self.board if not card.revealed]

    def to_prompt(self) -> str:
        """Convert to prompt string."""
        lines = []

        if self.current_role == Role.SPYMASTER:
            # Spymaster sees everything
            lines.append("=== CODENAMES - SPYMASTER VIEW ===")
            lines.append(f"Your team: {self.current_team.name}")
            lines.append(f"Red remaining: {self.red_remaining}")
            lines.append(f"Blue remaining: {self.blue_remaining}")
            lines.append("")
            lines.append("Board (R=Red, B=Blue, N=Neutral, X=Assassin, ?=Unrevealed):")
            lines.append("```")

            for row in range(self.SIZE):
                row_words = []
                for col in range(self.SIZE):
                    card = self.get_card(row, col)
                    if card.revealed:
                        row_words.append(f"[{card.word}]")
                    else:
                        type_char = {
                            CardType.RED: "R",
                            CardType.BLUE: "B",
                            CardType.NEUTRAL: "N",
                            CardType.ASSASSIN: "X",
                        }[card.card_type]
                        row_words.append(f"{card.word}({type_char})")
                lines.append("  ".join(f"{w:15}" for w in row_words))

            lines.append("```")
            lines.append("")
            lines.append("Give a clue: WORD NUMBER")
            lines.append("(Word must not be on the board)")

        else:
            # Guesser sees only revealed cards
            lines.append("=== CODENAMES - GUESSER VIEW ===")
            lines.append(f"Your team: {self.current_team.name}")
            if self.current_clue:
                lines.append(f"Clue: {self.current_clue.word} ({self.current_clue.number})")
                lines.append(f"Guesses remaining: {self.guesses_remaining}")
            lines.append("")
            lines.append("Board (revealed cards shown with [brackets]):")
            lines.append("```")

            for row in range(self.SIZE):
                row_words = []
                for col in range(self.SIZE):
                    card = self.get_card(row, col)
                    if card.revealed:
                        color = {
                            CardType.RED: "R",
                            CardType.BLUE: "B",
                            CardType.NEUTRAL: "-",
                            CardType.ASSASSIN: "X",
                        }[card.card_type]
                        row_words.append(f"[{card.word}/{color}]")
                    else:
                        row_words.append(card.word)
                lines.append("  ".join(f"{w:15}" for w in row_words))

            lines.append("```")
            lines.append("")
            lines.append("Choose a word or PASS")

        return "\n".join(lines)

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "board": [c.to_dict() for c in self.board],
            "current_team": self.current_team.name,
            "current_role": self.current_role.name,
            "current_clue": str(self.current_clue) if self.current_clue else None,
            "guesses_remaining": self.guesses_remaining,
            "red_remaining": self.red_remaining,
            "blue_remaining": self.blue_remaining,
            "game_over": self.game_over,
            "winner": self.winner.name if self.winner else None,
            "move_count": self.move_count,
        }

    def is_terminal(self) -> bool:
        return self.game_over

    def render(self) -> str:
        """Render for display."""
        return self.to_prompt()


@dataclass
class CodenamesConfig:
    """Configuration for Codenames."""

    # Game setup
    red_count: int = 9   # Red team words (goes first if 9)
    blue_count: int = 8  # Blue team words
    neutral_count: int = 7
    assassin_count: int = 1

    # Training config
    train_role: Role = Role.GUESSER  # Which role to train
    train_team: Team = Team.RED

    # Opponent settings
    opponent_spymaster: str = "simple"  # "simple", "llm"
    opponent_guesser: str = "random"    # "random", "llm"


# Default word list for Codenames
DEFAULT_WORDS: list[str] = [
    "AFRICA", "AGENT", "AIR", "ALIEN", "ALPS", "AMAZON", "AMBULANCE", "AMERICA",
    "ANGEL", "ANTARCTICA", "APPLE", "ARM", "ATLANTIS", "AUSTRALIA", "AZTEC",
    "BACK", "BALL", "BAND", "BANK", "BAR", "BARK", "BAT", "BATTERY", "BEACH",
    "BEAR", "BEAT", "BED", "BEIJING", "BELL", "BELT", "BERLIN", "BERRY",
    "BILL", "BLOCK", "BOARD", "BOLT", "BOMB", "BOND", "BOOM", "BOOT", "BOTTLE",
    "BOW", "BOX", "BRIDGE", "BRUSH", "BUCK", "BUFFALO", "BUG", "BUGLE",
    "BUTTON", "CALF", "CANADA", "CAP", "CAPITAL", "CAR", "CARD", "CARROT",
    "CASINO", "CAST", "CAT", "CELL", "CENTAUR", "CENTER", "CHAIR", "CHANGE",
    "CHARGE", "CHECK", "CHEST", "CHICK", "CHINA", "CHOCOLATE", "CHURCH",
    "CIRCLE", "CLIFF", "CLOAK", "CLUB", "CODE", "COLD", "COMIC", "COMPOUND",
    "CONCERT", "CONDUCTOR", "CONTRACT", "COOK", "COPPER", "COTTON", "COURT",
    "COVER", "CRANE", "CRASH", "CRICKET", "CROSS", "CROWN", "CYCLE", "CZECH",
    "DANCE", "DATE", "DAY", "DEATH", "DECK", "DEGREE", "DIAMOND", "DICE",
    "DINOSAUR", "DISEASE", "DOCTOR", "DOG", "DRAFT", "DRAGON", "DRESS",
    "DRILL", "DROP", "DUCK", "DWARF", "EAGLE", "EGYPT", "EMBASSY", "ENGINE",
    "ENGLAND", "EUROPE", "EYE", "FACE", "FAIR", "FALL", "FAN", "FENCE",
    "FIELD", "FIGHTER", "FIGURE", "FILE", "FILM", "FIRE", "FISH", "FLUTE",
    "FLY", "FOOT", "FORCE", "FOREST", "FORK", "FRANCE", "FRANK", "FROST",
]
