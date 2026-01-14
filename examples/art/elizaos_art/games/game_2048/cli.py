"""
CLI for 2048 ART Training

Commands:
- play: Watch the agent play
- interactive: Play yourself
- benchmark: Compare strategies
- train: Run GRPO training
- pipeline: Full train + evaluate
- evaluate: Test a checkpoint
"""

import asyncio
from pathlib import Path

import typer
from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

from elizaos_art.base import TrainingConfig
from elizaos_art.games.game_2048.agent import (
    Game2048Agent,
    Game2048HeuristicAgent,
    Game2048RandomAgent,
)
from elizaos_art.games.game_2048.environment import Game2048Environment
from elizaos_art.games.game_2048.types import Game2048Action, Game2048Config
from elizaos_art.trainer import GRPOTrainer

app = typer.Typer(
    name="elizaos-art-2048",
    help="2048 game training with ART/GRPO",
)
console = Console()


@app.command()
def play(
    episodes: int = typer.Option(10, help="Number of episodes to play"),
    agent_type: str = typer.Option(
        "heuristic",
        help="Agent type: heuristic, random, or llm",
    ),
    delay: float = typer.Option(0.1, help="Delay between moves (seconds)"),
    seed: int | None = typer.Option(None, help="Random seed"),
) -> None:
    """Watch an agent play 2048."""

    async def run() -> None:
        env = Game2048Environment()
        await env.initialize()

        # Select agent
        if agent_type == "random":
            agent = Game2048RandomAgent(seed)
        elif agent_type == "llm":
            agent = Game2048Agent()
        else:
            agent = Game2048HeuristicAgent()

        console.print(f"\n[bold]2048 - Playing {episodes} episodes with {agent.name}[/bold]\n")

        total_scores: list[int] = []
        max_tiles: list[int] = []

        for ep in range(episodes):
            state = await env.reset(seed=seed + ep if seed else None)

            with Live(console=console, refresh_per_second=10) as live:
                while not state.game_over:
                    actions = env.get_available_actions(state)
                    if not actions:
                        break

                    action = await agent.decide(state, actions)

                    # Display
                    panel = Panel(
                        env.render(state),
                        title=f"Episode {ep + 1}/{episodes}",
                        subtitle=f"Next: {action.name} {action.to_arrow()}",
                    )
                    live.update(panel)

                    state, _, _ = await env.step(action)
                    await asyncio.sleep(delay)

                # Final state
                panel = Panel(
                    env.render(state),
                    title=f"Episode {ep + 1}/{episodes} - GAME OVER",
                    style="red",
                )
                live.update(panel)

            total_scores.append(state.score)
            max_tiles.append(state.max_tile)
            console.print(
                f"Episode {ep + 1}: Score={state.score}, Max Tile={state.max_tile}"
            )

        # Summary
        console.print("\n[bold]Summary[/bold]")
        console.print(f"  Average Score: {sum(total_scores) / len(total_scores):.0f}")
        console.print(f"  Best Score: {max(total_scores)}")
        console.print(f"  Best Max Tile: {max(max_tiles)}")

    asyncio.run(run())


@app.command()
def interactive(
    show_hints: bool = typer.Option(True, help="Show AI hints"),
) -> None:
    """Play 2048 interactively."""

    async def run() -> None:
        env = Game2048Environment()
        await env.initialize()

        if show_hints:
            hint_agent = Game2048HeuristicAgent()

        state = await env.reset()
        console.print("\n[bold]2048 Interactive Mode[/bold]")
        console.print("Use arrow keys or WASD. Press Q to quit.\n")

        while not state.game_over:
            console.print(env.render(state))

            actions = env.get_available_actions(state)
            if not actions:
                break

            if show_hints:
                hint = await hint_agent.decide(state, actions)
                console.print(f"[dim]Hint: {hint.name} {hint.to_arrow()}[/dim]")

            # Get input
            valid_input = False
            while not valid_input:
                try:
                    user_input = console.input("Move (↑↓←→ or WASD, Q=quit): ").strip()
                    if user_input.lower() == "q":
                        console.print("Thanks for playing!")
                        return

                    action = Game2048Action.from_string(user_input)
                    if action in actions:
                        valid_input = True
                    else:
                        console.print("[red]Invalid move![/red]")
                except ValueError:
                    console.print("[red]Use UP/DOWN/LEFT/RIGHT or WASD[/red]")

            state, reward, _ = await env.step(action)
            console.print(f"[dim]+{reward:.0f} points[/dim]\n")

        console.print("\n[bold red]GAME OVER![/bold red]")
        console.print(env.render(state))
        console.print(f"\nFinal Score: {state.score}")
        console.print(f"Max Tile: {state.max_tile}")
        console.print(f"Moves: {state.move_count}")

    asyncio.run(run())


