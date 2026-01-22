"""
elizaOS agent for TextWorld environment.

This module provides different agent implementations for playing text adventure games:

1. TextWorldAgent: Lightweight wrapper that can use an existing AgentRuntime
   or fall back to heuristics. Good for benchmarking and testing.

2. ElizaOSAgent: Full elizaOS stack with its own runtime, character, and plugins.
   Good for trajectory generation where you want the complete elizaOS experience.

3. Heuristic/Random policies: Baselines for comparison. No LLM calls, deterministic.

## Design Decisions

### Why Multiple Agent Classes?

TextWorldAgent and ElizaOSAgent serve different purposes:

- TextWorldAgent: "Bring your own runtime". You control the runtime lifecycle.
  Useful when you're already using elizaOS and want to add game-playing capability.

- ElizaOSAgent: Self-contained. Creates and manages its own runtime.
  Useful for trajectory generation where you just want "play games, generate data".

### Why Heuristics as Fallback?

LLMs fail sometimes (rate limits, invalid responses, network issues).
Rather than crash, we fall back to simple heuristics that make reasonable moves.
This keeps data generation running and produces valid (if suboptimal) trajectories.

The heuristic priority (take > open > go > look) comes from how treasure hunt
games work: you need to collect items (take), find items in containers (open),
and explore (go). "look" is a no-op that wastes a turn.

### Why Temperature 0.7 for ElizaOSAgent?

Temperature controls randomness in LLM outputs:
- 0.0: Deterministic, always picks highest-probability token
- 1.0: Sample according to probability distribution
- >1.0: More random, can produce incoherent output

For GRPO training, we NEED different outputs from the same prompt (to compare).
0.7 gives variety while keeping outputs sensible. 0.3 (used in TextWorldAgent)
is lower because that agent prioritizes consistency over variety.
"""

from __future__ import annotations

import logging
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

logger = logging.getLogger(__name__)


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
    
    WHY THIS PRIORITY ORDER (take > open > go > look):
    
    1. "take" - Collecting items is the goal. If we CAN take something, we should.
       This greedy approach works because there are no "trap" items in TextWorld.
    
    2. "open" - Containers hide items. Opening them reveals more "take" options.
       We do this second because we can't take what we can't see.
    
    3. "go" - Exploration finds new rooms with new items/containers.
       We do this third because we've exhausted local options.
    
    4. "look" - Default when nothing else is available. Essentially a no-op
       since we already see the room description. Only happens when stuck.
    
    WHY ASYNC:
    This function is async for API compatibility with LLM-based agents.
    Both can be passed to env.play_episode() without special handling.
    The async overhead is negligible since we don't await anything.
    
    Args:
        state: Current game state
        
    Returns:
        Action to take
    """
    commands = state.admissible_commands

    # Priority: take > open > go > look
    # Each loop finds the FIRST matching command (order in commands list may matter)
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
    
    WHY RANDOM BASELINE:
    Random policies are the "worst reasonable baseline". They show what happens
    with no intelligence at all. If your trained model doesn't beat random,
    something is very wrong.
    
    In practice, random achieves ~5-10% win rate on easy games (by luck).
    Heuristics achieve ~30-50%. LLMs should achieve >70%.
    
    Args:
        state: Current game state
        
    Returns:
        Random action from available commands
    """
    import random
    if state.admissible_commands:
        return random.choice(state.admissible_commands)
    return "look"  # Fallback if no commands (shouldn't happen)


# =============================================================================
# Full elizaOS Agent with Runtime
# =============================================================================


