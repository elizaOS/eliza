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
    TemporalClueGreedyAgent,
    TemporalClueRandomAgent,
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
    episodes: int = typer.Option(10, help="Number of puzzles"),
    difficulty: str = typer.Option("medium", help="easy, medium, hard"),
    agent_type: str = typer.Option("greedy", help="random, greedy, or llm"),
) -> None:
    """Watch an agent solve temporal puzzles."""

    async def run() -> None:
        diff = {
            "easy": Difficulty.EASY,
            "medium": Difficulty.MEDIUM,
            "hard": Difficulty.HARD,
        }.get(difficulty.lower(), Difficulty.MEDIUM)

        config = TemporalClueConfig(difficulty=diff)
        env = TemporalClueEnvironment(config)
        await env.initialize()

        if agent_type == "random":
            agent = TemporalClueRandomAgent()
        elif agent_type == "llm":
            agent = TemporalClueAgent()
        else:
            agent = TemporalClueGreedyAgent()

        console.print(f"\n[bold]Temporal Clue - {agent.name} ({diff.name})[/bold]\n")

        solved = 0

        for ep in range(episodes):
            console.print(f"\n[bold cyan]Puzzle {ep + 1}/{episodes}[/bold cyan]")
            state = await env.reset(seed=ep)

            console.print(env.render(state))

            while not state.is_terminal():
                actions = env.get_available_actions(state)
                if not actions:
                    break

                action = await agent.decide(state, actions)

                if action == TemporalClueAction.SUBMIT:
                    console.print("[yellow]Submitting answer...[/yellow]")
                else:
                    event = state.puzzle.events[action.value]
                    console.print(f"[dim]Placing: {event}[/dim]")

                state, reward, _ = await env.step(action)

                if action != TemporalClueAction.SUBMIT:
                    console.print(f"  Order: {' → '.join(state.current_ordering)}")

            console.print(env.render(state))

            if state.solved:
                console.print("[green]SOLVED![/green]")
                solved += 1
            else:
                console.print("[red]Failed[/red]")
                console.print(f"Correct: {' → '.join(state.puzzle.solution)}")

        console.print(f"\n[bold]Results: {solved}/{episodes} solved ({solved/episodes:.1%})[/bold]")

    asyncio.run(run())


@app.command()
def interactive(
    difficulty: str = typer.Option("medium", help="easy, medium, hard"),
) -> None:
    """Solve temporal puzzles interactively."""

    async def run() -> None:
        diff = {
            "easy": Difficulty.EASY,
            "medium": Difficulty.MEDIUM,
            "hard": Difficulty.HARD,
        }.get(difficulty.lower(), Difficulty.MEDIUM)

        config = TemporalClueConfig(difficulty=diff)
        env = TemporalClueEnvironment(config)
        await env.initialize()

        console.print("\n[bold]Temporal Clue - Interactive Mode[/bold]")
        console.print("Order the events from earliest to latest.")
        console.print("Type event number, 's' to submit, 'r' to reset, 'q' to quit.\n")

        state = await env.reset()

        while True:
            console.print(env.render(state))

            # Show numbered options
            if state.remaining_events:
                console.print("\nAvailable events:")
                for i, event in enumerate(state.puzzle.events):
                    if event in state.remaining_events:
                        console.print(f"  {i}: {event}")

            if state.is_terminal():
                if state.solved:
                    console.print("\n[bold green]Congratulations! Puzzle solved![/bold green]")
                else:
                    console.print("\n[bold red]Out of attempts![/bold red]")
                    console.print(f"Solution: {' → '.join(state.puzzle.solution)}")

                again = console.input("\nPlay again? (y/n): ").strip().lower()
                if again == "y":
                    state = await env.reset()
                    continue
                break

            user_input = console.input("\nYour choice: ").strip().lower()

            if user_input == "q":
                console.print("Thanks for playing!")
                break
            elif user_input == "r":
                state = await env.reset()
                continue
            elif user_input == "s":
                if not state.remaining_events:
                    state, _, _ = await env.step(TemporalClueAction.SUBMIT)
                else:
                    console.print("[red]Place all events first![/red]")
            else:
                try:
                    idx = int(user_input)
                    if 0 <= idx < len(state.puzzle.events):
                        event = state.puzzle.events[idx]
                        if event in state.remaining_events:
                            state, _, _ = await env.step(TemporalClueAction(idx))
                        else:
                            console.print("[red]Event already placed![/red]")
                    else:
                        console.print("[red]Invalid number![/red]")
                except ValueError:
                    console.print("[red]Enter a number, 's', 'r', or 'q'[/red]")

    asyncio.run(run())


