"""
Temporal Clue Puzzle Environment

Implements temporal reasoning puzzles where events must be ordered.
"""

import random
from typing import ClassVar

from elizaos_art.base import BaseEnvironment
from elizaos_art.games.temporal_clue.types import (
    Difficulty,
    PUZZLE_SCENARIOS,
    TemporalClue,
    TemporalClueAction,
    TemporalClueConfig,
    TemporalClueState,
)


class TemporalClueEnvironment(BaseEnvironment[TemporalClueState, TemporalClueAction]):
    """
    Temporal Clue puzzle environment.

    Players must arrange events in chronological order based on clues.
    """

    MAX_EVENTS: ClassVar[int] = 8

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
        return "Temporal reasoning puzzles. Order events based on clues!"

    async def initialize(self) -> None:
        """Initialize the environment."""
        self._initialized = True

    async def reset(self, seed: int | None = None) -> TemporalClueState:
        """Reset with a new puzzle."""
        self._rng = random.Random(seed)

        # Select or generate a puzzle
        puzzle = self._generate_puzzle()

        events = puzzle["events"]
        correct_ordering = puzzle["correct_ordering"]
        clues = self._generate_clues(events, correct_ordering)

        # Start with empty ordering
        num_slots = len(events)
        current_ordering: tuple[str | None, ...] = tuple([None] * num_slots)

        self._current_state = TemporalClueState(
            events=tuple(events),
            clues=tuple(clues),
            current_ordering=current_ordering,
            unplaced_events=tuple(events),
            correct_ordering=tuple(correct_ordering),
            submitted=False,
            is_correct=False,
        )

        return self._current_state

    async def step(
        self, action: TemporalClueAction
    ) -> tuple[TemporalClueState, float, bool]:
        """Execute an action."""
        if self._current_state is None:
            raise RuntimeError("Environment not reset")

        state = self._current_state

        if state.submitted:
            return state, 0.0, True

        if action == TemporalClueAction.SUBMIT:
            # Submit and check answer
            is_correct = self._check_ordering(state)
            reward = 1.0 if is_correct else -1.0

            new_state = TemporalClueState(
                events=state.events,
                clues=state.clues,
                current_ordering=state.current_ordering,
                unplaced_events=state.unplaced_events,
                correct_ordering=state.correct_ordering,
                submitted=True,
                is_correct=is_correct,
            )

            self._current_state = new_state
            return new_state, reward, True

        # Place next unplaced event at position
        if not state.unplaced_events:
            return state, -0.1, False  # No events to place

        pos = action.value
        if pos >= len(state.current_ordering):
            return state, -0.1, False  # Invalid position

        if state.current_ordering[pos] is not None:
            return state, -0.1, False  # Position already filled

        # Place the first unplaced event
        event_to_place = state.unplaced_events[0]
        new_ordering = list(state.current_ordering)
        new_ordering[pos] = event_to_place

        new_unplaced = state.unplaced_events[1:]

        # Small reward for consistent placement (based on clues)
        reward = self._evaluate_placement(new_ordering, state.clues, event_to_place, pos)

        new_state = TemporalClueState(
            events=state.events,
            clues=state.clues,
            current_ordering=tuple(new_ordering),
            unplaced_events=new_unplaced,
            correct_ordering=state.correct_ordering,
            submitted=False,
            is_correct=False,
        )

        self._current_state = new_state
        return new_state, reward, False

    def get_available_actions(self, state: TemporalClueState) -> list[TemporalClueAction]:
        """Get list of valid actions."""
        if state.submitted:
            return []

        actions = []

        # Can place at any empty position
        for i, event in enumerate(state.current_ordering):
            if event is None:
                actions.append(TemporalClueAction.from_position(i))

        # Can always submit
        actions.append(TemporalClueAction.SUBMIT)

        return actions

    def render(self, state: TemporalClueState) -> str:
        """Render the state."""
        return state.render()

    def _generate_puzzle(self) -> dict:
        """Generate or select a puzzle."""
        if self._rng is None:
            self._rng = random.Random()

        if self.config.custom_scenarios:
            scenario = self._rng.choice(self.config.custom_scenarios)
        else:
            scenario_name = self._rng.choice(list(PUZZLE_SCENARIOS.keys()))
            scenario = PUZZLE_SCENARIOS[scenario_name]

        events = list(scenario["events"])
        correct_order = scenario.get("correct_order", list(range(len(events))))

        # Map indices to actual event names in correct order
        correct_ordering = [events[i] for i in correct_order]

        # Limit based on difficulty
        if self.config.difficulty == Difficulty.EASY:
            max_events = min(4, len(events))
        elif self.config.difficulty == Difficulty.MEDIUM:
            max_events = min(6, len(events))
        else:
            max_events = min(8, len(events))

        events = events[:max_events]
        correct_ordering = correct_ordering[:max_events]

        # Shuffle events for presentation
        shuffled_events = events.copy()
        self._rng.shuffle(shuffled_events)

        return {
            "events": shuffled_events,
            "correct_ordering": correct_ordering,
        }

    def _generate_clues(
        self, events: list[str], correct_ordering: list[str]
    ) -> list[TemporalClue]:
        """Generate clues based on correct ordering."""
        if self._rng is None:
            self._rng = random.Random()

        clues = []
        n = len(correct_ordering)

        # Determine number of clues based on difficulty
        if self.config.difficulty == Difficulty.EASY:
            num_clues = n - 1  # Direct chain
        elif self.config.difficulty == Difficulty.MEDIUM:
            num_clues = n  # Some redundancy
        else:
            num_clues = n + 2  # More clues, requiring inference

        # Generate clues from ordering
        for _ in range(num_clues):
            i = self._rng.randint(0, n - 2)
            j = self._rng.randint(i + 1, n - 1)

            event_a = correct_ordering[i]
            event_b = correct_ordering[j]

            # Choose relation type
            if j == i + 1 and self._rng.random() < 0.3:
                relation = "immediately_before"
            else:
                relation = self._rng.choice(["before", "before"])

            # Randomly swap to use "after" phrasing
            if self._rng.random() < 0.3:
                event_a, event_b = event_b, event_a
                relation = "after" if relation == "before" else "immediately_after"

            clue = TemporalClue(event_a=event_a, event_b=event_b, relation=relation)

            # Avoid duplicate clues
            if not any(
                c.event_a == clue.event_a
                and c.event_b == clue.event_b
                and c.relation == clue.relation
                for c in clues
            ):
                clues.append(clue)

        return clues

    def _check_ordering(self, state: TemporalClueState) -> bool:
        """Check if current ordering is correct."""
        # Get non-None events in order
        placed = [e for e in state.current_ordering if e is not None]

        if len(placed) != len(state.correct_ordering):
            return False

        return placed == list(state.correct_ordering)

    def _evaluate_placement(
        self,
        ordering: list[str | None],
        clues: tuple[TemporalClue, ...],
        placed_event: str,
        position: int,
    ) -> float:
        """Evaluate if a placement is consistent with clues."""
        reward = 0.0
        violations = 0

        for clue in clues:
            # Check if this placement relates to this clue
            if placed_event not in (clue.event_a, clue.event_b):
                continue

            other_event = clue.event_b if placed_event == clue.event_a else clue.event_a

            # Find position of other event (if placed)
            other_pos = None
            for i, e in enumerate(ordering):
                if e == other_event:
                    other_pos = i
                    break

            if other_pos is None:
                continue  # Other event not yet placed

            # Check consistency
            if clue.relation in ("before", "immediately_before"):
                if placed_event == clue.event_a:
                    # placed_event should be before other_event
                    if position >= other_pos:
                        violations += 1
                else:
                    # placed_event is event_b, should be after event_a
                    if position <= other_pos:
                        violations += 1
            else:  # "after", "immediately_after"
                if placed_event == clue.event_a:
                    # placed_event should be after other_event
                    if position <= other_pos:
                        violations += 1
                else:
                    # placed_event is event_b, should be before event_a
                    if position >= other_pos:
                        violations += 1

        if violations > 0:
            reward = -0.2 * violations
        else:
            reward = 0.1  # Small reward for consistent placement

        return reward
