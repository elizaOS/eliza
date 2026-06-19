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

import marshal
import random
from collections import deque

import numpy as np

# Moves are mapped to coordinate changes as follows
# 0: Move up
# 1: Move down
# 2: Move left
# 3: Move right
CHANGE_COORDINATES = {0: (-1, 0), 1: (1, 0), 2: (0, -1), 3: (0, 1)}


def is_deadlock_position(room_structure, position):
    """
    Check if a position would be a deadlock for a box (corner trap or wall trap).
    A position is a deadlock if:
    1. It's a corner (two adjacent walls) and has no target
    2. It's against a wall with no escape route and no target
    """
    r, c = position

    # If position has a target, it's not a deadlock
    if room_structure[r, c] == 2:  # Target position
        return False

    # Check for corner deadlock (two adjacent walls)
    walls_adjacent = 0
    wall_directions = []

    # Check all 4 directions for walls
    for i, (dr, dc) in enumerate([(-1, 0), (1, 0), (0, -1), (0, 1)]):
        nr, nc = r + dr, c + dc
        if (
            nr < 0
            or nr >= room_structure.shape[0]
            or nc < 0
            or nc >= room_structure.shape[1]
            or room_structure[nr, nc] == 0
        ):  # Wall or boundary
            walls_adjacent += 1
            wall_directions.append(i)

    # Corner deadlock: two adjacent walls
    if walls_adjacent >= 2:
        # Check if walls are adjacent (not opposite)
        if walls_adjacent == 2:
            # Adjacent if difference in direction indices is 2 or they're 0,3 or 1,2
            dir_diff = abs(wall_directions[0] - wall_directions[1])
            if dir_diff == 1 or dir_diff == 3:  # Adjacent walls
                return True
        elif walls_adjacent > 2:  # 3 or 4 walls = definitely corner
            return True

    return False


def detect_frozen_deadlocks(room_state, room_structure):
    """
    Detect frozen deadlocks - configurations where boxes block each other
    and cannot be resolved.
    """
    # Find all boxes
    boxes = np.where((room_state == 3) | (room_state == 4))  # Boxes on/off targets

    if len(boxes[0]) < 2:
        return False

    # Check for boxes forming unmovable clusters
    for i in range(len(boxes[0])):
        box_pos = (boxes[0][i], boxes[1][i])

        # Check if this box can move in any direction
        can_move = False
        for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            new_r, new_c = box_pos[0] + dr, box_pos[1] + dc
            push_r, push_c = box_pos[0] - dr, box_pos[1] - dc

            # Check if player can reach push position and box can move to new position
            if (
                0 <= new_r < room_state.shape[0]
                and 0 <= new_c < room_state.shape[1]
                and 0 <= push_r < room_state.shape[0]
                and 0 <= push_c < room_state.shape[1]
            ):
                # New position must be empty or target
                if room_state[new_r, new_c] in [1, 2]:
                    # Push position must be reachable by player
                    if room_state[push_r, push_c] in [1, 2] or is_player_reachable(
                        room_state, (push_r, push_c)
                    ):
                        can_move = True
                        break

        if not can_move:
            return True

    return False


def is_player_reachable(room_state, target_pos):
    """
    Check if player can reach a target position using BFS.
    """
    player_pos = np.where(room_state == 5)
    if len(player_pos[0]) == 0:
        return False

    start = (player_pos[0][0], player_pos[1][0])
    if start == target_pos:
        return True

    visited = set()
    queue = deque([start])
    visited.add(start)

    while queue:
        r, c = queue.popleft()

        for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nr, nc = r + dr, c + dc

            if (
                0 <= nr < room_state.shape[0]
                and 0 <= nc < room_state.shape[1]
                and (nr, nc) not in visited
            ):
                # Player can move to empty spaces or targets
                if room_state[nr, nc] in [1, 2]:
                    if (nr, nc) == target_pos:
                        return True
                    queue.append((nr, nc))
                    visited.add((nr, nc))

    return False


def check_initial_deadlocks(room_state, room_structure):
    """
    Check if the initial room setup has any deadlock situations.
    Returns True if deadlocks are found.
    """
    # Check for boxes in deadlock positions
    boxes = np.where((room_state == 3) | (room_state == 4))

    for i in range(len(boxes[0])):
        box_pos = (boxes[0][i], boxes[1][i])
        if is_deadlock_position(room_structure, box_pos):
            return True

    # Check for frozen deadlocks
    if detect_frozen_deadlocks(room_state, room_structure):
        return True

    return False


