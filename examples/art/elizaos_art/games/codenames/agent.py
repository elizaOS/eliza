"""
Codenames Agents for ART Training
"""

import re

from elizaos_art.base import BaseAgent
from elizaos_art.games.codenames.types import (
    CardColor,
    CodenamesAction,
    CodenamesState,
    Role,
)


class CodenamesAgent(BaseAgent[CodenamesState, CodenamesAction]):
    """
    Generic Codenames agent that can play both roles.
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
        return f"CodenamesAgent({self.model_name})"

    def get_system_prompt(self) -> str:
        """Get system prompt for the LLM."""
        return """You are an expert Codenames player. You can play both Spymaster and Guesser roles.

As SPYMASTER:
- You see the true colors of all words
- Give a one-word clue and a number (how many words relate to it)
- Your clue cannot be any word on the board
- Try to link multiple team words with clever associations
- AVOID clues that might lead to the ASSASSIN (💀)

As GUESSER:
- Use the clue to identify your team's words
- Think about common associations with the clue word
- You can guess up to (number + 1) words
- Say PASS to end your turn if unsure
- NEVER guess if you might hit the ASSASSIN

Remember:
- RED and BLUE are teams
- NEUTRAL ends your turn harmlessly
- ASSASSIN instantly loses the game for your team

Respond with just the action: a word number (0-24) for guessing, or PASS."""

    def format_action_prompt(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> str:
        """Format prompt for action selection."""
        action_strs = []
        for a in available_actions:
            if a == CodenamesAction.PASS:
                action_strs.append("PASS")
            elif a == CodenamesAction.GIVE_CLUE:
                action_strs.append("GIVE_CLUE (provide word and number)")
            else:
                idx = a.value
                if idx < len(state.words):
                    action_strs.append(f"{idx}:{state.words[idx]}")

        prompt = f"""{state.to_prompt()}

Available actions: {", ".join(action_strs[:10])}{"..." if len(action_strs) > 10 else ""}

What is your action?"""

        return prompt

    def parse_action(
        self,
        response: str,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        """Parse LLM response into an action."""
        response = response.strip().upper()

        # Check for PASS
        if "PASS" in response:
            if CodenamesAction.PASS in available_actions:
                return CodenamesAction.PASS

        # Try to extract a number
        match = re.search(r"\b(\d{1,2})\b", response)
        if match:
            try:
                idx = int(match.group(1))
                if 0 <= idx <= 24:
                    action = CodenamesAction.from_word_index(idx)
                    if action in available_actions:
                        return action
            except ValueError:
                pass

        # Default to first available non-pass action, or pass
        for action in available_actions:
            if action != CodenamesAction.PASS and action != CodenamesAction.GIVE_CLUE:
                return action

        if CodenamesAction.PASS in available_actions:
            return CodenamesAction.PASS

        return available_actions[0]

    async def decide(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        """Heuristic decision for standalone use."""
        if state.current_role == Role.GUESSER and state.current_clue:
            # Simple heuristic: pick first available unrevealed word
            for action in available_actions:
                if action != CodenamesAction.PASS and action != CodenamesAction.GIVE_CLUE:
                    return action

        return CodenamesAction.PASS if CodenamesAction.PASS in available_actions else available_actions[0]


class CodenamesSpymasterAgent(BaseAgent[CodenamesState, CodenamesAction]):
    """
    Specialized Spymaster agent.
    """

    def __init__(self, model_name: str = "meta-llama/Llama-3.2-3B-Instruct"):
        self.model_name = model_name

    @property
    def name(self) -> str:
        return f"CodenamesSpymaster({self.model_name})"

    def get_system_prompt(self) -> str:
        return """You are a Codenames Spymaster. Your job is to give clever one-word clues.

Rules:
- Give ONE word and a number (how many board words relate to it)
- Your clue cannot be a word on the board
- Link multiple team words with common themes
- AVOID associations with the ASSASSIN at all costs
- Consider: synonyms, categories, rhymes, compound words

Format your response as: WORD NUMBER
Example: FRUIT 2 (to hint at APPLE and ORANGE)"""

    def format_action_prompt(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> str:
        """Format prompt for giving a clue."""
        # Show spymaster view
        team_words = []
        avoid_words = []

        for i in range(25):
            if not state.revealed[i]:
                color = CardColor(state.colors[i])
                if color == state.current_team:
                    team_words.append(state.words[i])
                elif color == CardColor.ASSASSIN:
                    avoid_words.append(f"{state.words[i]} (ASSASSIN!)")
                elif color != CardColor.NEUTRAL:
                    avoid_words.append(state.words[i])

        prompt = f"""{state.to_prompt()}

Your team's words: {", ".join(team_words)}
AVOID: {", ".join(avoid_words)}

Give a clue (WORD NUMBER):"""

        return prompt

    def parse_action(
        self,
        response: str,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        """Parse response into GIVE_CLUE action."""
        return CodenamesAction.GIVE_CLUE

    async def decide(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        return CodenamesAction.GIVE_CLUE


class CodenamesGuesserAgent(BaseAgent[CodenamesState, CodenamesAction]):
    """
    Specialized Guesser agent.
    """

    def __init__(self, model_name: str = "meta-llama/Llama-3.2-3B-Instruct"):
        self.model_name = model_name

    @property
    def name(self) -> str:
        return f"CodenamesGuesser({self.model_name})"

    def get_system_prompt(self) -> str:
        return """You are a Codenames Guesser. Interpret clues to find your team's words.

Strategy:
- Think about what words relate to the clue
- Consider multiple meanings of the clue word
- Be cautious - wrong guesses help the opponent
- If unsure, PASS to save guesses for later
- NEVER guess randomly - that could hit the ASSASSIN

Respond with a number (0-24) to guess that word, or PASS."""

    def format_action_prompt(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> str:
        """Format prompt for guessing."""
        unrevealed = []
        for i in range(25):
            if not state.revealed[i]:
                unrevealed.append(f"{i}:{state.words[i]}")

        prompt = f"""{state.to_prompt()}

Unrevealed words: {", ".join(unrevealed)}

Your clue is: {state.current_clue}
Guesses remaining: {state.guesses_remaining}

Which word best matches the clue? (number or PASS):"""

        return prompt

    def parse_action(
        self,
        response: str,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        """Parse LLM response."""
        response = response.strip().upper()

        if "PASS" in response:
            if CodenamesAction.PASS in available_actions:
                return CodenamesAction.PASS

        match = re.search(r"\b(\d{1,2})\b", response)
        if match:
            idx = int(match.group(1))
            if 0 <= idx <= 24:
                action = CodenamesAction.from_word_index(idx)
                if action in available_actions:
                    return action

        return available_actions[0]

    async def decide(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        """Heuristic fallback."""
        # Pick first unrevealed word
        for action in available_actions:
            if action != CodenamesAction.PASS and action != CodenamesAction.GIVE_CLUE:
                return action
        return CodenamesAction.PASS
