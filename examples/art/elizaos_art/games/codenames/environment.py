"""
Codenames Environment

A word-guessing game where spymasters give clues and guessers identify words.
"""

import random

from elizaos_art.base import BaseEnvironment
from elizaos_art.games.codenames.types import (
    CardType,
    Clue,
    CodenamesAction,
    CodenamesConfig,
    CodenamesState,
    DEFAULT_WORDS,
    Role,
    Team,
    WordCard,
)


class CodenamesEnvironment(BaseEnvironment[CodenamesState, CodenamesAction]):
    """
    Codenames game environment.

    Supports training either Spymaster or Guesser roles.
    """

    def __init__(self, config: CodenamesConfig | None = None):
        self.config = config or CodenamesConfig()
        self._rng: random.Random | None = None
        self._current_state: CodenamesState | None = None
        self._word_list = DEFAULT_WORDS.copy()
        self._initialized = False

    @property
    def name(self) -> str:
        return "codenames"

    @property
    def description(self) -> str:
        return "Codenames word association game. Give clues or guess words!"

    async def initialize(self) -> None:
        """Initialize the environment."""
        self._initialized = True

    async def reset(self, seed: int | None = None) -> CodenamesState:
        """Reset and create a new game."""
        self._rng = random.Random(seed)

        # Select 25 random words
        words = self._rng.sample(self._word_list, 25)

        # Assign card types
        types: list[CardType] = (
            [CardType.RED] * self.config.red_count +
            [CardType.BLUE] * self.config.blue_count +
            [CardType.NEUTRAL] * self.config.neutral_count +
            [CardType.ASSASSIN] * self.config.assassin_count
        )
        self._rng.shuffle(types)

        # Create board
        board = tuple(
            WordCard(word=words[i], card_type=types[i], revealed=False)
            for i in range(25)
        )

        # Team with more cards goes first (usually red with 9)
        first_team = Team.RED if self.config.red_count > self.config.blue_count else Team.BLUE

        self._current_state = CodenamesState(
            board=board,
            current_team=first_team,
            current_role=Role.SPYMASTER,  # Spymaster gives clue first
            current_clue=None,
            guesses_remaining=0,
            red_remaining=self.config.red_count,
            blue_remaining=self.config.blue_count,
            game_over=False,
            winner=None,
            move_count=0,
        )

        # If we're training the guesser, auto-generate a clue
        if self.config.train_role == Role.GUESSER:
            await self._generate_opponent_clue()

        return self._current_state

    async def step(
        self, action: CodenamesAction
    ) -> tuple[CodenamesState, float, bool]:
        """
        Execute an action.

        For Spymaster: action is ignored, clue should be set via give_clue()
        For Guesser: action is position to guess or PASS
        """
        if self._current_state is None:
            raise RuntimeError("Environment not reset")

        if self._current_state.game_over:
            return self._current_state, 0.0, True

        state = self._current_state
        reward = 0.0

        if state.current_role == Role.GUESSER:
            # Handle guess
            if action == CodenamesAction.PASS:
                # End turn
                state = self._end_turn(state)
            else:
                state, reward = self._handle_guess(state, action)
        else:
            # Spymaster turn - this shouldn't happen in normal flow
            # The give_clue method handles spymaster actions
            pass

        self._current_state = state
        return state, reward, state.game_over

    def give_clue(self, clue: Clue) -> CodenamesState:
        """
        Give a clue as spymaster.

        Args:
            clue: The clue to give

        Returns:
            Updated state
        """
        if self._current_state is None:
            raise RuntimeError("Environment not reset")

        if self._current_state.current_role != Role.SPYMASTER:
            raise ValueError("Not spymaster's turn")

        # Validate clue word isn't on board
        board_words = {card.word.upper() for card in self._current_state.board}
        if clue.word.upper() in board_words:
            raise ValueError(f"Clue word '{clue.word}' is on the board")

        # Transition to guesser phase
        self._current_state = CodenamesState(
            board=self._current_state.board,
            current_team=self._current_state.current_team,
            current_role=Role.GUESSER,
            current_clue=clue,
            guesses_remaining=clue.number + 1,  # Can guess one extra
            red_remaining=self._current_state.red_remaining,
            blue_remaining=self._current_state.blue_remaining,
            game_over=False,
            winner=None,
            move_count=self._current_state.move_count + 1,
        )

        return self._current_state

    def get_available_actions(self, state: CodenamesState) -> list[CodenamesAction]:
        """Get available actions for current state."""
        if state.game_over:
            return []

        if state.current_role == Role.SPYMASTER:
            # Spymaster doesn't use discrete actions
            return []

        # Guesser can choose unrevealed cards or pass
        actions = [
            CodenamesAction(i)
            for i, card in enumerate(state.board)
            if not card.revealed
        ]
        actions.append(CodenamesAction.PASS)
        return actions

    def render(self, state: CodenamesState) -> str:
        """Render state for display."""
        return state.render()

    def _handle_guess(
        self,
        state: CodenamesState,
        action: CodenamesAction,
    ) -> tuple[CodenamesState, float]:
        """Handle a guess action."""
        pos = action.value
        card = state.board[pos]

        if card.revealed:
            # Invalid - card already revealed
            return state, -0.1

        # Reveal the card
        new_board = list(state.board)
        new_board[pos] = WordCard(
            word=card.word,
            card_type=card.card_type,
            revealed=True,
        )

        # Update remaining counts
        red_remaining = state.red_remaining
        blue_remaining = state.blue_remaining

        if card.card_type == CardType.RED:
            red_remaining -= 1
        elif card.card_type == CardType.BLUE:
            blue_remaining -= 1

        # Calculate reward and check game end
        reward = 0.0
        game_over = False
        winner = None
        end_turn = False

        current_team = state.current_team
        team_card_type = CardType.RED if current_team == Team.RED else CardType.BLUE

        if card.card_type == CardType.ASSASSIN:
            # Hit assassin - lose immediately
            game_over = True
            winner = current_team.opponent()
            reward = -10.0

        elif card.card_type == team_card_type:
            # Correct guess
            reward = 1.0

            # Check win condition
            if (current_team == Team.RED and red_remaining == 0) or \
               (current_team == Team.BLUE and blue_remaining == 0):
                game_over = True
                winner = current_team
                reward = 5.0
            elif state.guesses_remaining <= 1:
                end_turn = True

        elif card.card_type == team_card_type.opponent() if hasattr(team_card_type, 'opponent') else (
            CardType.BLUE if team_card_type == CardType.RED else CardType.RED
        ):
            # Opponent's card
            reward = -1.0
            end_turn = True

            # Check if opponent wins
            opp_type = CardType.BLUE if current_team == Team.RED else CardType.RED
            if (opp_type == CardType.RED and red_remaining == 0) or \
               (opp_type == CardType.BLUE and blue_remaining == 0):
                game_over = True
                winner = current_team.opponent()

        else:
            # Neutral card
            reward = -0.5
            end_turn = True

        new_state = CodenamesState(
            board=tuple(new_board),
            current_team=current_team,
            current_role=Role.GUESSER,
            current_clue=state.current_clue,
            guesses_remaining=state.guesses_remaining - 1,
            red_remaining=red_remaining,
            blue_remaining=blue_remaining,
            game_over=game_over,
            winner=winner,
            move_count=state.move_count + 1,
        )

        if end_turn and not game_over:
            new_state = self._end_turn(new_state)

        return new_state, reward

    def _end_turn(self, state: CodenamesState) -> CodenamesState:
        """End current team's turn."""
        next_team = state.current_team.opponent()

        return CodenamesState(
            board=state.board,
            current_team=next_team,
            current_role=Role.SPYMASTER,
            current_clue=None,
            guesses_remaining=0,
            red_remaining=state.red_remaining,
            blue_remaining=state.blue_remaining,
            game_over=state.game_over,
            winner=state.winner,
            move_count=state.move_count,
        )

    async def _generate_opponent_clue(self) -> None:
        """Generate a clue for the opponent spymaster."""
        if self._current_state is None:
            return

        # Simple heuristic: find first unrevealed team word
        team_type = (
            CardType.RED if self._current_state.current_team == Team.RED
            else CardType.BLUE
        )

        team_words = [
            card.word for card in self._current_state.board
            if card.card_type == team_type and not card.revealed
        ]

        if team_words:
            # Simple clue: first letter of first word + "HINT"
            hint_word = team_words[0][:3] + "HINT"
            clue = Clue(word=hint_word, number=1)
            self.give_clue(clue)
