"""
Unified Benchmark Runner for ART Games

Runs benchmarks across all games and generates comparison reports.
"""

import asyncio
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

from elizaos_art.base import TrainingConfig, TrainingMetrics
from elizaos_art.games.codenames import CodenamesEnvironment
from elizaos_art.games.codenames.agent import CodenamesGuesserAgent, CodenamesRandomAgent
from elizaos_art.games.codenames.types import CodenamesConfig, Role
from elizaos_art.games.game_2048 import Game2048Environment
from elizaos_art.games.game_2048.agent import Game2048HeuristicAgent, Game2048RandomAgent
from elizaos_art.games.temporal_clue import TemporalClueEnvironment
from elizaos_art.games.temporal_clue.agent import TemporalClueGreedyAgent, TemporalClueRandomAgent
from elizaos_art.games.temporal_clue.types import TemporalClueConfig
from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment
from elizaos_art.games.tic_tac_toe.agent import TicTacToeOptimalAgent, TicTacToeRandomAgent
from elizaos_art.games.tic_tac_toe.types import TicTacToeConfig
from elizaos_art.trainer import GRPOTrainer

console = Console()


@dataclass
class BenchmarkResult:
    """Result of a single benchmark run."""

    game: str
    agent: str
    episodes: int
    wins: int
    avg_reward: float
    max_reward: float
    win_rate: float
    elapsed_seconds: float
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "game": self.game,
            "agent": self.agent,
            "episodes": self.episodes,
            "wins": self.wins,
            "avg_reward": self.avg_reward,
            "max_reward": self.max_reward,
            "win_rate": self.win_rate,
            "elapsed_seconds": self.elapsed_seconds,
            "metadata": self.metadata,
        }


@dataclass
class PipelineResult:
    """Result of a full training pipeline."""

    game: str
    model: str
    baseline: dict
    final: dict
    improvement: dict
    training_steps: int
    total_trajectories: int
    elapsed_seconds: float

    def to_dict(self) -> dict:
        return {
            "game": self.game,
            "model": self.model,
            "baseline": self.baseline,
            "final": self.final,
            "improvement": self.improvement,
            "training_steps": self.training_steps,
            "total_trajectories": self.total_trajectories,
            "elapsed_seconds": self.elapsed_seconds,
        }


