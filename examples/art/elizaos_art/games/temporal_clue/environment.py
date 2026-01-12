"""
Temporal Clue Environment

Logic puzzles requiring temporal reasoning to order events.
"""

import random

from elizaos_art.base import BaseEnvironment
from elizaos_art.games.temporal_clue.types import (
    Difficulty,
    EVENT_THEMES,
    TemporalClue,
    TemporalClueAction,
    TemporalClueConfig,
    TemporalCluePuzzle,
    TemporalClueState,
    TemporalRelation,
)


class TemporalClueEnvironment(BaseEnvironment[TemporalClueState, TemporalClueAction]):
    """
    Temporal Clue puzzle environment.

    The agent must order events based on temporal clues.
    """

    def __init__(self, config: TemporalClueConfig | None = None):
        self.config = config or TemporalClueConfig()
        self._rng: random.Random | None = None
        self._current_state: TemporalClueState | None = None
        self._initialized = False

    @property
    def name(self) -> str:
        return "temporal_clue"

    @property
    def description(self) -> str:
        return "Logic puzzles requiring temporal reasoning to order events."

    async def initialize(self) -> None:
        """Initialize the environment."""
        self._initialized = True

    async def reset(self, seed: int | None = None) -> TemporalClueState:
        """Reset and generate a new puzzle."""
        self._rng = random.Random(seed)
        puzzle = self._generate_puzzle()

        self._current_state = TemporalClueState(
            puzzle=puzzle,
            current_ordering=(),
            remaining_events=tuple(puzzle.events),
            attempts=0,
            max_attempts=self.config.max_attempts,
            game_over=False,
            solved=False,
        )

        return self._current_state

    async def step(
        self, action: TemporalClueAction
    ) -> tuple[TemporalClueState, float, bool]:
        """
        Execute an action.

        Either select an event to place next, or submit the ordering.
        """
        if self._current_state is None:
            raise RuntimeError("Environment not reset")

        if self._current_state.game_over:
            return self._current_state, 0.0, True

        state = self._current_state

        if action == TemporalClueAction.SUBMIT:
            return self._handle_submit(state)
        else:
            return self._handle_place_event(state, action)

    def get_available_actions(
        self, state: TemporalClueState
    ) -> list[TemporalClueAction]:
        """Get available actions."""
        if state.game_over:
            return []

        actions = []

        # Can place any remaining event
        for i, event in enumerate(state.puzzle.events):
            if event in state.remaining_events:
                actions.append(TemporalClueAction(i))

        # Can submit if all events placed
        if not state.remaining_events:
            actions.append(TemporalClueAction.SUBMIT)

        return actions

    def render(self, state: TemporalClueState) -> str:
        """Render state for display."""
        return state.render()

    def _generate_puzzle(self) -> TemporalCluePuzzle:
        """Generate a puzzle based on difficulty."""
        if self._rng is None:
            self._rng = random.Random()

        # Select theme and events
        theme = self._rng.choice(list(EVENT_THEMES.keys()))
        all_events = EVENT_THEMES[theme].copy()

        # Number of events based on difficulty
        num_events = {
            Difficulty.EASY: 4,
            Difficulty.MEDIUM: 5,
            Difficulty.HARD: 7,
        }[self.config.difficulty]

        # Select events in order (maintaining natural order)
        start_idx = self._rng.randint(0, len(all_events) - num_events)
        events_ordered = all_events[start_idx : start_idx + num_events]

        # Generate clues
        clues = self._generate_clues(events_ordered)

        # Shuffle events for presentation
        events_shuffled = events_ordered.copy()
        self._rng.shuffle(events_shuffled)

        return TemporalCluePuzzle(
            puzzle_id=f"puzzle-{self._rng.randint(1000, 9999)}",
            events=events_shuffled,
            clues=clues,
            solution=events_ordered,
            difficulty=self.config.difficulty,
        )

    def _generate_clues(self, ordered_events: list[str]) -> list[TemporalClue]:
        """Generate clues for a set of ordered events."""
        if self._rng is None:
            self._rng = random.Random()

        clues: list[TemporalClue] = []
        n = len(ordered_events)

        # Number of clues based on difficulty
        num_clues = {
            Difficulty.EASY: n - 1,  # Minimal clues (chain)
            Difficulty.MEDIUM: n,    # Some redundancy
            Difficulty.HARD: n + 2,  # More complex
        }[self.config.difficulty]

        # Always include some direct ordering clues
        for i in range(n - 1):
            # Probability of including direct "before" clue
            if self._rng.random() < 0.7:
                relation = self._rng.choice([
                    TemporalRelation.BEFORE,
                    TemporalRelation.JUST_BEFORE,
                ])
                clues.append(TemporalClue(
                    event_a=ordered_events[i],
                    relation=relation,
                    event_b=ordered_events[i + 1],
                ))
            else:
                # Use "after" relation (reversed)
                clues.append(TemporalClue(
                    event_a=ordered_events[i + 1],
                    relation=TemporalRelation.AFTER,
                    event_b=ordered_events[i],
                ))

        # Add transitive clues for harder difficulties
        if self.config.difficulty != Difficulty.EASY and n > 3:
            # Add some non-adjacent clues
            for _ in range(2):
                i = self._rng.randint(0, n - 3)
                j = self._rng.randint(i + 2, n - 1)
                clues.append(TemporalClue(
                    event_a=ordered_events[i],
                    relation=TemporalRelation.BEFORE,
                    event_b=ordered_events[j],
                ))

        # Shuffle clues
        self._rng.shuffle(clues)

        return clues[:num_clues]

    def _handle_place_event(
        self,
        state: TemporalClueState,
        action: TemporalClueAction,
    ) -> tuple[TemporalClueState, float, bool]:
        """Handle placing an event in the ordering."""
        event_idx = action.value
        event = state.puzzle.events[event_idx]

        if event not in state.remaining_events:
            # Invalid action - event already placed
            return state, -0.1, False

        # Add event to ordering
        new_ordering = state.current_ordering + (event,)
        new_remaining = tuple(e for e in state.remaining_events if e != event)

        new_state = TemporalClueState(
            puzzle=state.puzzle,
            current_ordering=new_ordering,
            remaining_events=new_remaining,
            attempts=state.attempts,
            max_attempts=state.max_attempts,
            game_over=False,
            solved=False,
        )

        self._current_state = new_state

        # Small reward for making progress
        return new_state, 0.1, False

    def _handle_submit(
        self, state: TemporalClueState
    ) -> tuple[TemporalClueState, float, bool]:
        """Handle submitting the ordering."""
        if state.remaining_events:
            # Can't submit with remaining events
            return state, -0.5, False

        # Check if ordering is correct
        is_correct = list(state.current_ordering) == state.puzzle.solution

        if is_correct:
            # Solved!
            new_state = TemporalClueState(
                puzzle=state.puzzle,
                current_ordering=state.current_ordering,
                remaining_events=(),
                attempts=state.attempts + 1,
                max_attempts=state.max_attempts,
                game_over=True,
                solved=True,
            )
            self._current_state = new_state
            return new_state, 10.0, True

        # Wrong answer
        new_attempts = state.attempts + 1

        if new_attempts >= state.max_attempts:
            # Out of attempts
            new_state = TemporalClueState(
                puzzle=state.puzzle,
                current_ordering=state.current_ordering,
                remaining_events=(),
                attempts=new_attempts,
                max_attempts=state.max_attempts,
                game_over=True,
                solved=False,
            )
            self._current_state = new_state

            # Partial credit based on correct positions
            if self.config.partial_credit:
                reward = self._calculate_partial_reward(state)
            else:
                reward = -5.0

            return new_state, reward, True

        # Reset for another attempt
        new_state = TemporalClueState(
            puzzle=state.puzzle,
            current_ordering=(),
            remaining_events=tuple(state.puzzle.events),
            attempts=new_attempts,
            max_attempts=state.max_attempts,
            game_over=False,
            solved=False,
        )
        self._current_state = new_state
        return new_state, -2.0, False

    def _calculate_partial_reward(self, state: TemporalClueState) -> float:
        """Calculate partial credit for close answers."""
        correct = 0
        solution = state.puzzle.solution
        ordering = list(state.current_ordering)

        # Count events in correct position
        for i, event in enumerate(ordering):
            if i < len(solution) and event == solution[i]:
                correct += 1

        # Count correct adjacencies
        correct_pairs = 0
        for i in range(len(ordering) - 1):
            for j in range(len(solution) - 1):
                if ordering[i] == solution[j] and ordering[i + 1] == solution[j + 1]:
                    correct_pairs += 1
                    break

        # Reward based on both
        position_score = correct / len(solution)
        pair_score = correct_pairs / max(len(solution) - 1, 1)

        return (position_score + pair_score) * 2 - 3  # Range: -3 to +1
