"""
2048 Game Environment for ART Training

Train an LLM to achieve high scores in the 2048 tile-merging game.
"""

from elizaos_art.games.game_2048.agent import Game2048Agent
from elizaos_art.games.game_2048.environment import Game2048Environment
from elizaos_art.games.game_2048.types import Game2048Action, Game2048State

__all__ = [
    "Game2048Environment",
    "Game2048Agent",
    "Game2048State",
    "Game2048Action",
]
