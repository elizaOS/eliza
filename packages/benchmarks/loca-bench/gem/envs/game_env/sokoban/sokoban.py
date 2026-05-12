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

"""Sokoban game environment."""

import random
import re
from typing import Any, Optional, Tuple

import numpy as np

from gem.core import Env
from gem.utils.constants import LanguageGameReward

from .utils import generate_room

CHANGE_COORDINATES = {
    0: (-1, 0),  # up
    1: (1, 0),  # down
    2: (0, -1),  # left
    3: (0, 1),  # right
}


class SokobanEnv(Env):
    """Sokoban puzzle environment where player pushes boxes to target positions."""

    def __init__(
        self,
        dim_room: tuple = (6, 6),
        max_turns: int = 100,
        num_boxes: int = 3,
        **_,
    ):
        super().__init__()
        self.dim_room = dim_room
        self.max_turns = max_turns
        self.num_boxes = num_boxes
        self.num_gen_steps = int(1.7 * (dim_room[0] + dim_room[1]))
        self._is_random = dim_room is None or max_turns is None or num_boxes is None
        self.action_space = ["up", "down", "left", "right"]
        self.reset()

    def _get_instructions(self) -> str:
        example_action = self.sample_random_action()
        action_type = example_action.split("{")[1].split("}")[0]

        return (
            "You are solving the Sokoban puzzle. You are the player and you need to push all boxes to targets.\n"
            "When you are right next to a box, you can push it by moving in the same direction.\n"
            "You cannot push a box through a wall or another box, and you cannot pull a box.\n"
            f"you have to complete the puzzle within {self.max_turns} turns.\n"
            "On the board, objects are represented as:\n"
            "- The player (you) appears as 'P'\n"
            "- Walls are represented with '#'\n"
            "- Boxes are marked as 'X'\n"
            "- Empty goals are shown with 'O'\n"
            "- Boxes on goals are visualized with '√'\n"
            "- Empty floor is shown as '_'\n\n"
            "To submit your move, type the command in \\boxed{}.\n"
            f"For example: {example_action} to move {action_type}.\n"
            "Use logic and deduction to push all boxes onto the target positions!"
        )

    def get_task_suffix(self) -> str:
        return (
            f"Here is the current board layout:\n{self._render_board()}\n"
            "Enter your move."
        )

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        if self._is_random:
            candidates = [((6, 6), 2, 20), ((8, 8), 5, 50)]
            self.dim_room, self.num_boxes, self.max_turns = random.choice(candidates)
            self.num_gen_steps = int(1.7 * (self.dim_room[0] + self.dim_room[1]))

        max_retries = 50
        for attempt in range(max_retries):
            try:
                current_seed = None if seed is None else seed + attempt
                self.room_fixed, self.room_state, self.box_mapping = generate_room(
                    dim=self.dim_room,
                    num_steps=self.num_gen_steps,
                    num_boxes=self.num_boxes,
                    seed=current_seed,
                )
                break
            except (RuntimeError, RuntimeWarning):
                if attempt == max_retries - 1:
                    raise RuntimeError(
                        f"Failed to generate valid room after {max_retries} attempts"
                    )
                continue

        self.player_position = np.argwhere(self.room_state == 5)[0]
        self.turn_count = 0
        return self._get_instructions(), {"suffix": self.get_task_suffix()}

    def step(self, action: str) -> Tuple[str, float, bool, bool, dict[str, Any]]:
        # NOTE: can not set dense progressive reward here, as one can still push boxes on target positions
        self.turn_count += 1

        clean_action = self._parse_action(action)

        if clean_action is None:
            terminate_obs = (
                f"At turn {self.turn_count}, your submitted action is not valid."
            )
            return (
                terminate_obs,
                LanguageGameReward.format_error_reward,
                True,
                self.turn_count == self.max_turns,
                {"suffix": self.get_task_suffix()},
            )

        if self._would_collide_with_wall(clean_action):
            next_obs = f"At turn {self.turn_count}, you cannot move {clean_action} - you would collide with wall or other boxes!"
            reward = LanguageGameReward.invalid_action_reward
        else:
            move_successful, box_pushed = self._push(clean_action)

            if not move_successful:
                next_obs = f"At turn {self.turn_count}, invalid move - cannot move to that position."
                reward = LanguageGameReward.invalid_action_reward
            else:
                next_obs = f"At turn {self.turn_count}, you {'pushed a box while you ' if box_pushed else ''}moved {clean_action}."
                reward = LanguageGameReward.internal_step_reward

                # Check win condition
                if self._check_if_all_boxes_on_target():
                    next_obs = "Congratulations! You have solved the Sokoban puzzle!"
                    return (
                        next_obs,
                        LanguageGameReward.success_reward,
                        True,
                        False,
                        {"suffix": self.get_task_suffix()},
                    )

        # Check max turns
        if self.turn_count >= self.max_turns:
            terminate_obs = "You have reached the maximum number of turns."
            # compute soft reward here
            reward = LanguageGameReward.success_reward * (
                self._count_boxes_on_targets() / self.num_boxes
            )
            return terminate_obs, reward, True, True, {"suffix": self.get_task_suffix()}

        return next_obs, reward, False, False, {"suffix": self.get_task_suffix()}

    def sample_random_action(self) -> str:
        action = random.choice(self.action_space)
        return f"\\boxed{{{action}}}"

    def _would_collide_with_wall(self, action: str) -> bool:
        """Check if the given action would result in a wall collision."""
        change = CHANGE_COORDINATES[self.action_space.index(action)]
        new_position = self.player_position + change

        # Check bounds
        if (
            new_position[0] < 0
            or new_position[0] >= self.room_state.shape[0]
            or new_position[1] < 0
            or new_position[1] >= self.room_state.shape[1]
        ):
            return True

        # Check if the new position is a wall (value 0)
        if self.room_state[new_position[0], new_position[1]] == 0:
            return True

        # Check if there's a box that would be pushed into a wall or out of bounds
        if self.room_state[new_position[0], new_position[1]] in [3, 4]:  # There's a box
            box_new_position = new_position + change

            # Check if box would go out of bounds
            if (
                box_new_position[0] < 0
                or box_new_position[0] >= self.room_state.shape[0]
                or box_new_position[1] < 0
                or box_new_position[1] >= self.room_state.shape[1]
            ):
                return True

            # Check if box would be pushed into a wall or another box
            if self.room_state[box_new_position[0], box_new_position[1]] not in [
                1,
                2,
            ]:  # Not empty floor or target
                return True

        return False

    def _push(self, action):
        """Perform a push, if a box is adjacent in the right direction. If no box can be pushed, try to move."""
        change = CHANGE_COORDINATES[self.action_space.index(action)]
        new_position = self.player_position + change
        current_position = self.player_position.copy()

        # Check bounds first
        if (
            new_position[0] < 0
            or new_position[0] >= self.room_state.shape[0]
            or new_position[1] < 0
            or new_position[1] >= self.room_state.shape[1]
        ):
            return False, False

        # No push, if the push would get the box out of the room's grid
        new_box_position = new_position + change
        if (
            new_box_position[0] < 0
            or new_box_position[0] >= self.room_state.shape[0]
            or new_box_position[1] < 0
            or new_box_position[1] >= self.room_state.shape[1]
        ):
            # Try to move instead if no box pushing is possible
            return self._move(action), False

        can_push_box = self.room_state[new_position[0], new_position[1]] in [3, 4]
        can_push_box &= self.room_state[new_box_position[0], new_box_position[1]] in [
            1,
            2,
        ]

        if can_push_box:
            # Move Player
            self.player_position = new_position
            self.room_state[(new_position[0], new_position[1])] = 5
            self.room_state[current_position[0], current_position[1]] = self.room_fixed[
                current_position[0], current_position[1]
            ]

            # Move Box
            box_type = 4  # Box on floor
            if (
                self.room_fixed[new_box_position[0], new_box_position[1]] == 2
            ):  # Target position
                box_type = 3  # Box on target
            self.room_state[new_box_position[0], new_box_position[1]] = box_type
            return True, True
        else:
            # Try to move if no box to push is available
            return self._move(action), False

    def _move(self, action):
        """Moves the player to the next field, if it is not occupied."""
        change = CHANGE_COORDINATES[self.action_space.index(action)]
        new_position = self.player_position + change
        current_position = self.player_position.copy()

        # Check bounds
        if (
            new_position[0] < 0
            or new_position[0] >= self.room_state.shape[0]
            or new_position[1] < 0
            or new_position[1] >= self.room_state.shape[1]
        ):
            return False

        # Move player if the field in the moving direction is either an empty field or an empty box target.
        if self.room_state[new_position[0], new_position[1]] in [1, 2]:
            self.player_position = new_position
            self.room_state[(new_position[0], new_position[1])] = 5
            self.room_state[current_position[0], current_position[1]] = self.room_fixed[
                current_position[0], current_position[1]
            ]
            return True
        return False

    def _count_boxes_on_targets(self):
        """Count how many boxes are currently on target positions."""
        return int(np.sum(self.room_state == 3))

    def _check_if_all_boxes_on_target(self):
        """Check if all boxes are on target positions."""
        boxes_on_targets = self._count_boxes_on_targets()
        return boxes_on_targets == self.num_boxes

    def _render_board(self) -> str:
        """Render the game board with appropriate symbols."""
        grid_lookup = {0: "#", 1: "_", 2: "O", 3: "√", 4: "X", 5: "P", 6: "S"}

        board_str = ""
        for row in self.room_state:
            board_str += " ".join([grid_lookup[cell] for cell in row])
            board_str += "\n"
        return board_str

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
