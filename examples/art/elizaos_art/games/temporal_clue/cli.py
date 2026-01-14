"""
CLI for Temporal Clue ART Training
"""

import asyncio

import typer
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

from elizaos_art.base import TrainingConfig
from elizaos_art.games.temporal_clue.agent import (
    TemporalClueAgent,
    TemporalClueHeuristicAgent,
)
from elizaos_art.games.temporal_clue.environment import TemporalClueEnvironment
from elizaos_art.games.temporal_clue.types import (
    Difficulty,
    TemporalClueAction,
    TemporalClueConfig,
)
from elizaos_art.trainer import GRPOTrainer

app = typer.Typer(
    name="elizaos-art-temporal",
    help="Temporal Clue puzzle training with ART/GRPO",
)
console = Console()


@app.command()
def play(
    episodes: int = typer.Option(5, help="Number of puzzles"),
    difficulty: str = typer.Option("medium", help="Difficulty: easy, medium, hard"),
    agent_type: str = typer.Option("heuristic", help="Agent: heuristic"),
    delay: float = typer.Option(0.5, help="Delay between moves"),
    seed: int | None = typer.Option(None, help="Random seed"),
) -> None:
    """Watch an agent solve Temporal Clue puzzles."""

    async def run() -> None:
        diff = Difficulty(difficulty)
        config = TemporalClueConfig(difficulty=diff)
        env = TemporalClueEnvironment(config)
        await env.initialize()

        agent = TemporalClueHeuristicAgent()

        console.print(f"\n[bold]Temporal Clue - {episodes} puzzles ({difficulty})[/bold]\n")

        correct = 0

        for ep in range(episodes):
            state = await env.reset(seed=seed + ep if seed else None)
            console.print(f"\n[cyan]Puzzle {ep + 1}/{episodes}[/cyan]")

            while not state.submitted:
                console.print(env.render(state))

                actions = env.get_available_actions(state)
                if not actions:
                    break

                action = await agent.decide(state, actions)
                action_name = "SUBMIT" if action == TemporalClueAction.SUBMIT else f"Position {action.value}"
                console.print(f"Action: {action_name}")

                state, reward, _ = await env.step(action)
                await asyncio.sleep(delay)

            console.print(env.render(state))
            if state.is_correct:
                console.print("[green]CORRECT![/green]")
                correct += 1
            else:
                console.print("[red]INCORRECT[/red]")

        console.print(f"\n[bold]Results: {correct}/{episodes} correct ({correct / episodes:.1%})[/bold]")

    asyncio.run(run())


@app.command()
def interactive(
    difficulty: str = typer.Option("medium", help="Difficulty: easy, medium, hard"),
) -> None:
    """Solve Temporal Clue puzzles interactively."""

    async def run() -> None:
        diff = Difficulty(difficulty)
        config = TemporalClueConfig(difficulty=diff)
        env = TemporalClueEnvironment(config)
        await env.initialize()

        console.print("\n[bold]Temporal Clue Interactive Mode[/bold]")
        console.print("Order events from earliest (0) to latest.\n")

        state = await env.reset()

        while not state.submitted:
            console.print(env.render(state))

            actions = env.get_available_actions(state)
            if not actions:
                break

            user_input = console.input("\nPosition (0-7) or SUBMIT: ").strip().upper()

            if user_input == "SUBMIT":
                action = TemporalClueAction.SUBMIT
            else:
                try:
                    pos = int(user_input)
                    action = TemporalClueAction.from_position(pos)
                except (ValueError, IndexError):
                    console.print("[red]Invalid input[/red]")
                    continue

            if action not in actions:
                console.print("[red]Invalid action[/red]")
                continue

            state, reward, _ = await env.step(action)
            if reward != 0:
                console.print(f"[dim]Reward: {reward:+.1f}[/dim]")

        console.print("\n" + env.render(state))

        if state.is_correct:
            console.print("[bold green]Congratulations! You solved it![/bold green]")
        else:
            console.print("[bold red]Not quite right. Try again![/bold red]")

    asyncio.run(run())


@app.command()
def benchmark(
    episodes: int = typer.Option(100, help="Number of puzzles"),
    difficulty: str = typer.Option("medium", help="Difficulty: easy, medium, hard"),
) -> None:
    """Benchmark Temporal Clue performance."""

    async def run() -> None:
        diff = Difficulty(difficulty)
        config = TemporalClueConfig(difficulty=diff)
        env = TemporalClueEnvironment(config)
        await env.initialize()

        agent = TemporalClueHeuristicAgent()

        console.print(f"\n[bold]Benchmarking ({episodes} puzzles, {difficulty})[/bold]\n")

        correct = 0
        total_reward = 0.0

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Running...", total=episodes)

            for ep in range(episodes):
                state = await env.reset(seed=ep)
                episode_reward = 0.0

                while not state.submitted:
                    actions = env.get_available_actions(state)
                    if not actions:
                        break

                    action = await agent.decide(state, actions)
                    state, reward, _ = await env.step(action)
                    episode_reward += reward

                if state.is_correct:
                    correct += 1
                total_reward += episode_reward
                progress.update(task, advance=1)

        console.print(f"\n[bold]Results[/bold]")
        console.print(f"  Accuracy: {correct / episodes:.1%}")
        console.print(f"  Avg Reward: {total_reward / episodes:.2f}")

    asyncio.run(run())


@app.command()
def train(
    steps: int = typer.Option(50, help="Training steps"),
    difficulty: str = typer.Option("medium", help="Difficulty: easy, medium, hard"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct", help="Model"),
    resume: bool = typer.Option(False, help="Resume from checkpoint"),
) -> None:
    """Run GRPO training for Temporal Clue."""

    async def run() -> None:
        diff = Difficulty(difficulty)
        config = TemporalClueConfig(difficulty=diff)
        env = TemporalClueEnvironment(config)
        agent = TemporalClueAgent(model_name=model)

        trainer_config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            resume_from="./checkpoints/temporal_clue" if resume else None,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=trainer_config)
        await trainer.initialize()
        await trainer.train(steps)

    asyncio.run(run())


@app.command()
def pipeline(
    steps: int = typer.Option(50, help="Training steps"),
    eval_episodes: int = typer.Option(100, help="Evaluation episodes"),
    difficulty: str = typer.Option("medium", help="Difficulty: easy, medium, hard"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct", help="Model"),
    resume: bool = typer.Option(False, help="Resume from checkpoint"),
) -> None:
    """Run full training pipeline."""

    async def run() -> None:
        diff = Difficulty(difficulty)
        config = TemporalClueConfig(difficulty=diff)
        env = TemporalClueEnvironment(config)
        agent = TemporalClueAgent(model_name=model)

        trainer_config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            eval_episodes=eval_episodes,
            resume_from="./checkpoints/temporal_clue" if resume else None,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=trainer_config)
        results = await trainer.pipeline(steps, eval_episodes)

        console.print("\n[bold green]Pipeline Complete![/bold green]")
        console.print(f"Accuracy improvement: {results['improvement']['win_rate']:+.1%}")

    asyncio.run(run())


if __name__ == "__main__":
    app()
