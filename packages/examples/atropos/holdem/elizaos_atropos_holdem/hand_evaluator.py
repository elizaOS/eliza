"""
Poker hand evaluation for Texas Hold'em.
"""

from __future__ import annotations

from collections import Counter
from itertools import combinations
from typing import TYPE_CHECKING

from elizaos_atropos_holdem.types import Card, Rank, HandRank

if TYPE_CHECKING:
    pass


def evaluate_hand(cards: list[Card]) -> tuple[HandRank, list[int]]:
    """
    Evaluate a poker hand.
    
    Args:
        cards: List of 5-7 cards
        
    Returns:
        Tuple of (HandRank, tiebreaker values)
    """
    if len(cards) < 5:
        raise ValueError("Need at least 5 cards to evaluate")

    # Find best 5-card hand from all combinations
    best_rank = HandRank.HIGH_CARD
    best_values: list[int] = []

    for five_cards in combinations(cards, 5):
        rank, values = _evaluate_five(list(five_cards))
        if rank > best_rank or (rank == best_rank and values > best_values):
            best_rank = rank
            best_values = values

    return best_rank, best_values


def _evaluate_five(cards: list[Card]) -> tuple[HandRank, list[int]]:
    """Evaluate exactly 5 cards."""
    ranks = sorted([c.rank for c in cards], reverse=True)
    suits = [c.suit for c in cards]

    # Check for flush
    is_flush = len(set(suits)) == 1

    # Check for straight
    is_straight, straight_high = _check_straight(ranks)

    # Count ranks
    rank_counts = Counter(ranks)
    counts = sorted(rank_counts.values(), reverse=True)

    # Royal flush
    if is_flush and is_straight and straight_high == Rank.ACE:
        return HandRank.ROYAL_FLUSH, [14]

    # Straight flush
    if is_flush and is_straight:
        return HandRank.STRAIGHT_FLUSH, [straight_high]

    # Four of a kind
    if counts == [4, 1]:
        quad_rank = [r for r, c in rank_counts.items() if c == 4][0]
        kicker = [r for r, c in rank_counts.items() if c == 1][0]
        return HandRank.FOUR_OF_A_KIND, [quad_rank, kicker]

    # Full house
    if counts == [3, 2]:
        trips_rank = [r for r, c in rank_counts.items() if c == 3][0]
        pair_rank = [r for r, c in rank_counts.items() if c == 2][0]
        return HandRank.FULL_HOUSE, [trips_rank, pair_rank]

    # Flush
    if is_flush:
        return HandRank.FLUSH, ranks

    # Straight
    if is_straight:
        return HandRank.STRAIGHT, [straight_high]

    # Three of a kind
    if counts == [3, 1, 1]:
        trips_rank = [r for r, c in rank_counts.items() if c == 3][0]
        kickers = sorted([r for r, c in rank_counts.items() if c == 1], reverse=True)
        return HandRank.THREE_OF_A_KIND, [trips_rank] + kickers

    # Two pair
    if counts == [2, 2, 1]:
        pairs = sorted([r for r, c in rank_counts.items() if c == 2], reverse=True)
        kicker = [r for r, c in rank_counts.items() if c == 1][0]
        return HandRank.TWO_PAIR, pairs + [kicker]

    # One pair
    if counts == [2, 1, 1, 1]:
        pair_rank = [r for r, c in rank_counts.items() if c == 2][0]
        kickers = sorted([r for r, c in rank_counts.items() if c == 1], reverse=True)
        return HandRank.ONE_PAIR, [pair_rank] + kickers

    # High card
    return HandRank.HIGH_CARD, ranks


def _check_straight(ranks: list[Rank]) -> tuple[bool, int]:
    """
    Check if ranks form a straight.
    
    Returns:
        Tuple of (is_straight, high card rank)
    """
    unique_ranks = sorted(set(ranks), reverse=True)

    if len(unique_ranks) < 5:
        return False, 0

    # Check for wheel (A-2-3-4-5)
    if set(unique_ranks) >= {Rank.ACE, Rank.TWO, Rank.THREE, Rank.FOUR, Rank.FIVE}:
        return True, 5  # 5-high straight

    # Check for regular straight
    for i in range(len(unique_ranks) - 4):
        window = unique_ranks[i:i + 5]
        if window[0] - window[4] == 4:
            return True, window[0]

    return False, 0


def compare_hands(
    hand1: list[Card],
    hand2: list[Card],
) -> int:
    """
    Compare two hands.
    
    Args:
        hand1: First hand (5-7 cards)
        hand2: Second hand (5-7 cards)
        
    Returns:
        1 if hand1 wins, -1 if hand2 wins, 0 if tie
    """
    rank1, values1 = evaluate_hand(hand1)
    rank2, values2 = evaluate_hand(hand2)

    if rank1 > rank2:
        return 1
    if rank1 < rank2:
        return -1

    # Same rank, compare tiebreakers
    if values1 > values2:
        return 1
    if values1 < values2:
        return -1

    return 0


def get_hand_description(cards: list[Card]) -> str:
    """
    Get human-readable hand description.
    
    Args:
        cards: List of cards
        
    Returns:
        Description string
    """
    if len(cards) < 5:
        return "Incomplete hand"

    rank, values = evaluate_hand(cards)

    descriptions = {
        HandRank.ROYAL_FLUSH: "Royal Flush!",
        HandRank.STRAIGHT_FLUSH: f"Straight Flush, {_rank_name(values[0])}-high",
        HandRank.FOUR_OF_A_KIND: f"Four of a Kind, {_rank_name(values[0])}s",
        HandRank.FULL_HOUSE: f"Full House, {_rank_name(values[0])}s full of {_rank_name(values[1])}s",
        HandRank.FLUSH: f"Flush, {_rank_name(values[0])}-high",
        HandRank.STRAIGHT: f"Straight, {_rank_name(values[0])}-high",
        HandRank.THREE_OF_A_KIND: f"Three of a Kind, {_rank_name(values[0])}s",
        HandRank.TWO_PAIR: f"Two Pair, {_rank_name(values[0])}s and {_rank_name(values[1])}s",
        HandRank.ONE_PAIR: f"Pair of {_rank_name(values[0])}s",
        HandRank.HIGH_CARD: f"High Card, {_rank_name(values[0])}",
    }

    return descriptions.get(rank, "Unknown hand")


def _rank_name(rank_value: int) -> str:
    """Convert rank value to name."""
    names = {
        14: "Ace", 13: "King", 12: "Queen", 11: "Jack", 10: "Ten",
        9: "Nine", 8: "Eight", 7: "Seven", 6: "Six", 5: "Five",
        4: "Four", 3: "Three", 2: "Two",
    }
    return names.get(rank_value, str(rank_value))
