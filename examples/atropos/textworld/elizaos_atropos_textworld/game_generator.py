"""
Procedural game generation for TextWorld.
"""

from __future__ import annotations

import random
from typing import TYPE_CHECKING

from elizaos_atropos_textworld.types import (
    GameType,
    Difficulty,
    Room,
    Item,
    Container,
)

if TYPE_CHECKING:
    pass


# Room templates
ROOM_TEMPLATES = {
    "kitchen": {
        "description": "You are in a kitchen. The smell of old food lingers in the air.",
        "containers": ["refrigerator", "cupboard"],
    },
    "living_room": {
        "description": "You are in a cozy living room. A fireplace crackles nearby.",
        "containers": ["cabinet", "bookshelf"],
    },
    "bedroom": {
        "description": "You are in a bedroom. A large bed dominates the space.",
        "containers": ["dresser", "closet"],
    },
    "bathroom": {
        "description": "You are in a small bathroom with white tiles.",
        "containers": ["medicine cabinet"],
    },
    "garden": {
        "description": "You are in a peaceful garden. Flowers bloom all around.",
        "containers": ["shed"],
    },
    "basement": {
        "description": "You are in a dark basement. Cobwebs hang from the ceiling.",
        "containers": ["chest", "crate"],
    },
    "attic": {
        "description": "You are in a dusty attic. Old furniture is piled in corners.",
        "containers": ["trunk", "box"],
    },
    "hallway": {
        "description": "You are in a long hallway. Doors line both sides.",
        "containers": [],
    },
}

# Item templates
ITEM_TEMPLATES = {
    "treasure": [
        Item("golden key", "A shiny golden key.", takeable=True, is_goal=True),
        Item("diamond", "A sparkling diamond.", takeable=True, is_goal=True),
        Item("ancient coin", "An ancient gold coin.", takeable=True, is_goal=True),
        Item("ruby", "A deep red ruby.", takeable=True, is_goal=True),
        Item("treasure map", "An old treasure map.", takeable=True, is_goal=True),
    ],
    "food": [
        Item("apple", "A fresh red apple.", takeable=True, edible=True),
        Item("bread", "A loaf of bread.", takeable=True, edible=True, cookable=True),
        Item("cheese", "A wedge of cheese.", takeable=True, edible=True, cookable=True),
        Item("carrot", "An orange carrot.", takeable=True, edible=True, cookable=True),
    ],
    "tools": [
        Item("knife", "A sharp kitchen knife.", takeable=True),
        Item("lantern", "An old oil lantern.", takeable=True),
        Item("rope", "A coil of rope.", takeable=True),
    ],
    "misc": [
        Item("book", "An old dusty book.", takeable=True),
        Item("letter", "A sealed letter.", takeable=True),
        Item("candle", "A half-melted candle.", takeable=True),
    ],
}

# Container templates
CONTAINER_TEMPLATES = {
    "refrigerator": Container("refrigerator", "A large white refrigerator.", is_open=False),
    "cupboard": Container("cupboard", "A wooden cupboard.", is_open=False),
    "cabinet": Container("cabinet", "A glass-fronted cabinet.", is_open=False),
    "bookshelf": Container("bookshelf", "A tall bookshelf.", is_open=True),
    "dresser": Container("dresser", "A wooden dresser.", is_open=False),
    "closet": Container("closet", "A walk-in closet.", is_open=False),
    "medicine cabinet": Container("medicine cabinet", "A small medicine cabinet.", is_open=False),
    "shed": Container("shed", "A garden shed.", is_open=False),
    "chest": Container("chest", "An old wooden chest.", is_open=False),
    "crate": Container("crate", "A wooden crate.", is_open=False),
    "trunk": Container("trunk", "An antique trunk.", is_open=False),
    "box": Container("box", "A cardboard box.", is_open=False),
}


