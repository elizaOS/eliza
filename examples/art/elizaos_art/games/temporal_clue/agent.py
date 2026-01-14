"""
Temporal Clue Agents for ART Training
"""

import re

from elizaos_art.base import BaseAgent
from elizaos_art.games.temporal_clue.types import (
    TemporalClueAction,
    TemporalClueState,
)


class TemporalClueAgent(BaseAgent[TemporalClueState, TemporalClueAction]):
    """
    LLM-based agent for solving Temporal Clue puzzles.
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
        return f"TemporalClueAgent({self.model_name})"

    def get_system_prompt(self) -> str:
        """Get system prompt for the LLM."""
        return """You are an expert at solving temporal reasoning puzzles. Your task is to arrange events in chronological order based on given clues.

Strategy:
1. Read all clues carefully
2. Identify definite relationships (A before B)
3. Build a chain of events using transitive reasoning
4. If A is before B, and B is before C, then A is before C
5. Place events one at a time, starting with those you're most certain about
6. Use "immediately before/after" clues to lock adjacent positions

When placing events:
- Position 0 is EARLIEST (first to happen)
- Higher positions are LATER (happened after)
- SUBMIT when all events are placed to check your answer

Respond with just a position number (0-7) to place the next event, or SUBMIT."""

    def format_action_prompt(
        self,
        state: TemporalClueState,
        available_actions: list[TemporalClueAction],
    ) -> str:
        """Format prompt for action selection."""
        action_strs = []
        for a in available_actions:
            if a == TemporalClueAction.SUBMIT:
                action_strs.append("SUBMIT")
            else:
                action_strs.append(str(a.value))

        prompt = f"""{state.to_prompt()}

Available positions: {", ".join(action_strs)}

Next event to place: {state.unplaced_events[0] if state.unplaced_events else "None"}

Based on the clues, where should this event be placed? (position 0 = earliest)
Respond with a number or SUBMIT:"""

        return prompt

    def parse_action(
        self,
        response: str,
        available_actions: list[TemporalClueAction],
    ) -> TemporalClueAction:
        """Parse LLM response into an action."""
        response = response.strip().upper()

        # Check for SUBMIT
        if "SUBMIT" in response:
            if TemporalClueAction.SUBMIT in available_actions:
                return TemporalClueAction.SUBMIT

        # Try to extract a number
        match = re.search(r"\b([0-7])\b", response)
        if match:
            pos = int(match.group(1))
            action = TemporalClueAction.from_position(pos)
            if action in available_actions:
                return action

        # Default to first available position action
        for action in available_actions:
            if action != TemporalClueAction.SUBMIT:
                return action

        return available_actions[0]

    async def decide(
        self,
        state: TemporalClueState,
        available_actions: list[TemporalClueAction],
    ) -> TemporalClueAction:
        """Heuristic decision for standalone use."""
        if not state.unplaced_events:
            # All placed, submit
            return TemporalClueAction.SUBMIT

        # Simple heuristic: place in first available slot
        for action in available_actions:
            if action != TemporalClueAction.SUBMIT:
                return action

        return TemporalClueAction.SUBMIT


class TemporalClueHeuristicAgent(BaseAgent[TemporalClueState, TemporalClueAction]):
    """
    Heuristic-based agent that uses clue analysis.
    """

    @property
    def name(self) -> str:
        return "TemporalClueHeuristic"

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
        """Use clue analysis to make decisions."""
        if not state.unplaced_events:
            return TemporalClueAction.SUBMIT

        event_to_place = state.unplaced_events[0]

        # Analyze clues to find constraints
        must_be_before: set[str] = set()
        must_be_after: set[str] = set()

        for clue in state.clues:
            if event_to_place == clue.event_a:
                if "before" in clue.relation:
                    must_be_before.add(clue.event_b)
                else:  # after
                    must_be_after.add(clue.event_b)
            elif event_to_place == clue.event_b:
                if "before" in clue.relation:
                    must_be_after.add(clue.event_a)
                else:
                    must_be_before.add(clue.event_a)

        # Find valid positions based on already placed events
        ordering = list(state.current_ordering)
        best_pos = None

        for i, existing in enumerate(ordering):
            if existing is not None:
                continue  # Slot taken

            # Check if this position violates any constraints
            valid = True

            for j, other in enumerate(ordering):
                if other is None:
                    continue

                if other in must_be_before and j <= i:
                    valid = False  # Event must be after this
                    break
                if other in must_be_after and j >= i:
                    valid = False  # Event must be before this
                    break

            if valid:
                best_pos = i
                break

        if best_pos is not None:
            action = TemporalClueAction.from_position(best_pos)
            if action in available_actions:
                return action

        # Fallback: first available position
        for action in available_actions:
            if action != TemporalClueAction.SUBMIT:
                return action

        return TemporalClueAction.SUBMIT
