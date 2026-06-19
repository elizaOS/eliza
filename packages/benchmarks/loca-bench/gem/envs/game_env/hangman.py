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

"""Hangman game environment"""

import random
import re
from typing import Any, Dict, List, Optional, Tuple

import nltk
from nltk.corpus import words

from gem.core import Env
from gem.utils.constants import LanguageGameReward


class HangmanEnv(Env):
    def __init__(
        self,
        word_length: Optional[int] = 5,
        hardcore: Optional[bool] = False,
        max_turns: Optional[int] = 20,
        **_,
    ):
        super().__init__()
        nltk.download("words")
        self.word_length = word_length
        self.hardcore = hardcore
        self.max_turns = max_turns
        self._is_random = word_length is None or max_turns is None
        self.all_words = words.words("en") if hardcore else words.words("en-basic")
        self.reset()

    def _get_instructions(self) -> str:
        return (
            "You are playing Hangman.\n"
            f"The objective of the game is to guess the {self.word_length}-letter word by providing one letter guesses or the entire word.\n"
            "The cells that need to be populated with letters are represented by '_'.\n\n"
            f"There are two ways you can answer. You can provide one letter guesses in the format of {self.sample_random_word()}, or you can guess the entire word in the format of {self.sample_random_letter()}.\n"
            "If the given letter is in the word, it will be revealed in the grid.\n"
            "If the given word is correct, you win.\n"
            "As you play, the history of your choices will be appended below. Use the information to figure out the word and win.\n"
            "Some rules:\n"
            "1. You can only guess one letter/word at a time.\n"
            f"2. You have to win within {self.max_turns} turns.\n\n"
        )

    def get_task_suffix(self) -> str:
        return (
            f"Here is the current state of the Hangman grid:\n{self._render_board()}\n\n"
            "Enter your guess."
        )

    def reset(self, seed: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
        super().reset(seed)
        if self._is_random:
            candidates = [(3, 10), (5, 15), (7, 20)]
            self.word_length, self.max_turns = random.choice(candidates)
        _board = self._generate_board()
        self.board = ["_" for _ in _board]
        self.guessed_letters = set()
        self.turn_count = 0
        return self._get_instructions(), {"suffix": self.get_task_suffix()}

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        self.turn_count += 1
        action_search_pattern = re.compile(r"\\boxed{([a-zA-Z]+)}", re.IGNORECASE)
        matches = list(action_search_pattern.finditer(action))
        clean_action = matches[-1] if matches else None
        try:
            if clean_action is not None:
                player_guess = clean_action.group(1).upper().replace(" ", "")
            else:
                player_guess = None
        except Exception:
            player_guess = None

        if not player_guess:
            terminate_obs = "You did not provide a valid guess."
            return (
                terminate_obs,
                LanguageGameReward.format_error_reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )
        if len(player_guess) > 1:  # if player guesses the entire word
            if player_guess == self.secret_word:
                next_obs = f"Congratulations! You guessed the word '{self.secret_word}' correctly!"
                # reveal the other letters in the board to compute the reward
                _r = sum(1 if d == "_" else 0 for d in self.board) / len(self.board)
                reward = _r * 0.5 + LanguageGameReward.success_reward * 0.5
                return next_obs, reward, True, False, {"suffix": self.get_task_suffix()}
            elif len(self.secret_word) != len(player_guess):
                next_obs = f"At turn {self.turn_count}, You guessed '{player_guess}' which is of length {len(player_guess)}, but the secret word is of length {len(self.secret_word)}."
                reward = LanguageGameReward.invalid_action_reward
            else:
                next_obs = f"At turn {self.turn_count}, You guessed '{player_guess}' which is incorrect."
                reward = LanguageGameReward.internal_step_reward
        else:  # if player guesses a single letter
            if player_guess in self.guessed_letters:
                next_obs = f"At turn {self.turn_count}, you guessed '{player_guess}', which has been already guessed before."
                reward = LanguageGameReward.invalid_action_reward
            elif player_guess in self.secret_word:
                self.guessed_letters.add(player_guess)
                num_revealed = self._reveal_letter(player_guess)
                next_obs = f"At turn {self.turn_count}, you successfully guessed a letter '{player_guess}' that is in the secret word."
                reward = (num_revealed / len(self.secret_word)) * 0.5
            else:
                self.guessed_letters.add(player_guess)
                next_obs = f"At turn {self.turn_count}, you guessed a letter '{player_guess}' that is not in the secret word."
                reward = LanguageGameReward.internal_step_reward

        if self.turn_count >= self.max_turns:
            terminate_obs = "You have reached the maximum number of turns."
            return terminate_obs, reward, True, True, {"suffix": self.get_task_suffix()}
        return next_obs, reward, False, False, {"suffix": self.get_task_suffix()}

    def get_current_success_internal_reward(self, player_guess: str) -> float:
        pass

    def sample_random_word(self):
        """Samples a random word"""
        return f"\\boxed{{{random.choice(self.available_words).upper()}}}"

    def sample_random_letter(self):
        return f"\\boxed{{{random.choice('abcdefghijklmnopqrstuvwxyz').upper()}}}"

    def sample_random_action(self):
        functions = [self.sample_random_word, self.sample_random_letter]
        return random.choice(functions)()

    def _generate_board(self) -> List[List[Optional[int]]]:
        self.available_words = [
            word
            for word in self.all_words
            if len(word) == self.word_length and word.isalpha() and word.islower()
        ]
        self.secret_word = random.choice(self.available_words).upper()
        return list(self.secret_word)

    def _render_board(self, show_letters=True) -> str:
        header = " ".join(f"C{i:02}" for i in range(len(self.board)))
        lines = [header]

        # We only need a single row for the word
        row_str = ""  # Label for the single row
        for i, val in enumerate(self.board):
            if show_letters:
                row_str += f"  {val} "
            else:
                row_str += "  _ "
        lines.append(row_str)

        return "\n".join(lines)

    def _reveal_letter(self, player_guess):
        assert len(player_guess) == 1, "Only single letter guesses are allowed."
        num_revealed = 0
        for i, char in enumerate(self.secret_word):
            if char == player_guess:
                self.board[i] = player_guess
                num_revealed += 1
        return num_revealed
