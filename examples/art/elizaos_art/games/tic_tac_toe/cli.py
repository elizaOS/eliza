"""
CLI for Tic-Tac-Toe ART Training
"""

import asyncio

import typer
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

from elizaos_art.base import TrainingConfig
from elizaos_art.games.tic_tac_toe.agent import (
    TicTacToeAgent,
    TicTacToeOptimalAgent,
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
    episodes: int = typer.Option(10, help="Number of games to play"),
    agent_type: str = typer.Option(
        "optimal",
        help="Agent type: optimal, random, or llm",
    ),
    opponent: str = typer.Option(
        "random",
        help="Opponent type: random, optimal",
    ),
    delay: float = typer.Option(0.5, help="Delay between moves"),
) -> None:
    """Watch an agent play Tic-Tac-Toe."""

    async def run() -> None:
        config = TicTacToeConfig(opponent=opponent)
        env = TicTacToeEnvironment(config)
        await env.initialize()

        if agent_type == "random":
            agent = TicTacToeRandomAgent()
        elif agent_type == "llm":
            agent = TicTacToeAgent()
        else:
            agent = TicTacToeOptimalAgent()

        console.print(f"\n[bold]Tic-Tac-Toe - {agent.name} vs {opponent}[/bold]\n")

        wins = 0
        losses = 0
        draws = 0

        for ep in range(episodes):
            state = await env.reset(seed=ep)

            console.print(f"\n[bold cyan]Game {ep + 1}/{episodes}[/bold cyan]")

            while not state.is_terminal():
                console.print(env.render(state))

                actions = env.get_available_actions(state)
                if not actions:
                    break

                action = await agent.decide(state, actions)
                row, col = action.to_coords()
                console.print(f"[dim]Agent plays: position {action.value} ({row},{col})[/dim]")

                state, reward, done = await env.step(action)
                await asyncio.sleep(delay)

            console.print(env.render(state))

            if state.winner == 0:
                console.print("[yellow]Draw![/yellow]")
                draws += 1
            elif reward > 0:
                console.print("[green]Agent wins![/green]")
                wins += 1
            else:
                console.print("[red]Agent loses![/red]")
                losses += 1

        console.print("\n[bold]Results[/bold]")
        console.print(f"  Wins: {wins}")
        console.print(f"  Losses: {losses}")
        console.print(f"  Draws: {draws}")
        console.print(f"  Win Rate: {wins / episodes:.1%}")

    asyncio.run(run())


@app.command()
def interactive(
    opponent: str = typer.Option("optimal", help="Opponent: random, optimal"),
    you_first: bool = typer.Option(True, help="You play first (X)"),
) -> None:
    """Play Tic-Tac-Toe interactively."""

    async def run() -> None:
        # If human is X (plays first), AI is O (player 2); otherwise AI is X (player 1)
        ai_player = Player.O if you_first else Player.X
        config = TicTacToeConfig(ai_player=ai_player, opponent="none")
        env = TicTacToeEnvironment(config)
        await env.initialize()

        opponent_agent = TicTacToeOptimalAgent() if opponent == "optimal" else TicTacToeRandomAgent()

        state = await env.reset()
        console.print("\n[bold]Tic-Tac-Toe Interactive[/bold]")
        console.print(f"You are {'X' if you_first else 'O'}")
        console.print("Enter position 0-8 or quit with 'q'\n")

        your_turn = you_first

        while not state.is_terminal():
            console.print(env.render(state))
            actions = env.get_available_actions(state)

            if not actions:
                break

            if your_turn:
                valid = False
                while not valid:
                    inp = console.input("Your move (0-8): ").strip()
                    if inp.lower() == "q":
                        console.print("Thanks for playing!")
                        return
                    try:
                        action = TicTacToeAction.from_string(inp)
                        if action in actions:
                            valid = True
                        else:
                            console.print("[red]Position taken![/red]")
                    except ValueError:
                        console.print("[red]Enter 0-8[/red]")
            else:
                action = await opponent_agent.decide(state, actions)
                console.print(f"[dim]Opponent plays: {action.value}[/dim]")

            state, _, _ = await env.step(action)
            your_turn = not your_turn

        console.print(env.render(state))
        if state.winner == 0:
            console.print("[yellow]It's a draw![/yellow]")
        elif (state.winner == 1) == you_first:
            console.print("[green]You win![/green]")
        else:
            console.print("[red]You lose![/red]")

    asyncio.run(run())


