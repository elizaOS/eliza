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

"""Fifteen Puzzle environment"""

import random
import re
from typing import Any, Dict, List, Optional, Tuple

from gem.core import Env
from gem.utils.constants import LanguageGameReward


class FifteenPuzzleEnv(Env):
    def __init__(self, max_turns: Optional[int] = 20, num_rows: Optional[int] = 2, **_):
        super().__init__()
        self.max_turns = max_turns
        self.num_rows = num_rows
        self._is_random = num_rows is None or max_turns is None
        self.reset()

    def _get_instructions(self) -> str:
        return (
            f"You are playing the {self.greatest_num}-Puzzle game.\n"
            f"You have to arrange the numbered tiles in ascending order from 1 to {self.greatest_num}, with the empty space located in the bottom-right corner.\n"
            "To make a move, you can slide a tile into the empty space (represented by a double underscore, e.g. __) by using one of the following commands:\n"
            "- 'up': Move the tile below the empty space up.\n"
            "- 'down': Move the tile above the empty space down.\n"
            "- 'left': Move the tile to the right of the empty space left.\n"
            "- 'right': Move the tile to the left of the empty space right.\n"
            "To submit your move, type the direction (e.g., 'up', 'down', 'left', or 'right') in \\boxed{...}.\n"
            "The current board layout is shown below\n"
            "Use logic and planning to solve the puzzle.\n"
        )

    def get_task_suffix(self) -> str:
        return (
            f"Here is the current board layout: \n{self._render_board()}\n"
            "Enter your move."
        )

    def reset(self, seed: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
        super().reset(seed)
        if self._is_random:
            candidates = [(2, 10), (3, 20), (4, 50)]
            self.num_rows, self.max_turns = random.choice(candidates)

        self.greatest_num = self.num_rows**2 - 1
        self.board = self._generate_board()
        self.turn_count = 0
        return self._get_instructions(), {"suffix": self.get_task_suffix()}

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        self.turn_count += 1
        action_search_pattern = re.compile(
            r"\\boxed{(up|down|left|right)}"
        )  # e.g. \\boxed{up}
        matches = list(action_search_pattern.finditer(action))
        clean_action = matches[-1] if matches else None

        try:
            player_guess = clean_action.group(1).lower() if clean_action else None
        except Exception:
            player_guess = None

        if player_guess is None:
            terminate_obs = (
                f"At turn {self.turn_count}, you did not provide a valid guess"
            )
            return (
                terminate_obs,
                LanguageGameReward.format_error_reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )
        else:
            is_valid_move = self._move(player_guess)
            if not is_valid_move:  # invalid action
                next_obs = f"At turn {self.turn_count}, you chose a move {player_guess} that is outside the bounds of the board."
                reward = LanguageGameReward.invalid_action_reward
            else:
                if self._is_solved():
                    terminate_obs = "Congratulations! You have solved the puzzle!"
                    reward = LanguageGameReward.success_reward
                    return (
                        terminate_obs,
                        reward,
                        True,
                        False,
                        {"suffix": self.get_task_suffix()},
                    )
                else:
                    next_obs = f"At turn {self.turn_count}, you made a valid move: {player_guess}.\n"
                    reward = LanguageGameReward.internal_step_reward

        if self.turn_count >= self.max_turns:
            terminate_obs = "You have reached the maximum number of turns."
            reward += self._get_soft_reward()
            return terminate_obs, reward, True, True, {"suffix": self.get_task_suffix()}
        return next_obs, reward, False, False, {"suffix": self.get_task_suffix()}

    def _get_soft_reward(self) -> float:
        def _is_equal(a, b) -> bool:
            return a == b or (a is None and b is None)

        correct_tiles = list(range(1, self.greatest_num + 1)) + [None]
        current_tiles = [tile for row in self.board for tile in row]
        reward = 0
        for cor, cur in zip(correct_tiles, current_tiles):
            if _is_equal(cor, cur):
                reward += 1 / (self.greatest_num + 1)
        return reward

    def _generate_board(self) -> List[List[Optional[int]]]:
        tiles = list(range(1, self.greatest_num + 1)) + [None]
        random.shuffle(tiles)
        return [
            tiles[i : i + self.num_rows]
            for i in range(0, self.greatest_num + 1, self.num_rows)
        ]

    def _render_board(self) -> str:
        rendered_board = ""
        for row in self.board:
            rendered_board += (
                " ".join(["__" if x is None else f"{x:2}" for x in row]) + "\n"
            )
        return rendered_board

    def _move(self, direction: str) -> bool:
        empty_row, empty_col = self._get_empty_position()
        target_row, target_col = empty_row, empty_col
        if direction == "up" and empty_row < self.num_rows - 1:
            target_row += 1
        elif direction == "down" and empty_row > 0:
            target_row -= 1
        elif direction == "left" and empty_col < self.num_rows - 1:
            target_col += 1
        elif direction == "right" and empty_col > 0:
            target_col -= 1
        else:  # invalid move
            return False

        self.board[empty_row][empty_col], self.board[target_row][target_col] = (
            self.board[target_row][target_col],
            self.board[empty_row][empty_col],
        )
        return True

    def _get_empty_position(self):
        for r in range(self.num_rows):
            for c in range(self.num_rows):
                if self.board[r][c] is None:
                    return r, c

    def _is_solved(self) -> bool:
        correct_tiles = list(range(1, self.greatest_num + 1)) + [None]
        current_tiles = [tile for row in self.board for tile in row]
        return current_tiles == correct_tiles

    def sample_random_action(self) -> str:
        return random.choice(["up", "down", "left", "right"])
