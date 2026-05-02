"""
Protocol definition for systems being benchmarked.

Any trust-scoring system must implement this interface to be evaluated
by the benchmark harness.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal


@dataclass
class ExtractionResult:
    """Result of extracting a recommendation from a message."""

    is_recommendation: bool
    recommendation_type: Literal["BUY", "SELL", "NOISE"]
    conviction: Literal["HIGH", "MEDIUM", "LOW", "NONE"]
    token_mentioned: str  # ticker or empty
    token_address: str  # resolved address or empty


@dataclass
class UserTrustScore:
    """Trust score computed by the system for a user."""

    user_id: str
    trust_score: float  # 0-100 scale
    win_rate: float  # 0-1
    total_calls: int
    archetype: str  # system's classification


class SocialAlphaSystem(ABC):
    """
    Protocol that any trust-scoring system must implement.

    The benchmark harness calls these methods to evaluate the system.
    """

    @abstractmethod
    def extract_recommendation(self, message_text: str) -> ExtractionResult:
        """
        Extract a trading recommendation from a raw message.

        Args:
            message_text: Raw Discord message text

        Returns:
            ExtractionResult with classification and token info
        """
        ...

    @abstractmethod
    def process_call(
        self,
        user_id: str,
        token_address: str,
        recommendation_type: Literal["BUY", "SELL"],
        conviction: Literal["HIGH", "MEDIUM", "LOW"],
        price_at_call: float,
        timestamp: int,
    ) -> None:
        """
        Process a trading call — update internal state.

        This is called in chronological order to simulate real-time processing.

        Args:
            user_id: Unique user identifier
            token_address: Resolved token address
            recommendation_type: BUY or SELL
            conviction: Conviction level
            price_at_call: Token price when call was made
            timestamp: Unix ms timestamp of the call
        """
        ...

    @abstractmethod
    def update_price(self, token_address: str, price: float, timestamp: int) -> None:
        """
        Update the system with a new price observation for a token.

        Called to simulate price feeds arriving after calls are made.

        Args:
            token_address: Token address
            price: Current price
            timestamp: Unix ms timestamp
        """
        ...

    @abstractmethod
    def get_user_trust_score(self, user_id: str) -> UserTrustScore | None:
        """
        Get the system's computed trust score for a user.

        Args:
            user_id: User identifier

        Returns:
            UserTrustScore or None if user not tracked
        """
        ...

    @abstractmethod
    def get_leaderboard(self, top_k: int = 50) -> list[UserTrustScore]:
        """
        Get the system's ranked leaderboard.

        Args:
            top_k: Number of top users to return

        Returns:
            List of UserTrustScore sorted by trust_score descending
        """
        ...

    @abstractmethod
    def is_scam_token(self, token_address: str) -> bool:
        """
        Ask the system if it thinks a token is a scam/rug.

        Args:
            token_address: Token address

        Returns:
            True if the system flags this token as a scam
        """
        ...

    def reset(self) -> None:
        """Reset the system state for a fresh evaluation run."""
        pass
