"""
Unified Benchmark Runner for ART Games

Runs baseline benchmarks and full training pipelines
across all games with consistent reporting.
"""

import asyncio
import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

console = Console()


@dataclass
class BenchmarkResult:
    """Result of a single benchmark run."""

    game: str
    agent_type: str
    episodes: int
    wins: int
    losses: int
    draws: int
    avg_reward: float
    max_reward: float
    min_reward: float
    duration_seconds: float

    @property
    def win_rate(self) -> float:
        return self.wins / self.episodes if self.episodes > 0 else 0.0

    def to_dict(self) -> dict:
        return {
            "game": self.game,
            "agent_type": self.agent_type,
            "episodes": self.episodes,
            "wins": self.wins,
            "losses": self.losses,
            "draws": self.draws,
            "win_rate": self.win_rate,
            "avg_reward": self.avg_reward,
            "max_reward": self.max_reward,
            "min_reward": self.min_reward,
            "duration_seconds": self.duration_seconds,
        }


@dataclass
class PipelineResult:
    """Result of a full training pipeline."""

    game: str
    model: str
    baseline: BenchmarkResult
    final: BenchmarkResult
    training_steps: int
    training_trajectories: int
    training_duration_seconds: float
    improvement_pct: float


async def run_game_baseline(
    game_name: str,
    episodes: int = 100,
) -> BenchmarkResult:
    """Run baseline benchmark for a single game."""
    start_time = time.time()

    rewards: list[float] = []
    wins = 0
    losses = 0
    draws = 0

    if game_name == "game_2048":
        from elizaos_art.games.game_2048 import Game2048Environment, Game2048HeuristicAgent

        env = Game2048Environment()
        agent = Game2048HeuristicAgent()
        await env.initialize()

        for i in range(episodes):
            state = await env.reset(seed=i)
            total_reward = 0.0

            while not state.game_over:
                actions = env.get_available_actions(state)
                if not actions:
                    break
                action = await agent.decide(state, actions)
                state, reward, _ = await env.step(action)
                total_reward += reward

            rewards.append(total_reward)
            if state.max_tile >= 2048:
                wins += 1
            elif state.max_tile >= 1024:
                draws += 1
            else:
                losses += 1

    elif game_name == "tic_tac_toe":
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment, TicTacToeHeuristicAgent
        from elizaos_art.games.tic_tac_toe.types import TicTacToeConfig

        config = TicTacToeConfig(opponent="random")
        env = TicTacToeEnvironment(config)
        agent = TicTacToeHeuristicAgent()
        await env.initialize()

        for i in range(episodes):
            state = await env.reset(seed=i)
            total_reward = 0.0

            while not state.is_terminal():
                actions = env.get_available_actions(state)
                if not actions:
                    break
                action = await agent.decide(state, actions)
                state, reward, _ = await env.step(action)
                total_reward += reward

            rewards.append(total_reward)
            if state.winner and state.winner.value == 1:  # X wins
                wins += 1
            elif state.winner:
                losses += 1
            else:
                draws += 1

    elif game_name == "codenames":
        from elizaos_art.games.codenames import CodenamesEnvironment, CodenamesGuesserAgent
        from elizaos_art.games.codenames.types import CardColor, CodenamesConfig, Role

        config = CodenamesConfig(ai_role=Role.GUESSER, ai_team=CardColor.RED)
        env = CodenamesEnvironment(config)
        agent = CodenamesGuesserAgent()
        await env.initialize()

        for i in range(episodes):
            state = await env.reset(seed=i)
            total_reward = 0.0

            while not state.game_over:
                actions = env.get_available_actions(state)
                if not actions:
                    break

                if state.current_team == config.ai_team:
                    action = await agent.decide(state, actions)
                    state, reward, _ = await env.step(action)
                    total_reward += reward
                else:
                    # Opponent turn
                    for a in actions:
                        if a.value < 25:  # Select word
                            state, _, _ = await env.step(a)
                            break
                    else:
                        from elizaos_art.games.codenames.types import CodenamesAction

                        state, _, _ = await env.step(CodenamesAction.PASS)

            rewards.append(total_reward)
            if state.winner == config.ai_team:
                wins += 1
            else:
                losses += 1

    elif game_name == "temporal_clue":
        from elizaos_art.games.temporal_clue import (
            TemporalClueEnvironment,
            TemporalClueHeuristicAgent,
        )

        env = TemporalClueEnvironment()
        agent = TemporalClueHeuristicAgent()
        await env.initialize()

        for i in range(episodes):
            state = await env.reset(seed=i)
            total_reward = 0.0

            while not state.submitted:
                actions = env.get_available_actions(state)
                if not actions:
                    break
                action = await agent.decide(state, actions)
                state, reward, _ = await env.step(action)
                total_reward += reward

            rewards.append(total_reward)
            if state.is_correct:
                wins += 1
            else:
                losses += 1

    else:
        raise ValueError(f"Unknown game: {game_name}")

    duration = time.time() - start_time

    return BenchmarkResult(
        game=game_name,
        agent_type="heuristic",
        episodes=episodes,
        wins=wins,
        losses=losses,
        draws=draws,
        avg_reward=sum(rewards) / len(rewards) if rewards else 0,
        max_reward=max(rewards) if rewards else 0,
        min_reward=min(rewards) if rewards else 0,
        duration_seconds=duration,
    )


