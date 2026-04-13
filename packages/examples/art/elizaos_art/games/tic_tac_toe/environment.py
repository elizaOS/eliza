"""
Tic-Tac-Toe Game Environment

Implements the classic 3x3 Tic-Tac-Toe game.
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

    The AI agent plays as one player (default X),
    and an opponent (random, heuristic, or minimax) plays as the other.
    """

    SIZE: ClassVar[int] = 3
    WIN_LINES: ClassVar[list[tuple[int, ...]]] = [
        (0, 1, 2),  # Rows
        (3, 4, 5),
        (6, 7, 8),
        (0, 3, 6),  # Columns
        (1, 4, 7),
        (2, 5, 8),
        (0, 4, 8),  # Diagonals
        (2, 4, 6),
    ]

    def __init__(self, config: TicTacToeConfig | None = None):
        self.config = config or TicTacToeConfig()
        self._rng: random.Random | None = None
        self._current_state: TicTacToeState | None = None
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

        # Empty board
        board = tuple([0] * 9)

        self._current_state = TicTacToeState(
            board=board,
            current_player=Player.X,  # X always goes first
            winner=None,
            is_draw=False,
        )

        # If AI plays O, let opponent move first (unless interactive mode)
        if self.config.ai_player == Player.O and self.config.opponent != "none":
            self._current_state = await self._opponent_move(self._current_state)

        return self._current_state

    async def step(
        self, action: TicTacToeAction
    ) -> tuple[TicTacToeState, float, bool]:
        """
        Execute a move and return new state.

        Args:
            action: Position to place mark (0-8)

        Returns:
            Tuple of (new_state, reward, done)
        """
        if self._current_state is None:
            raise RuntimeError("Environment not reset")

        if self._current_state.is_terminal():
            return self._current_state, 0.0, True

        # Make AI's move
        board = list(self._current_state.board)

        if board[action.value] != Player.EMPTY.value:
            # Invalid move - penalize
            return self._current_state, -0.5, False

        board[action.value] = self.config.ai_player.value
        new_state = self._check_game_state(tuple(board), self._other_player(self.config.ai_player))

        if new_state.is_terminal():
            self._current_state = new_state
            return self._current_state, self._calculate_reward(new_state), True

        # Opponent's turn (skip if interactive mode)
        if self.config.opponent != "none":
            new_state = await self._opponent_move(new_state)
        self._current_state = new_state

        reward = self._calculate_reward(new_state)
        done = new_state.is_terminal()

        return self._current_state, reward, done

    def get_available_actions(self, state: TicTacToeState) -> list[TicTacToeAction]:
        """Get list of valid moves (empty positions)."""
        if state.is_terminal():
            return []

        return [
            TicTacToeAction(i)
            for i in range(9)
            if state.board[i] == Player.EMPTY.value
        ]

    def render(self, state: TicTacToeState) -> str:
        """Render the state as a string."""
        return state.render()

    def _check_game_state(
        self, board: tuple[int, ...], next_player: Player
    ) -> TicTacToeState:
        """Check for winner or draw."""
        # Check for winner
        for line in self.WIN_LINES:
            values = [board[i] for i in line]
            if values[0] != Player.EMPTY.value and values[0] == values[1] == values[2]:
                return TicTacToeState(
                    board=board,
                    current_player=next_player,
                    winner=Player(values[0]),
                )

        # Check for draw
        if all(cell != Player.EMPTY.value for cell in board):
            return TicTacToeState(
                board=board,
                current_player=next_player,
                is_draw=True,
            )

        # Game continues
        return TicTacToeState(
            board=board,
            current_player=next_player,
        )

    def _other_player(self, player: Player) -> Player:
        """Get the other player."""
        return Player.O if player == Player.X else Player.X

    def _calculate_reward(self, state: TicTacToeState) -> float:
        """Calculate reward from AI's perspective."""
        if state.winner == self.config.ai_player:
            return 1.0  # Win
        elif state.winner == self._other_player(self.config.ai_player):
            return -1.0  # Loss
        elif state.is_draw:
            return 0.0  # Draw
        return 0.0  # Game continues

    async def _opponent_move(self, state: TicTacToeState) -> TicTacToeState:
        """Make opponent's move."""
        if state.is_terminal():
            return state

        empty_positions = [i for i, cell in enumerate(state.board) if cell == Player.EMPTY.value]
        if not empty_positions:
            return state

        opponent = self._other_player(self.config.ai_player)

        if self.config.opponent == "minimax":
            pos = self._minimax_move(state, opponent)
        elif self.config.opponent == "heuristic":
            pos = self._heuristic_move(state, opponent)
        else:  # random
            pos = self._rng.choice(empty_positions) if self._rng else empty_positions[0]

        # Make move
        board = list(state.board)
        board[pos] = opponent.value

        return self._check_game_state(tuple(board), self.config.ai_player)

    def _heuristic_move(self, state: TicTacToeState, player: Player) -> int:
        """
        Simple heuristic opponent:
        1. Win if possible
        2. Block opponent's win
        3. Take center
        4. Take corner
        5. Take edge
        """
        opponent = self._other_player(player)
        board = list(state.board)
        empty = [i for i in range(9) if board[i] == Player.EMPTY.value]

        # 1. Win if possible
        for pos in empty:
            test_board = board.copy()
            test_board[pos] = player.value
            if self._is_winner(test_board, player):
                return pos

        # 2. Block opponent
        for pos in empty:
            test_board = board.copy()
            test_board[pos] = opponent.value
            if self._is_winner(test_board, opponent):
                return pos

        # 3. Take center
        if 4 in empty:
            return 4

        # 4. Take corner
        corners = [0, 2, 6, 8]
        available_corners = [c for c in corners if c in empty]
        if available_corners and self._rng:
            return self._rng.choice(available_corners)

        # 5. Take edge
        if empty and self._rng:
            return self._rng.choice(empty)

        return empty[0] if empty else 0

    def _minimax_move(self, state: TicTacToeState, player: Player) -> int:
        """Minimax opponent - plays optimally."""
        best_score = float("-inf")
        best_move = -1
        board = list(state.board)

        for pos in range(9):
            if board[pos] == Player.EMPTY.value:
                board[pos] = player.value
                score = self._minimax(board, 0, False, player)
                board[pos] = Player.EMPTY.value

                if score > best_score:
                    best_score = score
                    best_move = pos

        return best_move

    def _minimax(
        self,
        board: list[int],
        depth: int,
        is_maximizing: bool,
        player: Player,
    ) -> float:
        """Minimax algorithm."""
        opponent = self._other_player(player)

        # Check terminal states
        if self._is_winner(board, player):
            return 10 - depth
        if self._is_winner(board, opponent):
            return depth - 10
        if all(cell != Player.EMPTY.value for cell in board):
            return 0

        if is_maximizing:
            best_score = float("-inf")
            for pos in range(9):
                if board[pos] == Player.EMPTY.value:
                    board[pos] = player.value
                    score = self._minimax(board, depth + 1, False, player)
                    board[pos] = Player.EMPTY.value
                    best_score = max(score, best_score)
            return best_score
        else:
            best_score = float("inf")
            for pos in range(9):
                if board[pos] == Player.EMPTY.value:
                    board[pos] = opponent.value
                    score = self._minimax(board, depth + 1, True, player)
                    board[pos] = Player.EMPTY.value
                    best_score = min(score, best_score)
            return best_score

    def _is_winner(self, board: list[int], player: Player) -> bool:
        """Check if player has won."""
        for line in self.WIN_LINES:
            if all(board[i] == player.value for i in line):
                return True
        return False
