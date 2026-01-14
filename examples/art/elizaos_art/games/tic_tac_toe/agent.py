"""
Tic-Tac-Toe Agent for ART Training

LLM-based agent that learns to play Tic-Tac-Toe.
"""

import re

from elizaos_art.base import BaseAgent
from elizaos_art.games.tic_tac_toe.types import TicTacToeAction, TicTacToeState, Player


class TicTacToeAgent(BaseAgent[TicTacToeState, TicTacToeAction]):
    """
    LLM-based agent for playing Tic-Tac-Toe.

    Uses the LLM to decide where to place marks.
    """

    def __init__(
        self,
        model_name: str = "meta-llama/Llama-3.2-3B-Instruct",
        temperature: float = 0.7,
    ):
        self.model_name = model_name
        self.temperature = temperature

    @property
    def name(self) -> str:
        return f"TicTacToeAgent({self.model_name})"

    def get_system_prompt(self) -> str:
        """Get system prompt for the LLM."""
        return """You are an expert Tic-Tac-Toe player. Your goal is to win by getting three marks in a row (horizontally, vertically, or diagonally).

Key strategies:
1. Always block your opponent if they have two in a row
2. Take winning moves when available
3. Prefer the center (position 4) early in the game
4. Take corners (0, 2, 6, 8) over edges (1, 3, 5, 7)
5. Look for "forks" - positions that create two winning threats

The board positions are numbered 0-8:
 0 | 1 | 2
-----------
 3 | 4 | 5
-----------
 6 | 7 | 8

Respond with ONLY the position number (0-8) where you want to place your mark."""

    def format_action_prompt(
        self,
        state: TicTacToeState,
        available_actions: list[TicTacToeAction],
    ) -> str:
        """Format prompt for action selection."""
        action_positions = [str(a.value) for a in available_actions]

        prompt = f"""{state.to_prompt()}

Available positions: {", ".join(action_positions)}

Choose the best position to place your mark. Consider:
- Can you win immediately?
- Do you need to block the opponent?
- Is the center (4) available?

Respond with just the position number (one of: {", ".join(action_positions)}):"""

        return prompt

    def parse_action(
        self,
        response: str,
        available_actions: list[TicTacToeAction],
    ) -> TicTacToeAction:
        """Parse LLM response into an action."""
        response = response.strip()

        # Try to extract a number
        match = re.search(r"\b([0-8])\b", response)
        if match:
            pos = int(match.group(1))
            action = TicTacToeAction(pos)
            if action in available_actions:
                return action

        # Default to first available action
        return available_actions[0]

    async def decide(
        self,
        state: TicTacToeState,
        available_actions: list[TicTacToeAction],
    ) -> TicTacToeAction:
        """
        Decide which action to take.

        Uses heuristic as fallback for standalone usage.
        """
        if not available_actions:
            raise ValueError("No available actions")

        # Heuristic: center > corners > edges
        preference = [4, 0, 2, 6, 8, 1, 3, 5, 7]
        for pos in preference:
            action = TicTacToeAction(pos)
            if action in available_actions:
                return action

        return available_actions[0]


class TicTacToeHeuristicAgent(BaseAgent[TicTacToeState, TicTacToeAction]):
    """
    Heuristic-based agent for Tic-Tac-Toe.

    Good for baseline comparisons.
    """

    def __init__(self, player: Player = Player.X):
        self.player = player

    @property
    def name(self) -> str:
        return "TicTacToeHeuristic"

    def get_system_prompt(self) -> str:
        return ""

    def format_action_prompt(
        self,
        state: TicTacToeState,
        available_actions: list[TicTacToeAction],
    ) -> str:
        return ""

    def parse_action(
        self,
        response: str,
        available_actions: list[TicTacToeAction],
    ) -> TicTacToeAction:
        return available_actions[0]

    async def decide(
        self,
        state: TicTacToeState,
        available_actions: list[TicTacToeAction],
    ) -> TicTacToeAction:
        """Use heuristic strategy."""
        board = list(state.board)
        opponent = Player.O if self.player == Player.X else Player.X

        # 1. Win if possible
        for action in available_actions:
            test_board = board.copy()
            test_board[action.value] = self.player.value
            if self._is_winner(test_board, self.player):
                return action

        # 2. Block opponent
        for action in available_actions:
            test_board = board.copy()
            test_board[action.value] = opponent.value
            if self._is_winner(test_board, opponent):
                return action

        # 3. Take center
        if TicTacToeAction.POS_4 in available_actions:
            return TicTacToeAction.POS_4

        # 4. Take corner
        corners = [
            TicTacToeAction.POS_0,
            TicTacToeAction.POS_2,
            TicTacToeAction.POS_6,
            TicTacToeAction.POS_8,
        ]
        for corner in corners:
            if corner in available_actions:
                return corner

        # 5. Take any
        return available_actions[0]

    def _is_winner(self, board: list[int], player: Player) -> bool:
        """Check if player has won."""
        win_lines = [
            (0, 1, 2), (3, 4, 5), (6, 7, 8),
            (0, 3, 6), (1, 4, 7), (2, 5, 8),
            (0, 4, 8), (2, 4, 6),
        ]
        for line in win_lines:
            if all(board[i] == player.value for i in line):
                return True
        return False


class TicTacToeRandomAgent(BaseAgent[TicTacToeState, TicTacToeAction]):
    """Random agent for baseline comparison."""

    def __init__(self, seed: int | None = None):
        import random

        self._rng = random.Random(seed)

    @property
    def name(self) -> str:
        return "TicTacToeRandom"

    def get_system_prompt(self) -> str:
        return ""

    def format_action_prompt(
        self,
        state: TicTacToeState,
        available_actions: list[TicTacToeAction],
    ) -> str:
        return ""

    def parse_action(
        self,
        response: str,
        available_actions: list[TicTacToeAction],
    ) -> TicTacToeAction:
        return available_actions[0]

    async def decide(
        self,
        state: TicTacToeState,
        available_actions: list[TicTacToeAction],
    ) -> TicTacToeAction:
        """Choose a random available action."""
        return self._rng.choice(available_actions)
