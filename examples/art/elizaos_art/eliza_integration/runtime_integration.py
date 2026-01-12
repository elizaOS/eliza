"""
Runtime Integration for ElizaOS

Provides a unified runtime that connects:
- ART training pipeline
- ElizaOS trajectory logging
- Local AI model inference
- Local database storage

This enables running ART training within an ElizaOS agent context.
"""

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Generic, TypeVar

from elizaos_art.base import (
    Action,
    BaseAgent,
    BaseEnvironment,
    EpisodeResult,
    State,
    TrainingConfig,
    Trajectory,
)
from elizaos_art.eliza_integration.local_ai_adapter import (
    ElizaLocalAIProvider,
    LocalModelConfig,
    MockLocalAIProvider,
)
from elizaos_art.eliza_integration.storage_adapter import ElizaStorageAdapter
from elizaos_art.eliza_integration.trajectory_adapter import (
    ElizaEnvironmentState,
    ElizaLLMCall,
    ElizaTrajectoryLogger,
)

S = TypeVar("S", bound=State)
A = TypeVar("A", bound=Action)


@dataclass
class ARTRuntimeConfig:
    """Configuration for ART runtime with ElizaOS integration."""

    # Agent identification
    agent_id: str = "art-training-agent"
    agent_name: str = "ART Training Agent"

    # Model configuration
    model_config: LocalModelConfig = field(default_factory=LocalModelConfig)
    use_mock_model: bool = False  # For testing without actual models

    # Storage
    data_dir: str = "./data"

    # Training
    training_config: TrainingConfig = field(default_factory=TrainingConfig)

    # Logging
    log_all_llm_calls: bool = True
    log_to_console: bool = True


