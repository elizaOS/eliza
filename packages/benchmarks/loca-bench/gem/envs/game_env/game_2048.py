# Copyright 2025 AxonRL Team. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""2048 game environment."""

import math
import random
import re
from typing import Any, Dict, List, Optional, Tuple

from gem.core import Env
from gem.utils.constants import LanguageGameReward


class Game2048Env(Env):
    def __init__(
        self,
        target_tile: Optional[int] = 2048,
        max_turns: Optional[int] = 1000,
        board_size: int = 4,
        **_,
    ):
        super().__init__()
        self.target_tile = target_tile
        self.max_turns = max_turns
        self.board_size = board_size
        self._is_random = target_tile is None or max_turns is None
        self.reset()

    def _get_instructions(self) -> str:
        return (
            f"You are playing 2048.\n"
            f"Your goal is to reach the {self.target_tile} tile by sliding and merging tiles.\n"
            f"You have {self.max_turns} turns maximum.\n\n"
            "Rules:\n"
            "- When two tiles with the same number touch, they merge into one tile with double the value.\n"
            "- After each move, a new tile (2 or 4) appears in a random empty spot.\n"
            "- You can move tiles in four directions: 'up', 'down', 'left', 'right'.\n\n"
            "To submit your move, type the direction in \\boxed{...}.\n"
            f"For example: {self.sample_random_action()}\n\n"
        )

    def get_task_suffix(self) -> str:
        return f"Current board:\n{self._get_board_str()}\nEnter your move."

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        if self._is_random:
            candidates = [(16, 20), (32, 30), (64, 50)]
            self.target_tile, self.max_turns = random.choice(candidates)

        self.board = [
            [0 for _ in range(self.board_size)] for _ in range(self.board_size)
        ]
        self.turn_count = 0
        self.max_tile_achieved = 0

        # Add initial tiles
        self._add_random_tile()
        self._add_random_tile()
        self.max_tile_achieved = max(max(row) for row in self.board)
        # archive initial max_tile_achieved
        self.init_max_tile_achieved = self.max_tile_achieved

        return self._get_instructions(), {"suffix": self.get_task_suffix()}

    def _get_board_str(self) -> str:
        lines = []
        for row in self.board:
            formatted_row = []
            for cell in row:
                if cell == 0:
                    formatted_row.append("   .")
                else:
                    formatted_row.append(f"{cell:4d}")
            lines.append(" ".join(formatted_row))
        return "\n".join(lines)

    def _add_random_tile(self):
        empty_cells = []
        for i in range(self.board_size):
            for j in range(self.board_size):
                if self.board[i][j] == 0:
                    empty_cells.append((i, j))

        if empty_cells:
            i, j = random.choice(empty_cells)
            # 90% chance for 2, 10% chance for 4
            self.board[i][j] = 2 if random.random() < 0.9 else 4

    def _compress_line(self, line: List[int]) -> List[int]:
        """Compress a line by removing zeros"""
        return [x for x in line if x != 0] + [0] * line.count(0)

    def _merge_line(self, line: List[int]) -> Tuple[List[int], int]:
        """Merge adjacent equal tiles and return points earned"""
        compressed = self._compress_line(line)
        merged = []
        points = 0
        i = 0

        while i < len(compressed):
            if (
                i + 1 < len(compressed)
                and compressed[i] == compressed[i + 1]
                and compressed[i] != 0
            ):
                merged_value = compressed[i] * 2
                merged.append(merged_value)
                points += merged_value
                i += 2
            else:
                merged.append(compressed[i])
                i += 1

        # Fill with zeros to maintain board size
        while len(merged) < self.board_size:
            merged.append(0)

        return merged, points

    def _move_left(self) -> List[List[int]]:
        new_board = []

        for row in self.board:
            new_row, _ = self._merge_line(row)
            new_board.append(new_row)

        return new_board

    def _move_right(self) -> List[List[int]]:
        new_board = []

        for row in self.board:
            reversed_row = row[::-1]
            merged_row, _ = self._merge_line(reversed_row)
            new_board.append(merged_row[::-1])

        return new_board

    def _move_up(self) -> List[List[int]]:
        # Transpose board
        transposed = [
            [self.board[j][i] for j in range(self.board_size)]
            for i in range(self.board_size)
        ]

        new_transposed = []

        for row in transposed:
            new_row, _ = self._merge_line(row)
            new_transposed.append(new_row)

        # Transpose back
        new_board = [
            [new_transposed[j][i] for j in range(self.board_size)]
            for i in range(self.board_size)
        ]
        return new_board

    def _move_down(self) -> List[List[int]]:
        # Transpose board
        transposed = [
            [self.board[j][i] for j in range(self.board_size)]
            for i in range(self.board_size)
        ]

        new_transposed = []

        for row in transposed:
            reversed_row = row[::-1]
            merged_row, _ = self._merge_line(reversed_row)
            new_transposed.append(merged_row[::-1])

        # Transpose back
        new_board = [
            [new_transposed[j][i] for j in range(self.board_size)]
            for i in range(self.board_size)
        ]
        return new_board

    def _is_valid_move(self, direction: str) -> bool:
        """Check if a move would change the board state"""
        if direction == "left":
            new_board = self._move_left()
        elif direction == "right":
            new_board = self._move_right()
        elif direction == "up":
            new_board = self._move_up()
        elif direction == "down":
            new_board = self._move_down()
        else:
            return False

        return new_board != self.board

    def _is_game_over(self) -> bool:
        """Check if any moves are possible"""
        for direction in ["up", "down", "left", "right"]:
            if self._is_valid_move(direction):
                return False
        return True

    def _has_won(self) -> bool:
        """Check if target tile has been reached"""
        return self.max_tile_achieved >= self.target_tile

    def _get_progress_reward(self) -> float:
        """Calculate reward for tile progression with consistent tracking"""
        reward = 0.0
        current_max = max(max(row) for row in self.board)
        if current_max > self.target_tile:
            current_max = self.target_tile  # do not reward for exceeding target

        # Reward for reaching new maximum tile
        if current_max > self.max_tile_achieved:
            # Progressive reward based on log scale (tiles grow exponentially)
            # e.g. 4 -> 16 with target 32, the reward should be (4-2)/5 = 0.4
            reward = (math.log2(current_max) - math.log2(self.max_tile_achieved)) / (
                math.log2(self.target_tile) - math.log2(self.init_max_tile_achieved)
            )
            self.max_tile_achieved = current_max

        return reward

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        self.turn_count += 1

        # Parse action
        player_move = self._parse_action(action)
        if not player_move:
            terminate_obs = f"At turn {self.turn_count}, you did not provide a valid move. Please use \\boxed{{direction}} format."
            reward = LanguageGameReward.format_error_reward
            return (
                terminate_obs,
                reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )

        # Check if move is valid
        if not self._is_valid_move(player_move):
            next_obs = f"At turn {self.turn_count}, you chose move '{player_move}' which doesn't change the board state. Try a different direction."
            reward = LanguageGameReward.invalid_action_reward
        else:
            # Execute move
            if player_move == "left":
                new_board = self._move_left()
            elif player_move == "right":
                new_board = self._move_right()
            elif player_move == "up":
                new_board = self._move_up()
            elif player_move == "down":
                new_board = self._move_down()

            self.board = new_board

            # Add milestone rewards for tile progression
            reward = self._get_progress_reward()

            # Add new tile after successful move
            self._add_random_tile()

            # Check win condition
            if self._has_won():
                terminate_obs = f"Congratulations! You reached the {self.target_tile} tile in {self.turn_count} turns!"
                return (
                    terminate_obs,
                    reward,
                    True,
                    False,
                    {"suffix": self.get_task_suffix()},
                )

            # Check game over
            if self._is_game_over():
                terminate_obs = "Game over! No more moves possible."
                return (
                    terminate_obs,
                    reward,
                    True,
                    False,
                    {"suffix": self.get_task_suffix()},
                )

            next_obs = f"At turn {self.turn_count}, you moved {player_move}"

        # Check max turns
        if self.turn_count >= self.max_turns:
            terminate_obs = (
                f"You have reached the maximum number of turns ({self.max_turns})."
            )
            return (
                terminate_obs,
                reward,
                True,
                True,
                {"suffix": self.get_task_suffix()},
            )

        return next_obs, reward, False, False, {"suffix": self.get_task_suffix()}

    def _parse_action(self, action: str) -> Optional[str]:
        """Parse player action - only accepts up, down, left, right"""
        if not action:
            return None

        # First try to extract from \boxed{} format
        action_search_pattern = re.compile(
            r"\\boxed\{(up|down|left|right)\}", re.IGNORECASE
        )
        matches = list(action_search_pattern.finditer(action))
        clean_action = matches[-1] if matches else None
        if clean_action:
            return clean_action.group(1).lower()
        return None

    def sample_random_action(self):
        direction = random.choice(["up", "down", "left", "right"])
        return f"\\boxed{{{direction}}}"
