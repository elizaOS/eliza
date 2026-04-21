"""
2048 Agent for ART Training

LLM-based agent that learns to play 2048.
"""

import re

from elizaos_art.base import BaseAgent
from elizaos_art.games.game_2048.types import Game2048Action, Game2048State


class Game2048Agent(BaseAgent[Game2048State, Game2048Action]):
    """
    LLM-based agent for playing 2048.

    Uses the LLM to decide which direction to move based on
    the current board state.
    """

    def __init__(
        self,
        model_name: str = "meta-llama/Llama-3.2-3B-Instruct",
        temperature: float = 0.7,
    ):
        self.model_name = model_name
        self.temperature = temperature

    @property
    def name(self) -> str:
        return f"Game2048Agent({self.model_name})"

    def get_system_prompt(self) -> str:
        """Get system prompt for the LLM."""
        return """You are an expert 2048 game player. Your goal is to achieve the highest possible score by strategically merging tiles.

Key strategies:
1. Keep your highest tile in a corner (preferably bottom-left or bottom-right)
2. Build a monotonic sequence along the edges
3. Avoid moving up unless absolutely necessary (keeps high tiles in bottom)
4. Try to keep the board organized - don't scatter high tiles
5. Plan ahead - consider what tiles might spawn after your move
6. When possible, merge smaller tiles to free up space

The game ends when no moves are possible. Each merge adds the merged tile value to your score.

Respond with ONLY the direction to move: UP, DOWN, LEFT, or RIGHT."""

    def format_action_prompt(
        self,
        state: Game2048State,
        available_actions: list[Game2048Action],
    ) -> str:
        """Format prompt for action selection."""
        action_names = [a.name for a in available_actions]

        prompt = f"""{state.to_prompt()}

Available moves: {", ".join(action_names)}

Analyze the board and choose the best move. Consider:
- Where is your highest tile?
- Can you merge any tiles?
- Will this move maintain good board organization?

Respond with just the direction (one of: {", ".join(action_names)}):"""

        return prompt

    def parse_action(
        self,
        response: str,
        available_actions: list[Game2048Action],
    ) -> Game2048Action:
        """Parse LLM response into an action."""
        response = response.strip().upper()

        # Try direct match
        for action in available_actions:
            if action.name in response:
                return action

        # Try parsing with regex
        match = re.search(r"\b(UP|DOWN|LEFT|RIGHT|U|D|L|R)\b", response, re.IGNORECASE)
        if match:
            try:
                return Game2048Action.from_string(match.group(1))
            except ValueError:
                pass

        # Default to first available action
        return available_actions[0]

    async def decide(
        self,
        state: Game2048State,
        available_actions: list[Game2048Action],
    ) -> Game2048Action:
        """
        Decide which action to take.

        Note: In actual training, this is called by the trainer
        which handles the LLM interaction. This method is for
        standalone usage with a fallback heuristic.
        """
        if not available_actions:
            raise ValueError("No available actions")

        # Heuristic fallback: prefer DOWN > LEFT > RIGHT > UP
        preference_order = [
            Game2048Action.DOWN,
            Game2048Action.LEFT,
            Game2048Action.RIGHT,
            Game2048Action.UP,
        ]

        for preferred in preference_order:
            if preferred in available_actions:
                return preferred

        return available_actions[0]


class Game2048HeuristicAgent(BaseAgent[Game2048State, Game2048Action]):
    """
    Heuristic-based agent for 2048.

    Uses a simple strategy without LLM calls.
    Good for baseline comparisons.
    """

    @property
    def name(self) -> str:
        return "Game2048Heuristic"

    def get_system_prompt(self) -> str:
        return ""

    def format_action_prompt(
        self,
        state: Game2048State,
        available_actions: list[Game2048Action],
    ) -> str:
        return ""

    def parse_action(
        self,
        response: str,
        available_actions: list[Game2048Action],
    ) -> Game2048Action:
        return available_actions[0]

    async def decide(
        self,
        state: Game2048State,
        available_actions: list[Game2048Action],
    ) -> Game2048Action:
        """
        Use corner strategy heuristic.

        Prefers: DOWN > LEFT > RIGHT > UP
        This tends to keep high tiles in the bottom-left corner.
        """
        preference_order = [
            Game2048Action.DOWN,
            Game2048Action.LEFT,
            Game2048Action.RIGHT,
            Game2048Action.UP,
        ]

        for preferred in preference_order:
            if preferred in available_actions:
                return preferred

        return available_actions[0]


class Game2048RandomAgent(BaseAgent[Game2048State, Game2048Action]):
    """Random agent for baseline comparison."""

    def __init__(self, seed: int | None = None):
        import random

        self._rng = random.Random(seed)

    @property
    def name(self) -> str:
        return "Game2048Random"

    def get_system_prompt(self) -> str:
        return ""

    def format_action_prompt(
        self,
        state: Game2048State,
        available_actions: list[Game2048Action],
    ) -> str:
        return ""

    def parse_action(
        self,
        response: str,
        available_actions: list[Game2048Action],
    ) -> Game2048Action:
        return available_actions[0]

    async def decide(
        self,
        state: Game2048State,
        available_actions: list[Game2048Action],
    ) -> Game2048Action:
        """Choose a random available action."""
        return self._rng.choice(available_actions)
