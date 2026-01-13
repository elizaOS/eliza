"""
Tic-Tac-Toe Environment

Classic 3x3 Tic-Tac-Toe with configurable opponent.
"""

import random
from typing import ClassVar

from elizaos_art.base import BaseEnvironment
from elizaos_art.games.tic_tac_toe.types import (
    Player,
    TicTacToeAction,
    TicTacToeConfig,
    TicTacToeState,
)


class TicTacToeEnvironment(BaseEnvironment[TicTacToeState, TicTacToeAction]):
    """
    Tic-Tac-Toe game environment.

    The agent plays against a configurable opponent.
    """

    SIZE: ClassVar[int] = 3
    WIN_PATTERNS: ClassVar[list[tuple[int, ...]]] = [
        (0, 1, 2),  # Top row
        (3, 4, 5),  # Middle row
        (6, 7, 8),  # Bottom row
        (0, 3, 6),  # Left column
        (1, 4, 7),  # Center column
        (2, 5, 8),  # Right column
        (0, 4, 8),  # Diagonal
        (2, 4, 6),  # Anti-diagonal
    ]

    def __init__(self, config: TicTacToeConfig | None = None):
        self.config = config or TicTacToeConfig()
        self._rng: random.Random | None = None
        self._current_state: TicTacToeState | None = None
        self._agent_player = Player(self.config.ai_player)
        self._initialized = False

    @property
    def name(self) -> str:
        return "tic_tac_toe"

    @property
    def description(self) -> str:
        return "Classic Tic-Tac-Toe. Get three in a row to win!"

    async def initialize(self) -> None:
        """Initialize the environment."""
        self._initialized = True

    async def reset(self, seed: int | None = None) -> TicTacToeState:
        """Reset the game and return initial state."""
        self._rng = random.Random(seed)

        # Create empty board
        board = [Player.EMPTY.value] * 9

        # X always goes first
        self._current_state = TicTacToeState(
            board=tuple(board),
            current_player=Player.X.value,
            winner=None,
            move_count=0,
        )

        # If agent is O, opponent (X) moves first
        # Note: When opponent="none" (interactive mode), _get_opponent_move returns None
        # and we skip the automatic opponent move - the caller handles human input
        if self._agent_player == Player.O:
            opponent_move = self._get_opponent_move(self._current_state)
            if opponent_move is not None:
                board = list(self._current_state.board)
                board[opponent_move.value] = Player.X.value
                self._current_state = TicTacToeState(
                    board=tuple(board),
                    current_player=Player.O.value,
                    winner=None,
                    move_count=1,
                )

        return self._current_state

    async def step(
        self, action: TicTacToeAction
    ) -> tuple[TicTacToeState, float, bool]:
        """
        Execute a move.

        Args:
            action: Position to place marker

        Returns:
            Tuple of (new_state, reward, done)
        """
        if self._current_state is None:
            raise RuntimeError("Environment not reset")

        if self._current_state.winner is not None:
            return self._current_state, 0.0, True

        board = list(self._current_state.board)
        current = Player(self._current_state.current_player)

        # Validate move
        if board[action.value] != Player.EMPTY.value:
            # Invalid move penalty
            return self._current_state, -1.0, True

        # Make agent's move
        board[action.value] = current.value
        check_result = self._check_winner(board)
        move_count = self._current_state.move_count + 1

        if check_result is not None:
            # Game over - convert _check_winner result to proper state
            # _check_winner returns 0 for draw, 1/2 for winner
            is_draw = check_result == 0
            winner = None if is_draw else check_result
            self._current_state = TicTacToeState(
                board=tuple(board),
                current_player=current.opponent().value,
                winner=winner,
                is_draw=is_draw,
                move_count=move_count,
            )
            reward = self._calculate_reward(check_result)
            return self._current_state, reward, True

        # Opponent's turn
        opponent = current.opponent()
        temp_state = TicTacToeState(
            board=tuple(board),
            current_player=opponent.value,
            winner=None,
            move_count=move_count,
        )

        # Get opponent move
        opponent_move = self._get_opponent_move(temp_state)
        if opponent_move is not None:
            board[opponent_move.value] = opponent.value
            check_result = self._check_winner(board)
            move_count += 1
        else:
            check_result = None

        # Convert _check_winner result to proper state
        is_draw = check_result == 0
        winner = None if (check_result is None or is_draw) else check_result
        self._current_state = TicTacToeState(
            board=tuple(board),
            current_player=current.value,  # Back to agent's turn
            winner=winner,
            is_draw=is_draw,
            move_count=move_count,
        )

        done = check_result is not None
        reward = self._calculate_reward(check_result) if done else 0.0
        return self._current_state, reward, done

    def get_available_actions(self, state: TicTacToeState) -> list[TicTacToeAction]:
        """Get empty positions."""
        # Check terminal conditions - consistent with TicTacToeState.is_terminal()
        if state.winner is not None or state.is_draw:
            return []

        return [
            TicTacToeAction(i)
            for i in range(9)
            if state.board[i] == Player.EMPTY.value
        ]

    def render(self, state: TicTacToeState) -> str:
        """Render the state."""
        return state.render()

    def _check_winner(self, board: list[int]) -> int | None:
        """
        Check for a winner (internal helper).

        Note: This is an internal method. Callers should convert the result
        to proper TicTacToeState fields: winner=None and is_draw=True for draws.

        Returns:
            1 if X wins, 2 if O wins, 0 if draw, None if game ongoing.
        """
        for pattern in self.WIN_PATTERNS:
            values = [board[i] for i in pattern]
            if values[0] != Player.EMPTY.value and values[0] == values[1] == values[2]:
                return values[0]

        # Check for draw
        if all(cell != Player.EMPTY.value for cell in board):
            return 0

        return None

    def _calculate_reward(self, winner: int | None) -> float:
        """Calculate reward based on game outcome."""
        if winner is None:
            return 0.0
        elif winner == 0:
            return 0.0  # Draw
        elif winner == self._agent_player.value:
            return 1.0  # Win
        else:
            return -1.0  # Loss

    def _get_opponent_move(self, state: TicTacToeState) -> TicTacToeAction | None:
        """Get opponent's move based on config.

        Supported opponent types:
        - "none": No automatic opponent (interactive/human play). Returns None.
        - "random": Selects a random available position.
        - "heuristic": Simple priority-based strategy (center > corners > edges).
        - "optimal" / "minimax": Uses minimax algorithm for perfect play.

        Returns:
            The opponent's move, or None if no available moves or opponent="none".

        Raises:
            ValueError: If opponent type is not recognized.
        """
        available = self.get_available_actions(state)
        if not available:
            return None

        if self.config.opponent == "none":
            # Interactive mode: no automatic opponent, caller handles input
            return None
        elif self.config.opponent == "random":
            if self._rng is None:
                self._rng = random.Random()
            return self._rng.choice(available)
        elif self.config.opponent == "heuristic":
            return self._heuristic_move(available)
        elif self.config.opponent in ("optimal", "minimax"):
            return self._minimax_move(state)
        else:
            raise ValueError(
                f"Unknown opponent type: {self.config.opponent!r}. "
                f"Expected one of: 'none', 'random', 'heuristic', 'optimal', 'minimax'"
            )

    def _heuristic_move(self, available: list[TicTacToeAction]) -> TicTacToeAction:
        """Get a move using simple heuristics.
        
        Priority: center (4) > corners (0,2,6,8) > edges (1,3,5,7)
        """
        # Priority order: center, then corners, then edges
        priority = [4, 0, 2, 6, 8, 1, 3, 5, 7]
        for pos in priority:
            action = TicTacToeAction(pos)
            if action in available:
                return action
        # Fallback (shouldn't reach here if available is non-empty)
        return available[0]

    def _minimax_move(self, state: TicTacToeState) -> TicTacToeAction:
        """Get optimal move using minimax."""
        board = list(state.board)
        player = state.current_player

        best_score = float("-inf")
        best_move = None

        for action in self.get_available_actions(state):
            board[action.value] = player
            score = self._minimax(board, False, player)
            board[action.value] = Player.EMPTY.value

            if score > best_score:
                best_score = score
                best_move = action

        return best_move if best_move is not None else self.get_available_actions(state)[0]

    def _minimax(
        self,
        board: list[int],
        is_maximizing: bool,
        player: int,
    ) -> float:
        """Minimax algorithm."""
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
            best_score = float("-inf")
            for i in range(9):
                if board[i] == Player.EMPTY.value:
                    board[i] = current
                    score = self._minimax(board, False, player)
                    board[i] = Player.EMPTY.value
                    best_score = max(best_score, score)
            return best_score
        else:
            best_score = float("inf")
            for i in range(9):
                if board[i] == Player.EMPTY.value:
                    board[i] = current
                    score = self._minimax(board, True, player)
                    board[i] = Player.EMPTY.value
                    best_score = min(best_score, score)
            return best_score
