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

"""Wordle game environment"""

import random
import re
from typing import Any, List, Optional, Tuple

import nltk
from nltk.corpus import words

from gem.core import Env
from gem.utils.constants import LanguageGameReward


class WordleEnv(Env):
    def __init__(
        self,
        word_length: Optional[int] = 5,
        only_real_words: Optional[bool] = True,
        max_turns: Optional[int] = 20,
        **_,
    ):
        super().__init__()
        nltk.download("words")
        self.word_length = word_length
        self.only_real_words = only_real_words
        self.max_turns = max_turns
        self._is_random = word_length is None or max_turns is None
        self.all_words = words.words("en-basic")
        self.reset()

    def _get_instructions(self) -> str:
        return (
            f"You are playing Wordle.\n"
            f"You have to guess the secret {self.word_length}-letter word within {self.max_turns} turns.\n"
            "After you enter your guess, I will say mark your guess as follows:\n"
            "  - G (green): correct letter in the correct position\n"
            "  - Y (yellow): letter exists in the word but in the wrong position\n"
            "  - X (wrong): letter is not in the word\n"
            "After thinking, format your final answer inside \\boxed{...},"
            f" for example, {self.sample_random_action()}.\n"
            "As you play, the history of your guesses will be appended below. Use the information to complete the game before you run out of guesses.\n"
        )

    def get_task_suffix(self) -> str:
        return "Enter your guess."

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        if self._is_random:
            self.word_length = random.randint(3, 5)
            self.max_turns = self.word_length * 5
        self.available_words = [
            word
            for word in self.all_words
            if len(word) == self.word_length and word.isalpha() and word.islower()
        ]
        self.secret_word = random.choice(self.available_words).upper()
        self.previous_guesses = set()
        self.milestones = [0] * len(self.secret_word)
        self.turn_count = 0
        return self._get_instructions(), {"suffix": self.get_task_suffix()}

    def step(self, action: str) -> Tuple[str, float, bool, bool, dict[str, Any]]:
        self.turn_count += 1

        action_search_pattern = re.compile(r"\\boxed{([a-zA-Z]+(?:\s+[a-zA-Z]+)*)}")
        matches = list(action_search_pattern.finditer(action))
        clean_action = matches[-1] if matches else None
        # get player guess
        try:
            player_guess = clean_action.group(1).upper().replace(" ", "")
        except Exception:
            player_guess = None

        if not player_guess:  # format error
            next_obs = f"At turn {self.turn_count}, you did not provide a valid guess."
            reward = LanguageGameReward.format_error_reward
            return (
                next_obs,
                reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )
        elif len(player_guess) != self.word_length:  # invalid action
            next_obs = f"At turn {self.turn_count}, you guessed {player_guess} which has {len(player_guess)} letters but the secret word has {self.word_length} letters."
            reward = LanguageGameReward.invalid_action_reward
        elif player_guess in self.previous_guesses:  # invalid action
            next_obs = f"At turn {self.turn_count}, you guessed {player_guess}, which has been already guessed before."
            reward = LanguageGameReward.invalid_action_reward
        else:  # valid action
            self.previous_guesses.add(player_guess)
            feedback = self._evaluate_guess(player_guess)
            reward = self.get_current_success_internal_reward(feedback)
            next_obs = f"At turn {self.turn_count}, you guessed {player_guess}\nFeedback:\n{player_guess}\n{feedback}"
            if feedback.count("G") == self.word_length:  # finished
                terminate_obs = f"Congratulations! You guessed the secret word {self.secret_word} in {self.turn_count} turns."
                reward += LanguageGameReward.success_reward * 0.5
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

    def get_current_success_internal_reward(self, feedback) -> float:
        reward = 0
        for i, (f, m) in enumerate(zip(feedback, self.milestones)):
            if f == "G" and m == 0:
                reward += 1 / len(self.milestones) * 0.5
                # update milestones
                self.milestones[i] = 1
        return reward

    def sample_random_action(self):
        """Samples a random word"""
        return f"\\boxed{{{random.choice(self.available_words).upper()}}}"

    def _evaluate_guess(self, player_guess: str) -> List[str]:
        """Evaluates the player's guess against the secret word"""
        feedback = [None] * self.word_length
        secret_list = list(self.secret_word.upper())
        guess_list = list(player_guess.upper())

        # First pass: mark correct letters in the correct position (green)
        for i in range(self.word_length):
            if guess_list[i] == secret_list[i]:
                feedback[i] = "G"
                secret_list[i] = None  # Mark this letter as accounted for

        # Second pass: mark correct letters in the wrong position (yellow) or wrong letters
        for i in range(self.word_length):
            if feedback[i] is None:
                if guess_list[i] in secret_list:
                    feedback[i] = "Y"
                    # Remove the first occurrence of guess_list[i] from secret_list
                    index = secret_list.index(guess_list[i])
                    secret_list[index] = None
                else:
                    feedback[i] = "X"

        return feedback