@app.command()
def benchmark(
    episodes: int = typer.Option(100, help="Episodes per strategy"),
) -> None:
    """Benchmark different strategies."""

    async def run() -> None:
        env = Game2048Environment()
        await env.initialize()

        agents = [
            ("Random", Game2048RandomAgent()),
            ("Heuristic", Game2048HeuristicAgent()),
        ]

        results: dict[str, dict] = {}

        for name, agent in agents:
            console.print(f"\n[cyan]Benchmarking {name}...[/cyan]")
            scores: list[int] = []
            max_tiles: list[int] = []
            moves: list[int] = []

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                console=console,
            ) as progress:
                task = progress.add_task(f"{name}", total=episodes)

                for ep in range(episodes):
                    state = await env.reset(seed=ep)
                    while not state.game_over:
                        actions = env.get_available_actions(state)
                        if not actions:
                            break
                        action = await agent.decide(state, actions)
                        state, _, _ = await env.step(action)

                    scores.append(state.score)
                    max_tiles.append(state.max_tile)
                    moves.append(state.move_count)
                    progress.update(task, advance=1)

            results[name] = {
                "avg_score": sum(scores) / len(scores),
                "max_score": max(scores),
                "avg_max_tile": sum(max_tiles) / len(max_tiles),
                "best_tile": max(max_tiles),
                "avg_moves": sum(moves) / len(moves),
                "win_rate": sum(1 for t in max_tiles if t >= 2048) / len(max_tiles),
            }

        # Display results
        table = Table(title="2048 Benchmark Results")
        table.add_column("Strategy")
        table.add_column("Avg Score", justify="right")
        table.add_column("Max Score", justify="right")
        table.add_column("Best Tile", justify="right")
        table.add_column("2048 Rate", justify="right")

        for name, data in results.items():
            table.add_row(
                name,
                f"{data['avg_score']:.0f}",
                f"{data['max_score']}",
                f"{data['best_tile']}",
                f"{data['win_rate']:.1%}",
            )

        console.print("\n")
        console.print(table)

    asyncio.run(run())


@app.command()
def train(
    steps: int = typer.Option(50, help="Number of training steps"),
    rollouts: int = typer.Option(8, help="Rollouts per group"),
    groups: int = typer.Option(4, help="Groups per step"),
    lr: float = typer.Option(1e-5, help="Learning rate"),
    model: str = typer.Option(
        "meta-llama/Llama-3.2-3B-Instruct",
        help="Model to train",
    ),
    judge: str = typer.Option(
        "openai/gpt-5-mini",
        help="RULER judge model",
    ),
    resume: bool = typer.Option(False, help="Resume from checkpoint"),
) -> None:
    """Run GRPO training."""

    async def run() -> None:
        env = Game2048Environment()
        agent = Game2048Agent(model_name=model)

        config = TrainingConfig(
            model_name=model,
            learning_rate=lr,
            rollouts_per_group=rollouts,
            groups_per_step=groups,
            max_steps=steps,
            judge_model=judge,
            resume_from="./checkpoints/game_2048" if resume else None,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=config)
        await trainer.initialize()
        await trainer.train(steps)

    asyncio.run(run())


@app.command()
def pipeline(
    steps: int = typer.Option(50, help="Training steps"),
    eval_episodes: int = typer.Option(50, help="Evaluation episodes"),
    model: str = typer.Option(
        "meta-llama/Llama-3.2-3B-Instruct",
        help="Model to train",
    ),
    resume: bool = typer.Option(False, help="Resume from checkpoint"),
) -> None:
    """Run full training pipeline: baseline -> train -> evaluate."""

    async def run() -> None:
        env = Game2048Environment()
        agent = Game2048Agent(model_name=model)

        config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            eval_episodes=eval_episodes,
            resume_from="./checkpoints/game_2048" if resume else None,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=config)
        results = await trainer.pipeline(steps, eval_episodes)

        console.print("\n[bold green]Pipeline Complete![/bold green]")
        console.print(f"Improvement: {results['improvement']['avg_reward_pct']:+.1f}%")

    asyncio.run(run())


@app.command()
def evaluate(
    checkpoint: str = typer.Option(
        "./checkpoints/game_2048",
        help="Checkpoint path",
    ),
    episodes: int = typer.Option(50, help="Number of evaluation episodes"),
) -> None:
    """Evaluate a trained checkpoint."""

    async def run() -> None:
        env = Game2048Environment()
        agent = Game2048Agent()

        config = TrainingConfig(resume_from=checkpoint, eval_episodes=episodes)

        trainer = GRPOTrainer(env=env, agent=agent, config=config)
        await trainer.initialize()
        await trainer.evaluate(episodes, checkpoint)

    asyncio.run(run())


if __name__ == "__main__":
    app()
