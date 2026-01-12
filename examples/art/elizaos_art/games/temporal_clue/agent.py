"""
Temporal Clue Agent for ART Training

LLM-based agent that solves temporal reasoning puzzles.
"""

import re

from elizaos_art.base import BaseAgent
from elizaos_art.games.temporal_clue.types import (
    TemporalClueAction,
    TemporalClueState,
)


class TemporalClueAgent(BaseAgent[TemporalClueState, TemporalClueAction]):
    """
    LLM-based agent for solving temporal clue puzzles.

    Uses reasoning to order events based on temporal relationships.
    """

    def __init__(
        self,
        model_name: str = "meta-llama/Llama-3.2-3B-Instruct",
        temperature: float = 0.3,  # Lower temp for reasoning
    ):
        self.model_name = model_name
        self.temperature = temperature

    @property
    def name(self) -> str:
        return f"TemporalClueAgent({self.model_name})"

    def get_system_prompt(self) -> str:
        return """You are an expert at solving temporal logic puzzles. Given a set of events and clues about their temporal relationships, you must determine the correct chronological order.

Reasoning strategies:
1. Build a directed graph of "before" relationships
2. Look for anchor points (events that must be first/last)
3. Use transitive reasoning: if A before B and B before C, then A before C
4. "Immediately before/after" means no events in between
5. "Same time" means events happen simultaneously (treat as single position)

When placing events:
1. Start with events that have the most constraints
2. Check each placement against ALL clues
3. If stuck, try working backwards from later events

Respond with the event name to place next, or SUBMIT when all events are placed."""

    def format_action_prompt(
        self,
        state: TemporalClueState,
        available_actions: list[TemporalClueAction],
    ) -> str:
        """Format prompt for deciding next event."""
        prompt = f"""{state.to_prompt()}

Based on the clues, which event should come next in the chronological order?

Remaining events: {', '.join(state.remaining_events)}

Think step by step:
1. Which clues mention the remaining events?
2. Which event has the most "before" relationships with already-placed events?
3. Which event must logically come next?

"""

        if TemporalClueAction.SUBMIT in available_actions:
            prompt += "All events placed. Type SUBMIT to check your answer.\n"
            prompt += f"Your ordering: {' → '.join(state.current_ordering)}\n"
        else:
            prompt += "Respond with the name of the event to place next:\n"

        return prompt

    def parse_action(
        self,
        response: str,
        available_actions: list[TemporalClueAction],
    ) -> TemporalClueAction:
        """Parse response into an action."""
        response = response.strip().upper()

        if "SUBMIT" in response and TemporalClueAction.SUBMIT in available_actions:
            return TemporalClueAction.SUBMIT

        # Try to match event names
        # Get the state from context (need to pass through somehow)
        # For now, try matching by event index mentioned
        for action in available_actions:
            if action == TemporalClueAction.SUBMIT:
                continue

            # Try to find the event name in response
            event_idx = action.value
            if str(event_idx) in response:
                return action

        # Default to first available non-submit action
        for action in available_actions:
            if action != TemporalClueAction.SUBMIT:
                return action

        return available_actions[0]

    async def decide(
        self,
        state: TemporalClueState,
        available_actions: list[TemporalClueAction],
    ) -> TemporalClueAction:
        """
        Heuristic decision based on clue analysis.

        This is a fallback when not using the full LLM pipeline.
        """
        if TemporalClueAction.SUBMIT in available_actions:
            return TemporalClueAction.SUBMIT

        if not state.remaining_events:
            return TemporalClueAction.SUBMIT

        # Simple heuristic: find event with most "before" constraints
        # relative to remaining events
        scores: dict[str, int] = {e: 0 for e in state.remaining_events}

        for clue in state.puzzle.clues:
            event_a = clue.event_a
            event_b = clue.event_b

            # If A is remaining and has "before" relationship, increase its score
            if event_a in scores and clue.relation.name in ("BEFORE", "JUST_BEFORE"):
                if event_b in state.remaining_events:
                    scores[event_a] += 1
            # If B is remaining and has "after" relationship, increase its score
            if event_b in scores and clue.relation.name in ("AFTER", "JUST_AFTER"):
                if event_a in state.remaining_events:
                    scores[event_b] += 1

        # Find event with highest score (most "comes before" constraints)
        if scores:
            best_event = max(scores.keys(), key=lambda e: scores[e])
            event_idx = state.puzzle.events.index(best_event)
            return TemporalClueAction(event_idx)

        # Fallback: first remaining event
        first_remaining = state.remaining_events[0]
        return TemporalClueAction(state.puzzle.events.index(first_remaining))


class TemporalClueRandomAgent(BaseAgent[TemporalClueState, TemporalClueAction]):
    """Random agent for baseline."""

    def __init__(self, seed: int | None = None):
        import random

        self._rng = random.Random(seed)

    @property
    def name(self) -> str:
        return "TemporalClueRandom"

    def get_system_prompt(self) -> str:
        return ""

    def format_action_prompt(
        self,
        state: TemporalClueState,
        available_actions: list[TemporalClueAction],
    ) -> str:
        return ""

    def parse_action(
        self,
        response: str,
        available_actions: list[TemporalClueAction],
    ) -> TemporalClueAction:
        return available_actions[0]

    async def decide(
        self,
        state: TemporalClueState,
        available_actions: list[TemporalClueAction],
    ) -> TemporalClueAction:
        """Random choice among available actions."""
        non_submit = [a for a in available_actions if a != TemporalClueAction.SUBMIT]
        if non_submit:
            return self._rng.choice(non_submit)
        return TemporalClueAction.SUBMIT


class TemporalClueGreedyAgent(BaseAgent[TemporalClueState, TemporalClueAction]):
    """
    Greedy agent that uses simple constraint propagation.

    Better than random but not optimal.
    """

    @property
    def name(self) -> str:
        return "TemporalClueGreedy"

    def get_system_prompt(self) -> str:
        return ""

    def format_action_prompt(
        self,
        state: TemporalClueState,
        available_actions: list[TemporalClueAction],
    ) -> str:
        return ""

    def parse_action(
        self,
        response: str,
        available_actions: list[TemporalClueAction],
    ) -> TemporalClueAction:
        return available_actions[0]

    async def decide(
        self,
        state: TemporalClueState,
        available_actions: list[TemporalClueAction],
    ) -> TemporalClueAction:
        """Use constraint propagation to find best next event."""
        if TemporalClueAction.SUBMIT in available_actions:
            if not state.remaining_events:
                return TemporalClueAction.SUBMIT

        remaining = set(state.remaining_events)
        placed = set(state.current_ordering)

        # Find events that must come before all other remaining events
        must_be_first: set[str] = remaining.copy()

        for clue in state.puzzle.clues:
            a, b = clue.event_a, clue.event_b

            if clue.relation.name in ("BEFORE", "JUST_BEFORE"):
                # A comes before B
                if a in remaining and b in remaining:
                    must_be_first.discard(b)
            elif clue.relation.name in ("AFTER", "JUST_AFTER"):
                # A comes after B
                if a in remaining and b in remaining:
                    must_be_first.discard(a)

        if must_be_first:
            chosen = next(iter(must_be_first))
            return TemporalClueAction(state.puzzle.events.index(chosen))

        # Fallback
        if remaining:
            chosen = next(iter(remaining))
            return TemporalClueAction(state.puzzle.events.index(chosen))

        return TemporalClueAction.SUBMIT