class ElizaOSAgent:
    """
    Full elizaOS agent with AgentRuntime, Character, and plugins.
    
    WHY THIS CLASS:
    This is a self-contained elizaOS agent that manages its own runtime lifecycle.
    Use this when you want to generate training data without managing runtime
    details. The agent handles initialization, cleanup, and error recovery.
    
    WHY SEPARATE FROM TextWorldAgent:
    TextWorldAgent expects you to provide a runtime (dependency injection).
    ElizaOSAgent creates its own runtime (self-contained). Different use cases:
    
    - TextWorldAgent: "I have a runtime, let me use it for games"
    - ElizaOSAgent: "I just want to play games, handle the runtime for me"
    
    Example:
        >>> agent = ElizaOSAgent()
        >>> await agent.initialize()
        >>> action = await agent.decide(game_state)
        >>> await agent.cleanup()
    """

    def __init__(self, character: "Character | None" = None):
        """
        Initialize the elizaOS agent.
        
        WHY LAZY INITIALIZATION:
        We don't initialize the runtime here because:
        1. Construction should be fast (runtime init takes ~1 second)
        2. You might want to customize the character before init
        3. Errors during construction are harder to handle than async errors
        
        Args:
            character: Optional custom Character. Uses default explorer if not provided.
        """
        self._character = character
        self._runtime: "AgentRuntime | None" = None
        self._initialized = False

    @property
    def character(self) -> "Character":
        """
        Get or create the agent's character.
        
        WHY LAZY CHARACTER CREATION:
        The Character import triggers elizaos module loading. By deferring
        creation to first access, we keep __init__ fast and avoid import
        errors if elizaos isn't properly installed.
        
        WHY THIS DEFAULT CHARACTER:
        The system prompt is minimal but effective:
        - Clear goal (collect treasures)
        - Clear strategy hints (open containers, take items)
        - Clear output format (ONLY the command)
        
        The "ONLY the action command" instruction is crucial - without it,
        models tend to add explanations that break command parsing.
        """
        if self._character is None:
            from elizaos import Character
            self._character = Character(
                name="Explorer",
                bio="Expert text adventure player. Systematic, thorough, goal-oriented.",
                system="""You are playing a text adventure game.
Your goal: collect all treasures and explore efficiently.
Strategy: Open containers, take valuable items, explore systematically.
Respond with ONLY the action command, nothing else.""",
            )
        return self._character

    async def initialize(self) -> None:
        """
        Initialize elizaOS runtime with plugins.
        
        WHY IDEMPOTENT:
        Calling initialize() multiple times is safe (early return if already init).
        This simplifies usage - callers don't need to track init state.
        
        WHY THESE PLUGINS:
        - openai: Provides LLM capabilities (TEXT_SMALL model)
        - inmemorydb: Required by elizaOS runtime for state management
          (even though we don't persist anything, the runtime needs an adapter)
        """
        if self._initialized:
            return

        try:
            from elizaos import AgentRuntime
            from elizaos_plugin_openai import get_openai_plugin
            from elizaos_plugin_inmemorydb import plugin as inmemorydb_plugin

            self._runtime = AgentRuntime(
                character=self.character,
                plugins=[get_openai_plugin(), inmemorydb_plugin],
            )
            await self._runtime.initialize()
            self._initialized = True
            logger.info("elizaOS agent initialized successfully")

        except ImportError as e:
            # Clear error message for missing dependencies
            logger.error(f"Failed to import elizaOS dependencies: {e}")
            raise
        except Exception as e:
            logger.error(f"Failed to initialize elizaOS runtime: {e}")
            raise

    async def decide(self, state: GameState) -> str:
        """
        Get action from elizaOS runtime.
        
        WHY AUTO-INITIALIZE:
        If you forget to call initialize(), we do it automatically.
        This is a convenience - the agent "just works" even if you skip init.
        
        WHY TEMPERATURE 0.7:
        For GRPO training, we NEED variety in outputs (to compare different
        trajectories). 0.7 gives good variety while keeping outputs sensible.
        Lower (0.3) would be more consistent but less useful for training.
        
        WHY maxTokens=30:
        Game commands are short ("take key", "go north"). 30 tokens is plenty.
        Lower limits prevent the model from adding unwanted explanations.
        
        Args:
            state: Current game state
            
        Returns:
            Action to take (always valid - falls back to heuristic if needed)
        """
        if not self._initialized:
            await self.initialize()

        prompt = self._format_prompt(state)

        try:
            from elizaos.types.model import ModelType

            result = await self._runtime.use_model(
                ModelType.TEXT_SMALL.value,
                {"prompt": prompt, "maxTokens": 30, "temperature": 0.7},
            )
            # Take first line only - models sometimes add explanations
            action = str(result).strip().lower().split("\n")[0]

            # Empty response should fall back to heuristic
            # (empty string matches any string in Python: "" in "x" is True)
            if not action:
                logger.debug("LLM returned empty response, using heuristic")
                return self._heuristic_fallback(state)

            # Exact match against admissible commands (return original casing)
            for cmd in state.admissible_commands:
                if action == cmd.lower():
                    return cmd

            # Fuzzy match: "take the key" should match "take key"
            for cmd in state.admissible_commands:
                if action in cmd.lower() or cmd.lower() in action:
                    return cmd

            # Model gave invalid command - fall back to heuristic
            logger.debug(f"LLM response '{action}' not in admissible commands, using heuristic")
            return self._heuristic_fallback(state)

        except Exception as e:
            # Network error, rate limit, etc. - keep going with heuristics
            logger.warning(f"LLM failed: {e}, using heuristic")
            return self._heuristic_fallback(state)

    def _format_prompt(self, state: GameState) -> str:
        """
        Format the prompt for the LLM.
        
        WHY THIS FORMAT:
        Minimal but complete:
        - Description: What does the player see?
        - Inventory: What does the player have?
        - Progress: How close to winning?
        - Commands: What can the player do?
        
        We limit to 15 commands to keep prompt short. More commands = more
        tokens = slower/more expensive, and the model rarely needs 15+ options.
        
        The "Your action:" at the end primes the model to output JUST the action.
        """
        commands = ", ".join(state.admissible_commands[:15])
        return f"""{state.description}

Inventory: {state.inventory_str}
Progress: {state.score}/{state.max_score} (Step {state.steps}/{state.max_steps})

Commands: {commands}

Your action:"""

    def _heuristic_fallback(self, state: GameState) -> str:
        """
        Fallback heuristic when LLM fails.
        
        WHY FALLBACK:
        We never want decide() to raise an exception. Invalid output or errors
        should produce SOME valid action. Heuristics aren't optimal but they're
        always valid and keep the game running.
        
        This means every trajectory completes, even if some turns use heuristics.
        Better than losing entire episodes to transient errors.
        """
        for cmd in state.admissible_commands:
            if cmd.startswith("take"):
                return cmd
        for cmd in state.admissible_commands:
            if cmd.startswith("open"):
                return cmd
        for cmd in state.admissible_commands:
            if cmd.startswith("go"):
                return cmd
        return "look"

    async def cleanup(self) -> None:
        """
        Cleanup elizaOS runtime.
        
        WHY TRY/FINALLY:
        Even if stop() fails, we must clear _runtime and _initialized.
        Otherwise the agent would think it's still initialized but the
        runtime would be in a broken state.
        
        WHY NOT AUTO-CLEANUP:
        Python doesn't have reliable destructors for async resources.
        __del__ can't await, and atexit handlers are synchronous.
        Explicit cleanup is the only reliable approach.
        """
        if self._runtime:
            try:
                await self._runtime.stop()
                logger.info("elizaOS agent cleaned up")
            except Exception as e:
                logger.warning(f"Error during cleanup: {e}")
            finally:
                # Always clear state, even on error
                self._runtime = None
                self._initialized = False
