"""
Codenames Game Environment

Implements the Codenames word association game.
"""

import random
from typing import ClassVar

from elizaos_art.base import BaseEnvironment
from elizaos_art.games.codenames.types import (
    CardColor,
    Clue,
    CodenamesAction,
    CodenamesConfig,
    CodenamesState,
    DEFAULT_WORD_LIST,
    Role,
)


class CodenamesEnvironment(BaseEnvironment[CodenamesState, CodenamesAction]):
    """
    Codenames game environment.

    The AI can play as either Spymaster (gives clues) or Guesser (selects words).
    """

    SIZE: ClassVar[int] = 5
    BOARD_SIZE: ClassVar[int] = 25

    def __init__(self, config: CodenamesConfig | None = None):
        self.config = config or CodenamesConfig()
        self._rng: random.Random | None = None
        self._current_state: CodenamesState | None = None
        self._word_list = self.config.word_list or DEFAULT_WORD_LIST
        self._initialized = False
        self._pending_clue: Clue | None = None

    @property
    def name(self) -> str:
        return "codenames"

    @property
    def description(self) -> str:
        return "Codenames word association game. Give or guess clues!"

    async def initialize(self) -> None:
        """Initialize the environment."""
        self._initialized = True

    async def reset(self, seed: int | None = None) -> CodenamesState:
        """Reset the game and return initial state."""
        self._rng = random.Random(seed)

        # Select random words for the board
        words = tuple(self._rng.sample(self._word_list, self.BOARD_SIZE))

        # Assign colors
        colors_list = (
            [CardColor.RED.value] * self.config.red_count
            + [CardColor.BLUE.value] * self.config.blue_count
            + [CardColor.ASSASSIN.value] * self.config.assassin_count
            + [CardColor.NEUTRAL.value]
            * (self.BOARD_SIZE - self.config.red_count - self.config.blue_count - self.config.assassin_count)
        )
        self._rng.shuffle(colors_list)
        colors = tuple(colors_list)

        # All cards start unrevealed
        revealed = tuple([False] * self.BOARD_SIZE)

        # Red goes first (has more words)
        starting_team = CardColor.RED

        # Determine starting role
        if self.config.ai_role == Role.SPYMASTER:
            starting_role = Role.SPYMASTER
        else:
            starting_role = Role.GUESSER

        self._current_state = CodenamesState(
            words=words,
            colors=colors,
            revealed=revealed,
            current_team=starting_team,
            current_role=starting_role,
            current_clue=None,
            guesses_remaining=0,
            red_remaining=self.config.red_count,
            blue_remaining=self.config.blue_count,
        )

        # If AI is guesser, have spymaster give initial clue
        if self.config.ai_role == Role.GUESSER:
            self._current_state = self._generate_opponent_clue(self._current_state)

        return self._current_state

    async def step(
        self, action: CodenamesAction
    ) -> tuple[CodenamesState, float, bool]:
        """Execute an action and return new state."""
        if self._current_state is None:
            raise RuntimeError("Environment not reset")

        if self._current_state.game_over:
            return self._current_state, 0.0, True

        state = self._current_state

        if state.current_role == Role.SPYMASTER:
            # Spymaster gives clue (action is GIVE_CLUE, clue set via set_pending_clue)
            if self._pending_clue is None:
                return state, -0.1, False  # Invalid - no clue set

            new_state = CodenamesState(
                words=state.words,
                colors=state.colors,
                revealed=state.revealed,
                current_team=state.current_team,
                current_role=Role.GUESSER,  # Switch to guesser
                current_clue=self._pending_clue,
                guesses_remaining=self._pending_clue.number + 1,  # Can guess n+1 words
                red_remaining=state.red_remaining,
                blue_remaining=state.blue_remaining,
            )
            self._pending_clue = None
            self._current_state = new_state
            return new_state, 0.0, False

        else:
            # Guesser selects a word
            if action == CodenamesAction.PASS:
                # End turn
                new_state = self._end_turn(state)
                self._current_state = new_state
                return new_state, 0.0, new_state.game_over

            if action.value < 0 or action.value >= self.BOARD_SIZE:
                return state, -0.1, False  # Invalid action

            if state.revealed[action.value]:
                return state, -0.1, False  # Already revealed

            # Reveal the card
            new_state, reward = self._reveal_card(state, action.value)
            self._current_state = new_state
            return new_state, reward, new_state.game_over

    def set_pending_clue(self, clue: Clue) -> None:
        """Set the pending clue (for spymaster action)."""
        self._pending_clue = clue

    def get_available_actions(self, state: CodenamesState) -> list[CodenamesAction]:
        """Get list of valid actions."""
        if state.game_over:
            return []

        if state.current_role == Role.SPYMASTER:
            return [CodenamesAction.GIVE_CLUE]

        # Guesser actions
        actions = [CodenamesAction.PASS]
        for i in range(self.BOARD_SIZE):
            if not state.revealed[i]:
                actions.append(CodenamesAction.from_word_index(i))

        return actions

    def render(self, state: CodenamesState) -> str:
        """Render the state as a string."""
        return state.render()

    def _reveal_card(
        self, state: CodenamesState, idx: int
    ) -> tuple[CodenamesState, float]:
        """Reveal a card and update game state."""
        revealed = list(state.revealed)
        revealed[idx] = True

        color = CardColor(state.colors[idx])
        team = state.current_team

        red_remaining = state.red_remaining
        blue_remaining = state.blue_remaining
        guesses_remaining = state.guesses_remaining - 1
        game_over = False
        winner = None
        reward = 0.0

        if color == CardColor.ASSASSIN:
            # Game over - other team wins
            game_over = True
            winner = CardColor.BLUE if team == CardColor.RED else CardColor.RED
            reward = -3.0  # Big penalty

        elif color == team:
            # Correct guess
            reward = 1.0
            if team == CardColor.RED:
                red_remaining -= 1
                if red_remaining == 0:
                    game_over = True
                    winner = CardColor.RED
            else:
                blue_remaining -= 1
                if blue_remaining == 0:
                    game_over = True
                    winner = CardColor.BLUE

        elif color == CardColor.NEUTRAL:
            # Neutral - turn ends
            reward = 0.0
            guesses_remaining = 0

        else:
            # Wrong team - turn ends, helps opponent
            reward = -1.0
            guesses_remaining = 0
            if color == CardColor.RED:
                red_remaining -= 1
                if red_remaining == 0:
                    game_over = True
                    winner = CardColor.RED
            else:
                blue_remaining -= 1
                if blue_remaining == 0:
                    game_over = True
                    winner = CardColor.BLUE

        new_state = CodenamesState(
            words=state.words,
            colors=state.colors,
            revealed=tuple(revealed),
            current_team=state.current_team,
            current_role=state.current_role,
            current_clue=state.current_clue,
            guesses_remaining=guesses_remaining,
            red_remaining=red_remaining,
            blue_remaining=blue_remaining,
            game_over=game_over,
            winner=winner,
        )

        # Check if turn should end
        if guesses_remaining <= 0 and not game_over:
            new_state = self._end_turn(new_state)

        return new_state, reward

    def _end_turn(self, state: CodenamesState) -> CodenamesState:
        """End the current turn and switch teams."""
        next_team = CardColor.BLUE if state.current_team == CardColor.RED else CardColor.RED

        new_state = CodenamesState(
            words=state.words,
            colors=state.colors,
            revealed=state.revealed,
            current_team=next_team,
            current_role=Role.SPYMASTER if self.config.ai_role == Role.SPYMASTER else Role.GUESSER,
            current_clue=None,
            guesses_remaining=0,
            red_remaining=state.red_remaining,
            blue_remaining=state.blue_remaining,
            game_over=state.game_over,
            winner=state.winner,
        )

        # If AI is guesser, generate opponent clue
        if self.config.ai_role == Role.GUESSER and new_state.current_team == self.config.ai_team:
            new_state = self._generate_opponent_clue(new_state)

        return new_state

    def _generate_opponent_clue(self, state: CodenamesState) -> CodenamesState:
        """Generate a simple clue from opponent spymaster."""
        if self._rng is None:
            self._rng = random.Random()

        # Find unrevealed words for current team
        team_words = []
        for i in range(self.BOARD_SIZE):
            if not state.revealed[i] and CardColor(state.colors[i]) == state.current_team:
                team_words.append(i)

        if not team_words:
            # No words left
            return state

        # Simple clue: pick 1-2 random words
        num_words = min(2, len(team_words))
        clue = Clue(word="HINT", number=num_words)

        return CodenamesState(
            words=state.words,
            colors=state.colors,
            revealed=state.revealed,
            current_team=state.current_team,
            current_role=Role.GUESSER,
            current_clue=clue,
            guesses_remaining=num_words + 1,
            red_remaining=state.red_remaining,
            blue_remaining=state.blue_remaining,
            game_over=state.game_over,
            winner=state.winner,
        )
