"""
ElizaOS Atropos Blackjack Environment

A Blackjack environment for training ElizaOS agents using reinforcement learning.
Integrates with OpenAI Gymnasium's Blackjack environment.
"""

from elizaos_atropos_blackjack.types import (
    BlackjackAction,
    BlackjackState,
    BlackjackResult,
    EpisodeResult,
)
from elizaos_atropos_blackjack.environment import BlackjackEnvironment
from elizaos_atropos_blackjack.agent import BlackjackAgent
from elizaos_atropos_blackjack.strategy import BasicStrategy, optimal_action

__version__ = "1.0.0"

__all__ = [
    # Types
    "BlackjackAction",
    "BlackjackState",
    "BlackjackResult",
    "EpisodeResult",
    # Environment
    "BlackjackEnvironment",
    # Agent
    "BlackjackAgent",
    # Strategy
    "BasicStrategy",
    "optimal_action",
]
