"""
Blackjack environment wrapping OpenAI Gymnasium.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import gymnasium as gym

from elizaos_atropos_blackjack.types import (
    BlackjackAction,
    BlackjackState,
    BlackjackResult,
    EpisodeResult,
)

if TYPE_CHECKING:
    pass


class BlackjackEnvironment:
    """
    Blackjack environment for ElizaOS agents.
    
    Wraps OpenAI Gymnasium's Blackjack-v1 environment with a cleaner interface
    for use with ElizaOS agents and Atropos training.
    
    Example:
        >>> env = BlackjackEnvironment()
        >>> await env.initialize()
        >>> state = await env.reset()
        >>> result = await env.step(BlackjackAction.HIT)
    """

    def __init__(
        self,
        natural_bonus: bool = True,
        sab: bool = False,
        render_mode: str | None = None,
    ) -> None:
        """
        Initialize the Blackjack environment.
        
        Args:
            natural_bonus: If True, blackjack pays 1.5x (3:2)
            sab: If True, use Sutton & Barto version (simplified)
            render_mode: Gymnasium render mode ('human', 'rgb_array', None)
        """
        self._natural_bonus = natural_bonus
        self._sab = sab
        self._render_mode = render_mode
        self._env: gym.Env | None = None
        self._current_state: BlackjackState | None = None
        self._action_history: list[BlackjackAction] = []
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize the Gymnasium environment."""
        self._env = gym.make(
            "Blackjack-v1",
            natural=self._natural_bonus,
            sab=self._sab,
            render_mode=self._render_mode,
        )
        self._initialized = True

    @property
    def is_initialized(self) -> bool:
        """Check if environment is initialized."""
        return self._initialized

    @property
    def current_state(self) -> BlackjackState | None:
        """Get current game state."""
        return self._current_state

    def get_available_actions(self) -> list[BlackjackAction]:
        """Get list of available actions."""
        return [BlackjackAction.STICK, BlackjackAction.HIT]

    def get_action_names(self) -> dict[BlackjackAction, str]:
        """Get human-readable action names."""
        return {
            BlackjackAction.STICK: "Stand (stop taking cards)",
            BlackjackAction.HIT: "Hit (take another card)",
        }

    async def reset(self, seed: int | None = None) -> BlackjackState:
        """
        Reset the environment for a new episode.
        
        Args:
            seed: Optional random seed for reproducibility
            
        Returns:
            Initial game state
        """
        if not self._initialized or self._env is None:
            await self.initialize()

        assert self._env is not None
        obs, _info = self._env.reset(seed=seed)
        self._current_state = BlackjackState.from_tuple(obs)
        self._action_history = []

        return self._current_state

    async def step(self, action: BlackjackAction | int) -> BlackjackResult:
        """
        Take an action in the environment.
        
        Args:
            action: The action to take (STICK=0 or HIT=1)
            
        Returns:
            BlackjackResult with new state, reward, done flag, and info
        """
        if not self._initialized or self._env is None:
            raise RuntimeError("Environment not initialized. Call initialize() first.")

        # Convert to int if needed
        action_int = int(action) if isinstance(action, BlackjackAction) else action
        action_enum = BlackjackAction(action_int)

        obs, reward, terminated, truncated, info = self._env.step(action_int)

        self._current_state = BlackjackState.from_tuple(obs)
        self._action_history.append(action_enum)

        return BlackjackResult(
            state=self._current_state,
            reward=float(reward),
            done=terminated,
            truncated=truncated,
            info=dict(info),
        )

    async def play_episode(
        self,
        policy: callable,
        seed: int | None = None,
    ) -> EpisodeResult:
        """
        Play a complete episode using the given policy.
        
        Args:
            policy: Async function that takes (state, actions) and returns an action
            seed: Optional random seed
            
        Returns:
            EpisodeResult with final outcome
        """
        state = await self.reset(seed=seed)
        done = False
        total_reward = 0.0

        while not done:
            action = await policy(state, self.get_available_actions())
            result = await self.step(action)
            state = result.state
            total_reward = result.reward
            done = result.done

        return EpisodeResult(
            reward=total_reward,
            num_steps=len(self._action_history),
            final_state=state,
            action_history=list(self._action_history),
            won=total_reward > 0,
            is_blackjack=total_reward == 1.5,
            is_bust=state.player_sum > 21,
        )

    def render(self) -> str | None:
        """Render the current state."""
        if self._env is None:
            return None
        return self._env.render()

    async def close(self) -> None:
        """Close the environment."""
        if self._env is not None:
            self._env.close()
            self._env = None
        self._initialized = False

    def format_state(self, state: BlackjackState | None = None) -> str:
        """Format state for display."""
        s = state or self._current_state
        if s is None:
            return "No game in progress"

        dealer_card = "A" if s.dealer_card == 1 else str(s.dealer_card)
        ace_info = " (with usable Ace)" if s.usable_ace else ""

        return (
            f"╔═══════════════════════════════╗\n"
            f"║      BLACKJACK TABLE          ║\n"
            f"╠═══════════════════════════════╣\n"
            f"║  Dealer shows: [{dealer_card:>2}]           ║\n"
            f"║  Your hand:    [{s.player_sum:>2}]{ace_info:<11}║\n"
            f"╚═══════════════════════════════╝"
        )
