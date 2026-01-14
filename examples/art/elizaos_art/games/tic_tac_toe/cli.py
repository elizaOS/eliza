"""
CLI for Tic-Tac-Toe ART Training
"""

import asyncio

import typer
from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

from elizaos_art.base import TrainingConfig
from elizaos_art.games.tic_tac_toe.agent import (
    TicTacToeAgent,
    TicTacToeHeuristicAgent,
    TicTacToeRandomAgent,
)
from elizaos_art.games.tic_tac_toe.environment import TicTacToeEnvironment
from elizaos_art.games.tic_tac_toe.types import Player, TicTacToeAction, TicTacToeConfig
from elizaos_art.trainer import GRPOTrainer

app = typer.Typer(
    name="elizaos-art-tictactoe",
    help="Tic-Tac-Toe game training with ART/GRPO",
)
console = Console()


@app.command()
def play(
    episodes: int = typer.Option(10, help="Number of episodes to play"),
    agent_type: str = typer.Option("heuristic", help="Agent type: heuristic, random"),
    opponent: str = typer.Option("random", help="Opponent: random, heuristic, minimax"),
    delay: float = typer.Option(0.5, help="Delay between moves (seconds)"),
    seed: int | None = typer.Option(None, help="Random seed"),
) -> None:
    """Watch an agent play Tic-Tac-Toe."""

    async def run() -> None:
        config = TicTacToeConfig(opponent=opponent)
        env = TicTacToeEnvironment(config)
        await env.initialize()

        # Select agent
        if agent_type == "random":
            agent = TicTacToeRandomAgent(seed)
        else:
            agent = TicTacToeHeuristicAgent()

        console.print(f"\n[bold]Tic-Tac-Toe - {episodes} episodes with {agent.name}[/bold]")
        console.print(f"Opponent: {opponent}\n")

        wins = 0
        losses = 0
        draws = 0

        for ep in range(episodes):
            state = await env.reset(seed=seed + ep if seed else None)

            with Live(console=console, refresh_per_second=4) as live:
                while not state.is_terminal():
                    actions = env.get_available_actions(state)
                    if not actions:
                        break

                    action = await agent.decide(state, actions)

                    panel = Panel(
                        env.render(state),
                        title=f"Episode {ep + 1}/{episodes}",
                        subtitle=f"AI places at position {action.value}",
                    )
                    live.update(panel)

                    state, _, _ = await env.step(action)
                    await asyncio.sleep(delay)

                # Final state
                style = "green" if state.winner == config.ai_player else "red" if state.winner else "yellow"
                panel = Panel(
                    env.render(state),
                    title=f"Episode {ep + 1}/{episodes}",
                    style=style,
                )
                live.update(panel)

            if state.winner == config.ai_player:
                wins += 1
            elif state.winner:
                losses += 1
            else:
                draws += 1

            result = "WIN" if state.winner == config.ai_player else "LOSS" if state.winner else "DRAW"
            console.print(f"Episode {ep + 1}: {result}")

        # Summary
        console.print("\n[bold]Summary[/bold]")
        console.print(f"  Wins: {wins} ({wins / episodes:.1%})")
        console.print(f"  Losses: {losses} ({losses / episodes:.1%})")
        console.print(f"  Draws: {draws} ({draws / episodes:.1%})")

    asyncio.run(run())


@app.command()
def interactive(
    opponent: str = typer.Option("heuristic", help="Opponent: random, heuristic, minimax"),
) -> None:
    """Play Tic-Tac-Toe interactively."""

    async def run() -> None:
        # Human is X (plays first), AI opponent is O
        config = TicTacToeConfig(opponent=opponent, ai_player=Player.O)
        env = TicTacToeEnvironment(config)
        await env.initialize()

        console.print("\n[bold]Tic-Tac-Toe Interactive Mode[/bold]")
        console.print("You are X, opponent is O")
        console.print("Enter position 0-8 to place your mark.\n")

        state = await env.reset()

        while not state.is_terminal():
            console.print(env.render(state))

            actions = env.get_available_actions(state)
            if not actions:
                break

            # Get human input
            valid = False
            while not valid:
                try:
                    user_input = console.input("Your move (0-8): ").strip()
                    action = TicTacToeAction.from_string(user_input)
                    if action in actions:
                        valid = True
                    else:
                        console.print("[red]Position not available![/red]")
                except ValueError:
                    console.print("[red]Enter a number 0-8[/red]")

            state, _, _ = await env.step(action)
            console.print()

        console.print("\n[bold]Game Over![/bold]")
        console.print(env.render(state))

        if state.winner == Player.X:
            console.print("[green]You win![/green]")
        elif state.winner == Player.O:
            console.print("[red]Opponent wins![/red]")
        else:
            console.print("[yellow]It's a draw![/yellow]")

    asyncio.run(run())