async def run_baselines(
    episodes: int = 100,
    output_dir: str = "./benchmark_results/art",
) -> dict[str, BenchmarkResult]:
    """Run baseline benchmarks for all games."""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    games = ["game_2048", "tic_tac_toe", "codenames", "temporal_clue"]
    results: dict[str, BenchmarkResult] = {}

    console.print("\n[bold cyan]═══ ART Baseline Benchmarks ═══[/bold cyan]\n")

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        for game in games:
            task = progress.add_task(f"Benchmarking {game}...", total=1)
            result = await run_game_baseline(game, episodes)
            results[game] = result
            progress.update(task, completed=1)
            console.print(f"  {game}: {result.win_rate:.1%} win rate, {result.avg_reward:.1f} avg reward")

    # Display summary table
    table = Table(title="Baseline Benchmark Results")
    table.add_column("Game")
    table.add_column("Win Rate", justify="right")
    table.add_column("Avg Reward", justify="right")
    table.add_column("Episodes", justify="right")
    table.add_column("Duration", justify="right")

    for game, result in results.items():
        table.add_row(
            game,
            f"{result.win_rate:.1%}",
            f"{result.avg_reward:.1f}",
            str(result.episodes),
            f"{result.duration_seconds:.1f}s",
        )

    console.print("\n")
    console.print(table)

    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = output_path / f"baselines_{timestamp}.json"
    with open(results_file, "w") as f:
        json.dump({g: r.to_dict() for g, r in results.items()}, f, indent=2)

    console.print(f"\n[green]Results saved to {results_file}[/green]")

    return results


