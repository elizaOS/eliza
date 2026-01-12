"""
Tic-Tac-Toe Game Environment for ART Training

Train an LLM to play optimal Tic-Tac-Toe.
"""

from elizaos_art.games.tic_tac_toe.agent import (
    TicTacToeAgent,
    TicTacToeHeuristicAgent,
    TicTacToeRandomAgent,
)
from elizaos_art.games.tic_tac_toe.environment import TicTacToeEnvironment
from elizaos_art.games.tic_tac_toe.types import (
    TicTacToeAction,
    TicTacToeState,
    Player,
)

__all__ = [
    "TicTacToeEnvironment",
    "TicTacToeAgent",
    "TicTacToeHeuristicAgent",
    "TicTacToeRandomAgent",
    "TicTacToeState",
    "TicTacToeAction",
    "Player",
]