def generate_room(
    dim=(13, 13),
    p_change_directions=0.35,
    num_steps=25,
    num_boxes=3,
    tries=1000,
    second_player=False,
    seed: int = None,
):
    """
    Generates a Sokoban room with deadlock detection to ensure solvability.
    """
    rng_objects = (
        {"random": random.Random(seed), "numpy": np.random.default_rng(seed)}
        if seed is not None
        else {}
    )

    # Increase tries since we're being more strict about deadlocks
    for t in range(tries):
        try:
            room = room_topology_generation(
                dim, p_change_directions, num_steps, rng_objects=rng_objects
            )
            room = place_boxes_and_player(
                room,
                num_boxes=num_boxes,
                second_player=second_player,
                rng_objects=rng_objects,
            )

            # Room fixed represents all not movable parts of the room
            room_structure = np.copy(room)
            room_structure[room_structure == 5] = 1

            # Room structure represents the current state of the room including movable parts
            room_state = room.copy()
            room_state[room_state == 2] = 4

            # Check for initial deadlocks before reverse playing
            if check_initial_deadlocks(room_state, room_structure):
                continue

            room_state, score, box_mapping = reverse_playing(room_state, room_structure)
            room_state[room_state == 3] = 4

            # Double-check final state for deadlocks
            if score > 0 and not check_initial_deadlocks(room_state, room_structure):
                return room_structure, room_state, box_mapping

        except (RuntimeError, RuntimeWarning):
            continue

    raise RuntimeWarning(
        "Could not generate a room without deadlocks after {} tries".format(tries)
    )


def place_boxes_and_player_safe(room, num_boxes, second_player, rng_objects={}):
    """
    Enhanced version that avoids placing boxes in obvious deadlock positions.
    """
    numpy_rng = (
        rng_objects["numpy"] if "numpy" in rng_objects else np.random.default_rng()
    )

    # Get all available positions
    possible_positions = np.where(room == 1)
    num_possible_positions = possible_positions[0].shape[0]
    num_players = 2 if second_player else 1

    if num_possible_positions <= num_boxes + num_players:
        raise RuntimeError(
            "Not enough free spots (#{}) to place {} player and {} boxes.".format(
                num_possible_positions, num_players, num_boxes
            )
        )

    # Place player(s) first
    ind = numpy_rng.integers(num_possible_positions)
    player_position = possible_positions[0][ind], possible_positions[1][ind]
    room[player_position] = 5

    if second_player:
        possible_positions = np.where(room == 1)
        num_possible_positions = possible_positions[0].shape[0]
        ind = numpy_rng.integers(num_possible_positions)
        player_position = possible_positions[0][ind], possible_positions[1][ind]
        room[player_position] = 5

    # Place boxes, avoiding obvious deadlock positions
    boxes_placed = 0
    attempts = 0
    max_attempts = num_possible_positions * 3

    while boxes_placed < num_boxes and attempts < max_attempts:
        possible_positions = np.where(room == 1)
        num_possible_positions = possible_positions[0].shape[0]

        if num_possible_positions == 0:
            break

        ind = numpy_rng.integers(num_possible_positions)
        box_position = possible_positions[0][ind], possible_positions[1][ind]

        # Check if this position would be a deadlock
        temp_room = room.copy()
        temp_room[box_position] = 2

        if not is_deadlock_position(temp_room, box_position):
            room[box_position] = 2
            boxes_placed += 1

        attempts += 1

    if boxes_placed < num_boxes:
        raise RuntimeError("Could not place all boxes without creating deadlocks")

    return room


# Replace the original place_boxes_and_player function
def place_boxes_and_player(room, num_boxes, second_player, rng_objects={}):
    """
    Places the player and the boxes into the floors in a room.
    Now with deadlock avoidance.
    """
    return place_boxes_and_player_safe(room, num_boxes, second_player, rng_objects)


# Keep all other original functions unchanged
def room_topology_generation(
    dim=(10, 10), p_change_directions=0.35, num_steps=15, rng_objects={}
):
    """
    Generate a room topology, which consits of empty floors and walls.
    """
    random_rng = rng_objects["random"] if "random" in rng_objects else random.Random()
    dim_x, dim_y = dim

    # The ones in the mask represent all fields which will be set to floors
    # during the random walk. The centered one will be placed over the current
    # position of the walk.
    masks = [
        [[0, 0, 0], [1, 1, 1], [0, 0, 0]],
        [[0, 1, 0], [0, 1, 0], [0, 1, 0]],
        [[0, 0, 0], [1, 1, 0], [0, 1, 0]],
        [[0, 0, 0], [1, 1, 0], [1, 1, 0]],
        [[0, 0, 0], [0, 1, 1], [0, 1, 0]],
    ]

    # Possible directions during the walk
    directions = [(1, 0), (0, 1), (-1, 0), (0, -1)]
    direction = random_rng.sample(directions, 1)[0]

    # Starting position of random walk
    position = np.array(
        [random_rng.randint(1, dim_x - 1), random_rng.randint(1, dim_y - 1)]
    )

    level = np.zeros(dim, dtype=int)

    for s in range(num_steps):
        # Change direction randomly
        if random_rng.random() < p_change_directions:
            direction = random_rng.sample(directions, 1)[0]

        # Update position
        position = position + direction
        position[0] = max(min(position[0], dim_x - 2), 1)
        position[1] = max(min(position[1], dim_y - 2), 1)

        # Apply mask
        mask = random_rng.sample(masks, 1)[0]
        mask_start = position - 1
        level[
            mask_start[0] : mask_start[0] + 3, mask_start[1] : mask_start[1] + 3
        ] += mask

    level[level > 0] = 1
    level[:, [0, dim_y - 1]] = 0
    level[[0, dim_x - 1], :] = 0

    return level


