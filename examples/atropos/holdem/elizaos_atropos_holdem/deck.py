"""
Card deck implementation for Texas Hold'em.
"""

from __future__ import annotations

import random
from typing import TYPE_CHECKING

from elizaos_atropos_holdem.types import Card, Rank, Suit

if TYPE_CHECKING:
    pass


class Deck:
    """
    A standard 52-card deck.
    
    Example:
        >>> deck = Deck()
        >>> deck.shuffle()
        >>> card = deck.deal()
    """

    def __init__(self, seed: int | None = None) -> None:
        """
        Initialize a new deck.
        
        Args:
            seed: Optional random seed for reproducibility
        """
        self._rng = random.Random(seed)
        self._cards: list[Card] = []
        self._dealt: list[Card] = []
        self._reset()

    def _reset(self) -> None:
        """Reset deck to full 52 cards."""
        self._cards = [
            Card(rank, suit)
            for suit in Suit
            for rank in Rank
        ]
        self._dealt = []

    def shuffle(self, seed: int | None = None) -> None:
        """
        Shuffle the deck.
        
        Args:
            seed: Optional new random seed
        """
        if seed is not None:
            self._rng = random.Random(seed)
        self._reset()
        self._rng.shuffle(self._cards)

    def deal(self) -> Card:
        """
        Deal one card from the deck.
        
        Returns:
            The dealt card
            
        Raises:
            ValueError: If deck is empty
        """
        if not self._cards:
            raise ValueError("Deck is empty")
        card = self._cards.pop()
        self._dealt.append(card)
        return card

    def deal_many(self, count: int) -> list[Card]:
        """
        Deal multiple cards.
        
        Args:
            count: Number of cards to deal
            
        Returns:
            List of dealt cards
        """
        return [self.deal() for _ in range(count)]

    def burn(self) -> None:
        """Burn (discard) one card."""
        if self._cards:
            self._dealt.append(self._cards.pop())

    @property
    def remaining(self) -> int:
        """Number of cards remaining in deck."""
        return len(self._cards)

    @property
    def dealt_cards(self) -> list[Card]:
        """List of cards that have been dealt."""
        return list(self._dealt)


def create_deck(seed: int | None = None) -> Deck:
    """
    Create and shuffle a new deck.
    
    Args:
        seed: Optional random seed
        
    Returns:
        A shuffled deck
    """
    deck = Deck(seed)
    deck.shuffle()
    return deck
