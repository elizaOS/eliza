"""
Type definitions for the Blackjack environment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import TypeAlias


class BlackjackAction(IntEnum):
    """Available actions in Blackjack."""

    STICK = 0  # Stop taking cards
    HIT = 1    # Request another card


# Type aliases
Reward: TypeAlias = float
Done: TypeAlias = bool


@dataclass(frozen=True)
class BlackjackState:
    """
    Current state of a Blackjack game.
    
    Attributes:
        player_sum: Sum of player's cards (4-21)
        dealer_card: Dealer's visible card (1-10, where 1=Ace)
        usable_ace: Whether player has a usable ace
    """

    player_sum: int
    dealer_card: int
    usable_ace: bool

    def to_tuple(self) -> tuple[int, int, bool]:
        """Convert to tuple for Gymnasium compatibility."""
        return (self.player_sum, self.dealer_card, self.usable_ace)

    @classmethod
    def from_tuple(cls, obs: tuple[int, int, int]) -> BlackjackState:
        """Create from Gymnasium observation tuple."""
        return cls(
            player_sum=obs[0],
            dealer_card=obs[1],
            usable_ace=bool(obs[2]),
        )

    def __str__(self) -> str:
        ace_str = "with usable Ace" if self.usable_ace else "no usable Ace"
        return f"Player: {self.player_sum}, Dealer shows: {self.dealer_card}, {ace_str}"


@dataclass
class BlackjackResult:
    """
    Result of taking an action in the environment.
    
    Attributes:
        state: The new game state
        reward: Reward received
        done: Whether the episode is finished
        info: Additional information
    """

    state: BlackjackState
    reward: float
    done: bool
    truncated: bool
    info: dict[str, object] = field(default_factory=dict)


@dataclass
class EpisodeResult:
    """
    Result of a complete episode.
    
    Attributes:
        reward: Final reward (+1 win, -1 loss, 0 draw, +1.5 blackjack)
        num_steps: Number of actions taken
        final_state: Final game state
        action_history: List of actions taken
        won: Whether the player won
    """

    reward: float
    num_steps: int
    final_state: BlackjackState
    action_history: list[BlackjackAction]
    won: bool
    is_blackjack: bool = False
    is_bust: bool = False

    @property
    def is_draw(self) -> bool:
        """Check if the game was a draw."""
        return self.reward == 0.0

    @property
    def is_loss(self) -> bool:
        """Check if the player lost."""
        return self.reward < 0


@dataclass
class TrainingStats:
    """
    Statistics for training sessions.
    
    Attributes:
        episodes: Total episodes played
        wins: Number of wins
        losses: Number of losses
        draws: Number of draws
        blackjacks: Number of blackjacks
        busts: Number of busts
        total_reward: Cumulative reward
    """

    episodes: int = 0
    wins: int = 0
    losses: int = 0
    draws: int = 0
    blackjacks: int = 0
    busts: int = 0
    total_reward: float = 0.0

    @property
    def win_rate(self) -> float:
        """Calculate win rate."""
        if self.episodes == 0:
            return 0.0
        return self.wins / self.episodes

    @property
    def loss_rate(self) -> float:
        """Calculate loss rate."""
        if self.episodes == 0:
            return 0.0
        return self.losses / self.episodes

    @property
    def draw_rate(self) -> float:
        """Calculate draw rate."""
        if self.episodes == 0:
            return 0.0
        return self.draws / self.episodes

    @property
    def average_reward(self) -> float:
        """Calculate average reward per episode."""
        if self.episodes == 0:
            return 0.0
        return self.total_reward / self.episodes

    def record_episode(self, result: EpisodeResult) -> None:
        """Record an episode result."""
        self.episodes += 1
        self.total_reward += result.reward

        if result.is_blackjack:
            self.blackjacks += 1
            self.wins += 1
        elif result.won:
            self.wins += 1
        elif result.is_draw:
            self.draws += 1
        else:
            self.losses += 1
            if result.is_bust:
                self.busts += 1

    def __str__(self) -> str:
        return (
            f"Episodes: {self.episodes} | "
            f"Win: {self.win_rate:.1%} | "
            f"Loss: {self.loss_rate:.1%} | "
            f"Draw: {self.draw_rate:.1%} | "
            f"Avg Reward: {self.average_reward:.3f}"
        )
