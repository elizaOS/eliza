"""
Base classes for ART environments and agents.

Provides abstract interfaces that all games must implement.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Generic, TypeVar

# Type variables for state and action
S = TypeVar("S", bound="State")
A = TypeVar("A", bound="Action")


class State(ABC):
    """Abstract base class for game states."""

    @abstractmethod
    def to_prompt(self) -> str:
        """Convert state to a prompt string for the LLM."""
        ...

    @abstractmethod
    def to_dict(self) -> dict:
        """Convert state to a dictionary for serialization."""
        ...

    @abstractmethod
    def is_terminal(self) -> bool:
        """Check if this is a terminal state."""
        ...


class Action(IntEnum):
    """Base class for discrete actions."""

    pass


@dataclass(frozen=True)
class EpisodeResult(Generic[S]):
    """Result of a completed episode."""

    final_state: S
    reward: float
    num_steps: int
    won: bool
    metadata: dict = field(default_factory=dict)

    @property
    def is_draw(self) -> bool:
        """Check if the episode ended in a draw."""
        return not self.won and self.reward == 0.0


@dataclass
class TrainingConfig:
    """Configuration for GRPO training."""

    # Model settings
    model_name: str = "meta-llama/Llama-3.2-3B-Instruct"
    backend: str = "vllm"  # "vllm" or "huggingface"

    # Training hyperparameters
    learning_rate: float = 1e-5
    rollouts_per_group: int = 8
    groups_per_step: int = 4
    max_steps: int = 100

    # RULER settings
    judge_model: str = "openai/gpt-5-mini"
    judge_temperature: float = 0.0

    # Checkpointing
    checkpoint_dir: str = "./checkpoints"
    save_every: int = 5
    resume_from: str | None = None

    # Evaluation
    eval_episodes: int = 50


@dataclass
class TrainingMetrics:
    """Metrics tracked during training."""

    step: int = 0
    total_episodes: int = 0
    total_trajectories: int = 0

    # Performance metrics
    avg_reward: float = 0.0
    max_reward: float = 0.0
    win_rate: float = 0.0

    # Training metrics
    loss: float = 0.0
    learning_rate: float = 0.0

    # Timing
    elapsed_time_seconds: float = 0.0

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "step": self.step,
            "total_episodes": self.total_episodes,
            "total_trajectories": self.total_trajectories,
            "avg_reward": self.avg_reward,
            "max_reward": self.max_reward,
            "win_rate": self.win_rate,
            "loss": self.loss,
            "learning_rate": self.learning_rate,
            "elapsed_time_seconds": self.elapsed_time_seconds,
        }


class BaseEnvironment(ABC, Generic[S, A]):
    """Abstract base class for game environments."""

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the environment."""
        ...

    @abstractmethod
    async def reset(self, seed: int | None = None) -> S:
        """Reset the environment and return initial state."""
        ...

    @abstractmethod
    async def step(self, action: A) -> tuple[S, float, bool]:
        """
        Execute an action and return (new_state, reward, done).

        Args:
            action: The action to take

        Returns:
            Tuple of (new_state, reward, done)
        """
        ...

    @abstractmethod
    def get_available_actions(self, state: S) -> list[A]:
        """Get list of valid actions for the given state."""
        ...

    @abstractmethod
    def render(self, state: S) -> str:
        """Render the state as a string for display."""
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """Get the environment name."""
        ...

    @property
    @abstractmethod
    def description(self) -> str:
        """Get a description of the game/task."""
        ...

    async def close(self) -> None:
        """Clean up resources."""
        pass

    async def play_episode(
        self,
        policy: "BaseAgent[S, A]",
        seed: int | None = None,
        max_steps: int = 1000,
    ) -> EpisodeResult[S]:
        """
        Play a complete episode using the given policy.

        Args:
            policy: Agent to use for decisions
            seed: Random seed for reproducibility
            max_steps: Maximum steps before termination

        Returns:
            EpisodeResult with final state and metrics
        """
        state = await self.reset(seed)
        total_reward = 0.0
        steps = 0
        won = False

        while steps < max_steps:
            available_actions = self.get_available_actions(state)
            if not available_actions:
                break

            action = await policy.decide(state, available_actions)
            state, reward, done = await self.step(action)
            total_reward += reward
            steps += 1

            if done:
                won = reward > 0
                break

        return EpisodeResult(
            final_state=state,
            reward=total_reward,
            num_steps=steps,
            won=won,
        )


class BaseAgent(ABC, Generic[S, A]):
    """Abstract base class for game agents."""

    @abstractmethod
    async def decide(self, state: S, available_actions: list[A]) -> A:
        """
        Decide which action to take given the current state.

        Args:
            state: Current game state
            available_actions: List of valid actions

        Returns:
            The chosen action
        """
        ...

    @abstractmethod
    def get_system_prompt(self) -> str:
        """Get the system prompt for the LLM."""
        ...

    @abstractmethod
    def format_action_prompt(self, state: S, available_actions: list[A]) -> str:
        """Format the prompt for action selection."""
        ...

    @abstractmethod
    def parse_action(self, response: str, available_actions: list[A]) -> A:
        """Parse the LLM response into an action."""
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """Get the agent name."""
        ...


@dataclass
class Trajectory(Generic[S, A]):
    """A single trajectory (episode) for training."""

    trajectory_id: str
    scenario_id: str
    messages: list[dict]  # OpenAI-format messages
    reward: float
    metadata: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)

    def to_art_format(self) -> dict:
        """Convert to ART-compatible format."""
        return {
            "messages": self.messages,
            "reward": self.reward,
            "metadata": {
                "trajectory_id": self.trajectory_id,
                "scenario_id": self.scenario_id,
                **self.metadata,
            },
            "metrics": self.metrics,
        }
