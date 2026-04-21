"""
ART Game Environments

Each game provides:
- Environment: Game logic and state management
- Agent: LLM-based decision making
- CLI: Command-line interface for play/train/benchmark

All environments use the canonical ElizaOS agent pattern:
- Full AgentRuntime with character and plugins
- Message processing through message_service
- Actions registered and invoked
- Providers for context
- basicCapabilities enabled by default
"""

from elizaos_art.games.codenames import (
    CodenamesAgent,
    CodenamesEnvironment,
    CodenamesGuesserAgent,
    CodenamesSpymasterAgent,
)
from elizaos_art.games.game_2048 import (
    Game2048Agent,
    Game2048Environment,
    Game2048HeuristicAgent,
    Game2048RandomAgent,
)
from elizaos_art.games.temporal_clue import (
    TemporalClueAgent,
    TemporalClueEnvironment,
    TemporalClueHeuristicAgent,
)
from elizaos_art.games.tic_tac_toe import (
    TicTacToeAgent,
    TicTacToeEnvironment,
    TicTacToeHeuristicAgent,
    TicTacToeRandomAgent,
)

__all__ = [
    # 2048
    "Game2048Environment",
    "Game2048Agent",
    "Game2048HeuristicAgent",
    "Game2048RandomAgent",
    # Tic-Tac-Toe
    "TicTacToeEnvironment",
    "TicTacToeAgent",
    "TicTacToeHeuristicAgent",
    "TicTacToeRandomAgent",
    # Codenames
    "CodenamesEnvironment",
    "CodenamesAgent",
    "CodenamesSpymasterAgent",
    "CodenamesGuesserAgent",
    # Temporal Clue
    "TemporalClueEnvironment",
    "TemporalClueAgent",
    "TemporalClueHeuristicAgent",
]
