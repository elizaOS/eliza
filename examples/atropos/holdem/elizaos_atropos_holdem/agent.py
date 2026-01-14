"""
ElizaOS agent for Texas Hold'em environment.
"""

from __future__ import annotations

import uuid
import random
from typing import TYPE_CHECKING

from elizaos_atropos_holdem.types import (
    Action,
    ActionType,
    GameState,
    SessionStats,
    HandRank,
    Chips,
)
from elizaos_atropos_holdem.hand_evaluator import evaluate_hand, get_hand_description

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.primitives import UUID


class HoldemAgent:
    """
    ElizaOS-powered Texas Hold'em agent.
    
    Uses LLM or heuristics to make poker decisions.
    
    Example:
        >>> runtime = AgentRuntime(plugins=[get_openai_plugin()])
        >>> await runtime.initialize()
        >>> agent = HoldemAgent(runtime, position=0)
        >>> action = await agent.decide(game_state)
    """

    def __init__(
        self,
        runtime: AgentRuntime | None = None,
        position: int = 0,
        use_llm: bool = True,
        agent_id: UUID | None = None,
        style: str = "balanced",
    ) -> None:
        """
        Initialize the Hold'em agent.
        
        Args:
            runtime: ElizaOS AgentRuntime
            position: Seat position at the table
            use_llm: Whether to use LLM for decisions
            agent_id: Optional agent ID
            style: Playing style (tight, loose, aggressive, balanced)
        """
        self._runtime = runtime
        self._position = position
        self._use_llm = use_llm
        self._agent_id = agent_id or str(uuid.uuid4())
        self._style = style
        self._stats = SessionStats()

    @property
    def position(self) -> int:
        """Get seat position."""
        return self._position

    @property
    def stats(self) -> SessionStats:
        """Get session statistics."""
        return self._stats

    async def decide(self, state: GameState, *, trajectory_step_id: str | None = None) -> Action:
        """
        Decide the next action.
        
        Args:
            state: Current game state
            
        Returns:
            The action to take
        """
        if self._use_llm and self._runtime is not None:
            return await self._decide_with_eliza(state, trajectory_step_id=trajectory_step_id)
        return self._decide_with_heuristics(state)

    def _decide_with_heuristics(self, state: GameState) -> Action:
        """Use simple heuristics for decision making."""
        player = state.get_player(self._position)
        valid_actions = state.get_valid_actions()

        # Can't act if we don't have cards
        if player.hole_cards is None:
            return Action(ActionType.FOLD)

        # Calculate hand strength
        all_cards = list(player.hole_cards) + state.community_cards
        hand_rank, _ = evaluate_hand(all_cards) if len(all_cards) >= 5 else (HandRank.HIGH_CARD, [])

        to_call = state.current_bet - player.bet_this_round
        pot_odds = to_call / (state.pot + to_call) if to_call > 0 else 0

        # Simple strategy based on hand strength
        if hand_rank >= HandRank.TWO_PAIR:
            # Strong hand - raise or bet
            for action in valid_actions:
                if action.action_type == ActionType.RAISE:
                    return action
            for action in valid_actions:
                if action.action_type == ActionType.CALL:
                    return action

        elif hand_rank >= HandRank.ONE_PAIR:
            # Medium hand - call or check
            if to_call == 0:
                for action in valid_actions:
                    if action.action_type == ActionType.CHECK:
                        return action
            if pot_odds < 0.3:
                for action in valid_actions:
                    if action.action_type == ActionType.CALL:
                        return action

        # Weak hand
        if to_call == 0:
            for action in valid_actions:
                if action.action_type == ActionType.CHECK:
                    return action

        # Fold if we have to pay too much
        return Action(ActionType.FOLD)

    async def _decide_with_eliza(self, state: GameState, *, trajectory_step_id: str | None = None) -> Action:
        """Use canonical ElizaOS message pipeline for decision making."""
        if self._runtime is None:
            return self._decide_with_heuristics(state)

        try:
            from elizaos_atropos_shared.canonical_eliza import run_with_context
            from elizaos_atropos_holdem.eliza_plugin import (
                HOLDEM_STORE,
                HoldemDecisionContext,
            )

            _result, ctx = await run_with_context(
                self._runtime,
                HOLDEM_STORE,
                HoldemDecisionContext(state=state, position=self._position),
                source="atropos_holdem",
                text="Choose the next holdem action.",
                trajectory_step_id=trajectory_step_id,
            )
            chosen = ctx.chosen

            valid_actions = state.get_valid_actions()
            if chosen == "FOLD":
                return Action(ActionType.FOLD)
            if chosen == "CHECK":
                for a in valid_actions:
                    if a.action_type == ActionType.CHECK:
                        return a
            if chosen == "CALL":
                for a in valid_actions:
                    if a.action_type == ActionType.CALL:
                        return a
            if chosen == "ALL_IN":
                for a in valid_actions:
                    if a.action_type == ActionType.ALL_IN:
                        return a
            if chosen == "RAISE":
                for a in valid_actions:
                    if a.action_type == ActionType.RAISE:
                        return a

            return self._decide_with_heuristics(state)

        except Exception:
            return self._decide_with_heuristics(state)

    def record_result(self, profit: Chips, won: bool = False, pot_size: Chips = 0) -> None:
        """Record a hand result."""
        self._stats.record_hand(profit, won, pot_size)

    def get_summary(self) -> str:
        """Get agent summary."""
        return (
            f"Hold'em Agent (Position {self._position})\n"
            f"Style: {self._style}\n"
            f"{self._stats}"
        )


async def create_random_policy(state: GameState, position: int) -> Action:
    """Random policy for baseline."""
    valid_actions = state.get_valid_actions()
    return random.choice(valid_actions) if valid_actions else Action(ActionType.FOLD)


async def create_calling_station_policy(state: GameState, position: int) -> Action:
    """Always call/check policy."""
    valid_actions = state.get_valid_actions()

    for action in valid_actions:
        if action.action_type == ActionType.CHECK:
            return action

    for action in valid_actions:
        if action.action_type == ActionType.CALL:
            return action

    return Action(ActionType.FOLD)
