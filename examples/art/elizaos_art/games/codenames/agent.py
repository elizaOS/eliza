"""
Codenames Agents for ART Training

LLM-based agents for both Spymaster and Guesser roles.
"""

import re

from elizaos_art.base import BaseAgent
from elizaos_art.games.codenames.types import (
    CardType,
    Clue,
    CodenamesAction,
    CodenamesState,
    Role,
    Team,
    WordCard,
)


class CodenamesSpymasterAgent(BaseAgent[CodenamesState, CodenamesAction]):
    """
    LLM-based Spymaster agent.

    Gives clues to help guessers identify team words.
    """

    def __init__(
        self,
        model_name: str = "meta-llama/Llama-3.2-3B-Instruct",
        temperature: float = 0.7,
    ):
        self.model_name = model_name
        self.temperature = temperature
        self._pending_clue: Clue | None = None

    @property
    def name(self) -> str:
        return f"CodenamesSpymaster({self.model_name})"

    def get_system_prompt(self) -> str:
        return """You are a Codenames Spymaster. Your goal is to give one-word clues that help your team identify their words while avoiding opponent words and the assassin.

Rules:
1. Your clue must be ONE WORD only
2. Your clue cannot be any word on the board
3. Include a NUMBER indicating how many words relate to your clue
4. Your clue cannot be part of any board word

Strategy:
1. Look for thematic connections between your team's words
2. Avoid clues that might lead to opponent words or assassin
3. Start with safe, clear connections before risky multi-word clues
4. Consider word associations your guesser might make

Respond with: CLUE_WORD NUMBER
Example: OCEAN 2 (if you have FISH and BEACH)"""

    def format_action_prompt(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> str:
        """Format prompt for giving a clue."""
        team = state.current_team
        team_type = CardType.RED if team == Team.RED else CardType.BLUE
        opp_type = CardType.BLUE if team == Team.RED else CardType.RED

        # Get word categories
        team_words = [c.word for c in state.board if c.card_type == team_type and not c.revealed]
        opp_words = [c.word for c in state.board if c.card_type == opp_type and not c.revealed]
        neutral = [c.word for c in state.board if c.card_type == CardType.NEUTRAL and not c.revealed]
        assassin = [c.word for c in state.board if c.card_type == CardType.ASSASSIN and not c.revealed]

        prompt = f"""{state.to_prompt()}

Your team's words to find: {", ".join(team_words)}
Opponent's words (AVOID): {", ".join(opp_words)}
Neutral words: {", ".join(neutral)}
ASSASSIN (NEVER lead to): {", ".join(assassin)}

Give a clue in format: WORD NUMBER
The word should connect to some of your team's words.
Respond with just the clue:"""

        return prompt

    def parse_action(
        self,
        response: str,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        """Parse response into a clue (stored) and return dummy action."""
        # Try to parse clue from response
        match = re.search(r"([A-Za-z]+)\s+(\d+)", response.strip())
        if match:
            word = match.group(1).upper()
            number = int(match.group(2))
            self._pending_clue = Clue(word=word, number=number)
        else:
            # Default clue
            self._pending_clue = Clue(word="HINT", number=1)

        # Return dummy action (spymaster doesn't use actions)
        return CodenamesAction.PASS

    def get_pending_clue(self) -> Clue | None:
        """Get the clue parsed from the last response."""
        return self._pending_clue

    async def decide(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        """Generate a simple heuristic clue."""
        team_type = CardType.RED if state.current_team == Team.RED else CardType.BLUE

        team_words = [
            c.word for c in state.board
            if c.card_type == team_type and not c.revealed
        ]

        if team_words:
            # Simple clue based on first word
            first_word = team_words[0]
            self._pending_clue = Clue(word=f"{first_word[:2]}CLUE", number=1)
        else:
            self._pending_clue = Clue(word="PASS", number=0)

        return CodenamesAction.PASS


class CodenamesGuesserAgent(BaseAgent[CodenamesState, CodenamesAction]):
    """
    LLM-based Guesser agent.

    Interprets clues and selects words.
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
        return f"CodenamesGuesser({self.model_name})"

    def get_system_prompt(self) -> str:
        return """You are a Codenames Guesser. Your spymaster gives you clues, and you must identify your team's words on the board.

Rules:
1. The clue word relates to one or more of your team's words
2. The number tells you how many words relate to the clue
3. You can guess up to (number + 1) words
4. Stop guessing if you're unsure - hitting wrong words helps opponents

Strategy:
1. Think about how the clue word connects to each unrevealed word
2. Start with the most confident guess
3. Consider common associations and wordplay
4. If unsure, pass rather than risk hitting opponent or assassin

Respond with either:
- A word from the board
- PASS to end your turn"""

    def format_action_prompt(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> str:
        """Format prompt for guessing."""
        unrevealed = [
            state.board[a.value].word
            for a in available_actions
            if a != CodenamesAction.PASS
        ]

        prompt = f"""{state.to_prompt()}

Unrevealed words: {", ".join(unrevealed)}

Think about which word(s) best match the clue "{state.current_clue}".
Consider word associations, categories, and meanings.

Respond with one word from the list above, or PASS:"""

        return prompt

    def parse_action(
        self,
        response: str,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        """Parse response into an action."""
        response = response.strip().upper()

        if "PASS" in response:
            return CodenamesAction.PASS

        # Try to match a word
        for action in available_actions:
            if action == CodenamesAction.PASS:
                continue
            # Get the word for this position - need board access
            # For now, just match by position mentioned
            match = re.search(r"(\d+)", response)
            if match:
                pos = int(match.group(1))
                if 0 <= pos <= 24:
                    candidate = CodenamesAction(pos)
                    if candidate in available_actions:
                        return candidate

        # Try word match (would need board context)
        # Default to first available non-pass action
        for action in available_actions:
            if action != CodenamesAction.PASS:
                return action

        return CodenamesAction.PASS

    async def decide(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        """Heuristic decision - pick first unrevealed."""
        for action in available_actions:
            if action != CodenamesAction.PASS:
                return action
        return CodenamesAction.PASS


class CodenamesRandomAgent(BaseAgent[CodenamesState, CodenamesAction]):
    """Random agent for baseline."""

    def __init__(self, seed: int | None = None):
        import random

        self._rng = random.Random(seed)

    @property
    def name(self) -> str:
        return "CodenamesRandom"

    def get_system_prompt(self) -> str:
        return ""

    def format_action_prompt(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> str:
        return ""

    def parse_action(
        self,
        response: str,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        return available_actions[0]

    async def decide(
        self,
        state: CodenamesState,
        available_actions: list[CodenamesAction],
    ) -> CodenamesAction:
        """Random choice excluding pass most of the time."""
        non_pass = [a for a in available_actions if a != CodenamesAction.PASS]
        if non_pass and self._rng.random() > 0.2:
            return self._rng.choice(non_pass)
        return CodenamesAction.PASS
