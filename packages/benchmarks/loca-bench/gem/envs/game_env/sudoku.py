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

"""Sudoku Environment"""

import copy
import random
import re
from typing import Any, List, Optional, Tuple

from gem.core import Env
from gem.utils.constants import LanguageGameReward


class SudokuEnv(Env):
    def __init__(
        self,
        clues: int = 30,
        max_turns: Optional[int] = 100,
        scale=9,  # 4 for easy version
        **_,
    ):
        super().__init__()
        self.clues = clues
        self.max_turns = max_turns
        self.scale = scale
        self._is_random = scale is None or clues is None or max_turns is None
        self.reset()

    def _get_instructions(self) -> str:
        prompt = (
            f"You are playing {'A simple version of' if self.scale == 4 else ''} Sudoku.\n"
            f"Each row is numbered from 1 to {self.scale}, and each column is also numbered from 1 to {self.scale}.\n"
            f"Empty cells are represented by '.', and pre-filled cells contain digits from 1 to {self.scale}.\n\n"
        )

        prompt += (
            f"Your objective is to fill the empty cells in the {self.scale}x{self.scale} grid with digits from 1 to {self.scale} such that:\n"
            f"1. Each row contains all digits from 1 to {self.scale} without repetition.\n"
            f"2. Each column contains all digits from 1 to {self.scale} without repetition.\n"
            f"3. Each of the nine {self.scale}x{self.scale} subgrids contains all digits from 1 to {self.scale} without repetition.\n\n"
            "Rules and Instructions:\n"
            "1. **Do not overwrite** the initial numbers provided in the grid.\n"
            "2. **Only fill** empty cells represented by '.'.\n"
            "3. You may respond in any manner you prefer, but ensure that your response includes the format of '\\boxed{row column number}', e.g. \\boxed{1 1 5}.\n"
            "4. **Ensure** that your move does not violate Sudoku rules. Invalid moves, including overwriting pre-filled cells and placing two numbers in one row/col/sub-grid will result in penalties.\n"
            "The history of your moves will be appended as you play more rounds. Use the history of your move to improve your decision making by avoiding the moves you have tried. Good luck!\n\n"
        )
        return prompt

    def get_task_suffix(self) -> str:
        return (
            f"Here is the current board layout:\n{self._render_board()}\n"
            "Enter your move."
        )

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        if self._is_random:
            candidates = [(4, 10, 15), (9, 50, 50)]
            self.scale, self.clues, self.max_turns = random.choice(candidates)
        self.full_grid, self.board = self._generate_board()
        self.init_num_empty = sum([row.count(0) for row in self.board])
        self.turn_count = 0
        return self._get_instructions(), {"suffix": self.get_task_suffix()}

    def step(self, action: str) -> Tuple[str, float, bool, bool, dict[str, Any]]:
        self.turn_count += 1
        action_search_pattern = re.compile(r"\\boxed{(\d+)\s(\d+)\s(\d+)}")
        matches = list(action_search_pattern.finditer(action))
        clean_action = matches[-1] if matches else None
        try:
            row = int(clean_action.group(1)) if clean_action else None
            col = int(clean_action.group(2)) if clean_action else None
            guess_num = int(clean_action.group(3)) if clean_action else None
        except Exception:
            row, col, guess_num = None, None, None

        if row is None or col is None or guess_num is None:
            terminate_obs = "You did not provide a valid guess."
            return (
                terminate_obs,
                LanguageGameReward.format_error_reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )

        if not (
            1 <= row <= self.scale
            and 1 <= col <= self.scale
            and 1 <= guess_num <= self.scale
        ):
            next_obs = f"At turn {self.turn_count}, you tried to place {guess_num} at R{row} C{col}, which is out of bounds."
            reward = LanguageGameReward.invalid_action_reward
        else:  # valid action
            row_idx, col_idx = row - 1, col - 1
            if self.board[row_idx][col_idx] != 0:
                next_obs = f"At turn {self.turn_count}, you tried to place {guess_num} at R{row} C{col}, which is already filled. You cannot overwrite pre-filled cells."
                reward = LanguageGameReward.invalid_action_reward
            elif self._is_move_correct(row_idx, col_idx, guess_num):
                self.board[row_idx][col_idx] = guess_num
                next_obs = f"At turn {self.turn_count}, you placed {guess_num} at R{row} C{col}, which is correct."
                reward = 1 / self.init_num_empty  # reward for correct move
                if self._is_puzzle_complete():
                    terminate_obs = (
                        "Congratulations! You have completed the Sudoku puzzle!"
                    )
                    return (
                        terminate_obs,
                        reward,
                        True,
                        False,
                        {"suffix": self.get_task_suffix()},
                    )
            else:
                next_obs = f"At turn {self.turn_count}, you tried to place {guess_num} at R{row} C{col}, which violates Sudoku rules."
                reward = LanguageGameReward.invalid_action_reward
        if self.turn_count >= self.max_turns:
            terminate_obs = "You have reached the maximum number of turns."
            return terminate_obs, reward, True, True, {"suffix": self.get_task_suffix()}
        return next_obs, reward, False, False, {"suffix": self.get_task_suffix()}

    def _render_board(self, game_board: Optional[List[int]] = None) -> str:
        """
        Converts the current grid to a formatted string with row and column indices.

        Returns:
            str: Formatted grid string with indices.
        """
        if game_board is None:
            game_board = self.board

        sub_scale = int(self.scale**0.5)
        header = "   " + " ".join(
            [
                f"C{j + 1}" + ("  " if (j + 1) % sub_scale == 0 else "")
                for j in range(self.scale)
            ]
        )  # Column headers
        lines = [header]
        for i, row in enumerate(game_board):
            row_str = f"R{i + 1} "  # Row header
            for j, num in enumerate(row):
                cell = str(num) if num != 0 else "."
                row_str += f" {cell} "
                if (j + 1) % sub_scale == 0 and j < (self.scale - 1):
                    row_str += "| "
            lines.append(row_str.strip())
            if (i + 1) % sub_scale == 0 and i < (self.scale - 1):
                lines.append("   " + "- " * 2 * (self.scale - 1))

        return "\n".join(lines)

    def _generate_board(self) -> List[List[int]]:
        # generate a full grid
        full_grid = self._generate_full_grid()
        # remove cells to create a puzzle
        puzzle_grid = self._remove_cells(full_grid, self.clues)
        return full_grid, puzzle_grid

    def _generate_full_grid(self) -> List[List[int]]:
        grid = [[0 for _ in range(self.scale)] for _ in range(self.scale)]
        self._fill_grid(grid)
        return grid

    def _fill_grid(self, grid: List[List[int]]) -> bool:
        empty = self._find_empty(grid)
        if not empty:
            return True
        row, col = empty
        numbers = list(range(1, self.scale + 1))
        random.shuffle(numbers)
        for num in numbers:
            if self.is_safe(grid, row, col, num):
                grid[row][col] = num
                if self._fill_grid(grid):
                    return True
                grid[row][col] = 0
        return False

    def _find_empty(self, grid: List[List[int]]) -> Optional[Tuple[int, int]]:
        """
        Finds an empty cell in the grid.

        Args:
            grid (List[List[int]]): The Sudoku grid.

        Returns:
            Optional[Tuple[int, int]]: The row and column of an empty cell, or None if full.
        """
        for i in range(self.scale):
            for j in range(self.scale):
                if grid[i][j] == 0:
                    return (i, j)
        return None

    def is_safe(self, grid: List[List[int]], row: int, col: int, num: int) -> bool:
        """
        Checks if it's safe to place a number in a given cell.

        Args:
            grid (List[List[int]]): The Sudoku grid.
            row (int): Row index.
            col (int): Column index.
            num (int): Number to place.

        Returns:
            bool: True if safe, False otherwise.
        """
        # Check row
        if num in grid[row]:
            return False
        # Check column
        if num in [grid[i][col] for i in range(self.scale)]:
            return False
        # Check subgrid
        n = int(self.scale**0.5)
        start_row, start_col = n * (row // n), n * (col // n)
        for i in range(start_row, start_row + n):
            for j in range(start_col, start_col + n):
                if grid[i][j] == num:
                    return False
        return True

    def _remove_cells(self, grid: List[List[int]], clues: int) -> List[List[int]]:
        """
        Removes cells from the full grid to create a puzzle, ensuring a unique solution.

        Args:
            grid (List[List[int]]): A fully solved Sudoku grid.
            clues (int): Number of clues (filled cells) to retain.

        Returns:
            List[List[int]]: The resulting Sudoku puzzle grid.
        """
        puzzle = copy.deepcopy(grid)
        cells = [(i, j) for i in range(self.scale) for j in range(self.scale)]
        random.shuffle(cells)

        while len(cells) > ((self.scale**2) - clues):
            row, col = cells.pop()
            removed = puzzle[row][col]
            puzzle[row][col] = 0

            # Make a copy to check for uniqueness
            grid_copy = copy.deepcopy(puzzle)
            solutions = []
            self._count_solutions(grid_copy, solutions)
            if len(solutions) != 1:
                # Not unique, revert the removal
                puzzle[row][col] = removed

        return puzzle

    def _solve_sudoku(self, grid: List[List[int]]) -> bool:
        """
        Solves the Sudoku puzzle using backtracking. Modifies the grid in-place.

        Args:
            grid (List[List[int]]): The Sudoku grid to solve.

        Returns:
            bool: True if solvable, False otherwise.
        """
        empty = self._find_empty(grid)
        if not empty:
            return True  # Solved
        row, col = empty

        for num in range(1, self.scale + 1):
            if self.is_safe(grid, row, col, num):
                grid[row][col] = num
                if self._solve_sudoku(grid):
                    return True
                grid[row][col] = 0
        return False

    def _count_solutions(
        self, grid: List[List[int]], solutions: List[List[List[int]]], limit: int = 2
    ) -> int:
        """
        Counts the number of solutions for a given Sudoku puzzle.

        Args:
            grid (List[List[int]]): The Sudoku grid.
            solutions (List[List[List[int]]]): A list to store found solutions.
            limit (int): The maximum number of solutions to find.

        Returns:
            int: The number of solutions found.
        """
        if len(solutions) >= limit:
            return len(solutions)

        empty = self._find_empty(grid)
        if not empty:
            solutions.append(copy.deepcopy(grid))
            return len(solutions)
        row, col = empty

        for num in range(1, self.scale + 1):
            if self.is_safe(grid, row, col, num):
                grid[row][col] = num
                self._count_solutions(grid, solutions, limit)
                grid[row][col] = 0
        return len(solutions)

    def _is_move_correct(self, row: int, col: int, num: int) -> bool:
        """Check if move is correct based on the full solution grid."""
        return self.full_grid[row][col] == num

    def _is_puzzle_complete(self) -> bool:
        """
        Checks if the puzzle is completely and correctly filled.

        Returns:
            bool: True if complete, False otherwise.
        """
        for i in range(self.scale):
            for j in range(self.scale):
                num = self.board[i][j]
                if num == 0 or not self._is_move_correct_complete(i, j, num):
                    return False
        return True

    def _is_move_correct_complete(self, row: int, col: int, num: int) -> bool:
        """
        Checks if the current move is still valid in the completed puzzle.

        Args:
            row (int): Row index (0-based).
            col (int): Column index (0-based).
            num (int): Number to place.

        Returns:
            bool: True if the move is correct, False otherwise.
        """
        # Temporarily remove the number to check for duplicates
        self.board[row][col] = 0
        correct = self._is_move_correct(row, col, num)
        self.board[row][col] = num  # Restore the number
        return correct
