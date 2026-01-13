"""
ElizaOS agent for TextWorld environment.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from elizaos_atropos_textworld.types import (
    GameState,
    EpisodeResult,
    TrainingStats,
)

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.primitives import UUID


class TextWorldAgent:
    """
    ElizaOS-powered TextWorld agent.
    
    Uses LLM to understand game text and make decisions about
    which actions to take in text adventure games.
    
    Example:
        >>> runtime = AgentRuntime(plugins=[get_openai_plugin()])
        >>> await runtime.initialize()
        >>> agent = TextWorldAgent(runtime)
        >>> action = await agent.decide(game_state)
    """

    def __init__(
        self,
        runtime: AgentRuntime | None = None,
        use_llm: bool = True,
        agent_id: UUID | None = None,
    ) -> None:
        """
        Initialize the TextWorld agent.
        
        Args:
            runtime: ElizaOS AgentRuntime
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

    async def decide(self, state: GameState, *, trajectory_step_id: str | None = None) -> str:
        """
        Decide the next action to take.
        
        Args:
            state: Current game state
            
        Returns:
            The action to take as a string
        """
        if self._use_llm and self._runtime is not None:
            return await self._decide_with_eliza(state, trajectory_step_id=trajectory_step_id)
        return self._decide_with_heuristics(state)

    def _decide_with_heuristics(self, state: GameState) -> str:
        """Use simple heuristics for decision making."""
        commands = state.admissible_commands

        # Priority: take goal items > open containers > explore
        for cmd in commands:
            if cmd.startswith("take"):
                return cmd

        for cmd in commands:
            if cmd.startswith("open"):
                return cmd

        for cmd in commands:
            if cmd.startswith("go"):
                return cmd

        # Default to look
        return "look"

    async def _decide_with_eliza(self, state: GameState, *, trajectory_step_id: str | None = None) -> str:
        """Use canonical ElizaOS message pipeline for decision making."""
        if self._runtime is None:
            return self._decide_with_heuristics(state)

        try:
            from elizaos_atropos_shared.canonical_eliza import run_with_context
            from elizaos_atropos_textworld.eliza_plugin import (
                TEXTWORLD_STORE,
                TextWorldDecisionContext,
            )

            _result, ctx = await run_with_context(
                self._runtime,
                TEXTWORLD_STORE,
                TextWorldDecisionContext(state=state),
                source="atropos_textworld",
                text="Choose the next TextWorld command.",
                trajectory_step_id=trajectory_step_id,
            )
            chosen = ctx.chosen_command

            if chosen:
                # Validate against admissible commands (case-insensitive)
                admissible_lower = {cmd.lower(): cmd for cmd in state.admissible_commands}
                if chosen.lower() in admissible_lower:
                    return admissible_lower[chosen.lower()]

            return self._decide_with_heuristics(state)
        except Exception:
            return self._decide_with_heuristics(state)

    def record_episode(self, result: EpisodeResult) -> None:
        """Record an episode result."""
        self._stats.record_episode(result)
        self._episode_history.append(result)

    def reset_stats(self) -> None:
        """Reset training statistics."""
        self._stats = TrainingStats()
        self._episode_history = []

    def get_summary(self) -> str:
        """Get a summary of agent performance."""
        return (
            f"TextWorld Agent Summary\n"
            f"=======================\n"
            f"Mode: {'LLM-based' if self._use_llm else 'Heuristic'}\n"
            f"{self._stats}"
        )


async def create_heuristic_policy(state: GameState) -> str:
    """
    Heuristic policy for baseline comparison.
    
    Args:
        state: Current game state
        
    Returns:
        Action to take
    """
    commands = state.admissible_commands

    # Priority: take > open > go > look
    for cmd in commands:
        if cmd.startswith("take"):
            return cmd

    for cmd in commands:
        if cmd.startswith("open"):
            return cmd

    for cmd in commands:
        if cmd.startswith("go"):
            return cmd

    return "look"


async def create_random_policy(state: GameState) -> str:
    """
    Random policy for baseline comparison.
    
    Args:
        state: Current game state
        
    Returns:
        Random action
    """
    import random
    if state.admissible_commands:
        return random.choice(state.admissible_commands)
    return "look"