class GameGenerator:
    """
    Procedural game generator for TextWorld-style games.
    
    Generates text adventure games with varying complexity based on
    difficulty settings and game type.
    """

    def __init__(
        self,
        game_type: GameType = GameType.TREASURE_HUNT,
        difficulty: Difficulty = Difficulty.MEDIUM,
        seed: int | None = None,
    ) -> None:
        """
        Initialize the game generator.
        
        Args:
            game_type: Type of game to generate
            difficulty: Game difficulty
            seed: Random seed for reproducibility
        """
        self._game_type = game_type
        self._difficulty = difficulty
        self._rng = random.Random(seed)

        # Difficulty parameters
        self._params = self._get_difficulty_params()

    def _get_difficulty_params(self) -> dict[str, int]:
        """Get parameters based on difficulty."""
        if self._difficulty == Difficulty.EASY:
            return {
                "num_rooms": 3,
                "num_items": 2,
                "num_containers": 1,
                "num_goals": 1,
                "max_steps": 50,
            }
        elif self._difficulty == Difficulty.MEDIUM:
            return {
                "num_rooms": 5,
                "num_items": 4,
                "num_containers": 3,
                "num_goals": 2,
                "max_steps": 100,
            }
        else:  # HARD
            return {
                "num_rooms": 8,
                "num_items": 6,
                "num_containers": 5,
                "num_goals": 3,
                "max_steps": 150,
            }

    def generate(self) -> dict[str, Room]:
        """
        Generate a new game world.
        
        Returns:
            Dictionary of room name to Room objects
        """
        num_rooms = self._params["num_rooms"]

        # Select room types
        room_types = list(ROOM_TEMPLATES.keys())
        selected_types = self._rng.sample(
            room_types,
            min(num_rooms, len(room_types)),
        )

        # Pad with random rooms if needed
        while len(selected_types) < num_rooms:
            selected_types.append(self._rng.choice(room_types))

        # Create rooms
        rooms: dict[str, Room] = {}
        for i, room_type in enumerate(selected_types):
            template = ROOM_TEMPLATES[room_type]
            room_name = f"{room_type}_{i}" if i > 0 else room_type

            # Create containers for this room
            containers: list[Container] = []
            for container_name in template["containers"]:
                if container_name in CONTAINER_TEMPLATES:
                    template_container = CONTAINER_TEMPLATES[container_name]
                    containers.append(Container(
                        name=template_container.name,
                        description=template_container.description,
                        is_open=template_container.is_open,
                    ))

            rooms[room_name] = Room(
                name=room_name,
                description=str(template["description"]),
                containers=containers[:self._params["num_containers"]],
            )

        # Connect rooms
        room_names = list(rooms.keys())
        for i, room_name in enumerate(room_names):
            room = rooms[room_name]

            # Connect to next room
            if i < len(room_names) - 1:
                next_room = room_names[i + 1]
                room.exits["north"] = next_room
                rooms[next_room].exits["south"] = room_name

            # Add some random connections for larger games
            if self._difficulty != Difficulty.EASY and i > 1:
                if self._rng.random() < 0.3:
                    random_room = self._rng.choice(room_names[:i])
                    if random_room != room_name:
                        direction = self._rng.choice(["east", "west"])
                        if direction not in room.exits:
                            opposite = "west" if direction == "east" else "east"
                            room.exits[direction] = random_room
                            rooms[random_room].exits[opposite] = room_name

        # Place items
        self._place_items(rooms)

        return rooms

    def _place_items(self, rooms: dict[str, Room]) -> None:
        """Place items and goals in the world."""
        room_list = list(rooms.values())

        # Place goal items
        if self._game_type == GameType.TREASURE_HUNT:
            goal_items = self._rng.sample(
                ITEM_TEMPLATES["treasure"],
                self._params["num_goals"],
            )
        elif self._game_type == GameType.COOKING:
            goal_items = self._rng.sample(
                ITEM_TEMPLATES["food"],
                self._params["num_goals"],
            )
        else:
            goal_items = self._rng.sample(
                ITEM_TEMPLATES["treasure"],
                self._params["num_goals"],
            )

        # Place goals in random rooms/containers
        for item in goal_items:
            room = self._rng.choice(room_list)

            # 50% chance to put in container if available
            if room.containers and self._rng.random() < 0.5:
                container = self._rng.choice(room.containers)
                # Create a copy of the item for the container
                container.contents.append(Item(
                    name=item.name,
                    description=item.description,
                    takeable=item.takeable,
                    is_goal=True,
                ))
            else:
                room.items.append(Item(
                    name=item.name,
                    description=item.description,
                    takeable=item.takeable,
                    is_goal=True,
                ))

        # Place other items
        other_categories = ["tools", "misc"]
        if self._game_type == GameType.COOKING:
            other_categories.append("food")

        all_other_items = []
        for category in other_categories:
            all_other_items.extend(ITEM_TEMPLATES.get(category, []))

        num_other = min(
            self._params["num_items"] - self._params["num_goals"],
            len(all_other_items),
        )

        if num_other > 0:
            other_items = self._rng.sample(all_other_items, num_other)

            for item in other_items:
                room = self._rng.choice(room_list)
                room.items.append(Item(
                    name=item.name,
                    description=item.description,
                    takeable=item.takeable,
                    edible=item.edible,
                    cookable=item.cookable,
                ))

    def get_starting_room(self, rooms: dict[str, Room]) -> str:
        """Get the name of the starting room."""
        return list(rooms.keys())[0]

    def count_goals(self, rooms: dict[str, Room]) -> int:
        """Count total goal items in the world."""
        count = 0
        for room in rooms.values():
            for item in room.items:
                if item.is_goal:
                    count += 1
            for container in room.containers:
                for item in container.contents:
                    if item.is_goal:
                        count += 1
        return count

    @property
    def max_steps(self) -> int:
        """Get maximum steps for this game."""
        return self._params["max_steps"]