@app.command()
def benchmark(
    episodes: int = typer.Option(1000, help="Games per matchup"),
) -> None:
    """Benchmark different strategies."""

    async def run() -> None:
        agents = [
            ("Random", TicTacToeRandomAgent()),
            ("Optimal", TicTacToeOptimalAgent()),
        ]
        opponents = ["random", "optimal"]

        results: list[dict] = []

        for agent_name, agent in agents:
            for opp in opponents:
                console.print(f"[cyan]{agent_name} vs {opp}...[/cyan]")

                config = TicTacToeConfig(opponent=opp)
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
                    task = progress.add_task("Playing", total=episodes)

                    for ep in range(episodes):
                        state = await env.reset(seed=ep)
                        while not state.is_terminal():
                            actions = env.get_available_actions(state)
                            if not actions:
                                break
                            action = await agent.decide(state, actions)
                            state, reward, _ = await env.step(action)

                        if state.winner == 0:
                            draws += 1
                        elif reward > 0:
                            wins += 1
                        else:
                            losses += 1

                        progress.update(task, advance=1)

                results.append({
                    "agent": agent_name,
                    "opponent": opp,
                    "wins": wins,
                    "losses": losses,
                    "draws": draws,
                    "win_rate": wins / episodes,
                })

        table = Table(title="Tic-Tac-Toe Benchmark")
        table.add_column("Agent")
        table.add_column("Opponent")
        table.add_column("Wins", justify="right")
        table.add_column("Losses", justify="right")
        table.add_column("Draws", justify="right")
        table.add_column("Win Rate", justify="right")

        for r in results:
            table.add_row(
                r["agent"],
                r["opponent"],
                str(r["wins"]),
                str(r["losses"]),
                str(r["draws"]),
                f"{r['win_rate']:.1%}",
            )

        console.print("\n")
        console.print(table)

    asyncio.run(run())


@app.command()
def train(
    steps: int = typer.Option(50, help="Training steps"),
    rollouts: int = typer.Option(8, help="Rollouts per group"),
    opponent: str = typer.Option("random", help="Training opponent"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct"),
    resume: bool = typer.Option(False, help="Resume from checkpoint"),
) -> None:
    """Run GRPO training."""

    async def run() -> None:
        config = TicTacToeConfig(opponent=opponent)
        env = TicTacToeEnvironment(config)
        agent = TicTacToeAgent(model_name=model)

        train_config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            rollouts_per_group=rollouts,
            resume_from="./checkpoints/tic_tac_toe" if resume else None,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=train_config)
        await trainer.initialize()
        await trainer.train(steps)

    asyncio.run(run())


@app.command()
def pipeline(
    steps: int = typer.Option(50, help="Training steps"),
    eval_episodes: int = typer.Option(100, help="Evaluation episodes"),
    opponent: str = typer.Option("random", help="Training opponent"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct"),
) -> None:
    """Full training pipeline."""

    async def run() -> None:
        config = TicTacToeConfig(opponent=opponent)
        env = TicTacToeEnvironment(config)
        agent = TicTacToeAgent(model_name=model)

        train_config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            eval_episodes=eval_episodes,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=train_config)
        results = await trainer.pipeline(steps, eval_episodes)

        console.print(f"\n[bold green]Pipeline Complete![/bold green]")
        console.print(f"Win rate improvement: {results['improvement']['win_rate']:+.1%}")

    asyncio.run(run())


if __name__ == "__main__":
    app()
