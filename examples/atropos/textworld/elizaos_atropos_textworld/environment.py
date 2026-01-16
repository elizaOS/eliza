"""
TextWorld environment implementation.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from elizaos_atropos_textworld.types import (
    GameType,
    Difficulty,
    GameState,
    StepResult,
    EpisodeResult,
    Room,
    Item,
)
from elizaos_atropos_textworld.game_generator import GameGenerator

if TYPE_CHECKING:
    pass


class TextWorldEnvironment:
    """
    TextWorld-style text adventure environment.
    
    Generates procedural text-based games and provides an interface
    for ElizaOS agents to interact with them.
    
    Example:
        >>> env = TextWorldEnvironment(game_type="treasure_hunt", difficulty="medium")
        >>> await env.initialize()
        >>> state = await env.reset()
        >>> result = await env.step("go north")
    """

    def __init__(
        self,
        game_type: GameType | str = GameType.TREASURE_HUNT,
        difficulty: Difficulty | str = Difficulty.MEDIUM,
        seed: int | None = None,
    ) -> None:
        """
        Initialize the TextWorld environment.
        
        Args:
            game_type: Type of game to generate
            difficulty: Game difficulty level
            seed: Random seed for reproducibility
        """
        if isinstance(game_type, str):
            game_type = GameType(game_type)
        if isinstance(difficulty, str):
            difficulty = Difficulty(difficulty)

        self._game_type = game_type
        self._difficulty = difficulty
        self._seed = seed
        self._generator = GameGenerator(game_type, difficulty, seed)

        # Game state
        self._rooms: dict[str, Room] = {}
        self._current_room: str = ""
        self._inventory: list[Item] = []
        self._score: int = 0
        self._max_score: int = 0
        self._steps: int = 0
        self._max_steps: int = 100
        self._game_over: bool = False
        self._won: bool = False
        self._action_history: list[str] = []
        self._initialized: bool = False

    async def initialize(self) -> None:
        """Initialize the environment."""
        self._initialized = True

    async def reset(self, seed: int | None = None) -> GameState:
        """
        Reset the environment with a new game.
        
        Args:
            seed: Optional random seed
            
        Returns:
            Initial game state
        """
        # Generate new game
        if seed is not None:
            self._generator = GameGenerator(
                self._game_type,
                self._difficulty,
                seed,
            )

        self._rooms = self._generator.generate()
        self._current_room = self._generator.get_starting_room(self._rooms)
        self._inventory = []
        self._score = 0
        self._max_score = self._generator.count_goals(self._rooms)
        self._steps = 0
        self._max_steps = self._generator.max_steps
        self._game_over = False
        self._won = False
        self._action_history = []

        return self._get_state()

    def _get_state(self) -> GameState:
        """Get current game state."""
        room = self._rooms[self._current_room]

        return GameState(
            description=room.get_full_description(),
            inventory=list(self._inventory),
            current_room=self._current_room,
            score=self._score,
            max_score=self._max_score,
            steps=self._steps,
            max_steps=self._max_steps,
            admissible_commands=self._get_admissible_commands(),
            game_over=self._game_over,
            won=self._won,
        )

    def _get_admissible_commands(self) -> list[str]:
        """Get list of valid commands in current state."""
        commands: list[str] = ["look", "inventory"]
        room = self._rooms[self._current_room]

        # Navigation
        for direction in room.exits.keys():
            commands.append(f"go {direction}")

        # Item interaction
        for item in room.items:
            commands.append(f"examine {item.name}")
            if item.takeable:
                commands.append(f"take {item.name}")

        # Container interaction
        for container in room.containers:
            commands.append(f"examine {container.name}")
            if not container.is_open:
                commands.append(f"open {container.name}")
            else:
                commands.append(f"close {container.name}")
                for item in container.contents:
                    commands.append(f"take {item.name} from {container.name}")

        # Inventory interaction
        for item in self._inventory:
            commands.append(f"drop {item.name}")
            commands.append(f"examine {item.name}")
            if item.edible:
                commands.append(f"eat {item.name}")

        return commands

    async def step(self, action: str) -> StepResult:
        """
        Execute an action in the game.
        
        Args:
            action: The action to take (e.g., "go north", "take key")
            
        Returns:
            StepResult with new state, reward, and feedback
        """
        self._steps += 1
        self._action_history.append(action)

        action = action.lower().strip()
        feedback, reward = self._execute_action(action)

        # Check win condition
        if self._score >= self._max_score:
            self._won = True
            self._game_over = True
            feedback += "\n*** You have won! ***"

        # Check step limit
        if self._steps >= self._max_steps:
            self._game_over = True
            feedback += "\n*** You ran out of time. ***"

        return StepResult(
            state=self._get_state(),
            reward=reward,
            done=self._game_over,
            feedback=feedback,
        )

    def _execute_action(self, action: str) -> tuple[str, float]:
        """Execute an action and return feedback and reward."""
        room = self._rooms[self._current_room]

        # Look
        if action == "look":
            return room.get_full_description(), 0.0

        # Inventory
        if action == "inventory":
            if not self._inventory:
                return "Your inventory is empty.", 0.0
            items = ", ".join(str(item) for item in self._inventory)
            return f"You are carrying: {items}.", 0.0

        # Go direction
        match = re.match(r"go\s+(\w+)", action)
        if match:
            direction = match.group(1)
            if direction in room.exits:
                self._current_room = room.exits[direction]
                new_room = self._rooms[self._current_room]
                return f"You go {direction}.\n\n{new_room.get_full_description()}", 0.0
            return f"You can't go {direction} from here.", -0.1

        # Take item
        match = re.match(r"take\s+(.+?)(?:\s+from\s+(.+))?$", action)
        if match:
            item_name = match.group(1)
            container_name = match.group(2)

            if container_name:
                # Take from container
                for container in room.containers:
                    if container.name.lower() == container_name.lower():
                        if not container.is_open:
                            return f"The {container.name} is closed.", -0.1
                        for item in container.contents:
                            if item.name.lower() == item_name.lower():
                                container.contents.remove(item)
                                self._inventory.append(item)
                                reward = 1.0 if item.is_goal else 0.1
                                if item.is_goal:
                                    self._score += 1
                                return f"You take the {item.name} from the {container.name}.", reward
                        return f"There's no {item_name} in the {container.name}.", -0.1
                return f"There's no {container_name} here.", -0.1
            else:
                # Take from room
                for item in room.items:
                    if item.name.lower() == item_name.lower():
                        if not item.takeable:
                            return f"You can't take the {item.name}.", -0.1
                        room.items.remove(item)
                        self._inventory.append(item)
                        reward = 1.0 if item.is_goal else 0.1
                        if item.is_goal:
                            self._score += 1
                        return f"You take the {item.name}.", reward
                return f"There's no {item_name} here.", -0.1

        # Drop item
        match = re.match(r"drop\s+(.+)", action)
        if match:
            item_name = match.group(1)
            for item in self._inventory:
                if item.name.lower() == item_name.lower():
                    self._inventory.remove(item)
                    room.items.append(item)
                    return f"You drop the {item.name}.", 0.0
            return f"You don't have a {item_name}.", -0.1

        # Open container
        match = re.match(r"open\s+(.+)", action)
        if match:
            container_name = match.group(1)
            for container in room.containers:
                if container.name.lower() == container_name.lower():
                    if container.is_open:
                        return f"The {container.name} is already open.", 0.0
                    if container.locked:
                        # Check for key
                        has_key = any(
                            item.name.lower() == container.key_name
                            for item in self._inventory
                            if container.key_name
                        )
                        if not has_key:
                            return f"The {container.name} is locked.", 0.0
                    container.is_open = True
                    if container.contents:
                        contents = ", ".join(str(i) for i in container.contents)
                        return f"You open the {container.name}, revealing: {contents}.", 0.5
                    return f"You open the {container.name}. It's empty.", 0.1
            return f"There's no {container_name} here.", -0.1

        # Close container
        match = re.match(r"close\s+(.+)", action)
        if match:
            container_name = match.group(1)
            for container in room.containers:
                if container.name.lower() == container_name.lower():
                    if not container.is_open:
                        return f"The {container.name} is already closed.", 0.0
                    container.is_open = False
                    return f"You close the {container.name}.", 0.0
            return f"There's no {container_name} here.", -0.1

        # Examine
        match = re.match(r"examine\s+(.+)", action)
        if match:
            target = match.group(1)

            # Check inventory
            for item in self._inventory:
                if item.name.lower() == target.lower():
                    return item.description, 0.0

            # Check room items
            for item in room.items:
                if item.name.lower() == target.lower():
                    return item.description, 0.0

            # Check containers
            for container in room.containers:
                if container.name.lower() == target.lower():
                    return container.description, 0.0
                if container.is_open:
                    for item in container.contents:
                        if item.name.lower() == target.lower():
                            return item.description, 0.0

            return f"You don't see any {target} here.", -0.1

        # Eat item
        match = re.match(r"eat\s+(.+)", action)
        if match:
            item_name = match.group(1)
            for item in self._inventory:
                if item.name.lower() == item_name.lower():
                    if not item.edible:
                        return f"You can't eat the {item.name}.", -0.1
                    self._inventory.remove(item)
                    return f"You eat the {item.name}. Delicious!", 0.1
            return f"You don't have a {item_name}.", -0.1

        return f"I don't understand '{action}'.", -0.1

    async def close(self) -> None:
        """Close the environment."""
        self._rooms = {}
        self._initialized = False

    def get_episode_result(self) -> EpisodeResult:
        """Get result of current episode."""
        return EpisodeResult(
            score=self._score,
            max_score=self._max_score,
            steps=self._steps,
            max_steps=self._max_steps,
            won=self._won,
            actions_taken=list(self._action_history),
        )

    async def play_episode(
        self,
        policy: callable,
        seed: int | None = None,
    ) -> EpisodeResult:
        """
        Play a complete episode using the given policy.
        
        Args:
            policy: Async function that takes (state) and returns an action string
            seed: Optional random seed
            
        Returns:
            EpisodeResult with final outcome
        """
        state = await self.reset(seed=seed)

        while not state.game_over:
            action = await policy(state)
            result = await self.step(action)
            state = result.state

        return self.get_episode_result()
