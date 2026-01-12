"""
ART Game Environments

Each game provides:
- Environment: Game logic and state management
- Agent: LLM-based decision making
- CLI: Command-line interface for play/train/benchmark
"""

from elizaos_art.games.codenames import CodenamesEnvironment
from elizaos_art.games.game_2048 import Game2048Environment
from elizaos_art.games.temporal_clue import TemporalClueEnvironment
from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment

__all__ = [
    "Game2048Environment",
    "TicTacToeEnvironment",
    "CodenamesEnvironment",
    "TemporalClueEnvironment",
]
