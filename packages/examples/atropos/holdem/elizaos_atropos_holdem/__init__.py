"""
ElizaOS Atropos Texas Hold'em Environment

A Texas Hold'em poker environment for training ElizaOS agents.
"""

from elizaos_atropos_holdem.types import (
    Suit,
    Rank,
    Card,
    HandRank,
    Action,
    ActionType,
    Phase,
    PlayerState,
    GameState,
    HandResult,
)
from elizaos_atropos_holdem.deck import Deck
from elizaos_atropos_holdem.hand_evaluator import evaluate_hand, compare_hands
from elizaos_atropos_holdem.environment import HoldemEnvironment
from elizaos_atropos_holdem.agent import HoldemAgent

__version__ = "1.0.0"

__all__ = [
    # Types
    "Suit",
    "Rank",
    "Card",
    "HandRank",
    "Action",
    "ActionType",
    "Phase",
    "PlayerState",
    "GameState",
    "HandResult",
    # Deck
    "Deck",
    # Hand evaluation
    "evaluate_hand",
    "compare_hands",
    # Environment
    "HoldemEnvironment",
    # Agent
    "HoldemAgent",
]
