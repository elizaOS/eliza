#!/usr/bin/env python3
"""
elizaOS Adventure Game Demo

A text adventure game where an AI agent (powered by elizaOS) explores a dungeon,
making decisions about which actions to take. Demonstrates:
- elizaOS runtime with plugins
- OpenAI integration for AI decision making
- Custom game actions
- State management

Usage:
    OPENAI_API_KEY=your_key ./examples/python/.venv/bin/python examples/python/adventure-game.py

To suppress logs:
    LOG_LEVEL=fatal OPENAI_API_KEY=your_key python examples/python/adventure-game.py
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from dataclasses import dataclass, field
from enum import Enum
from typing import TypedDict

# Suppress noisy logs
logging.getLogger("httpx").setLevel(logging.WARNING)
if os.environ.get("LOG_LEVEL", "").lower() == "fatal":
    logging.disable(logging.CRITICAL)

from uuid6 import uuid7
import uuid

from elizaos import Character, ModelType
from elizaos.runtime import AgentRuntime
from elizaos.types.memory import Memory
from elizaos.types.primitives import Content, as_uuid
from elizaos_plugin_openai import get_openai_plugin


# ============================================================================
# GAME WORLD DEFINITION
# ============================================================================


@dataclass
class Item:
    id: str
    name: str
    description: str
    usable: bool


@dataclass
class Enemy:
    name: str
    health: int
    damage: int
    description: str
    defeated_message: str


@dataclass
class Room:
    id: str
    name: str
    description: str
    exits: dict[str, str]
    items: list[Item]
    enemy: Enemy | None = None
    visited: bool = False


@dataclass
class GameState:
    current_room: str = "entrance"
    inventory: list[Item] = field(default_factory=list)
    health: int = 100
    max_health: int = 100
    score: int = 0
    turns_played: int = 0
    game_over: bool = False
    victory: bool = False


# Item definitions
ITEMS: dict[str, Item] = {
    "torch": Item(
        id="torch",
        name="Rusty Torch",
        description="A flickering torch that casts dancing shadows",
        usable=True,
    ),
    "key": Item(
        id="key",
        name="Golden Key",
        description="An ornate key with strange symbols",
        usable=True,
    ),
    "sword": Item(
        id="sword",
        name="Ancient Sword",
        description="A weathered but sharp blade",
        usable=True,
    ),
    "potion": Item(
        id="potion",
        name="Health Potion",
        description="A glowing red liquid that restores health",
        usable=True,
    ),
    "treasure": Item(
        id="treasure",
        name="Dragon's Treasure",
        description="A chest overflowing with gold and gems",
        usable=False,
    ),
}

# Enemy definitions
ENEMIES: dict[str, Enemy] = {
    "goblin": Enemy(
        name="Cave Goblin",
        health=30,
        damage=10,
        description="A snarling goblin blocks your path, brandishing a crude club",
        defeated_message="The goblin crumples to the ground, defeated!",
    ),
    "skeleton": Enemy(
        name="Skeletal Guardian",
        health=40,
        damage=15,
        description="Ancient bones rattle as a skeleton warrior rises to face you",
        defeated_message="The skeleton collapses into a pile of bones!",
    ),
    "dragon": Enemy(
        name="Ancient Dragon",
        health=100,
        damage=25,
        description="A massive dragon guards its treasure, smoke curling from its nostrils",
        defeated_message="With a final roar, the dragon falls! The treasure is yours!",
    ),
}


def create_game_world() -> dict[str, Room]:
    """Create a fresh game world with all rooms."""
    return {
        "entrance": Room(
            id="entrance",
            name="Dungeon Entrance",
            description="You stand at the entrance of a dark dungeon. Cold air flows from within, "
            "carrying whispers of adventure and danger. Stone steps lead down into darkness.",
            exits={"north": "hallway"},
            items=[Item(**vars(ITEMS["torch"]))],
        ),
        "hallway": Room(
            id="hallway",
            name="Torch-lit Hallway",
            description="A long hallway stretches before you, ancient torches casting flickering "
            "light on the stone walls. Cobwebs hang from the ceiling.",
            exits={"south": "entrance", "north": "chamber", "east": "armory"},
            items=[],
            enemy=Enemy(**vars(ENEMIES["goblin"])),
        ),
        "armory": Room(
            id="armory",
            name="Abandoned Armory",
            description="Rusted weapons line the walls of this forgotten armory. "
            "Most are beyond use, but something glints in the corner.",
            exits={"west": "hallway"},
            items=[Item(**vars(ITEMS["sword"])), Item(**vars(ITEMS["potion"]))],
        ),
        "chamber": Room(
            id="chamber",
            name="Central Chamber",
            description="A vast underground chamber with a domed ceiling. "
            "Three passages branch off into darkness. A locked door stands to the north.",
            exits={"south": "hallway", "east": "crypt", "west": "library", "north": "throne"},
            items=[],
            enemy=Enemy(**vars(ENEMIES["skeleton"])),
        ),
        "library": Room(
            id="library",
            name="Ancient Library",
            description="Dusty tomes fill towering shelves. The air smells of old paper "
            "and forgotten knowledge. A golden key lies on a reading table.",
            exits={"east": "chamber"},
            items=[Item(**vars(ITEMS["key"]))],
        ),
        "crypt": Room(
            id="crypt",
            name="Dark Crypt",
            description="Stone sarcophagi line the walls of this burial chamber. "
            "The silence is oppressive.",
            exits={"west": "chamber"},
            items=[Item(**vars(ITEMS["potion"]))],
        ),
        "throne": Room(
            id="throne",
            name="Dragon's Throne Room",
            description="A massive cavern dominated by an ancient throne. "
            "Piles of gold and gems surround it. This is the dragon's lair!",
            exits={"south": "chamber"},
            items=[Item(**vars(ITEMS["treasure"]))],
            enemy=Enemy(**vars(ENEMIES["dragon"])),
        ),
    }


# ============================================================================
# GAME ENGINE
# ============================================================================


class AdventureGame:
    """Text adventure game engine."""

    def __init__(self) -> None:
        self.world = create_game_world()
        self.state = GameState()

    def get_state(self) -> GameState:
        """Get a copy of current game state."""
        return GameState(
            current_room=self.state.current_room,
            inventory=list(self.state.inventory),
            health=self.state.health,
            max_health=self.state.max_health,
            score=self.state.score,
            turns_played=self.state.turns_played,
            game_over=self.state.game_over,
            victory=self.state.victory,
        )

    def get_current_room(self) -> Room:
        """Get the current room."""
        return self.world[self.state.current_room]

    def get_available_actions(self) -> list[str]:
        """Get list of available actions."""
        room = self.get_current_room()
        actions: list[str] = []

        # Movement
        for direction in room.exits.keys():
            # Check if north requires key for throne room
            if direction == "north" and room.id == "chamber":
                if any(i.id == "key" for i in self.state.inventory):
                    actions.append(f"go {direction}")
            else:
                actions.append(f"go {direction}")

        # Pick up items
        for item in room.items:
            actions.append(f"take {item.name.lower()}")

        # Combat
        if room.enemy and room.enemy.health > 0:
            actions.append("attack")
            if any(i.id == "sword" for i in self.state.inventory):
                actions.append("attack with sword")

        # Use items
        for item in self.state.inventory:
            if item.usable:
                actions.append(f"use {item.name.lower()}")

        # Always available
        actions.append("look around")
        actions.append("check inventory")

        return actions

    def execute_action(self, action: str) -> str:
        """Execute an action and return the result."""
        self.state.turns_played += 1
        action_lower = action.lower().strip()

        # Movement
        if action_lower.startswith("go "):
            return self._handle_move(action_lower[3:])

        # Take item
        if action_lower.startswith("take "):
            return self._handle_take(action_lower[5:])
        if action_lower.startswith("pick up "):
            return self._handle_take(action_lower[8:])

        # Attack
        if action_lower.startswith("attack"):
            with_sword = "sword" in action_lower
            return self._handle_attack(with_sword)

        # Use item
        if action_lower.startswith("use "):
            return self._handle_use(action_lower[4:])

        # Look around
        if action_lower in ("look around", "look"):
            return self.describe_room()

        # Check inventory
        if action_lower in ("check inventory", "inventory", "i"):
            return self.describe_inventory()

        return f'I don\'t understand "{action}". Try one of the available actions.'

    def _handle_move(self, direction: str) -> str:
        """Handle movement."""
        room = self.get_current_room()

        # Check for locked door
        if (
            direction == "north"
            and room.id == "chamber"
            and not any(i.id == "key" for i in self.state.inventory)
        ):
            return "The door to the north is locked. You need a key to proceed."

        # Check for enemies blocking the path
        if room.enemy and room.enemy.health > 0 and direction != "south":
            return f"The {room.enemy.name} blocks your path! You must defeat it first or retreat south."

        if direction in room.exits:
            next_room_id = room.exits[direction]

            # Use key if going to throne room
            if direction == "north" and room.id == "chamber":
                key_idx = next((i for i, item in enumerate(self.state.inventory) if item.id == "key"), None)
                if key_idx is not None:
                    self.state.inventory.pop(key_idx)

            self.state.current_room = next_room_id
            new_room = self.get_current_room()
            first_visit = not new_room.visited
            new_room.visited = True

            if first_visit:
                self.state.score += 10

            result = f"You move {direction}.\n\n{self.describe_room()}"

            if new_room.enemy and new_room.enemy.health > 0:
                result += f"\n\n⚔️ DANGER! {new_room.enemy.description}"

            return result

        return f"You cannot go {direction} from here."

    def _handle_take(self, item_name: str) -> str:
        """Handle taking an item."""
        room = self.get_current_room()
        item_idx = next(
            (i for i, item in enumerate(room.items) if item_name.lower() in item.name.lower()),
            None,
        )

        if item_idx is not None:
            item = room.items.pop(item_idx)
            self.state.inventory.append(item)
            self.state.score += 5
            return f"You pick up the {item.name}. {item.description}"

        return f'There is no "{item_name}" here to take.'

    def _handle_attack(self, with_sword: bool) -> str:
        """Handle combat."""
        room = self.get_current_room()

        if not room.enemy or room.enemy.health <= 0:
            return "There is nothing to attack here."

        enemy = room.enemy
        player_damage = 35 if with_sword else 15
        weapon_text = "strike with your ancient sword" if with_sword else "punch with your fists"

        enemy.health -= player_damage

        result = f"You {weapon_text}, dealing {player_damage} damage!"

        if enemy.health <= 0:
            result += f"\n\n🎉 {enemy.defeated_message}"
            self.state.score += 50

            # Victory condition: defeating the dragon
            if enemy.name == "Ancient Dragon":
                self.state.victory = True
                self.state.game_over = True
                self.state.score += 200
                result += "\n\n🏆 VICTORY! You have conquered the dungeon and claimed the dragon's treasure!"
                result += f"\n\nFinal Score: {self.state.score} points in {self.state.turns_played} turns."
        else:
            # Enemy counterattacks
            self.state.health -= enemy.damage
            result += f"\nThe {enemy.name} strikes back for {enemy.damage} damage!"
            result += f"\nYour health: {self.state.health}/{self.state.max_health} | Enemy health: {enemy.health}"

            if self.state.health <= 0:
                self.state.game_over = True
                result += f"\n\n💀 GAME OVER! You have been defeated by the {enemy.name}."
                result += f"\n\nFinal Score: {self.state.score} points in {self.state.turns_played} turns."

        return result

    def _handle_use(self, item_name: str) -> str:
        """Handle using an item."""
        item_idx = next(
            (i for i, item in enumerate(self.state.inventory) if item_name.lower() in item.name.lower()),
            None,
        )

        if item_idx is None:
            return f'You don\'t have "{item_name}" in your inventory.'

        item = self.state.inventory[item_idx]

        if item.id == "potion":
            heal_amount = min(50, self.state.max_health - self.state.health)
            self.state.health += heal_amount
            self.state.inventory.pop(item_idx)
            return f"You drink the health potion and restore {heal_amount} health! Health: {self.state.health}/{self.state.max_health}"

        if item.id == "torch":
            return "The torch illuminates your surroundings. You can see more clearly now."

        if item.id == "key":
            return "The key looks like it would fit a large lock. Perhaps there's a locked door somewhere."

        if item.id == "sword":
            return "You swing the ancient sword through the air. It feels well-balanced and deadly."

        return f"You can't use the {item.name} right now."

    def describe_room(self) -> str:
        """Get room description."""
        room = self.get_current_room()
        description = f"📍 {room.name}\n\n{room.description}"

        if room.items:
            item_names = ", ".join(i.name for i in room.items)
            description += f"\n\n📦 Items here: {item_names}"

        exits = ", ".join(room.exits.keys())
        description += f"\n\n🚪 Exits: {exits}"

        if room.id == "chamber" and not any(i.id == "key" for i in self.state.inventory):
            description += "\n(The door to the north is locked)"

        return description

    def describe_inventory(self) -> str:
        """Get inventory description."""
        if not self.state.inventory:
            return "🎒 Your inventory is empty."

        items = "\n".join(f"  - {i.name}: {i.description}" for i in self.state.inventory)
        return (
            f"🎒 Inventory:\n{items}\n\n"
            f"❤️ Health: {self.state.health}/{self.state.max_health} | ⭐ Score: {self.state.score}"
        )

    def get_status_line(self) -> str:
        """Get status line."""
        return f"❤️ {self.state.health}/{self.state.max_health} | ⭐ {self.state.score} | 🔄 Turn {self.state.turns_played}"


# ============================================================================
# AI AGENT INTEGRATION
# ============================================================================


def string_to_uuid(input_str: str) -> str:
    """Convert a string to a deterministic UUID (matching TypeScript's stringToUuid)."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, input_str))


@dataclass
class GameSession:
    """Game session with runtime and game state."""

    runtime: AgentRuntime
    game: AdventureGame
    room_id: str
    game_master_id: str


async def create_session() -> GameSession:
    """Create and initialize a game session."""
    print("🚀 Initializing adventure...")

    openai_key = os.environ.get("OPENAI_API_KEY")
    if not openai_key:
        raise RuntimeError("OPENAI_API_KEY environment variable is required")

    character = Character(
        name="Eliza the Adventurer",
        username="eliza_adventurer",
        bio=[
            "A brave AI adventurer exploring dangerous dungeons.",
            "Known for clever problem-solving and careful exploration.",
            "Prefers to be well-prepared before combat.",
        ],
        system="You are a strategic adventurer in a text adventure game.",
    )

    # action_planning=False ensures only one action is executed per turn,
    # which is critical for game scenarios where state changes after each action
    runtime = AgentRuntime(
        character=character, 
        plugins=[get_openai_plugin()],
        action_planning=False,  # Single action per turn for game state consistency
    )
    await runtime.initialize()

    game = AdventureGame()
    room_id = string_to_uuid("adventure-game-room")
    game_master_id = string_to_uuid("dungeon-master")

    print("✅ Adventure ready!")
    return GameSession(
        runtime=runtime, 
        game=game, 
        room_id=room_id, 
        game_master_id=game_master_id
    )


async def save_game_result(session: GameSession, result: str) -> None:
    """Save a game result message so the agent can see the outcome."""
    runtime = session.runtime
    
    result_message = Memory(
        id=as_uuid(str(uuid.uuid4())),
        entity_id=as_uuid(session.game_master_id),
        room_id=as_uuid(session.room_id),
        content=Content(text=f"GAME RESULT: {result}"),
        created_at=int(asyncio.get_event_loop().time() * 1000),
    )
    
    # Save to memory so it appears in conversation history
    await runtime.create_memory(result_message, "messages")


async def decide_action(session: GameSession) -> str:
    """Have the AI decide the next action."""
    game = session.game
    runtime = session.runtime

    state = game.get_state()
    room = game.get_current_room()
    actions = game.get_available_actions()

    # Build the game state message from the Dungeon Master
    enemy_info = ""
    if room.enemy and room.enemy.health > 0:
        enemy_info = f"⚠️ ENEMY PRESENT: {room.enemy.name} (Health: {room.enemy.health})"

    inventory_str = ", ".join(i.name for i in state.inventory) or "empty"
    actions_str = "\n".join(f"{i + 1}. {a}" for i, a in enumerate(actions))

    game_context = f"""DUNGEON MASTER UPDATE:

GAME STATE:
- Location: {room.name}
- Health: {state.health}/{state.max_health}
- Inventory: {inventory_str}
- Score: {state.score}
- Turn: {state.turns_played}

CURRENT SCENE:
{game.describe_room()}

{enemy_info}

AVAILABLE ACTIONS:
{actions_str}

INSTRUCTIONS:
You are playing a text adventure game. Your goal is to explore the dungeon, collect items, defeat enemies, and find the dragon's treasure.

Think strategically:
- Explore to find items and the key before facing the dragon
- Pick up weapons (sword) before combat
- Use health potions when low on health
- The dragon is the final boss - be prepared!

Based on the current situation, choose the best action. Consider:
- If there's an enemy, do you have a weapon? Should you fight or flee?
- Are there useful items to pick up?
- Have you explored all areas?
- Is your health low? Do you have healing items?

Respond with ONLY the exact action text you want to take (e.g., "go north" or "attack with sword").
"""

    # Create a proper message memory from the Dungeon Master
    message = Memory(
        id=as_uuid(str(uuid.uuid4())),
        entity_id=as_uuid(session.game_master_id),
        room_id=as_uuid(session.room_id),
        content=Content(text=game_context),
        created_at=int(asyncio.get_event_loop().time() * 1000),
    )

    chosen_action = "look around"  # Default fallback

    # Use the message service to handle the message through the full pipeline.
    # This gives the agent access to recent messages, providers, actions, etc.
    result = await runtime.message_service.handle_message(runtime, message)

    if result.response_content and result.response_content.text:
        chosen_action = result.response_content.text.strip()

    # Validate the action is in available actions (case-insensitive match)
    matched_action = next(
        (a for a in actions if a.lower() == chosen_action.lower()),
        None,
    )

    if matched_action:
        return matched_action

    # Try to find a partial match
    partial_match = next(
        (
            a
            for a in actions
            if a.lower() in chosen_action.lower() or chosen_action.lower() in a.lower()
        ),
        None,
    )

    if partial_match:
        return partial_match

    # Default to looking around if no valid action found
    return "look around"


# ============================================================================
# GAME DISPLAY
# ============================================================================


def show_intro() -> None:
    """Show game introduction."""
    print("\n🏰 elizaOS Adventure Game Demo")
    print(
        """
╔════════════════════════════════════════════════════════════════════╗
║                   THE DUNGEON OF DOOM                              ║
╠════════════════════════════════════════════════════════════════════╣
║  Watch as Eliza the AI Adventurer explores a dangerous dungeon!    ║
║                                                                    ║
║  The AI will:                                                      ║
║  • Explore rooms and collect items                                 ║
║  • Fight monsters using strategic decisions                        ║
║  • Manage health and inventory                                     ║
║  • Seek the dragon's treasure!                                     ║
║                                                                    ║
║  AI: OpenAI via elizaos-plugin-openai                              ║
╚════════════════════════════════════════════════════════════════════╝
"""
    )


def show_turn(turn_number: int, action: str) -> None:
    """Show turn header."""
    print(f"\n{'═' * 60}")
    print(f"🎮 TURN {turn_number}")
    print(f"{'─' * 60}")
    print(f'🤖 Eliza decides: "{action}"')
    print(f"{'─' * 60}")


def show_result(result: str, status: str) -> None:
    """Show action result."""
    print(result)
    print(f"\n{status}")


def show_game_over(victory: bool, score: int, turns: int) -> None:
    """Show game over screen."""
    print(f"\n{'═' * 60}")
    if victory:
        print("🏆 VICTORY! Eliza has conquered the dungeon!")
    else:
        print("💀 GAME OVER! Eliza has fallen...")
    print(f"Final Score: {score} points in {turns} turns")
    print(f"{'═' * 60}\n")


# ============================================================================
# MAIN GAME LOOP
# ============================================================================


async def run_adventure_game() -> None:
    """Run the automatic AI adventure game."""
    show_intro()

    session = await create_session()
    game = session.game

    # Show initial room
    print("\n📜 The adventure begins...\n")
    initial_description = game.describe_room()
    print(initial_description)

    # Save initial room description as a message so agent has context
    await save_game_result(session, initial_description)

    delay_sec = 2.0  # Delay between turns for readability

    while not game.get_state().game_over:
        # Get AI's decision
        action = await decide_action(session)

        # Display and execute the action
        show_turn(game.get_state().turns_played + 1, action)

        result = game.execute_action(action)
        show_result(result, game.get_status_line())

        # Save the game result as a message so the agent can learn from outcomes
        await save_game_result(session, result)

        # Small delay for readability
        await asyncio.sleep(delay_sec)

        # Safety limit
        if game.get_state().turns_played > 100:
            print("\n⏰ Game exceeded 100 turns. Ending...")
            break

    final_state = game.get_state()
    show_game_over(final_state.victory, final_state.score, final_state.turns_played)

    await session.runtime.stop()
    print("Thanks for watching! 🎮")


async def run_interactive_mode() -> None:
    """Run interactive mode where user can guide or play."""
    show_intro()

    session = await create_session()
    game = session.game

    print("\n📜 INTERACTIVE MODE: Guide Eliza through the dungeon!\n")
    print("You can type actions yourself, or type 'ai' to let Eliza decide.\n")
    initial_description = game.describe_room()
    print(initial_description)

    # Save initial room description as a message
    await save_game_result(session, initial_description)

    while not game.get_state().game_over:
        print(f"\n{game.get_status_line()}")
        print("Available actions:", ", ".join(game.get_available_actions()))

        try:
            user_input = await asyncio.to_thread(
                input, "Your command (or 'ai' for AI choice, 'quit' to exit): "
            )
        except EOFError:
            break

        user_input = user_input.strip()
        if not user_input or user_input.lower() in ("quit", "exit"):
            break

        if user_input.lower() == "ai":
            print("Eliza is thinking...")
            action = await decide_action(session)
            print(f'Eliza chooses: "{action}"')
        else:
            action = user_input

        result = game.execute_action(action)
        print(f"\n{result}")

        # Save game result as message so agent can learn from outcomes
        await save_game_result(session, result)

    final_state = game.get_state()
    if final_state.game_over:
        show_game_over(final_state.victory, final_state.score, final_state.turns_played)

    await session.runtime.stop()
    print("Thanks for playing! 🎮")


# ============================================================================
# ENTRY POINT
# ============================================================================


async def main() -> None:
    """Main entry point."""
    print("\nChoose game mode:")
    print("1. Watch AI Play - Eliza plays automatically")
    print("2. Interactive - Guide Eliza or play yourself")

    try:
        choice = await asyncio.to_thread(input, "Enter choice (1 or 2): ")
    except EOFError:
        print("Goodbye! 👋")
        return

    choice = choice.strip()

    if choice == "1":
        await run_adventure_game()
    elif choice == "2":
        await run_interactive_mode()
    else:
        print("Invalid choice. Goodbye! 👋")


if __name__ == "__main__":
    asyncio.run(main())

