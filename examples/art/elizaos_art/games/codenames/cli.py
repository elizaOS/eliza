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
from elizaos_art.games.codenames.agent import CodenamesAgent, CodenamesGuesserAgent
from elizaos_art.games.codenames.environment import CodenamesEnvironment
from elizaos_art.games.codenames.types import CodenamesAction, CodenamesConfig, CardColor, Role
from elizaos_art.trainer import GRPOTrainer

app = typer.Typer(
    name="elizaos-art-codenames",
    help="Codenames game training with ART/GRPO",
)
console = Console()


@app.command()
def play(
    episodes: int = typer.Option(5, help="Number of episodes"),
    role: str = typer.Option("guesser", help="Role: guesser or spymaster"),
    delay: float = typer.Option(1.0, help="Delay between moves"),
    seed: int | None = typer.Option(None, help="Random seed"),
) -> None:
    """Watch an agent play Codenames."""

    async def run() -> None:
        ai_role = Role.SPYMASTER if role == "spymaster" else Role.GUESSER
        config = CodenamesConfig(ai_role=ai_role, ai_team=CardColor.RED)
        env = CodenamesEnvironment(config)
        await env.initialize()

        agent = CodenamesGuesserAgent() if ai_role == Role.GUESSER else CodenamesAgent()

        console.print(f"\n[bold]Codenames - {episodes} episodes as {role}[/bold]\n")

        wins = 0
        losses = 0

        for ep in range(episodes):
            state = await env.reset(seed=seed + ep if seed else None)
            console.print(f"\n[cyan]Episode {ep + 1}/{episodes}[/cyan]")

            while not state.game_over:
                console.print(env.render(state))

                actions = env.get_available_actions(state)
                if not actions:
                    break

                if state.current_team == config.ai_team:
                    action = await agent.decide(state, actions)
                    console.print(f"AI action: {action.name}")
                    state, reward, _ = await env.step(action)
                    console.print(f"Reward: {reward}")
                else:
                    # Opponent turn - simulate
                    state, _, _ = await env.step(actions[0])

                await asyncio.sleep(delay)

            # Game over
            console.print("\n" + env.render(state))
            if state.winner == config.ai_team:
                console.print("[green]WIN![/green]")
                wins += 1
            else:
                console.print("[red]LOSS[/red]")
                losses += 1

        console.print(f"\n[bold]Results: {wins} wins, {losses} losses[/bold]")

    asyncio.run(run())


@app.command()
def interactive(
    role: str = typer.Option("guesser", help="Your role: guesser or spymaster"),
) -> None:
    """Play Codenames interactively."""

    async def run() -> None:
        ai_role = Role.GUESSER if role == "guesser" else Role.SPYMASTER
        config = CodenamesConfig(ai_role=ai_role, ai_team=CardColor.RED)
        env = CodenamesEnvironment(config)
        await env.initialize()

        console.print("\n[bold]Codenames Interactive Mode[/bold]")
        console.print(f"You are the {role} for the RED team.\n")

        state = await env.reset()

        while not state.game_over:
            console.print(env.render(state))

            actions = env.get_available_actions(state)
            if not actions:
                break

            if state.current_role == ai_role and state.current_team == config.ai_team:
                # Player's turn
                console.print("\nYour turn!")

                if ai_role == Role.GUESSER:
                    user_input = console.input("Enter word number (or PASS): ").strip()

                    if user_input.upper() == "PASS":
                        action = CodenamesAction.PASS
                    else:
                        try:
                            idx = int(user_input)
                            action = CodenamesAction.from_word_index(idx)
                        except (ValueError, IndexError):
                            console.print("[red]Invalid input[/red]")
                            continue

                    state, reward, _ = await env.step(action)
                    console.print(f"Reward: {reward}\n")
                else:
                    # Spymaster gives clue
                    clue_word = console.input("Clue word: ").strip()
                    clue_num = int(console.input("Number: ").strip())

                    from elizaos_art.games.codenames.types import Clue

                    env.set_pending_clue(Clue(word=clue_word, number=clue_num))
                    state, _, _ = await env.step(CodenamesAction.GIVE_CLUE)
            else:
                # AI/opponent turn
                console.print("[dim]Opponent's turn...[/dim]")
                await asyncio.sleep(0.5)

                for action in actions:
                    if action not in (CodenamesAction.PASS, CodenamesAction.GIVE_CLUE):
                        state, _, _ = await env.step(action)
                        break
                else:
                    state, _, _ = await env.step(CodenamesAction.PASS)

        console.print("\n[bold]Game Over![/bold]")
        console.print(env.render(state))

        if state.winner == config.ai_team:
            console.print("[green]You win![/green]")
        else:
            console.print("[red]You lose![/red]")

    asyncio.run(run())


