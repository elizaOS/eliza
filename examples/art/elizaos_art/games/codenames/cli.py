"""
CLI for Codenames ART Training
"""

import asyncio

import typer
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

from elizaos_art.base import TrainingConfig
from elizaos_art.games.codenames.agent import (
    CodenamesGuesserAgent,
    CodenamesRandomAgent,
    CodenamesSpymasterAgent,
)
from elizaos_art.games.codenames.environment import CodenamesEnvironment
from elizaos_art.games.codenames.types import (
    Clue,
    CodenamesAction,
    CodenamesConfig,
    Role,
    Team,
)
from elizaos_art.trainer import GRPOTrainer

app = typer.Typer(
    name="elizaos-art-codenames",
    help="Codenames game training with ART/GRPO",
)
console = Console()


@app.command()
def play(
    episodes: int = typer.Option(5, help="Number of games"),
    role: str = typer.Option("guesser", help="Role: spymaster or guesser"),
    team: str = typer.Option("red", help="Team: red or blue"),
) -> None:
    """Watch an agent play Codenames."""

    async def run() -> None:
        train_role = Role.SPYMASTER if role == "spymaster" else Role.GUESSER
        train_team = Team.RED if team == "red" else Team.BLUE

        config = CodenamesConfig(train_role=train_role, train_team=train_team)
        env = CodenamesEnvironment(config)
        await env.initialize()

        if train_role == Role.GUESSER:
            agent = CodenamesGuesserAgent()
        else:
            agent = CodenamesSpymasterAgent()

        console.print(f"\n[bold]Codenames - {role.title()} ({team.title()} team)[/bold]\n")

        wins = 0

        for ep in range(episodes):
            console.print(f"\n[bold cyan]Game {ep + 1}/{episodes}[/bold cyan]")
            state = await env.reset(seed=ep)

            while not state.is_terminal():
                console.print(env.render(state))

                if state.current_role == Role.GUESSER:
                    actions = env.get_available_actions(state)
                    if not actions:
                        break

                    action = await agent.decide(state, actions)
                    word = state.board[action.value].word if action != CodenamesAction.PASS else "PASS"
                    console.print(f"[dim]Agent guesses: {word}[/dim]")

                    state, reward, done = await env.step(action)
                    console.print(f"[dim]Reward: {reward:+.1f}[/dim]")
                else:
                    # Generate clue
                    await env._generate_opponent_clue()
                    state = env._current_state
                    if state and state.current_clue:
                        console.print(f"[yellow]Clue: {state.current_clue}[/yellow]")

            console.print(env.render(state))

            if state.winner == train_team:
                console.print("[green]Agent's team wins![/green]")
                wins += 1
            else:
                console.print("[red]Agent's team loses![/red]")

        console.print(f"\n[bold]Results: {wins}/{episodes} wins[/bold]")

    asyncio.run(run())


@app.command()
def interactive(
    role: str = typer.Option("guesser", help="Your role: spymaster or guesser"),
) -> None:
    """Play Codenames interactively."""

    async def run() -> None:
        train_role = Role.SPYMASTER if role == "spymaster" else Role.GUESSER
        config = CodenamesConfig(train_role=train_role)
        env = CodenamesEnvironment(config)
        await env.initialize()

        state = await env.reset()
        console.print(f"\n[bold]Codenames Interactive - You are {role.title()}[/bold]\n")

        while not state.is_terminal():
            console.print(env.render(state))

            if state.current_role == Role.SPYMASTER and train_role == Role.SPYMASTER:
                # Your turn to give clue
                clue_input = console.input("Give clue (WORD NUMBER): ").strip()
                if clue_input.lower() == "q":
                    break

                try:
                    parts = clue_input.split()
                    word = parts[0].upper()
                    number = int(parts[1]) if len(parts) > 1 else 1
                    clue = Clue(word=word, number=number)
                    state = env.give_clue(clue)
                except (IndexError, ValueError) as e:
                    console.print(f"[red]Invalid clue: {e}[/red]")
                    continue

            elif state.current_role == Role.GUESSER and train_role == Role.GUESSER:
                # Your turn to guess
                actions = env.get_available_actions(state)
                unrevealed = [
                    state.board[a.value].word
                    for a in actions
                    if a != CodenamesAction.PASS
                ]
                console.print(f"Words: {', '.join(unrevealed)}")

                guess = console.input("Guess a word (or PASS): ").strip().upper()
                if guess == "Q":
                    break

                if guess == "PASS":
                    action = CodenamesAction.PASS
                else:
                    try:
                        action = CodenamesAction.from_word(guess, list(state.board))
                    except ValueError:
                        console.print("[red]Word not found![/red]")
                        continue

                state, reward, _ = await env.step(action)
                console.print(f"[dim]Reward: {reward:+.1f}[/dim]")

            else:
                # AI's turn
                if state.current_role == Role.SPYMASTER:
                    await env._generate_opponent_clue()
                    state = env._current_state
                    if state and state.current_clue:
                        console.print(f"[yellow]AI Clue: {state.current_clue}[/yellow]")
                else:
                    # AI guesses
                    actions = env.get_available_actions(state)
                    ai_agent = CodenamesRandomAgent()
                    action = await ai_agent.decide(state, actions)
                    word = state.board[action.value].word if action != CodenamesAction.PASS else "PASS"
                    console.print(f"[dim]AI guesses: {word}[/dim]")
                    state, _, _ = await env.step(action)

        console.print("\n[bold]Game Over![/bold]")
        console.print(env.render(state))
        if state.winner:
            console.print(f"Winner: {state.winner.name}")

    asyncio.run(run())