async def run_pipelines(
    model: str = "meta-llama/Llama-3.2-3B-Instruct",
    steps: int = 50,
    eval_episodes: int = 50,
    output_dir: str = "./benchmark_results/art",
) -> dict[str, PipelineResult]:
    """Run full training pipelines for all games."""
    from elizaos_art.base import TrainingConfig
    from elizaos_art.trainer import GRPOTrainer

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    console.print("\n[bold cyan]═══ ART Training Pipelines ═══[/bold cyan]")
    console.print(f"Model: {model}")
    console.print(f"Steps: {steps}")
    console.print(f"Eval episodes: {eval_episodes}\n")

    results: dict[str, PipelineResult] = {}

    games_configs = [
        ("game_2048", None),
        ("tic_tac_toe", None),
        ("codenames", None),
        ("temporal_clue", None),
    ]

    for game_name, _ in games_configs:
        console.print(f"\n[bold blue]Training {game_name}...[/bold blue]")

        try:
            # Get environment and agent
            if game_name == "game_2048":
                from elizaos_art.games.game_2048 import Game2048Agent, Game2048Environment

                env = Game2048Environment()
                agent = Game2048Agent(model_name=model)

            elif game_name == "tic_tac_toe":
                from elizaos_art.games.tic_tac_toe import TicTacToeAgent, TicTacToeEnvironment

                env = TicTacToeEnvironment()
                agent = TicTacToeAgent(model_name=model)

            elif game_name == "codenames":
                from elizaos_art.games.codenames import CodenamesAgent, CodenamesEnvironment

                env = CodenamesEnvironment()
                agent = CodenamesAgent(model_name=model)

            elif game_name == "temporal_clue":
                from elizaos_art.games.temporal_clue import (
                    TemporalClueAgent,
                    TemporalClueEnvironment,
                )

                env = TemporalClueEnvironment()
                agent = TemporalClueAgent(model_name=model)

            else:
                continue

            config = TrainingConfig(
                model_name=model,
                max_steps=steps,
                eval_episodes=eval_episodes,
            )

            trainer = GRPOTrainer(env=env, agent=agent, config=config)
            pipeline_results = await trainer.pipeline(steps, eval_episodes)

            # Create result
            baseline = BenchmarkResult(
                game=game_name,
                agent_type=model,
                episodes=eval_episodes,
                wins=int(pipeline_results["baseline"]["win_rate"] * eval_episodes),
                losses=eval_episodes - int(pipeline_results["baseline"]["win_rate"] * eval_episodes),
                draws=0,
                avg_reward=pipeline_results["baseline"]["avg_reward"],
                max_reward=pipeline_results["baseline"]["max_reward"],
                min_reward=pipeline_results["baseline"]["min_reward"],
                duration_seconds=0,
            )

            final = BenchmarkResult(
                game=game_name,
                agent_type=f"{model} (trained)",
                episodes=eval_episodes,
                wins=int(pipeline_results["final"]["win_rate"] * eval_episodes),
                losses=eval_episodes - int(pipeline_results["final"]["win_rate"] * eval_episodes),
                draws=0,
                avg_reward=pipeline_results["final"]["avg_reward"],
                max_reward=pipeline_results["final"]["max_reward"],
                min_reward=pipeline_results["final"]["min_reward"],
                duration_seconds=0,
            )

            results[game_name] = PipelineResult(
                game=game_name,
                model=model,
                baseline=baseline,
                final=final,
                training_steps=steps,
                training_trajectories=len(pipeline_results.get("training", [])) * 8,
                training_duration_seconds=0,
                improvement_pct=pipeline_results["improvement"]["avg_reward_pct"],
            )

            console.print(f"  [green]✓[/green] {game_name}: {results[game_name].improvement_pct:+.1f}% improvement")

        except Exception as e:
            console.print(f"  [red]✗[/red] {game_name}: {e}")

    # Display summary
    if results:
        table = Table(title="Training Pipeline Results")
        table.add_column("Game")
        table.add_column("Baseline", justify="right")
        table.add_column("Trained", justify="right")
        table.add_column("Improvement", justify="right")

        for game, result in results.items():
            table.add_row(
                game,
                f"{result.baseline.avg_reward:.1f}",
                f"{result.final.avg_reward:.1f}",
                f"{result.improvement_pct:+.1f}%",
            )

        console.print("\n")
        console.print(table)

    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = output_path / f"pipelines_{timestamp}.json"
    with open(results_file, "w") as f:
        json.dump(
            {
                g: {
                    "game": r.game,
                    "model": r.model,
                    "baseline": r.baseline.to_dict(),
                    "final": r.final.to_dict(),
                    "improvement_pct": r.improvement_pct,
                    "training_steps": r.training_steps,
                }
                for g, r in results.items()
            },
            f,
            indent=2,
        )

    console.print(f"\n[green]Results saved to {results_file}[/green]")

    return results
