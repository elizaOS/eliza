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

"""Mastermind game environment"""

import random
import re
from typing import Any, List, Optional, Tuple

from gem.core import Env
from gem.utils.constants import LanguageGameReward


class MastermindEnv(Env):
    def __init__(
        self,
        code_length: Optional[int] = 4,
        num_numbers: Optional[int] = 6,
        duplicate_numbers: Optional[bool] = False,
        max_turns: Optional[int] = 20,
        **_,  # ignore addtional parameters, e.g. `seed`
    ):
        super().__init__()
        self.code_length = code_length
        self.num_numbers = num_numbers
        self.duplicate_numbers = duplicate_numbers
        self.max_turns = max_turns
        self._is_random = (
            code_length is None or num_numbers is None or max_turns is None
        )
        self.reset()

    def _get_instructions(self) -> str:
        return (
            f"You are playing Mastermind.\n"
            f"You have to guess the secret {self.code_length} digit code within {self.max_turns} turns.\n"
            f"The code consists of digits from 1 to {self.num_numbers} (inclusive). "
            f"Duplicate numbers are {'allowed' if self.duplicate_numbers else 'not allowed'}.\n"
            "After you enter your guess, I will say mark your guess with black and white pegs, where a black peg indicates a correct digit in the correct position, while a white peg indicates a correct digit in the wrong position.\n"
            "After thinking, format your final answer inside \\boxed{...},"
            f" for example, {self.sample_random_action()}.\n"
            "As you play, the history of your guesses will be appended below. Use the information to complete the game before you run out of guesses.\n"
            "Enter your first guess to start the game.\n"
        )

    def get_task_suffix(self) -> str:
        return "Enter your guess."

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        if self._is_random:
            candidates = [(2, 4, 10), (4, 6, 20), (4, 8, 30)]
            self.code_length, self.num_numbers, self.max_turns = random.choice(
                candidates
            )
        available_numbers = list(range(1, self.num_numbers + 1))
        sample_fn = random.choices if self.duplicate_numbers else random.sample
        self.game_code = sample_fn(available_numbers, k=self.code_length)
        self.previous_guesses = set()
        self.turn_count = 0
        self.milestone = 0
        return self._get_instructions(), {}

    def step(self, action: str) -> Tuple[str, float, bool, bool, dict[str, Any]]:
        self.turn_count += 1
        action_search_pattern = re.compile(r"\\boxed{(\d+(?:\s+\d+)*)}")
        matches = list(action_search_pattern.finditer(action))
        clean_action = matches[-1] if matches else None
        try:
            player_guess = list(map(int, clean_action.group(1).split()))
        except Exception:
            player_guess = None

        if not player_guess:
            next_obs = f"At turn {self.turn_count}, you did not provide a valid guess."
            reward = LanguageGameReward.format_error_reward
            return (
                next_obs,
                reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )
        elif not len(player_guess) == self.code_length:  # invalid action
            next_obs = f"At turn {self.turn_count}, you guessed {player_guess} which has {len(player_guess)} entries but the code has length {self.code_length}."
            reward = LanguageGameReward.invalid_action_reward
        elif any(num < 1 or num > self.num_numbers for num in player_guess):
            next_obs = f"At turn {self.turn_count}, you guessed {player_guess}, which has numbers outside the range 1 to {self.num_numbers}."
            reward = LanguageGameReward.invalid_action_reward
        elif tuple(player_guess) in self.previous_guesses:
            next_obs = f"At turn {self.turn_count}, you guessed {player_guess}, which has been already guessed before."
            reward = LanguageGameReward.invalid_action_reward
        else:
            self.previous_guesses.add(tuple(player_guess))
            black_pegs, white_pegs = self._evaluate_guess(player_guess)
            next_obs = f"At turn {self.turn_count}, you guessed {player_guess}. This guess receives {black_pegs} black peg(s) and {white_pegs} white peg(s)."
            reward = self.get_current_success_internal_reward(black_pegs)
            if black_pegs == self.code_length:
                terminate_obs = f"Congratulations! You guessed the correct code {self.game_code} in {self.turn_count} turns."
                return (
                    terminate_obs,
                    reward,
                    True,
                    False,
                    {"suffix": self.get_task_suffix()},
                )
        if self.turn_count >= self.max_turns:  # reach max_turns
            terminate_obs = "You have reached the maximum number of turns."
            return terminate_obs, reward, True, True, {"suffix": self.get_task_suffix()}
        return next_obs, reward, False, False, {"suffix": self.get_task_suffix()}

    def get_current_success_internal_reward(self, blackpeg) -> float:
        if blackpeg > self.milestone:
            reward = (blackpeg - self.milestone) / self.code_length
            self.milestone = blackpeg
            return reward
        return 0.0

    def sample_random_action(self):
        return (
            "\\boxed{"
            + " ".join(
                map(
                    str, random.sample(range(1, self.num_numbers + 1), self.code_length)
                )
            )
            + "}"
        )

    def _evaluate_guess(self, player_guess: List[int]) -> Tuple[int, int]:
        """
        Evaluates the player's guess and returns the number of black and white pegs.
        Black peg: correct digit in the correct position.
        White peg: correct digit in the wrong position.

        Args: player_guess (List[int]): The player's guess.
        Returns: Tuple[int, int]: Number of black and white pegs.
        """
        assert len(player_guess) == self.code_length
        black_pegs = 0
        white_pegs = 0

        # Create copies to mark matched positions
        code_copy = self.game_code.copy()
        guess_copy = player_guess.copy()

        # First pass: count black pegs and mark them as None
        for i in range(self.code_length):
            if guess_copy[i] == code_copy[i]:
                black_pegs += 1
                code_copy[i] = None
                guess_copy[i] = None

        # Second pass: count white pegs using the remaining numbers
        for i in range(self.code_length):
            if guess_copy[i] is not None and guess_copy[i] in code_copy:
                white_pegs += 1
                # Remove the first occurrence to prevent over-counting
                code_copy[code_copy.index(guess_copy[i])] = None

        return black_pegs, white_pegs
