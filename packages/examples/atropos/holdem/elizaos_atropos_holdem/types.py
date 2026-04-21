"""
Type definitions for the Texas Hold'em environment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, IntEnum
from typing import TypeAlias


class Suit(str, Enum):
    """Card suits."""

    SPADES = "♠"
    HEARTS = "♥"
    DIAMONDS = "♦"
    CLUBS = "♣"

    @classmethod
    def from_char(cls, c: str) -> Suit:
        """Create from character."""
        mapping = {"s": cls.SPADES, "h": cls.HEARTS, "d": cls.DIAMONDS, "c": cls.CLUBS}
        return mapping.get(c.lower(), cls.SPADES)


class Rank(IntEnum):
    """Card ranks (2-14, where 14=Ace)."""

    TWO = 2
    THREE = 3
    FOUR = 4
    FIVE = 5
    SIX = 6
    SEVEN = 7
    EIGHT = 8
    NINE = 9
    TEN = 10
    JACK = 11
    QUEEN = 12
    KING = 13
    ACE = 14

    def __str__(self) -> str:
        names = {11: "J", 12: "Q", 13: "K", 14: "A"}
        return names.get(self.value, str(self.value))

    @classmethod
    def from_char(cls, c: str) -> Rank:
        """Create from character."""
        mapping = {
            "2": cls.TWO, "3": cls.THREE, "4": cls.FOUR, "5": cls.FIVE,
            "6": cls.SIX, "7": cls.SEVEN, "8": cls.EIGHT, "9": cls.NINE,
            "t": cls.TEN, "10": cls.TEN, "j": cls.JACK, "q": cls.QUEEN,
            "k": cls.KING, "a": cls.ACE,
        }
        return mapping.get(c.lower(), cls.TWO)


class HandRank(IntEnum):
    """Poker hand rankings."""

    HIGH_CARD = 1
    ONE_PAIR = 2
    TWO_PAIR = 3
    THREE_OF_A_KIND = 4
    STRAIGHT = 5
    FLUSH = 6
    FULL_HOUSE = 7
    FOUR_OF_A_KIND = 8
    STRAIGHT_FLUSH = 9
    ROYAL_FLUSH = 10

    @property
    def name_str(self) -> str:
        """Get human-readable name."""
        names = {
            1: "High Card", 2: "One Pair", 3: "Two Pair",
            4: "Three of a Kind", 5: "Straight", 6: "Flush",
            7: "Full House", 8: "Four of a Kind",
            9: "Straight Flush", 10: "Royal Flush",
        }
        return names.get(self.value, "Unknown")


class ActionType(str, Enum):
    """Types of poker actions."""

    FOLD = "fold"
    CHECK = "check"
    CALL = "call"
    RAISE = "raise"
    ALL_IN = "all_in"


class Phase(str, Enum):
    """Betting phases."""

    PREFLOP = "preflop"
    FLOP = "flop"
    TURN = "turn"
    RIVER = "river"
    SHOWDOWN = "showdown"


@dataclass(frozen=True)
class Card:
    """A playing card."""

    rank: Rank
    suit: Suit

    def __str__(self) -> str:
        return f"{self.rank}{self.suit.value}"

    def __hash__(self) -> int:
        return hash((self.rank, self.suit))

    @classmethod
    def from_str(cls, s: str) -> Card:
        """Create card from string like 'As' or 'Th'."""
        if len(s) < 2:
            raise ValueError(f"Invalid card string: {s}")
        rank = Rank.from_char(s[:-1])
        suit = Suit.from_char(s[-1])
        return cls(rank, suit)


@dataclass
class Action:
    """A player action."""

    action_type: ActionType
    amount: int = 0

    def __str__(self) -> str:
        if self.action_type == ActionType.RAISE:
            return f"raise to {self.amount}"
        elif self.action_type == ActionType.ALL_IN:
            return f"all-in ({self.amount})"
        elif self.action_type == ActionType.CALL:
            return f"call {self.amount}"
        return self.action_type.value


@dataclass
class PlayerState:
    """State of a single player."""

    position: int
    stack: int
    hole_cards: tuple[Card, Card] | None
    bet_this_round: int = 0
    total_bet: int = 0
    folded: bool = False
    all_in: bool = False

    @property
    def is_active(self) -> bool:
        """Check if player can still act."""
        return not self.folded and not self.all_in and self.stack > 0


# Type alias for chips
Chips: TypeAlias = int


@dataclass
class GameState:
    """Current state of a poker hand."""

    phase: Phase
    community_cards: list[Card]
    pot: Chips
    current_bet: Chips
    players: list[PlayerState]
    current_player: int
    button: int
    small_blind: Chips
    big_blind: Chips
    betting_history: list[list[Action]] = field(default_factory=list)
    hand_over: bool = False

    def get_player(self, position: int) -> PlayerState:
        """Get player by position."""
        return self.players[position]

    def active_players(self) -> list[PlayerState]:
        """Get list of non-folded players."""
        return [p for p in self.players if not p.folded]

    def players_in_hand(self) -> int:
        """Count players still in the hand."""
        return len([p for p in self.players if not p.folded])

    def min_raise(self) -> Chips:
        """Get minimum raise amount."""
        return self.big_blind

    def get_valid_actions(self) -> list[Action]:
        """Get list of valid actions for current player."""
        player = self.players[self.current_player]
        actions: list[Action] = []

        to_call = self.current_bet - player.bet_this_round

        # Always can fold
        actions.append(Action(ActionType.FOLD))

        if to_call == 0:
            # Can check
            actions.append(Action(ActionType.CHECK))
        else:
            # Can call
            call_amount = min(to_call, player.stack)
            actions.append(Action(ActionType.CALL, call_amount))

        # Can raise if have enough chips
        min_raise = self.current_bet + self.min_raise()
        if player.stack > to_call:
            # Minimum raise
            raise_amount = min(min_raise, player.stack + player.bet_this_round)
            actions.append(Action(ActionType.RAISE, raise_amount))

            # All-in
            if player.stack + player.bet_this_round > raise_amount:
                actions.append(Action(ActionType.ALL_IN, player.stack + player.bet_this_round))

        return actions


@dataclass
class HandResult:
    """Result of a completed hand."""

    winners: list[int]  # Winning player positions
    payouts: dict[int, Chips]  # Position -> chips won/lost
    winning_hand: HandRank | None
    showed_down: bool

    def __str__(self) -> str:
        if self.winning_hand:
            return f"Winner(s): {self.winners} with {self.winning_hand.name_str}"
        return f"Winner(s): {self.winners}"


@dataclass
class SessionStats:
    """Statistics for a poker session."""

    hands_played: int = 0
    hands_won: int = 0
    total_profit: Chips = 0
    biggest_pot_won: Chips = 0

    @property
    def win_rate(self) -> float:
        """Calculate win rate."""
        if self.hands_played == 0:
            return 0.0
        return self.hands_won / self.hands_played

    @property
    def avg_profit(self) -> float:
        """Average profit per hand."""
        if self.hands_played == 0:
            return 0.0
        return self.total_profit / self.hands_played

    def record_hand(self, profit: Chips, won: bool, pot_size: Chips = 0) -> None:
        """Record a hand result."""
        self.hands_played += 1
        self.total_profit += profit
        if won:
            self.hands_won += 1
            if pot_size > self.biggest_pot_won:
                self.biggest_pot_won = pot_size

    def __str__(self) -> str:
        return (
            f"Hands: {self.hands_played} | "
            f"Win Rate: {self.win_rate:.1%} | "
            f"Total: {self.total_profit:+d}"
        )
