"""
ElizaOS agent for Blackjack environment.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from elizaos_atropos_blackjack.types import (
    BlackjackAction,
    BlackjackState,
    TrainingStats,
    EpisodeResult,
)
from elizaos_atropos_blackjack.strategy import BasicStrategy

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.primitives import UUID


class BlackjackAgent:
    """
    ElizaOS-powered Blackjack agent.
    
    This agent can use either:
    - LLM-based decisions (when runtime has model providers)
    - Optimal basic strategy (fallback or explicit)
    
    Example:
        >>> runtime = AgentRuntime(plugins=[get_openai_plugin()])
        >>> await runtime.initialize()
        >>> agent = BlackjackAgent(runtime, use_llm=True)
        >>> action = await agent.decide(state, available_actions)
    """

    def __init__(
        self,
        runtime: AgentRuntime | None = None,
        use_llm: bool = False,
        agent_id: UUID | None = None,
    ) -> None:
        """
        Initialize the Blackjack agent.
        
        Args:
            runtime: ElizaOS AgentRuntime (optional for basic strategy mode)
            use_llm: Whether to use LLM for decisions
            agent_id: Optional agent ID
        """
        self._runtime = runtime
        self._use_llm = use_llm
        self._agent_id = agent_id or str(uuid.uuid4())
        self._stats = TrainingStats()
        self._episode_history: list[EpisodeResult] = []

    @property
    def stats(self) -> TrainingStats:
        """Get training statistics."""
        return self._stats

    @property
    def agent_id(self) -> str:
        """Get agent ID."""
        return str(self._agent_id)

    async def decide(
        self,
        state: BlackjackState,
        available_actions: list[BlackjackAction],
        *,
        trajectory_step_id: str | None = None,
    ) -> BlackjackAction:
        """
        Decide the next action to take.
        
        Args:
            state: Current game state
            available_actions: List of available actions
            
        Returns:
            The chosen action
        """
        if self._use_llm and self._runtime is not None:
            return await self._decide_with_eliza(state, available_actions, trajectory_step_id=trajectory_step_id)
        return self._decide_with_strategy(state)

    def _decide_with_strategy(self, state: BlackjackState) -> BlackjackAction:
        """Use basic strategy for decision."""
        return BasicStrategy.get_action(state)

    async def _decide_with_eliza(
        self,
        state: BlackjackState,
        available_actions: list[BlackjackAction],
        *,
        trajectory_step_id: str | None = None,
    ) -> BlackjackAction:
        """Use canonical ElizaOS message pipeline for decision making."""
        if self._runtime is None:
            return self._decide_with_strategy(state)

        try:
            from elizaos_atropos_shared.canonical_eliza import run_with_context
            from elizaos_atropos_blackjack.eliza_plugin import (
                BLACKJACK_STORE,
                BlackjackDecisionContext,
            )

            _result, ctx = await run_with_context(
                self._runtime,
                BLACKJACK_STORE,
                BlackjackDecisionContext(state=state),
                source="atropos_blackjack",
                text="Choose the next blackjack action.",
                trajectory_step_id=trajectory_step_id,
            )
            chosen = ctx.chosen

            if chosen is not None and chosen in available_actions:
                return chosen

            return self._decide_with_strategy(state)
        except Exception:
            # Fallback to basic strategy on error
            return self._decide_with_strategy(state)

    def record_episode(self, result: EpisodeResult) -> None:
        """
        Record the result of an episode.
        
        Args:
            result: The episode result
        """
        self._stats.record_episode(result)
        self._episode_history.append(result)

    def reset_stats(self) -> None:
        """Reset training statistics."""
        self._stats = TrainingStats()
        self._episode_history = []

    def get_summary(self) -> str:
        """Get a summary of agent performance."""
        return (
            f"Blackjack Agent Summary\n"
            f"=======================\n"
            f"Mode: {'LLM-based' if self._use_llm else 'Basic Strategy'}\n"
            f"{self._stats}\n"
            f"Blackjacks: {self._stats.blackjacks}\n"
            f"Busts: {self._stats.busts}"
        )


async def create_optimal_policy(
    state: BlackjackState,
    available_actions: list[BlackjackAction],
) -> BlackjackAction:
    """
    Optimal policy function using basic strategy.
    
    This can be passed directly to env.play_episode().
    
    Args:
        state: Current game state
        available_actions: Available actions (unused, for compatibility)
        
    Returns:
        Optimal action
    """
    _ = available_actions  # Not used for optimal strategy
    return BasicStrategy.get_action(state)


async def create_random_policy(
    state: BlackjackState,
    available_actions: list[BlackjackAction],
) -> BlackjackAction:
    """
    Random policy for baseline comparison.
    
    Args:
        state: Current game state (unused)
        available_actions: Available actions
        
    Returns:
        Random action
    """
    import random
    _ = state
    return random.choice(available_actions)
