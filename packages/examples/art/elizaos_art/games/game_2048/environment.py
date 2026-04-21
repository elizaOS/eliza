"""
2048 Game Environment

Implements the classic 2048 tile-merging game.
"""

import random
from typing import ClassVar

from elizaos_art.base import BaseEnvironment
from elizaos_art.games.game_2048.types import (
    Game2048Action,
    Game2048Config,
    Game2048State,
)


class Game2048Environment(BaseEnvironment[Game2048State, Game2048Action]):
    """
    2048 game environment.

    The goal is to merge tiles to create the 2048 tile (or higher).
    Each move slides all tiles in a direction, merging equal adjacent tiles.
    After each move, a new 2 or 4 tile spawns randomly.
    """

    SIZE: ClassVar[int] = 4

    def __init__(self, config: Game2048Config | None = None):
        self.config = config or Game2048Config()
        self._rng: random.Random | None = None
        self._current_state: Game2048State | None = None
        self._initialized = False

    @property
    def name(self) -> str:
        return "game_2048"

    @property
    def description(self) -> str:
        return "2048 tile-merging puzzle game. Merge tiles to reach 2048!"

    async def initialize(self) -> None:
        """Initialize the environment."""
        self._initialized = True

    async def reset(self, seed: int | None = None) -> Game2048State:
        """Reset the game and return initial state."""
        self._rng = random.Random(seed)

        # Create empty board
        board = [0] * (self.SIZE * self.SIZE)

        # Spawn initial tiles
        board = self._spawn_tile(board)
        board = self._spawn_tile(board)

        self._current_state = Game2048State(
            board=tuple(board),
            score=0,
            max_tile=max(board),
            move_count=0,
            game_over=False,
        )
        return self._current_state

    async def step(
        self, action: Game2048Action
    ) -> tuple[Game2048State, float, bool]:
        """
        Execute a move and return new state.

        Args:
            action: Direction to move

        Returns:
            Tuple of (new_state, reward, done)
        """
        if self._current_state is None:
            raise RuntimeError("Environment not reset")

        board = list(self._current_state.board)
        old_score = self._current_state.score

        # Apply move
        board, score_delta, moved = self._apply_move(board, action)

        if moved:
            # Spawn new tile
            board = self._spawn_tile(board)

        # Check game over
        game_over = self._is_game_over(board)

        # Calculate new score
        new_score = old_score + score_delta
        max_tile = max(board)

        # Create new state
        self._current_state = Game2048State(
            board=tuple(board),
            score=new_score,
            max_tile=max_tile,
            move_count=self._current_state.move_count + 1,
            game_over=game_over,
        )

        # Calculate reward based on config
        reward = self._calculate_reward(score_delta, max_tile, game_over)

        return self._current_state, reward, game_over

    def get_available_actions(self, state: Game2048State) -> list[Game2048Action]:
        """Get list of valid moves (moves that change the board)."""
        if state.game_over:
            return []

        valid_actions = []
        board = list(state.board)

        for action in Game2048Action:
            _, _, moved = self._apply_move(board.copy(), action)
            if moved:
                valid_actions.append(action)

        return valid_actions

    def render(self, state: Game2048State) -> str:
        """Render the state as a string."""
        return state.render()

    def _spawn_tile(self, board: list[int]) -> list[int]:
        """Spawn a new tile (2 or 4) in a random empty cell."""
        if self._rng is None:
            self._rng = random.Random()

        empty_cells = [i for i, v in enumerate(board) if v == 0]
        if not empty_cells:
            return board

        pos = self._rng.choice(empty_cells)
        value = 4 if self._rng.random() < self.config.spawn_4_probability else 2
        board[pos] = value
        return board

    def _apply_move(
        self, board: list[int], action: Game2048Action
    ) -> tuple[list[int], int, bool]:
        """
        Apply a move to the board.

        Returns:
            Tuple of (new_board, score_delta, moved)
        """
        original = board.copy()
        score_delta = 0

        if action == Game2048Action.UP:
            board, score_delta = self._move_up(board)
        elif action == Game2048Action.DOWN:
            board, score_delta = self._move_down(board)
        elif action == Game2048Action.LEFT:
            board, score_delta = self._move_left(board)
        elif action == Game2048Action.RIGHT:
            board, score_delta = self._move_right(board)

        moved = board != original
        return board, score_delta, moved

    def _compress(self, line: list[int]) -> list[int]:
        """Compress a line by removing zeros."""
        return [x for x in line if x != 0]

    def _merge(self, line: list[int]) -> tuple[list[int], int]:
        """Merge adjacent equal tiles and return score."""
        score = 0
        result: list[int] = []
        i = 0
        while i < len(line):
            if i + 1 < len(line) and line[i] == line[i + 1]:
                merged = line[i] * 2
                result.append(merged)
                score += merged
                i += 2
            else:
                result.append(line[i])
                i += 1
        return result, score

    def _process_line(self, line: list[int]) -> tuple[list[int], int]:
        """Compress, merge, and pad a line."""
        compressed = self._compress(line)
        merged, score = self._merge(compressed)
        # Pad with zeros
        while len(merged) < self.SIZE:
            merged.append(0)
        return merged, score

    def _get_row(self, board: list[int], row: int) -> list[int]:
        """Get a row from the board."""
        return board[row * self.SIZE : (row + 1) * self.SIZE]

    def _set_row(self, board: list[int], row: int, values: list[int]) -> None:
        """Set a row in the board."""
        for col in range(self.SIZE):
            board[row * self.SIZE + col] = values[col]

    def _get_col(self, board: list[int], col: int) -> list[int]:
        """Get a column from the board."""
        return [board[row * self.SIZE + col] for row in range(self.SIZE)]

    def _set_col(self, board: list[int], col: int, values: list[int]) -> None:
        """Set a column in the board."""
        for row in range(self.SIZE):
            board[row * self.SIZE + col] = values[row]

    def _move_left(self, board: list[int]) -> tuple[list[int], int]:
        """Move all tiles left."""
        total_score = 0
        for row in range(self.SIZE):
            line = self._get_row(board, row)
            new_line, score = self._process_line(line)
            self._set_row(board, row, new_line)
            total_score += score
        return board, total_score

    def _move_right(self, board: list[int]) -> tuple[list[int], int]:
        """Move all tiles right."""
        total_score = 0
        for row in range(self.SIZE):
            line = self._get_row(board, row)
            line.reverse()
            new_line, score = self._process_line(line)
            new_line.reverse()
            self._set_row(board, row, new_line)
            total_score += score
        return board, total_score

    def _move_up(self, board: list[int]) -> tuple[list[int], int]:
        """Move all tiles up."""
        total_score = 0
        for col in range(self.SIZE):
            line = self._get_col(board, col)
            new_line, score = self._process_line(line)
            self._set_col(board, col, new_line)
            total_score += score
        return board, total_score

    def _move_down(self, board: list[int]) -> tuple[list[int], int]:
        """Move all tiles down."""
        total_score = 0
        for col in range(self.SIZE):
            line = self._get_col(board, col)
            line.reverse()
            new_line, score = self._process_line(line)
            new_line.reverse()
            self._set_col(board, col, new_line)
            total_score += score
        return board, total_score

    def _is_game_over(self, board: list[int]) -> bool:
        """Check if no moves are possible."""
        # Check for empty cells
        if 0 in board:
            return False

        # Check for possible merges
        for row in range(self.SIZE):
            for col in range(self.SIZE):
                val = board[row * self.SIZE + col]
                # Check right neighbor
                if col < self.SIZE - 1:
                    if board[row * self.SIZE + col + 1] == val:
                        return False
                # Check bottom neighbor
                if row < self.SIZE - 1:
                    if board[(row + 1) * self.SIZE + col] == val:
                        return False

        return True

    def _calculate_reward(
        self, score_delta: int, max_tile: int, game_over: bool
    ) -> float:
        """Calculate reward based on configuration."""
        if self.config.reward_type == "score":
            return float(score_delta)
        elif self.config.reward_type == "max_tile":
            # Reward based on achieving new max tiles
            import math

            if max_tile >= self.config.target_tile:
                return 100.0
            return float(math.log2(max_tile)) if max_tile > 0 else 0.0
        elif self.config.reward_type == "combined":
            # Combine score and milestone bonuses
            reward = float(score_delta)
            milestones = [128, 256, 512, 1024, 2048, 4096]
            for milestone in milestones:
                if max_tile >= milestone:
                    reward += milestone * 0.1
            return reward
        else:
            return float(score_delta)
