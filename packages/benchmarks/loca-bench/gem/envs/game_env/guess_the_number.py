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

"""Guess the number game environment."""

import math
import random
import re
from typing import Any, Optional, Tuple

from gem.core import Env
from gem.utils.constants import LanguageGameReward


class GuessTheNumberEnv(Env):
    def __init__(
        self, min_number: int = 1, max_number: int = 20, max_turns: int = 20, **_
    ):
        super().__init__()
        self.min_number = min_number
        self.max_number = max_number
        self.max_turns = max_turns
        self._is_random = min_number is None or max_number is None
        self.reset()

    def _get_instructions(self) -> str:
        return (
            f"You are playing Guess The Number.\n"
            f"You have to guess the number between {self.min_number} and {self.max_number} (inclusive) within {self.max_turns} turns.\n"
            "As you enter your guess, the game will provide you with hints such as the target number is 'higher' or 'lower'.\n"
            "You may provide your response in any manner. Only the number that is wrapped inside \\boxed{} will be considered as your guess,"
            f" for example, {self.sample_random_action()}.\n"
            "As you play, the history of your guesses will be appended below. Use the information to complete the game before you run out of guesses.\n"
            "Enter your first guess to start the game.\n"
        )

    def get_task_suffix(self) -> str:
        return "Enter your next guess."

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        if self._is_random:
            self.min_number = random.randint(1, 10)
            self.max_number = random.randint(self.min_number + 5, self.min_number + 50)
            self.max_turns = math.ceil(math.sqrt(self.max_number - self.min_number)) + 1

        self.game_number = random.randint(self.min_number, self.max_number)
        self.previous_guesses = set()
        self.turn_count = 0
        return self._get_instructions(), {"suffix": self.get_task_suffix()}

    def step(self, action: str) -> Tuple[str, float, bool, bool, dict[str, Any]]:
        self.turn_count += 1
        action_search_pattern = re.compile(r"\\boxed{(\d+)}")
        matches = list(action_search_pattern.finditer(action))
        clean_action = matches[-1] if matches else None
        try:
            player_guess = int(clean_action.group(1))
        except Exception:
            player_guess = None

        if not player_guess:
            terminate_obs = (
                f"At turn {self.turn_count}, you did not provide a valid guess."
            )
            reward = LanguageGameReward.format_error_reward
            return (
                terminate_obs,
                reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )
        elif player_guess < self.min_number or player_guess > self.max_number:
            next_obs = f"At turn {self.turn_count}, you guessed {player_guess}, which is outside the range specified."
            reward = LanguageGameReward.invalid_action_reward
        elif player_guess in self.previous_guesses:
            next_obs = f"At turn {self.turn_count}, you guessed {player_guess}, which has been already guessed before."
            reward = LanguageGameReward.invalid_action_reward
        else:  # valid action
            self.previous_guesses.add(player_guess)
            hint = "lower" if player_guess > self.game_number else "higher"
            next_obs = f"At turn {self.turn_count}, you guessed {player_guess}, and the target number is {hint} than {player_guess}."
            reward = LanguageGameReward.internal_step_reward
            if player_guess == self.game_number:
                terminate_obs = f"Congratulations! You guessed the correct number {self.game_number} in {self.turn_count} turns."
                reward = LanguageGameReward.success_reward
                return (
                    terminate_obs,
                    reward,
                    True,
                    False,
                    {"suffix": self.get_task_suffix()},
                )
        if self.turn_count >= self.max_turns:  # reach max_turns
            terminate_obs = "You have reached the maximum number of turns."
            if player_guess < self.min_number or player_guess > self.max_number:
                reward = LanguageGameReward.invalid_action_reward
            else:
                distance = abs(player_guess - self.game_number)
                reward = 1 - (distance / (self.max_number - self.min_number))
            return terminate_obs, reward, True, True, {"suffix": self.get_task_suffix()}
        return next_obs, reward, False, False, {"suffix": self.get_task_suffix()}

    def sample_random_action(self):
        return "\\boxed{" + str(random.randint(self.min_number, self.max_number)) + "}"