class ARTRuntime(Generic[S, A]):
    """
    Unified runtime for ART training with ElizaOS integration.
    
    Connects:
    - Environment (game/task)
    - Agent (LLM-based decision maker)
    - Trajectory Logger (ElizaOS plugin-trajectory-logger)
    - Model Provider (ElizaOS plugin-local-ai)
    - Storage (ElizaOS plugin-localdb)
    """

    def __init__(
        self,
        env: BaseEnvironment[S, A],
        agent: BaseAgent[S, A],
        config: ARTRuntimeConfig | None = None,
    ):
        self.env = env
        self.agent = agent
        self.config = config or ARTRuntimeConfig()

        # Initialize components
        self.storage = ElizaStorageAdapter(self.config.data_dir)
        self.trajectory_logger = ElizaTrajectoryLogger(
            agent_id=self.config.agent_id,
            data_dir=Path(self.config.data_dir) / "trajectories",
        )

        # Model provider
        if self.config.use_mock_model:
            self.model_provider = MockLocalAIProvider()
        else:
            self.model_provider = ElizaLocalAIProvider(self.config.model_config)

        self._initialized = False

    async def initialize(self) -> None:
        """Initialize all components."""
        if self._initialized:
            return

        await self.env.initialize()
        await self.model_provider.initialize()
        self._initialized = True

    async def rollout(
        self,
        scenario_id: str,
        seed: int | None = None,
        max_steps: int = 1000,
    ) -> Trajectory:
        """
        Execute a single rollout with full trajectory logging.
        
        Returns an ART-compatible Trajectory.
        """
        if not self._initialized:
            await self.initialize()

        # Start trajectory
        trajectory_id = self.trajectory_logger.start_trajectory(
            scenario_id=scenario_id,
            metadata={
                "env": self.env.name,
                "agent": self.agent.name,
                "seed": seed,
            },
        )

        messages: list[dict] = []
        total_reward = 0.0
        state = await self.env.reset(seed)
        done = False
        step_count = 0

        # Add system prompt
        system_prompt = self.agent.get_system_prompt()
        messages.append({"role": "system", "content": system_prompt})

        try:
            while not done and step_count < max_steps:
                # Get available actions
                available_actions = self.env.get_available_actions(state)
                if not available_actions:
                    break

                # Create environment state for logging
                env_state = ElizaEnvironmentState(
                    timestamp=int(asyncio.get_event_loop().time() * 1000),
                    custom=state.to_dict() if hasattr(state, "to_dict") else {},
                )

                # Start step
                step_id = self.trajectory_logger.start_step(
                    trajectory_id=trajectory_id,
                    env_state=env_state,
                )

                # Format prompt for agent
                user_prompt = self.agent.format_action_prompt(state, available_actions)
                messages.append({"role": "user", "content": user_prompt})

                # Get model response
                import time

                start_time = time.time()
                response = await self.model_provider.generate_text(
                    prompt=user_prompt,
                    system_prompt=system_prompt,
                    temperature=self.config.training_config.judge_temperature,
                )
                latency_ms = int((time.time() - start_time) * 1000)

                messages.append({"role": "assistant", "content": response})

                # Log LLM call
                if self.config.log_all_llm_calls:
                    self.trajectory_logger.log_llm_call(
                        step_id=step_id,
                        llm_call=ElizaLLMCall(
                            model=self.config.model_config.small_model,
                            system_prompt=system_prompt,
                            user_prompt=user_prompt,
                            response=response,
                            latency_ms=latency_ms,
                            purpose="action",
                        ),
                    )

                # Parse action from response
                action = self.agent.parse_action(response, available_actions)

                # Execute action
                state, reward, done = await self.env.step(action)
                total_reward += reward
                step_count += 1

                # Complete step
                self.trajectory_logger.complete_step(
                    trajectory_id=trajectory_id,
                    step_id=step_id,
                    action_type=str(action),
                    action_name=action.name if hasattr(action, "name") else str(action),
                    parameters={"action_value": int(action)},
                    success=True,
                    reward=reward,
                )

        except Exception as e:
            # End trajectory with error status
            self.trajectory_logger.end_trajectory(
                trajectory_id=trajectory_id,
                status="error",
                final_metrics={"error": str(e)},
            )
            raise

        # End trajectory
        eliza_traj = self.trajectory_logger.end_trajectory(
            trajectory_id=trajectory_id,
            status="completed" if done else "terminated",
            final_metrics={
                "total_reward": total_reward,
                "steps": step_count,
                "final_state": state.to_dict() if hasattr(state, "to_dict") else {},
            },
        )

        # Save to storage
        if eliza_traj:
            await self.storage.save_trajectory(eliza_traj)

        # Return ART-compatible trajectory
        return Trajectory(
            trajectory_id=trajectory_id,
            scenario_id=scenario_id,
            messages=messages,
            reward=total_reward,
            metadata={
                "env": self.env.name,
                "agent": self.agent.name,
                "model": self.config.model_config.small_model,
                "seed": seed,
            },
            metrics={
                "total_reward": total_reward,
                "steps": step_count,
            },
        )

    async def rollout_batch(
        self,
        scenario_id: str,
        num_rollouts: int,
        seeds: list[int] | None = None,
    ) -> list[Trajectory]:
        """Execute multiple rollouts for GRPO training."""
        if seeds is None:
            seeds = list(range(num_rollouts))

        trajectories = []
        for i, seed in enumerate(seeds[:num_rollouts]):
            traj = await self.rollout(
                scenario_id=f"{scenario_id}-{i}",
                seed=seed,
            )
            trajectories.append(traj)

        return trajectories

    async def evaluate(
        self,
        num_episodes: int = 100,
        seed_offset: int = 0,
    ) -> dict:
        """Evaluate current model performance."""
        rewards: list[float] = []
        wins = 0

        for i in range(num_episodes):
            traj = await self.rollout(
                scenario_id=f"eval-{i}",
                seed=seed_offset + i,
            )
            rewards.append(traj.reward)
            if traj.reward > 0:
                wins += 1

        return {
            "episodes": num_episodes,
            "avg_reward": sum(rewards) / len(rewards) if rewards else 0,
            "max_reward": max(rewards) if rewards else 0,
            "min_reward": min(rewards) if rewards else 0,
            "win_rate": wins / num_episodes if num_episodes > 0 else 0,
        }


def create_art_runtime(
    env: BaseEnvironment,
    agent: BaseAgent,
    config: ARTRuntimeConfig | None = None,
) -> ARTRuntime:
    """
    Factory function to create an ART runtime with ElizaOS integration.
    
    Example:
        ```python
        from elizaos_art.games.game_2048 import Game2048Environment, Game2048Agent
        from elizaos_art.eliza_integration import create_art_runtime, ARTRuntimeConfig
        
        env = Game2048Environment()
        agent = Game2048Agent()
        config = ARTRuntimeConfig(
            agent_id="my-2048-trainer",
            use_mock_model=True,  # For testing
        )
        
        runtime = create_art_runtime(env, agent, config)
        await runtime.initialize()
        
        # Run evaluation
        results = await runtime.evaluate(num_episodes=100)
        print(f"Win rate: {results['win_rate']:.1%}")
        
        # Run training rollouts
        trajectories = await runtime.rollout_batch(
            scenario_id="training-batch-1",
            num_rollouts=8,
        )
        ```
    """
    return ARTRuntime(env=env, agent=agent, config=config)
