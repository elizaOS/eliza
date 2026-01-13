"""
Tic-Tac-Toe Agent for ART Training

LLM-based agent that learns to play optimal Tic-Tac-Toe.
"""

import re

from elizaos_art.base import BaseAgent
from elizaos_art.games.tic_tac_toe.types import (
    Player,
    TicTacToeAction,
    TicTacToeState,
)


class TicTacToeAgent(BaseAgent[TicTacToeState, TicTacToeAction]):
    """
    LLM-based agent for playing Tic-Tac-Toe.

    Uses the LLM to decide where to place markers.
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
        return """You are an expert Tic-Tac-Toe player. Your goal is to win or at least draw every game.

Key strategies:
1. If you can win, take the winning move
2. If opponent can win next turn, block them
3. Take the center (position 4) if available
4. Take corners (positions 0, 2, 6, 8) over edges
5. Look for "fork" opportunities (two ways to win)
6. Block opponent's fork attempts

Board positions:
```
 0 | 1 | 2
---+---+---
 3 | 4 | 5
---+---+---
 6 | 7 | 8
```

Respond with ONLY the position number (0-8) where you want to place your marker."""

    def format_action_prompt(
        self,
        state: TicTacToeState,
        available_actions: list[TicTacToeAction],
    ) -> str:
        """Format prompt for action selection."""
        positions = [str(a.value) for a in available_actions]

        prompt = f"""{state.to_prompt()}

Available positions: {", ".join(positions)}

Analyze the board:
1. Can you win in one move?
2. Do you need to block the opponent?
3. What's the best strategic position?

Respond with just the position number (one of: {", ".join(positions)}):"""

        return prompt

    def parse_action(
        self,
        response: str,
        available_actions: list[TicTacToeAction],
    ) -> TicTacToeAction:
        """Parse LLM response into an action."""
        response = response.strip()

        # Try direct number match
        match = re.search(r"\b([0-8])\b", response)
        if match:
            pos = int(match.group(1))
            action = TicTacToeAction(pos)
            if action in available_actions:
                return action

        # Try coordinate match
        coord_match = re.search(r"(\d)[,\s]+(\d)", response)
        if coord_match:
            try:
                row, col = int(coord_match.group(1)), int(coord_match.group(2))
                action = TicTacToeAction.from_coords(row, col)
                if action in available_actions:
                    return action
            except (ValueError, IndexError):
                pass

        # Default to first available
        return available_actions[0]

    async def decide(
        self,
        state: TicTacToeState,
        available_actions: list[TicTacToeAction],
    ) -> TicTacToeAction:
        """
        Decide which action to take.

        Falls back to heuristic when not using LLM.
        """
        if not available_actions:
            raise ValueError("No available actions")

        # Simple heuristic: center > corners > edges
        priority = [4, 0, 2, 6, 8, 1, 3, 5, 7]
        for pos in priority:
            action = TicTacToeAction(pos)
            if action in available_actions:
                return action

        return available_actions[0]


class TicTacToeOptimalAgent(BaseAgent[TicTacToeState, TicTacToeAction]):
    """
    Optimal Tic-Tac-Toe agent using minimax.

    Never loses - always plays perfectly.
    """

    @property
    def name(self) -> str:
        return "TicTacToeOptimal"

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
        """Use minimax to find optimal move."""
        return self._minimax_move(state, available_actions)

    def _minimax_move(
        self,
        state: TicTacToeState,
        available: list[TicTacToeAction],
    ) -> TicTacToeAction:
        """Find best move using minimax."""
        board = list(state.board)
        player = state.current_player

        best_score = float("-inf")
        best_move = available[0]

        for action in available:
            board[action.value] = player
            score = self._minimax(board, False, player)
            board[action.value] = Player.EMPTY.value

            if score > best_score:
                best_score = score
                best_move = action

        return best_move

    def _minimax(
        self,
        board: list[int],
        is_maximizing: bool,
        player: int,
    ) -> float:
        """Minimax with alpha-beta could be added for efficiency."""
        winner = self._check_winner(board)
        if winner is not None:
            if winner == 0:
                return 0.0
            elif winner == player:
                return 1.0
            else:
                return -1.0

        current = player if is_maximizing else Player(player).opponent().value

        if is_maximizing:
            best = float("-inf")
            for i in range(9):
                if board[i] == Player.EMPTY.value:
                    board[i] = current
                    best = max(best, self._minimax(board, False, player))
                    board[i] = Player.EMPTY.value
            return best
        else:
            best = float("inf")
            for i in range(9):
                if board[i] == Player.EMPTY.value:
                    board[i] = current
                    best = min(best, self._minimax(board, True, player))
                    board[i] = Player.EMPTY.value
            return best

    def _check_winner(self, board: list[int]) -> int | None:
        """Check for winner."""
        patterns = [
            (0, 1, 2), (3, 4, 5), (6, 7, 8),
            (0, 3, 6), (1, 4, 7), (2, 5, 8),
            (0, 4, 8), (2, 4, 6),
        ]
        for p in patterns:
            if board[p[0]] != 0 and board[p[0]] == board[p[1]] == board[p[2]]:
                return board[p[0]]
        if all(c != 0 for c in board):
            return 0
        return None


class TicTacToeHeuristicAgent(BaseAgent[TicTacToeState, TicTacToeAction]):
    """
    Heuristic Tic-Tac-Toe agent using simple position priority.

    Uses center > corners > edges strategy without full minimax search.
    """

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
        """Use simple heuristic: center > corners > edges."""
        if not available_actions:
            raise ValueError("No available actions")

        # Priority: center, then corners, then edges
        priority = [4, 0, 2, 6, 8, 1, 3, 5, 7]
        for pos in priority:
            action = TicTacToeAction(pos)
            if action in available_actions:
                return action

        return available_actions[0]


class TicTacToeRandomAgent(BaseAgent[TicTacToeState, TicTacToeAction]):
    """Random agent for baseline."""

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
        """Choose random available position."""
        return self._rng.choice(available_actions)
