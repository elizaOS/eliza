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

"""Crosswords game environment - adapted from TextArena."""

import copy
import importlib
import random
import re
from typing import Any, Dict, Optional, Tuple

import pandas as pd

from gem.core import Env
from gem.utils.constants import LanguageGameReward


class CrosswordsEnv(Env):
    """Crosswords puzzle environment where player fills letters based on clues."""

    def __init__(
        self,
        hardcore: bool = False,
        max_turns: int = 100,
        num_words: int = 5,
        **_,
    ):
        super().__init__()
        self.hardcore = hardcore
        self.max_turns = max_turns
        self.num_words = num_words
        self._is_random = hardcore is None or max_turns is None or num_words is None
        self._load_words(hardcore=hardcore)
        self.reset()

    def _load_words(self, words_path: Optional[str] = None, hardcore: bool = False):
        """Load word database using pandas for cleaner data handling."""
        if words_path is None:
            words_path = importlib.resources.files(
                "gem.envs.game_env.crosswords"
            ).joinpath("words_clues.jsonl")

        df = pd.read_json(words_path, lines=True)
        filtered_df = df[df["hardcore"] == hardcore]
        if filtered_df.empty:
            raise ValueError(f"No words found matching hardcore={hardcore} criteria.")
        self.word_data = filtered_df.to_dict("records")

    def _get_instructions(self) -> str:
        return (
            "You are playing Crosswords.\n"
            "Here is the current state of the Crosswords grid. Each row and column are numbered.\n"
            "The cells that need to be populated with letters are represented by '_', and those that do not need words are represented by '.'.\n\n"
            "You can only provide one response per turn. Hence, plan your approach and risk appetite.\n"
            "Only guesses in the format of \\boxed{row column letter} will be fetched from your response, e.g. \\boxed{0 0 d}, \\boxed{1 2 G}.\n"
            f"you have to finish the game in a maximum of {self.max_turns} turns.\n"
            "As you play, the history of your choices will be appended below. Use the information to complete the game."
        )

    def get_task_suffix(self) -> str:
        return (
            f"Current Board:\n{self._render_board()}\n"
            f"Here are the clues for the words you need to find:\n{self._clue_generator()}\n"
            "Enter your guess."
        )

    def reset(self, seed: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
        super().reset(seed)

        if self._is_random:
            self.hardcore = random.choice([False, True])
            self.num_words = 3
            self.max_turns = 20
            self._load_words(hardcore=self.hardcore)

        # Generate the game board and placed words for the clues
        game_board, placed_words, clues = self._generate_board()

        self.solution = copy.copy(game_board)
        self.board = self._hide_letters(game_board)
        self.clues = clues
        self.placed_words = placed_words

        # Calculate total letter cells for progressive reward
        self.total_letter_cells = sum(
            1 for row in self.board for cell in row if cell != "."
        )
        self.turn_count = 0

        return self._get_instructions(), {"suffix": self.get_task_suffix()}

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        self.turn_count += 1

        # Parse action: row column letter with \boxed{} format
        row, col, letter = self._parse_action(action)

        if row is None or col is None or letter is None:
            terminate_obs = f"At turn {self.turn_count}, you did not provide a valid guess in \\boxed{{row column letter}} format."
            return (
                terminate_obs,
                LanguageGameReward.format_error_reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )

        if row < 0 or row >= len(self.board) or col < 0 or col >= len(self.board[0]):
            next_obs = f"At turn {self.turn_count}, you tried to place {letter} at ({row}, {col}), which is out of bounds."
            reward = LanguageGameReward.invalid_action_reward
        elif self.board[row][col] == ".":
            next_obs = f"At turn {self.turn_count}, you tried to place {letter} at ({row}, {col}), which is a black dot and cannot be filled."
            reward = LanguageGameReward.invalid_action_reward
        elif self.board[row][col] != "_":
            next_obs = f"At turn {self.turn_count}, you tried to place {letter} at ({row}, {col}), but the cell is already filled."
            reward = LanguageGameReward.invalid_action_reward
        elif not self.solution[row][col].upper() == letter:
            next_obs = f"At turn {self.turn_count}, you tried to place {letter} at ({row}, {col}), but it is incorrect."
            reward = LanguageGameReward.internal_step_reward
        else:
            # Valid move
            self.board[row][col] = letter
            next_obs = f"At turn {self.turn_count}, you placed {letter} at ({row}, {col}) correctly."
            reward = (
                1 / self.total_letter_cells
            )  # Each correct letter gives a small reward

        # Check if game is complete
        if self._is_game_over():
            next_obs = "Congratulations! You completed the Crosswords puzzle!"
            return (
                next_obs,
                reward,
                True,
                False,
                {"suffix": self.get_task_suffix()},
            )

        # Check max turns
        if self.turn_count >= self.max_turns:
            terminate_obs = "You have reached the maximum number of turns."
            return terminate_obs, reward, True, True, {"suffix": self.get_task_suffix()}

        return next_obs, reward, False, False, {"suffix": self.get_task_suffix()}

    def sample_random_action(self) -> str:
        """Generate a random action for sampling."""
        if hasattr(self, "board"):
            # Find empty cells
            empty_cells = []
            for i, row in enumerate(self.board):
                for j, cell in enumerate(row):
                    if cell == "_":
                        empty_cells.append((i, j))

            if empty_cells:
                row, col = random.choice(empty_cells)
                letter = random.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
                return f"\\boxed{{[{row} {col} {letter}]}}"

        return "\\boxed{[0 0 A]}"

    def _generate_board(self):
        """Generate crossword board with placed words - adapted from TextArena."""
        # Sample words, their directions and their clues
        sampled_word_data = random.sample(
            self.word_data, min(self.num_words, len(self.word_data))
        )
        sampled_word_data_sorted = sorted(
            sampled_word_data, key=lambda x: len(x["word"]), reverse=True
        )
        words = [x["word"] for x in sampled_word_data_sorted]
        directions = {
            x["word"]: random.choice(["across", "down"])
            for x in sampled_word_data_sorted
        }
        clues = {
            x["word"]: list(x["clues"].values())[0] for x in sampled_word_data_sorted
        }

        # Generate the crossword grid
        grid_size = self._determine_initial_grid_size(words)
        grid = self._create_empty_grid(grid_size)
        placed_words = {}  # word: (row, col, direction)

        for word in words:
            placed = False
            if not placed_words:  # First word
                # Place the first word in the center of the grid
                if directions[word] == "across":
                    row = grid_size // 2
                    col = (grid_size - len(word)) // 2
                else:
                    row = (grid_size - len(word)) // 2
                    col = grid_size // 2

                if self._can_place_word(grid, word, directions[word], row, col):
                    self._place_word_on_grid(grid, word, directions[word], row, col)
                    placed_words[word] = (row, col, directions[word])
                    placed = True
            else:
                # Attempt to find overlaps
                possible_positions = self._find_overlaps(
                    word, grid, placed_words, directions
                )
                random.shuffle(possible_positions)  # Randomize to add variability
                for pos in possible_positions:
                    row, col, direction = pos
                    if self._can_place_word(grid, word, direction, row, col):
                        self._place_word_on_grid(grid, word, direction, row, col)
                        placed_words[word] = (row, col, direction)
                        placed = True
                        break

            if not placed:
                # If no overlap placement is possible, try placing the word in any free position
                for row in range(grid_size):
                    for col in range(grid_size):
                        if self._can_place_word(grid, word, directions[word], row, col):
                            self._place_word_on_grid(
                                grid, word, directions[word], row, col
                            )
                            placed_words[word] = (row, col, directions[word])
                            placed = True
                            break
                    if placed:
                        break

        return grid, placed_words, clues

    def _determine_initial_grid_size(self, words):
        """Determine the initial size of the grid based on the length of the longest word."""
        max_length = max(len(word) for word in words)
        return round(max_length * 1.5)  # Ensures grid is larger than longest word

    def _create_empty_grid(self, size):
        """Create an empty grid of the specified size."""
        return [["." for _ in range(size)] for _ in range(size)]

    def _can_place_word(self, grid, word, direction, row, col):
        """Check if a word can be placed on the grid at the specified position."""
        if direction == "across":
            if col + len(word) > len(grid[0]):
                return False
            for i, letter in enumerate(word):
                current_cell = grid[row][col + i]
                if current_cell != "." and current_cell != letter:
                    return False
        else:  # "down"
            if row + len(word) > len(grid):
                return False
            for i, letter in enumerate(word):
                current_cell = grid[row + i][col]
                if current_cell != "." and current_cell != letter:
                    return False
        return True

    def _place_word_on_grid(self, grid, word, direction, row, col):
        """Place a word on the grid at the specified position."""
        if direction == "across":
            for i, letter in enumerate(word):
                grid[row][col + i] = letter
        else:  # "down"
            for i, letter in enumerate(word):
                grid[row + i][col] = letter

    def _find_overlaps(self, word, grid, placed_words, directions):
        """Find all possible valid overlaps for the word with already placed words."""
        overlaps = []
        for placed_word, (p_row, p_col, p_direction) in placed_words.items():
            for i, letter in enumerate(word):
                for j, placed_letter in enumerate(placed_word):
                    if letter == placed_letter:
                        # Determine the possible position based on the direction of the placed word
                        if p_direction == "across":
                            row = p_row - i
                            col = p_col + j
                            if (
                                directions[word] == "down"
                                and 0 <= row < len(grid)
                                and 0 <= col < len(grid[0])
                            ):
                                if self._can_place_word(grid, word, "down", row, col):
                                    overlaps.append((row, col, "down"))
                        elif p_direction == "down":
                            row = p_row + j
                            col = p_col - i
                            if (
                                directions[word] == "across"
                                and 0 <= row < len(grid)
                                and 0 <= col < len(grid[0])
                            ):
                                if self._can_place_word(grid, word, "across", row, col):
                                    overlaps.append((row, col, "across"))
        return overlaps

    def _render_board(self):
        """Render the grid for text display."""
        if not hasattr(self, "board"):
            return "Board not initialized"

        header = "   " + " ".join(f"C{i:02}" for i in range(len(self.board)))
        lines = [header]
        for i, row in enumerate(self.board):
            row_str = f"R{i:02} "
            for val in row:
                row_str += f" {val}  "
            lines.append(row_str)
        return "\n".join(lines)

    def _hide_letters(self, grid):
        """Hide the letters in the grid."""
        return [["_" if cell != "." else cell for cell in row] for row in grid]

    def _get_percentage_completion(self) -> float:
        """Compute the percentage of the crossword that has been solved so far."""
        total_letter_cells = (
            0  # Count every cell that should eventually contain a letter
        )
        filled_letter_cells = 0
        for row in self.board:
            for cell in row:
                if cell != ".":  # not a black square
                    total_letter_cells += 1
                    if cell != "_" and cell.isalpha():  # already revealed / guessed
                        filled_letter_cells += 1
        if total_letter_cells == 0:  # safety guard
            return 0.0
        return filled_letter_cells / total_letter_cells

    def _is_game_over(self) -> bool:
        """Check if the game is over."""
        return all("_" not in row for row in self.board)

    def _clue_generator(self):
        """Generate clues string for display."""
        if not hasattr(self, "placed_words") or not hasattr(self, "clues"):
            return "No clues available"

        res = []
        for i, (word, clue) in enumerate(self.clues.items()):
            if word in self.placed_words:
                direction = self.placed_words[word][2]
                res.append(f"{i + 1}. {clue} ({direction}): {len(word)} letters")
        return "\n".join(res)

    def _parse_action(self, action: str) -> Optional[Tuple[int, int, str]]:
        """Parse the action string to extract row, column, and letter."""
        boxed_pattern = re.compile(r"\\boxed\{(\d+)\s+(\d+)\s+([a-zA-Z])\}")
        matches = list(boxed_pattern.finditer(action))
        match = matches[-1] if matches else None
        if match:
            row, col, letter = match.groups(1)
            return int(row), int(col), letter.upper()
        return None, None, None
