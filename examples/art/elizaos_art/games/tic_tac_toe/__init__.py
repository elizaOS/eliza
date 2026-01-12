"""
Tic-Tac-Toe Environment for ART Training

Train an LLM to play optimal Tic-Tac-Toe.
"""

from elizaos_art.games.tic_tac_toe.agent import TicTacToeAgent
from elizaos_art.games.tic_tac_toe.environment import TicTacToeEnvironment
from elizaos_art.games.tic_tac_toe.types import TicTacToeAction, TicTacToeState

__all__ = [
    "TicTacToeEnvironment",
    "TicTacToeAgent",
    "TicTacToeState",
    "TicTacToeAction",
]