# Global variables used for reverse playing.
explored_states = set()
num_boxes = 0
best_room_score = -1
best_room = None
best_box_mapping = None


def reverse_playing(room_state, room_structure, search_depth=100):
    """
    This function plays Sokoban reverse in a way, such that the player can
    move and pull boxes.
    It ensures a solvable level with all boxes not being placed on a box target.
    """
    global explored_states, num_boxes, best_room_score, best_room, best_box_mapping

    # Box_Mapping is used to calculate the box displacement for every box
    box_mapping = {}
    box_locations = np.where(room_structure == 2)
    num_boxes = len(box_locations[0])
    for l in range(num_boxes):
        box = (box_locations[0][l], box_locations[1][l])
        box_mapping[box] = box

    # explored_states globally stores the best room state and score found during search
    explored_states = set()
    best_room_score = -1
    best_box_mapping = box_mapping
    depth_first_search(
        room_state,
        room_structure,
        box_mapping,
        box_swaps=0,
        last_pull=(-1, -1),
        ttl=300,
    )

    return best_room, best_room_score, best_box_mapping


def depth_first_search(
    room_state, room_structure, box_mapping, box_swaps=0, last_pull=(-1, -1), ttl=300
):
    """
    Searches through all possible states of the room.
    This is a recursive function, which stops if the tll is reduced to 0 or
    over 1.000.000 states have been explored.
    """
    global explored_states, num_boxes, best_room_score, best_room, best_box_mapping

    ttl -= 1
    if ttl <= 0 or len(explored_states) >= 300000:
        return

    state_tohash = marshal.dumps(room_state)

    # Only search this state, if it not yet has been explored
    if not (state_tohash in explored_states):
        # Add current state and its score to explored states
        room_score = box_swaps * box_displacement_score(box_mapping)
        if np.where(room_state == 2)[0].shape[0] != num_boxes:
            room_score = 0

        if room_score > best_room_score:
            best_room = room_state
            best_room_score = room_score
            best_box_mapping = box_mapping

        explored_states.add(state_tohash)

        for action in ["up", "down", "left", "right"]:
            # The state and box mapping  need to be copied to ensure
            # every action start from a similar state.
            room_state_next = room_state.copy()
            box_mapping_next = box_mapping.copy()

            room_state_next, box_mapping_next, last_pull_next = reverse_move(
                room_state_next, room_structure, box_mapping_next, last_pull, action
            )

            box_swaps_next = box_swaps
            if last_pull_next != last_pull:
                box_swaps_next += 1

            depth_first_search(
                room_state_next,
                room_structure,
                box_mapping_next,
                box_swaps_next,
                last_pull,
                ttl,
            )


def reverse_move(room_state, room_structure, box_mapping, last_pull, action):
    """
    Perform reverse action. Where all actions in the range [0, 3] correspond to
    push actions and the ones greater 3 are simmple move actions.
    """
    player_position = np.where(room_state == 5)
    player_position = np.array([player_position[0][0], player_position[1][0]])

    change = CHANGE_COORDINATES[["up", "down", "left", "right"].index(action)]
    next_position = player_position + change

    # Check if next position is an empty floor or an empty box target
    if room_state[next_position[0], next_position[1]] in [1, 2]:
        # Move player, independent of pull or move action.
        room_state[player_position[0], player_position[1]] = room_structure[
            player_position[0], player_position[1]
        ]
        room_state[next_position[0], next_position[1]] = 5

        # In addition try to pull a box if the action is a pull action
        possible_box_location = change[0] * -1, change[1] * -1
        possible_box_location += player_position

        if room_state[possible_box_location[0], possible_box_location[1]] in [3, 4]:
            # Perform pull of the adjacent box
            room_state[player_position[0], player_position[1]] = 3
            room_state[possible_box_location[0], possible_box_location[1]] = (
                room_structure[possible_box_location[0], possible_box_location[1]]
            )

            # Update the box mapping
            for k in box_mapping.keys():
                if box_mapping[k] == (
                    possible_box_location[0],
                    possible_box_location[1],
                ):
                    box_mapping[k] = (player_position[0], player_position[1])
                    last_pull = k

    return room_state, box_mapping, last_pull


def box_displacement_score(box_mapping):
    """
    Calculates the sum of all Manhattan distances, between the boxes
    and their origin box targets.
    """
    score = 0
    for box_target in box_mapping.keys():
        box_location = np.array(box_mapping[box_target])
        box_target = np.array(box_target)
        dist = np.sum(np.abs(box_location - box_target))
        score += dist
    return score
