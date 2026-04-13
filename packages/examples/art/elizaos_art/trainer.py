"""
GRPO Trainer for ART-based reinforcement learning.

Implements the full training pipeline:
1. Rollout - Generate trajectories
2. RULER Score - Use LLM judge to rank
3. GRPO Train - Update model weights
4. Checkpoint - Save state
"""

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Generic, TypeVar

import art
import art.local
from art.rewards import ruler_score_group
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn

from elizaos_art.base import (
    Action,
    BaseAgent,
    BaseEnvironment,
    EpisodeResult,
    State,
    TrainingConfig,
    TrainingMetrics,
    Trajectory,
)

console = Console()

S = TypeVar("S", bound=State)
A = TypeVar("A", bound=Action)


@dataclass
class RolloutResult(Generic[S]):
    """Result of a rollout including trajectory data."""

    episode: EpisodeResult[S]
    trajectory: Trajectory
    messages: list[dict]


class RulerScorer:
    """RULER-based trajectory scoring using LLM-as-judge."""

    def __init__(
        self,
        judge_model: str = "openai/gpt-5-mini",
        temperature: float = 0.0,
        extra_params: dict | None = None,
    ):
        self.judge_model = judge_model
        self.temperature = temperature
        self.extra_params = extra_params or {}

    async def score_group(
        self,
        group: art.TrajectoryGroup,
        debug: bool = False,
    ) -> art.TrajectoryGroup:
        """
        Score a trajectory group using RULER.

        Args:
            group: TrajectoryGroup to score
            debug: Whether to print debug info

        Returns:
            Scored TrajectoryGroup with rankings
        """
        return await ruler_score_group(
            group,
            judge_model=self.judge_model,
            debug=debug,
            swallow_exceptions=True,
            extra_litellm_params={
                "temperature": self.temperature,
                **self.extra_params,
            },
        )


@dataclass
class TrainingState:
    """Persistent training state for checkpointing."""

    step: int = 0
    total_trajectories: int = 0
    best_reward: float = float("-inf")
    model_name: str = ""
    metrics_history: list[dict] = field(default_factory=list)

    def save(self, path: Path) -> None:
        """Save training state to file."""
        with open(path, "w") as f:
            json.dump(
                {
                    "step": self.step,
                    "total_trajectories": self.total_trajectories,
                    "best_reward": self.best_reward,
                    "model_name": self.model_name,
                    "metrics_history": self.metrics_history,
                },
                f,
                indent=2,
            )

    @classmethod
    def load(cls, path: Path) -> "TrainingState":
        """Load training state from file."""
        with open(path) as f:
            data = json.load(f)
        state = cls()
        state.step = data["step"]
        state.total_trajectories = data["total_trajectories"]
        state.best_reward = data["best_reward"]
        state.model_name = data.get("model_name", "")
        state.metrics_history = data["metrics_history"]
        return state