@app.command()
def benchmark(
    episodes: int = typer.Option(50, help="Episodes per configuration"),
) -> None:
    """Benchmark Codenames performance."""

    async def run() -> None:
        config = CodenamesConfig(ai_role=Role.GUESSER, ai_team=CardColor.RED)
        env = CodenamesEnvironment(config)
        await env.initialize()

        agent = CodenamesGuesserAgent()

        console.print(f"\n[bold]Benchmarking Codenames ({episodes} episodes)[/bold]\n")

        wins = 0
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

                while not state.game_over:
                    actions = env.get_available_actions(state)
                    if not actions:
                        break

                    if state.current_team == config.ai_team:
                        action = await agent.decide(state, actions)
                        state, reward, _ = await env.step(action)
                        episode_reward += reward
                    else:
                        state, _, _ = await env.step(actions[0])

                if state.winner == config.ai_team:
                    wins += 1
                total_reward += episode_reward
                progress.update(task, advance=1)

        console.print(f"\n[bold]Results[/bold]")
        console.print(f"  Win Rate: {wins / episodes:.1%}")
        console.print(f"  Avg Reward: {total_reward / episodes:.2f}")

    asyncio.run(run())


@app.command()
def train(
    steps: int = typer.Option(50, help="Training steps"),
    role: str = typer.Option("guesser", help="Role to train: guesser or spymaster"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct", help="Model"),
    resume: bool = typer.Option(False, help="Resume from checkpoint"),
) -> None:
    """Run GRPO training for Codenames."""

    async def run() -> None:
        ai_role = Role.SPYMASTER if role == "spymaster" else Role.GUESSER
        config = CodenamesConfig(ai_role=ai_role, ai_team=CardColor.RED)
        env = CodenamesEnvironment(config)
        agent = CodenamesAgent(model_name=model)

        trainer_config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            resume_from="./checkpoints/codenames" if resume else None,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=trainer_config)
        await trainer.initialize()
        await trainer.train(steps)

    asyncio.run(run())


@app.command()
def pipeline(
    steps: int = typer.Option(50, help="Training steps"),
    eval_episodes: int = typer.Option(50, help="Evaluation episodes"),
    role: str = typer.Option("guesser", help="Role: guesser or spymaster"),
    model: str = typer.Option("meta-llama/Llama-3.2-3B-Instruct", help="Model"),
    resume: bool = typer.Option(False, help="Resume from checkpoint"),
) -> None:
    """Run full training pipeline."""

    async def run() -> None:
        ai_role = Role.SPYMASTER if role == "spymaster" else Role.GUESSER
        config = CodenamesConfig(ai_role=ai_role, ai_team=CardColor.RED)
        env = CodenamesEnvironment(config)
        agent = CodenamesAgent(model_name=model)

        trainer_config = TrainingConfig(
            model_name=model,
            max_steps=steps,
            eval_episodes=eval_episodes,
            resume_from="./checkpoints/codenames" if resume else None,
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=trainer_config)
        results = await trainer.pipeline(steps, eval_episodes)

        console.print("\n[bold green]Pipeline Complete![/bold green]")
        console.print(f"Win rate improvement: {results['improvement']['win_rate']:+.1%}")

    asyncio.run(run())


if __name__ == "__main__":
    app()