@app.command()
def benchmark(
    episodes: int = typer.Option(100, help="Episodes per configuration"),
) -> None:
    """Benchmark different strategies and opponents."""

    async def run() -> None:
        results: dict[str, dict] = {}

        configurations = [
            ("Heuristic vs Random", TicTacToeHeuristicAgent(), "random"),
            ("Heuristic vs Heuristic", TicTacToeHeuristicAgent(), "heuristic"),
            ("Heuristic vs Minimax", TicTacToeHeuristicAgent(), "minimax"),
            ("Random vs Random", TicTacToeRandomAgent(), "random"),
        ]

        for name, agent, opponent in configurations:
            console.print(f"\n[cyan]Benchmarking {name}...[/cyan]")

            config = TicTacToeConfig(opponent=opponent)
            env = TicTacToeEnvironment(config)
            await env.initialize()

            wins = 0
            losses = 0
            draws = 0

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                console=console,
            ) as progress:
                task = progress.add_task(name, total=episodes)

                for ep in range(episodes):
                    state = await env.reset(seed=ep)
                    while not state.is_terminal():
                        actions = env.get_available_actions(state)
                        if not actions:
                            break
                        action = await agent.decide(state, actions)
                        state, _, _ = await env.step(action)

                    if state.winner == config.ai_player:
                        wins += 1
                    elif state.winner:
                        losses += 1
                    else:
                        draws += 1

                    progress.update(task, advance=1)

            results[name] = {
                "wins": wins,
                "losses": losses,
                "draws": draws,
                "win_rate": wins / episodes,
            }

        # Display results
        table = Table(title="Tic-Tac-Toe Benchmark Results")
        table.add_column("Configuration")
        table.add_column("Wins", justify="right")
        table.add_column("Losses", justify="right")
        table.add_column("Draws", justify="right")
        table.add_column("Win Rate", justify="right")

        for name, data in results.items():
            table.add_row(
                name,
                str(data["wins"]),
                str(data["losses"]),
                str(data["draws"]),
                f"{data['win_rate']:.1%}",
            )

        console.print("\n")
        console.print(table)

    asyncio.run(run())


@app.command()
def train(
    steps: int = typer.Option(50, help="Number of training steps"),
    rollouts: int = typer.Option(8, help="Rollouts per group"),
    opponent: str = typer.Option("random", help="Opponent: random, heuristic"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct", help="Model to train"),
    resume: bool = typer.Option(False, help="Resume from checkpoint"),
) -> None:
    """Run GRPO training."""

    async def run() -> None:
        config = TicTacToeConfig(opponent=opponent)
        env = TicTacToeEnvironment(config)
        agent = TicTacToeAgent(model_name=model)

        trainer_config = TrainingConfig(
            model_name=model,
            rollouts_per_group=rollouts,
            max_steps=steps,
            resume_from="./checkpoints/tic_tac_toe" if resume else None,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=trainer_config)
        await trainer.initialize()
        await trainer.train(steps)

    asyncio.run(run())


@app.command()
def pipeline(
    steps: int = typer.Option(50, help="Training steps"),
    eval_episodes: int = typer.Option(100, help="Evaluation episodes"),
    opponent: str = typer.Option("random", help="Opponent: random, heuristic"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct", help="Model to train"),
    resume: bool = typer.Option(False, help="Resume from checkpoint"),
) -> None:
    """Run full training pipeline."""

    async def run() -> None:
        config = TicTacToeConfig(opponent=opponent)
        env = TicTacToeEnvironment(config)
        agent = TicTacToeAgent(model_name=model)

        trainer_config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            eval_episodes=eval_episodes,
            resume_from="./checkpoints/tic_tac_toe" if resume else None,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=trainer_config)
        results = await trainer.pipeline(steps, eval_episodes)

        console.print("\n[bold green]Pipeline Complete![/bold green]")
        console.print(f"Win rate improvement: {results['improvement']['win_rate']:+.1%}")

    asyncio.run(run())


if __name__ == "__main__":
    app()
