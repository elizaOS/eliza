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

import random
import re
from typing import Any, Dict, Optional, Tuple

from gem.core import Env
from gem.utils.constants import LanguageGameReward


class TowerofHanoiEnv(Env):
    def __init__(self, num_disks: int = 3, max_turns: int = 100, **_):
        super().__init__()
        self.num_disks = num_disks
        self.max_turns = max_turns
        self._is_random = num_disks is None or max_turns is None
        self.reset()

    def _get_instructions(self) -> str:
        prompt = (
            f"You are playing Tower of Hanoi with {self.num_disks} disks.\n"
            f"You have to move the disks from tower A to tower C.\n"
            "To move a disk, type the source tower and the target tower (e.g., '\\boxed{A C}').\n"
            "Note that you can only move the top disk of a tower, and that a bigger disk cannot be placed on a smaller disk.\n"
            "As you play, the history of your moves will be displayed.\n"
        )
        return prompt

    def get_task_suffix(self) -> str:
        return (
            f"Here is the current state of the tower of hanoi:\n{self._render_board()}\n"
            "Enter your move."
        )

    def reset(self, seed: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
        super().reset(seed)
        if self._is_random:
            candidates = [(3, 10), (4, 20), (5, 35)]
            self.num_disks, self.max_turns = random.choice(candidates)
        self.board = self._generate_board()
        self.turn_count = 0
        return (self._get_instructions(), {"suffix": self.get_task_suffix()})

    def step(self, action: str) -> Tuple[str, float, bool, bool, Dict[str, Any]]:
        self.turn_count += 1
        action_search_pattern = re.compile(r"\\boxed{([ABCabc])\s*,?\s*([ABCabc])}")
        matches = list(action_search_pattern.finditer(action))
        clean_action = matches[-1] if matches else None

        try:
            src = clean_action.group(1).upper()
            dst = clean_action.group(2).upper()
        except Exception:
            src, dst = None, None

        if src is None or dst is None:
            terminate_obs = "You did not provide a valid action."
            return (
                terminate_obs,
                LanguageGameReward.format_error_reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )

        if not self.board[src]:
            next_obs = f"At turn {self.turn_count}, you tried to move from tower {src}, which is empty."
            reward = LanguageGameReward.invalid_action_reward
        elif self.board[dst] and self.board[src][-1] > self.board[dst][-1]:
            next_obs = f"At turn {self.turn_count}, you tried to move from tower {src} to tower {dst}, but the top disk on tower {src} is larger than the top disk on tower {dst}."
            reward = LanguageGameReward.invalid_action_reward
        else:  # valid action
            disk = self.board[src].pop()
            self.board[dst].append(disk)
            next_obs = f"At turn {self.turn_count}, you moved disk {disk} from tower {src} to tower {dst}."
            reward = LanguageGameReward.internal_step_reward
            if self.board["C"] == list(range(self.num_disks, 0, -1)):
                terminate_obs = "Congratulations! You solved the Tower of Hanoi Puzzle"
                reward = LanguageGameReward.success_reward
                return (
                    terminate_obs,
                    reward,
                    True,
                    False,
                    {"suffix": self.get_task_suffix()},
                )
        if self.turn_count >= self.max_turns:
            terminate_obs = "You have reached the maximum number of turns."
            reward = len(self.board["C"]) / self.num_disks
            return terminate_obs, reward, True, True, {"suffix": self.get_task_suffix()}
        return next_obs, reward, False, False, {"suffix": self.get_task_suffix()}

    def _generate_board(self):
        towers = {"A": list(range(self.num_disks, 0, -1)), "B": [], "C": []}
        return towers

    def _render_board(self):
        rendered_board = ""
        for tower, disks in self.board.items():
            rendered_board += f"{tower}: {disks}\n"
        return rendered_board