class GRPOTrainer(Generic[S, A]):
    """
    GRPO (Group Relative Policy Optimization) Trainer.

    Implements continuous RL training for LLM agents using the ART framework.
    """

    def __init__(
        self,
        env: BaseEnvironment[S, A],
        agent: BaseAgent[S, A],
        config: TrainingConfig | None = None,
    ):
        self.env = env
        self.agent = agent
        self.config = config or TrainingConfig()

        # Initialize ART model
        self.model: art.Model | None = None
        self.scorer = RulerScorer(
            judge_model=self.config.judge_model,
            temperature=self.config.judge_temperature,
        )

        # Training state
        self.state = TrainingState()
        self.start_time: float = 0

        # Paths
        self.checkpoint_dir = Path(self.config.checkpoint_dir) / self.env.name
        self.results_dir = Path("results") / self.env.name

    async def initialize(self) -> None:
        """Initialize the trainer and load any checkpoints."""
        await self.env.initialize()

        # Create directories
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)
        self.results_dir.mkdir(parents=True, exist_ok=True)

        # Initialize ART model
        self.model = art.TrainableModel(
            name=self.config.model_name,
            base_model=self.config.model_name,
            project=f"elizaos-art-{self.env.name}",
        )

        # Register with backend

        # Use LocalBackend for vLLM (default)
        if self.config.backend == "vllm":
            backend = art.local.LocalBackend()
        else:
            # Fallback or TODO for HFBackend if it differs
            console.print("[yellow]Warning: HFBackend not found, using LocalBackend[/yellow]")
            backend = art.local.LocalBackend()

        await self.model.register(backend)

        # Log inference server info if available (set by register())
        if self.model.inference_base_url:
            console.print(f"[green]Inference server available at {self.model.inference_base_url}[/green]")

        # Load checkpoint if resuming
        if self.config.resume_from:
            await self._load_checkpoint(self.config.resume_from)
        else:
            # Check for existing checkpoint
            state_path = self.checkpoint_dir / "training_state.json"
            if state_path.exists():
                self.state = TrainingState.load(state_path)
                console.print(f"[yellow]Resuming from step {self.state.step}[/yellow]")

    async def rollout(
        self,
        scenario_id: str,
        seed: int | None = None,
    ) -> Trajectory:
        """
        Execute a single rollout and collect trajectory.

        Args:
            scenario_id: Identifier for grouping trajectories
            seed: Random seed

        Returns:
            Trajectory with messages and reward
        """
        messages: list[dict] = []

        # Add system prompt
        system_prompt = self.agent.get_system_prompt()
        messages.append({"role": "system", "content": system_prompt})

        # Play episode
        state = await self.env.reset(seed)
        total_reward = 0.0
        done = False

        while not done:
            available_actions = self.env.get_available_actions(state)
            if not available_actions:
                break

            # Get action from agent
            user_prompt = self.agent.format_action_prompt(state, available_actions)
            messages.append({"role": "user", "content": user_prompt})

            # Get model response
            response = await self._get_model_response(messages)
            messages.append({"role": "assistant", "content": response})

            # Parse and execute action
            action = self.agent.parse_action(response, available_actions)
            state, reward, done = await self.env.step(action)
            total_reward += reward

        # Create trajectory
        return Trajectory(
            trajectory_id=f"{scenario_id}-{time.time_ns()}",
            scenario_id=scenario_id,
            messages=messages,
            reward=total_reward,
            metadata={
                "env": self.env.name,
                "model": self.config.model_name,
                "seed": seed,
            },
            metrics={
                "total_reward": total_reward,
                "num_turns": len([m for m in messages if m["role"] == "assistant"]),
            },
        )

    async def _get_model_response(self, messages: list[dict]) -> str:
        """Get response from the model."""
        if self.model is None:
            raise RuntimeError("Trainer not initialized")

        # Use ART's chat completion via OpenAI client
        client = self.model.openai_client()
        response = await client.chat.completions.create(
            model=self.model.name,
            messages=messages,
            temperature=0.7,  # Default temp
        )
        return response.choices[0].message.content or ""

    async def gather_trajectory_groups(
        self,
        num_groups: int,
        rollouts_per_group: int,
    ) -> list[art.TrajectoryGroup]:
        """
        Gather multiple trajectory groups for training.

        Args:
            num_groups: Number of scenario groups
            rollouts_per_group: Number of rollouts per scenario

        Returns:
            List of TrajectoryGroup objects
        """
        groups = []

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task(
                f"Gathering {num_groups} groups...",
                total=num_groups,
            )

            for i in range(num_groups):
                scenario_id = f"scenario-{self.state.step}-{i}"
                trajectories = []

                for j in range(rollouts_per_group):
                    traj = await self.rollout(
                        scenario_id=scenario_id,
                        seed=self.state.step * 1000 + i * 100 + j,
                    )
                    trajectories.append(art.Trajectory(
                        messages=traj.messages,
                        reward=traj.reward,
                        metadata=traj.metadata,
                    ))

                groups.append(art.TrajectoryGroup(trajectories))
                progress.update(task, advance=1)

        return groups

    async def train_step(self) -> TrainingMetrics:
        """
        Execute a single training step.

        Returns:
            Training metrics for this step
        """
        step_start = time.time()

        # 1. Gather trajectory groups
        console.print(f"\n[bold blue]Step {self.state.step + 1}[/bold blue]")
        console.print("Gathering trajectories...")

        groups = await self.gather_trajectory_groups(
            num_groups=self.config.groups_per_step,
            rollouts_per_group=self.config.rollouts_per_group,
        )

        # 2. Score with RULER
        console.print("Scoring with RULER...")
        scored_groups = []
        for group in groups:
            scored = await self.scorer.score_group(group, debug=False)
            scored_groups.append(scored)

        # 3. Train with GRPO
        # TODO: Using private _train_model API - monitor art library for public alternative
        console.print("Training...")
        if self.model is not None:
            async for _ in self.model.backend._train_model(
                self.model,
                scored_groups,
                config=art.TrainConfig(learning_rate=self.config.learning_rate),
                dev_config={},
                verbose=False
            ):
                pass

        # Calculate metrics
        all_rewards = [t.reward for g in groups for t in g.trajectories]
        avg_reward = sum(all_rewards) / len(all_rewards) if all_rewards else 0
        max_reward = max(all_rewards) if all_rewards else 0
        wins = sum(1 for r in all_rewards if r > 0)
        win_rate = wins / len(all_rewards) if all_rewards else 0

        # Update state
        self.state.step += 1
        self.state.total_trajectories += len(all_rewards)
        if max_reward > self.state.best_reward:
            self.state.best_reward = max_reward

        metrics = TrainingMetrics(
            step=self.state.step,
            total_episodes=len(all_rewards),
            total_trajectories=self.state.total_trajectories,
            avg_reward=avg_reward,
            max_reward=max_reward,
            win_rate=win_rate,
            learning_rate=self.config.learning_rate,
            elapsed_time_seconds=time.time() - step_start,
        )

        self.state.metrics_history.append(metrics.to_dict())

        # Print progress
        console.print(
            f"  Avg Reward: [green]{avg_reward:.2f}[/green] | "
            f"Max: [cyan]{max_reward:.2f}[/cyan] | "
            f"Win Rate: [yellow]{win_rate:.1%}[/yellow]"
        )

        # Checkpoint
        if self.state.step % self.config.save_every == 0:
            await self._save_checkpoint()

        return metrics

    async def train(self, num_steps: int | None = None) -> list[TrainingMetrics]:
        """
        Run the full training loop.

        Args:
            num_steps: Number of steps to train (defaults to config)

        Returns:
            List of training metrics per step
        """
        self.start_time = time.time()
        steps = num_steps or self.config.max_steps
        metrics_list: list[TrainingMetrics] = []

        console.print(f"\n[bold]Starting GRPO Training[/bold]")
        console.print(f"  Model: {self.config.model_name}")
        console.print(f"  Environment: {self.env.name}")
        console.print(f"  Steps: {steps}")
        console.print(f"  Rollouts/group: {self.config.rollouts_per_group}")
        console.print(f"  Groups/step: {self.config.groups_per_step}")

        try:
            for _ in range(steps):
                metrics = await self.train_step()
                metrics_list.append(metrics)

                # Save trajectory log
                self._log_trajectories(metrics)

        except KeyboardInterrupt:
            console.print("\n[yellow]Training interrupted. Saving checkpoint...[/yellow]")

        finally:
            await self._save_checkpoint()
            await self._save_final_report(metrics_list)

        return metrics_list

    async def evaluate(
        self,
        num_episodes: int | None = None,
        checkpoint: str | None = None,
    ) -> dict:
        """
        Evaluate the current or specified model.

        Args:
            num_episodes: Number of evaluation episodes
            checkpoint: Optional checkpoint to load

        Returns:
            Evaluation metrics dictionary
        """
        episodes = num_episodes or self.config.eval_episodes

        if checkpoint:
            await self._load_checkpoint(checkpoint)

        console.print(f"\n[bold]Evaluating on {episodes} episodes[/bold]")

        rewards = []
        wins = 0

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Evaluating...", total=episodes)

            for i in range(episodes):
                traj = await self.rollout(f"eval-{i}", seed=i)
                rewards.append(traj.reward)
                if traj.reward > 0:
                    wins += 1
                progress.update(task, advance=1)

        results = {
            "episodes": episodes,
            "avg_reward": sum(rewards) / len(rewards),
            "max_reward": max(rewards),
            "min_reward": min(rewards),
            "win_rate": wins / episodes,
            "wins": wins,
        }

        console.print(f"\n[bold]Evaluation Results[/bold]")
        console.print(f"  Avg Reward: [green]{results['avg_reward']:.2f}[/green]")
        console.print(f"  Max Reward: [cyan]{results['max_reward']:.2f}[/cyan]")
        console.print(f"  Win Rate: [yellow]{results['win_rate']:.1%}[/yellow]")

        return results

    async def pipeline(
        self,
        num_steps: int | None = None,
        eval_episodes: int | None = None,
    ) -> dict:
        """
        Run the full training pipeline:
        1. Baseline evaluation
        2. Training
        3. Final evaluation
        4. Comparison report

        Args:
            num_steps: Training steps
            eval_episodes: Evaluation episodes

        Returns:
            Complete pipeline results
        """
        await self.initialize()

        steps = num_steps or self.config.max_steps
        episodes = eval_episodes or self.config.eval_episodes

        console.print("\n[bold cyan]═══ ART Training Pipeline ═══[/bold cyan]")
        console.print(f"Environment: {self.env.name}")
        console.print(f"Model: {self.config.model_name}")

        # 1. Baseline
        console.print("\n[bold]Phase 1: Baseline Evaluation[/bold]")
        baseline = await self.evaluate(episodes)

        # 2. Training
        console.print("\n[bold]Phase 2: GRPO Training[/bold]")
        training_metrics = await self.train(steps)

        # 3. Final evaluation
        console.print("\n[bold]Phase 3: Final Evaluation[/bold]")
        final = await self.evaluate(episodes)

        # 4. Generate report
        results = {
            "baseline": baseline,
            "training": [m.to_dict() for m in training_metrics],
            "final": final,
            "improvement": {
                "avg_reward": final["avg_reward"] - baseline["avg_reward"],
                "avg_reward_pct": (
                    (final["avg_reward"] - baseline["avg_reward"]) / max(abs(baseline["avg_reward"]), 1)
                    * 100
                ),
                "win_rate": final["win_rate"] - baseline["win_rate"],
            },
        }

        await self._generate_report(results)

        return results

    async def _save_checkpoint(self) -> None:
        """Save current training state and model checkpoint."""
        # Save training state
        state_path = self.checkpoint_dir / "training_state.json"
        self.state.save(state_path)

        # Save model checkpoint
        if self.model is not None:
            step_dir = self.checkpoint_dir / f"step_{self.state.step}"
            step_dir.mkdir(exist_ok=True)
            # Model checkpointing handled by ART

        console.print(f"[dim]Checkpoint saved at step {self.state.step}[/dim]")

    async def _load_checkpoint(self, checkpoint_path: str) -> None:
        """Load training state and model from checkpoint."""
        path = Path(checkpoint_path)
        if path.is_dir():
            state_path = path / "training_state.json"
        else:
            state_path = path

        if state_path.exists():
            self.state = TrainingState.load(state_path)
            console.print(f"[green]Loaded checkpoint from step {self.state.step}[/green]")

    def _log_trajectories(self, metrics: TrainingMetrics) -> None:
        """Log training trajectories to file."""
        log_path = self.results_dir / "training_log.jsonl"
        with open(log_path, "a") as f:
            f.write(json.dumps(metrics.to_dict()) + "\n")

    async def _save_final_report(self, metrics: list[TrainingMetrics]) -> None:
        """Save final training report."""
        report_path = self.results_dir / "training_summary.json"
        with open(report_path, "w") as f:
            json.dump(
                {
                    "env": self.env.name,
                    "model": self.config.model_name,
                    "total_steps": self.state.step,
                    "total_trajectories": self.state.total_trajectories,
                    "best_reward": self.state.best_reward,
                    "final_metrics": metrics[-1].to_dict() if metrics else {},
                    "config": {
                        "learning_rate": self.config.learning_rate,
                        "rollouts_per_group": self.config.rollouts_per_group,
                        "groups_per_step": self.config.groups_per_step,
                    },
                },
                f,
                indent=2,
            )

    async def _generate_report(self, results: dict) -> None:
        """Generate markdown comparison report."""
        report_path = self.results_dir / "benchmark_report.md"

        baseline = results["baseline"]
        final = results["final"]
        improvement = results["improvement"]

        report = f"""# {self.env.name} Training Results

## Summary

| Metric | Vanilla | Trained | Improvement |
|--------|---------|---------|-------------|
| Avg Reward | {baseline['avg_reward']:.2f} | {final['avg_reward']:.2f} | {improvement['avg_reward']:+.2f} ({improvement['avg_reward_pct']:+.1f}%) |
| Max Reward | {baseline['max_reward']:.2f} | {final['max_reward']:.2f} | - |
| Win Rate | {baseline['win_rate']:.1%} | {final['win_rate']:.1%} | {improvement['win_rate']:+.1%} |

## Configuration

- **Model**: {self.config.model_name}
- **Learning Rate**: {self.config.learning_rate}
- **Training Steps**: {self.state.step}
- **Rollouts/Group**: {self.config.rollouts_per_group}
- **Groups/Step**: {self.config.groups_per_step}
- **Judge Model**: {self.config.judge_model}

## Training Progress

Total Trajectories: {self.state.total_trajectories}
Best Reward Achieved: {self.state.best_reward:.2f}
"""

        with open(report_path, "w") as f:
            f.write(report)

        console.print(f"\n[green]Report saved to {report_path}[/green]")