class BenchmarkRunner:
    """
    Runs benchmarks and training pipelines across all ART games.

    Supports:
    - Baseline benchmarks (random, heuristic agents)
    - Full training pipelines (GRPO)
    - Comparison reports
    """

    def __init__(
        self,
        output_dir: Path | str = "./benchmark_results/art",
        episodes_per_game: int = 100,
    ):
        self.output_dir = Path(output_dir)
        self.episodes_per_game = episodes_per_game
        self.results: list[BenchmarkResult] = []
        self.pipeline_results: list[PipelineResult] = []

    async def run_all_baselines(self) -> list[BenchmarkResult]:
        """Run baseline benchmarks for all games."""
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.results = []

        console.print("\n[bold cyan]═══ ART Baseline Benchmarks ═══[/bold cyan]\n")

        # 2048
        await self._benchmark_2048()

        # Tic-Tac-Toe
        await self._benchmark_tictactoe()

        # Codenames
        await self._benchmark_codenames()

        # Temporal Clue
        await self._benchmark_temporal()

        # Save results
        self._save_results()
        self._print_summary()

        return self.results

    async def run_all_pipelines(
        self,
        model: str = "meta-llama/Llama-3.2-3B-Instruct",
        steps: int = 50,
        eval_episodes: int = 50,
    ) -> list[PipelineResult]:
        """Run training pipelines for all games."""
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.pipeline_results = []

        console.print("\n[bold cyan]═══ ART Training Pipelines ═══[/bold cyan]\n")
        console.print(f"Model: {model}")
        console.print(f"Training steps: {steps}")
        console.print(f"Evaluation episodes: {eval_episodes}\n")

        games = ["game_2048", "tic_tac_toe", "codenames", "temporal_clue"]

        for game in games:
            console.print(f"\n[bold]Training {game}...[/bold]")
            try:
                result = await self._run_pipeline(game, model, steps, eval_episodes)
                self.pipeline_results.append(result)
            except Exception as e:
                console.print(f"[red]Error training {game}: {e}[/red]")

        # Save and report
        self._save_pipeline_results()
        self._print_pipeline_summary()

        return self.pipeline_results

    async def _benchmark_2048(self) -> None:
        """Benchmark 2048 strategies."""
        console.print("[cyan]Benchmarking 2048...[/cyan]")

        env = Game2048Environment()
        await env.initialize()

        agents = [
            ("Random", Game2048RandomAgent()),
            ("Heuristic", Game2048HeuristicAgent()),
        ]

        for name, agent in agents:
            result = await self._run_benchmark(env, agent, "2048", name)
            self.results.append(result)

    async def _benchmark_tictactoe(self) -> None:
        """Benchmark Tic-Tac-Toe strategies."""
        console.print("[cyan]Benchmarking Tic-Tac-Toe...[/cyan]")

        config = TicTacToeConfig(opponent_type="random")
        env = TicTacToeEnvironment(config)
        await env.initialize()

        agents = [
            ("Random", TicTacToeRandomAgent()),
            ("Optimal", TicTacToeOptimalAgent()),
        ]

        for name, agent in agents:
            result = await self._run_benchmark(env, agent, "Tic-Tac-Toe", name)
            self.results.append(result)

    async def _benchmark_codenames(self) -> None:
        """Benchmark Codenames strategies."""
        console.print("[cyan]Benchmarking Codenames...[/cyan]")

        config = CodenamesConfig(train_role=Role.GUESSER)
        env = CodenamesEnvironment(config)
        await env.initialize()

        agents = [
            ("Random", CodenamesRandomAgent()),
            ("Heuristic", CodenamesGuesserAgent()),
        ]

        for name, agent in agents:
            result = await self._run_benchmark(env, agent, "Codenames", name)
            self.results.append(result)

    async def _benchmark_temporal(self) -> None:
        """Benchmark Temporal Clue strategies."""
        console.print("[cyan]Benchmarking Temporal Clue...[/cyan]")

        config = TemporalClueConfig()
        env = TemporalClueEnvironment(config)
        await env.initialize()

        agents = [
            ("Random", TemporalClueRandomAgent()),
            ("Greedy", TemporalClueGreedyAgent()),
        ]

        for name, agent in agents:
            result = await self._run_benchmark(env, agent, "Temporal Clue", name)
            self.results.append(result)

    async def _run_benchmark(
        self,
        env,
        agent,
        game_name: str,
        agent_name: str,
    ) -> BenchmarkResult:
        """Run benchmark for a single agent."""
        import time

        start_time = time.time()
        rewards: list[float] = []
        wins = 0

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
            transient=True,
        ) as progress:
            task = progress.add_task(f"{game_name}/{agent_name}", total=self.episodes_per_game)

            for ep in range(self.episodes_per_game):
                state = await env.reset(seed=ep)
                ep_reward = 0.0

                while not state.is_terminal():
                    actions = env.get_available_actions(state)
                    if not actions:
                        break
                    action = await agent.decide(state, actions)
                    state, reward, done = await env.step(action)
                    ep_reward += reward

                rewards.append(ep_reward)
                if ep_reward > 0:
                    wins += 1

                progress.update(task, advance=1)

        elapsed = time.time() - start_time
        avg_reward = sum(rewards) / len(rewards)
        max_reward = max(rewards)
        win_rate = wins / self.episodes_per_game

        console.print(
            f"  {agent_name}: Avg={avg_reward:.2f}, Max={max_reward:.2f}, "
            f"WinRate={win_rate:.1%}"
        )

        return BenchmarkResult(
            game=game_name,
            agent=agent_name,
            episodes=self.episodes_per_game,
            wins=wins,
            avg_reward=avg_reward,
            max_reward=max_reward,
            win_rate=win_rate,
            elapsed_seconds=elapsed,
        )

    async def _run_pipeline(
        self,
        game: str,
        model: str,
        steps: int,
        eval_episodes: int,
    ) -> PipelineResult:
        """Run training pipeline for a game."""
        import time

        start_time = time.time()

        # Create environment and agent based on game
        if game == "game_2048":
            from elizaos_art.games.game_2048 import Game2048Agent, Game2048Environment

            env = Game2048Environment()
            agent = Game2048Agent(model_name=model)
        elif game == "tic_tac_toe":
            from elizaos_art.games.tic_tac_toe import TicTacToeAgent, TicTacToeEnvironment
            from elizaos_art.games.tic_tac_toe.types import TicTacToeConfig

            env = TicTacToeEnvironment(TicTacToeConfig())
            agent = TicTacToeAgent(model_name=model)
        elif game == "codenames":
            from elizaos_art.games.codenames import CodenamesEnvironment
            from elizaos_art.games.codenames.agent import CodenamesGuesserAgent
            from elizaos_art.games.codenames.types import CodenamesConfig, Role

            env = CodenamesEnvironment(CodenamesConfig(train_role=Role.GUESSER))
            agent = CodenamesGuesserAgent(model_name=model)
        elif game == "temporal_clue":
            from elizaos_art.games.temporal_clue import TemporalClueAgent, TemporalClueEnvironment

            env = TemporalClueEnvironment()
            agent = TemporalClueAgent(model_name=model)
        else:
            raise ValueError(f"Unknown game: {game}")

        config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            eval_episodes=eval_episodes,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=config)
        results = await trainer.pipeline(steps, eval_episodes)

        elapsed = time.time() - start_time

        return PipelineResult(
            game=game,
            model=model,
            baseline=results["baseline"],
            final=results["final"],
            improvement=results["improvement"],
            training_steps=steps,
            total_trajectories=trainer.state.total_trajectories,
            elapsed_seconds=elapsed,
        )

    def _save_results(self) -> None:
        """Save benchmark results to file."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        results_file = self.output_dir / f"baseline_results_{timestamp}.json"

        with open(results_file, "w") as f:
            json.dump([r.to_dict() for r in self.results], f, indent=2)

        console.print(f"\n[dim]Results saved to {results_file}[/dim]")

    def _save_pipeline_results(self) -> None:
        """Save pipeline results to file."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        results_file = self.output_dir / f"pipeline_results_{timestamp}.json"

        with open(results_file, "w") as f:
            json.dump([r.to_dict() for r in self.pipeline_results], f, indent=2)

        console.print(f"\n[dim]Results saved to {results_file}[/dim]")

    def _print_summary(self) -> None:
        """Print benchmark summary table."""
        table = Table(title="ART Baseline Benchmark Results")
        table.add_column("Game")
        table.add_column("Agent")
        table.add_column("Avg Reward", justify="right")
        table.add_column("Max Reward", justify="right")
        table.add_column("Win Rate", justify="right")

        for r in self.results:
            table.add_row(
                r.game,
                r.agent,
                f"{r.avg_reward:.2f}",
                f"{r.max_reward:.2f}",
                f"{r.win_rate:.1%}",
            )

        console.print("\n")
        console.print(table)

    def _print_pipeline_summary(self) -> None:
        """Print pipeline summary table."""
        table = Table(title="ART Training Pipeline Results")
        table.add_column("Game")
        table.add_column("Baseline", justify="right")
        table.add_column("Trained", justify="right")
        table.add_column("Improvement", justify="right")
        table.add_column("Time")

        for r in self.pipeline_results:
            table.add_row(
                r.game,
                f"{r.baseline.get('avg_reward', 0):.2f}",
                f"{r.final.get('avg_reward', 0):.2f}",
                f"{r.improvement.get('avg_reward_pct', 0):+.1f}%",
                f"{r.elapsed_seconds / 60:.1f}m",
            )

        console.print("\n")
        console.print(table)


async def run_baselines(
    episodes: int = 100,
    output_dir: str = "./benchmark_results/art",
) -> list[BenchmarkResult]:
    """Run baseline benchmarks for all games."""
    runner = BenchmarkRunner(output_dir=output_dir, episodes_per_game=episodes)
    return await runner.run_all_baselines()


async def run_pipelines(
    model: str = "meta-llama/Llama-3.2-3B-Instruct",
    steps: int = 50,
    eval_episodes: int = 50,
    output_dir: str = "./benchmark_results/art",
) -> list[PipelineResult]:
    """Run training pipelines for all games."""
    runner = BenchmarkRunner(output_dir=output_dir)
    return await runner.run_all_pipelines(model, steps, eval_episodes)