@app.command()
def benchmark(
    episodes: int = typer.Option(100, help="Games to play"),
) -> None:
    """Benchmark guesser strategies."""

    async def run() -> None:
        config = CodenamesConfig(train_role=Role.GUESSER)

        agents = [
            ("Random", CodenamesRandomAgent()),
            ("Heuristic", CodenamesGuesserAgent()),
        ]

        results: list[dict] = []

        for agent_name, agent in agents:
            console.print(f"[cyan]Benchmarking {agent_name}...[/cyan]")

            env = CodenamesEnvironment(config)
            await env.initialize()

            wins = 0
            total_guesses = 0
            correct_guesses = 0

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                console=console,
            ) as progress:
                task = progress.add_task(agent_name, total=episodes)

                for ep in range(episodes):
                    state = await env.reset(seed=ep)
                    ep_guesses = 0
                    ep_correct = 0

                    while not state.is_terminal():
                        if state.current_role == Role.GUESSER:
                            actions = env.get_available_actions(state)
                            if not actions:
                                break

                            action = await agent.decide(state, actions)
                            old_remaining = (
                                state.red_remaining
                                if state.current_team == Team.RED
                                else state.blue_remaining
                            )

                            state, reward, _ = await env.step(action)

                            if action != CodenamesAction.PASS:
                                ep_guesses += 1
                                new_remaining = (
                                    state.red_remaining
                                    if state.current_team == Team.RED
                                    else state.blue_remaining
                                )
                                if new_remaining < old_remaining:
                                    ep_correct += 1
                        else:
                            await env._generate_opponent_clue()
                            state = env._current_state

                    if state.winner == config.train_team:
                        wins += 1

                    total_guesses += ep_guesses
                    correct_guesses += ep_correct
                    progress.update(task, advance=1)

            results.append({
                "agent": agent_name,
                "wins": wins,
                "win_rate": wins / episodes,
                "total_guesses": total_guesses,
                "accuracy": correct_guesses / max(total_guesses, 1),
            })

        table = Table(title="Codenames Benchmark")
        table.add_column("Agent")
        table.add_column("Wins", justify="right")
        table.add_column("Win Rate", justify="right")
        table.add_column("Guess Accuracy", justify="right")

        for r in results:
            table.add_row(
                r["agent"],
                str(r["wins"]),
                f"{r['win_rate']:.1%}",
                f"{r['accuracy']:.1%}",
            )

        console.print("\n")
        console.print(table)

    asyncio.run(run())


@app.command()
def train(
    steps: int = typer.Option(50, help="Training steps"),
    rollouts: int = typer.Option(8, help="Rollouts per group"),
    role: str = typer.Option("guesser", help="Role to train"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct"),
) -> None:
    """Run GRPO training."""

    async def run() -> None:
        train_role = Role.SPYMASTER if role == "spymaster" else Role.GUESSER
        config = CodenamesConfig(train_role=train_role)
        env = CodenamesEnvironment(config)

        if train_role == Role.GUESSER:
            agent = CodenamesGuesserAgent(model_name=model)
        else:
            agent = CodenamesSpymasterAgent(model_name=model)

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
    role: str = typer.Option("guesser", help="Role to train"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct"),
) -> None:
    """Full training pipeline."""

    async def run() -> None:
        train_role = Role.SPYMASTER if role == "spymaster" else Role.GUESSER
        config = CodenamesConfig(train_role=train_role)
        env = CodenamesEnvironment(config)

        if train_role == Role.GUESSER:
            agent = CodenamesGuesserAgent(model_name=model)
        else:
            agent = CodenamesSpymasterAgent(model_name=model)

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
