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

"""Word Search game environment - adapted from TextArena."""

import random
import re
import string
from typing import Any, Dict, List, Optional, Tuple

from nltk.corpus import words

from gem.core import Env
from gem.utils.constants import LanguageGameReward


class WordSearchEnv(Env):
    """Word Search puzzle environment where player finds hidden words in a grid."""

    def __init__(
        self,
        hardcore: bool = False,
        max_turns: int = 20,
        num_words: int = 5,
        **_,
    ):
        super().__init__()
        self.hardcore = hardcore
        self.max_turns = max_turns
        self.num_words = num_words
        self._is_random = hardcore is None or max_turns is None or num_words is None
        self.reset()

    def _get_instructions(self) -> str:
        return (
            f"You are participating in a Word Search challenge ({'Hardcore' if self.hardcore else 'Basic'}).\n"
            "The objective is to find and highlight hidden words on the grid below.\n"
            "The rows and columns are numbered for your reference.\n\n"
            "Words you have already found are marked in square brackets [ ].\n"
            "Each row and column is numbered for clarity.\n\n"
            "To locate a word, specify the row and column of its start and end letters.\n"
            "Note that words are either across (horizontal) or down (vertical).\n"
            "Use the format \\boxed{start_row start_col end_row end_col} for submission.\n"
            "For instance: \\boxed{1 1 1 5} to find a word from row 1, col 1 to row 1, col 5.\n\n"
            "Guidelines:\n"
            f"- you have a maximum of {self.max_turns} turns to find all the words.\n"
            "- Each guess must be unique; you cannot repeat the same guess.\n"
            "- The history of your attempts will be recorded below.\n"
            "- Make your guesses carefully and strategically!"
        )

    def get_task_suffix(self) -> str:
        return (
            f"Current Board:\n{self._render_board(show_words=True)}\n"
            f"Words Found: {len(self.correct_words)}/{len(self.placed_words)}\n"
            "Enter your guess."
        )

    def reset(self, seed: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
        super().reset(seed)

        if self._is_random:
            self.hardcore = random.choice([False, True])
            self.num_words = 5
            self.max_turns = 20

        self.word_list = words.words("en") if self.hardcore else words.words("en-basic")
        # Generate the word search grid
        self.game_board, self.placed_words = self._generate_word_search()
        self.highlighted_positions = set()
        self.correct_words = set()
        self.attempts = []
        self.turn_count = 0

        return self._get_instructions(), {"suffix": self.get_task_suffix()}

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        self.turn_count += 1

        # Parse action: [start_row start_col end_row end_col]
        coordinates = self._parse_action(action)

        if any([c is None for c in coordinates]):
            terminate_obs = f"At turn {self.turn_count}, you did not provide a valid guess in \\boxed{{start_row start_col end_row end_col}} format."
            return (
                terminate_obs,
                LanguageGameReward.format_error_reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )

        start_row, start_col, end_row, end_col = coordinates

        # Validate coordinates
        if not self._are_coordinates_valid(start_row, start_col, end_row, end_col):
            next_obs = f"At turn {self.turn_count}, your tried coordinates ({start_row}, {start_col}) to ({end_row}, {end_col}) are out of bounds."
            reward = LanguageGameReward.invalid_action_reward
        elif (start_row, start_col, end_row, end_col) in self.attempts:
            next_obs = f"At turn {self.turn_count}, you have already tried the coordinates ({start_row}, {start_col}) to ({end_row}, {end_col})."
            reward = LanguageGameReward.invalid_action_reward
        elif start_row != end_row and start_col != end_col:
            next_obs = f"At turn {self.turn_count}, you tried ({start_row}, {start_col}) to ({end_row}, {end_col}), which is not valid because words must be either across (horizontal) or down (vertical)."
            reward = LanguageGameReward.invalid_action_reward
        elif self._check_word(start_row, start_col, end_row, end_col):
            # Correct word found
            word_found = self._map_coordinate_to_word(
                start_row, start_col, end_row, end_col
            )
            self.correct_words.add(word_found)
            self._highlight_word(start_row, start_col, end_row, end_col)
            next_obs = f"At turn {self.turn_count}, correct! You found the word '{word_found}' at coordinates ({start_row}, {start_col}) to ({end_row}, {end_col})."
            reward = 1 / len(
                self.placed_words
            )  # Progressive reward based on word found
        else:
            # Incorrect guess
            next_obs = f"At turn {self.turn_count}, incorrect attempt. No word found at coordinates ({start_row}, {start_col}) to ({end_row}, {end_col})."
            reward = LanguageGameReward.internal_step_reward
        self.attempts.append((start_row, start_col, end_row, end_col))

        # Check if all words found
        if len(self.correct_words) == len(self.placed_words):
            next_obs = "Congratulations! You completed the Word Search puzzle!"
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
            # Give partial reward based on completion percentage
            return terminate_obs, reward, True, True, {"suffix": self.get_task_suffix()}

        return next_obs, reward, False, False, {"suffix": self.get_task_suffix()}

    def sample_random_action(self) -> str:
        """Generate a random action for sampling."""
        if hasattr(self, "game_board"):
            grid_size = len(self.game_board)
            start_row = random.randint(0, grid_size - 1)
            start_col = random.randint(0, grid_size - 1)
            end_row = random.randint(0, grid_size - 1)
            end_col = random.randint(0, grid_size - 1)
            return f"\\boxed{{[{start_row} {start_col} {end_row} {end_col}]}}"
        return "\\boxed{[0 0 0 2]}"

    def _generate_word_search(self):
        """Generate a word search grid with placed words."""
        # Sample words and sort by length (longest first)
        words = random.sample(self.word_list, min(self.num_words, len(self.word_list)))
        words = [word.upper() for word in words]
        words = sorted(words, key=lambda w: len(w), reverse=True)

        # Assign random directions
        directions = {word: random.choice(["across", "down"]) for word in words}

        # Determine grid size
        grid_size = self._determine_initial_grid_size(words)
        grid = self._create_empty_grid(grid_size)

        placed_words = {}

        for word in words:
            placed = False

            if not placed_words:  # First word - place in center
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
                # Try to find overlaps with existing words
                possible_positions = self._find_overlaps(
                    word, grid, placed_words, directions
                )
                random.shuffle(possible_positions)
                for row, col, direction in possible_positions:
                    if self._can_place_word(grid, word, direction, row, col):
                        self._place_word_on_grid(grid, word, direction, row, col)
                        placed_words[word] = (row, col, direction)
                        placed = True
                        break

            if not placed:
                # Try any free position
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

        # Fill empty cells with random letters
        self._fill_empty_cells(grid)

        return grid, placed_words

    def _determine_initial_grid_size(self, words: List[str]) -> int:
        """Determine grid size based on longest word."""
        max_length = max(len(word) for word in words)
        return round(max_length * 1.5)

    def _create_empty_grid(self, size: int) -> List[List[str]]:
        """Create empty grid filled with dots."""
        return [["." for _ in range(size)] for _ in range(size)]

    def _can_place_word(
        self, grid: List[List[str]], word: str, direction: str, row: int, col: int
    ) -> bool:
        """Check if word can be placed at position."""
        if direction == "across":
            if col + len(word) > len(grid[0]):
                return False
            for i, letter in enumerate(word):
                current_cell = grid[row][col + i]
                if current_cell != "." and current_cell != letter:
                    return False
        else:  # down
            if row + len(word) > len(grid):
                return False
            for i, letter in enumerate(word):
                current_cell = grid[row + i][col]
                if current_cell != "." and current_cell != letter:
                    return False
        return True

    def _place_word_on_grid(
        self, grid: List[List[str]], word: str, direction: str, row: int, col: int
    ):
        """Place word on grid at specified position."""
        if direction == "across":
            for i, letter in enumerate(word):
                grid[row][col + i] = letter
        else:  # down
            for i, letter in enumerate(word):
                grid[row + i][col] = letter

    def _find_overlaps(
        self, word: str, grid: List[List[str]], placed_words: Dict, directions: Dict
    ) -> List[Tuple[int, int, str]]:
        """Find possible overlap positions for word."""
        overlaps = []
        for placed_word, (p_row, p_col, p_direction) in placed_words.items():
            for i, letter in enumerate(word):
                for j, placed_letter in enumerate(placed_word):
                    if letter == placed_letter:
                        if p_direction == "across":
                            row = p_row - i
                            col = p_col + j
                            if (
                                directions[word] == "down"
                                and 0 <= row < len(grid)
                                and 0 <= col < len(grid[0])
                            ):
                                overlaps.append((row, col, "down"))
                        elif p_direction == "down":
                            row = p_row + j
                            col = p_col - i
                            if (
                                directions[word] == "across"
                                and 0 <= row < len(grid)
                                and 0 <= col < len(grid[0])
                            ):
                                overlaps.append((row, col, "across"))
        return overlaps

    def _fill_empty_cells(self, grid: List[List[str]]):
        """Fill empty cells with random letters."""
        for row in range(len(grid)):
            for col in range(len(grid[0])):
                if grid[row][col] == ".":
                    grid[row][col] = random.choice(string.ascii_uppercase)

    def _are_coordinates_valid(
        self, start_row: int, start_col: int, end_row: int, end_col: int
    ) -> bool:
        """Check if coordinates are within grid bounds."""
        grid_size = len(self.game_board)
        return (
            0 <= start_row < grid_size
            and 0 <= start_col < grid_size
            and 0 <= end_row < grid_size
            and 0 <= end_col < grid_size
        )

    def _check_word(
        self, start_row: int, start_col: int, end_row: int, end_col: int
    ) -> bool:
        """Check if coordinates match a placed word exactly."""
        for word, (row, col, direction) in self.placed_words.items():
            expected_start = (row, col)
            if direction == "across":
                expected_end = (row, col + len(word) - 1)
            else:  # down
                expected_end = (row + len(word) - 1, col)

            actual_start = (start_row, start_col)
            actual_end = (end_row, end_col)

            # Check both forward and backward directions
            if (actual_start == expected_start and actual_end == expected_end) or (
                actual_start == expected_end and actual_end == expected_start
            ):
                return True
        return False

    def _map_coordinate_to_word(
        self, start_row: int, start_col: int, end_row: int, end_col: int
    ) -> Optional[str]:
        """Map coordinates to the corresponding word."""
        for word, (row, col, direction) in self.placed_words.items():
            if self._matches_position(
                word, row, col, direction, start_row, start_col, end_row, end_col
            ):
                return word
        return None

    def _matches_position(
        self,
        word: str,
        row: int,
        col: int,
        direction: str,
        start_row: int,
        start_col: int,
        end_row: int,
        end_col: int,
    ) -> bool:
        """Check if coordinates match word position."""
        if direction == "across":
            expected_start = (row, col)
            expected_end = (row, col + len(word) - 1)
        else:  # down
            expected_start = (row, col)
            expected_end = (row + len(word) - 1, col)

        actual_start = (start_row, start_col)
        actual_end = (end_row, end_col)

        return (actual_start == expected_start and actual_end == expected_end) or (
            actual_start == expected_end and actual_end == expected_start
        )

    def _highlight_word(
        self, start_row: int, start_col: int, end_row: int, end_col: int
    ):
        """Highlight word positions."""
        if start_row == end_row:  # Horizontal word
            for col in range(min(start_col, end_col), max(start_col, end_col) + 1):
                self.highlighted_positions.add((start_row, col))
        elif start_col == end_col:  # Vertical word
            for row in range(min(start_row, end_row), max(start_row, end_row) + 1):
                self.highlighted_positions.add((row, start_col))

    def _render_board(self, show_words: bool = True) -> str:
        """Render the word search grid."""
        if not hasattr(self, "game_board"):
            return "Board not initialized"

        header = "   " + " ".join(f"C{i:02}" for i in range(len(self.game_board)))
        lines = [header]
        for i, row in enumerate(self.game_board):
            row_str = f"R{i:02} "
            for j, val in enumerate(row):
                if (i, j) in self.highlighted_positions and show_words:
                    row_str += f"[{val}] "
                else:
                    row_str += f" {val}  "
            lines.append(row_str)
        return "\n".join(lines)

    def _parse_action(self, action: str) -> Optional[Tuple[int, int, int, int]]:
        """Parse the action string to extract coordinates."""
        boxed_pattern = re.compile(r"\\boxed\{(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\}")
        matches = list(boxed_pattern.finditer(action))
        match = matches[-1] if matches else None
        if match:
            return tuple(int(x) for x in match.groups())

        return None, None, None, None