@app.command()
def benchmark(
    episodes: int = typer.Option(100, help="Puzzles per strategy"),
    difficulty: str = typer.Option("medium", help="easy, medium, hard"),
) -> None:
    """Benchmark different strategies."""

    async def run() -> None:
        diff = {
            "easy": Difficulty.EASY,
            "medium": Difficulty.MEDIUM,
            "hard": Difficulty.HARD,
        }.get(difficulty.lower(), Difficulty.MEDIUM)

        agents = [
            ("Random", TemporalClueRandomAgent()),
            ("Greedy", TemporalClueGreedyAgent()),
        ]

        results: list[dict] = []

        for agent_name, agent in agents:
            console.print(f"[cyan]Benchmarking {agent_name}...[/cyan]")

            config = TemporalClueConfig(difficulty=diff)
            env = TemporalClueEnvironment(config)
            await env.initialize()

            solved = 0
            total_attempts = 0
            total_reward = 0.0

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                console=console,
            ) as progress:
                task = progress.add_task(agent_name, total=episodes)

                for ep in range(episodes):
                    state = await env.reset(seed=ep)
                    ep_reward = 0.0

                    while not state.is_terminal():
                        actions = env.get_available_actions(state)
                        if not actions:
                            break
                        action = await agent.decide(state, actions)
                        state, reward, _ = await env.step(action)
                        ep_reward += reward

                    if state.solved:
                        solved += 1

                    total_attempts += state.attempts
                    total_reward += ep_reward
                    progress.update(task, advance=1)

            results.append({
                "agent": agent_name,
                "solved": solved,
                "solve_rate": solved / episodes,
                "avg_attempts": total_attempts / episodes,
                "avg_reward": total_reward / episodes,
            })

        table = Table(title=f"Temporal Clue Benchmark ({diff.name})")
        table.add_column("Agent")
        table.add_column("Solved", justify="right")
        table.add_column("Solve Rate", justify="right")
        table.add_column("Avg Attempts", justify="right")
        table.add_column("Avg Reward", justify="right")

        for r in results:
            table.add_row(
                r["agent"],
                str(r["solved"]),
                f"{r['solve_rate']:.1%}",
                f"{r['avg_attempts']:.2f}",
                f"{r['avg_reward']:.2f}",
            )

        console.print("\n")
        console.print(table)

    asyncio.run(run())


@app.command()
def train(
    steps: int = typer.Option(50, help="Training steps"),
    rollouts: int = typer.Option(8, help="Rollouts per group"),
    difficulty: str = typer.Option("medium", help="easy, medium, hard"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct"),
) -> None:
    """Run GRPO training."""

    async def run() -> None:
        diff = {
            "easy": Difficulty.EASY,
            "medium": Difficulty.MEDIUM,
            "hard": Difficulty.HARD,
        }.get(difficulty.lower(), Difficulty.MEDIUM)

        config = TemporalClueConfig(difficulty=diff)
        env = TemporalClueEnvironment(config)
        agent = TemporalClueAgent(model_name=model)

        train_config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            rollouts_per_group=rollouts,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=train_config)
        await trainer.initialize()
        await trainer.train(steps)

    asyncio.run(run())


@app.command()
def pipeline(
    steps: int = typer.Option(50, help="Training steps"),
    eval_episodes: int = typer.Option(50, help="Evaluation episodes"),
    difficulty: str = typer.Option("medium", help="easy, medium, hard"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct"),
) -> None:
    """Full training pipeline."""

    async def run() -> None:
        diff = {
            "easy": Difficulty.EASY,
            "medium": Difficulty.MEDIUM,
            "hard": Difficulty.HARD,
        }.get(difficulty.lower(), Difficulty.MEDIUM)

        config = TemporalClueConfig(difficulty=diff)
        env = TemporalClueEnvironment(config)
        agent = TemporalClueAgent(model_name=model)

        train_config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            eval_episodes=eval_episodes,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=train_config)
        results = await trainer.pipeline(steps, eval_episodes)

        console.print(f"\n[bold green]Pipeline Complete![/bold green]")
        console.print(f"Solve rate improvement: {results['improvement']['win_rate']:+.1%}")

    asyncio.run(run())


if __name__ == "__main__":
    app()
