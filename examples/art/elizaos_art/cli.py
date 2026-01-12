"""
Main CLI for ElizaOS ART demos.

Provides unified commands across all games.
"""

import asyncio
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

app = typer.Typer(
    name="elizaos-art",
    help="ElizaOS ART (Adaptive Reinforcement Training) - Train LLMs with GRPO",
)
console = Console()


@app.command("list")
def list_games() -> None:
    """List all available games/environments."""
    table = Table(title="Available ART Games")
    table.add_column("Game", style="cyan")
    table.add_column("Description")
    table.add_column("Command")

    games = [
        ("2048", "Tile-merging puzzle game", "elizaos-art-2048"),
        ("Tic-Tac-Toe", "Classic strategy game", "elizaos-art-tictactoe"),
        ("Codenames", "Word association game", "elizaos-art-codenames"),
        ("Temporal Clue", "Temporal reasoning puzzles", "elizaos-art-temporal"),
    ]

    for name, desc, cmd in games:
        table.add_row(name, desc, cmd)

    console.print(table)
    console.print("\n[dim]Use --help on any command for more options[/dim]")


@app.command()
def status() -> None:
    """Show training status across all games."""
    table = Table(title="Training Status")
    table.add_column("Game", style="cyan")
    table.add_column("Step")
    table.add_column("Best Reward")
    table.add_column("Checkpoint")

    checkpoint_dirs = [
        ("2048", Path("checkpoints/game_2048")),
        ("Tic-Tac-Toe", Path("checkpoints/tic_tac_toe")),
        ("Codenames", Path("checkpoints/codenames")),
        ("Temporal Clue", Path("checkpoints/temporal_clue")),
    ]

    for name, checkpoint_dir in checkpoint_dirs:
        state_file = checkpoint_dir / "training_state.json"
        if state_file.exists():
            import json

            with open(state_file) as f:
                state = json.load(f)
            table.add_row(
                name,
                str(state.get("step", 0)),
                f"{state.get('best_reward', 0):.2f}",
                "[green]✓[/green]",
            )
        else:
            table.add_row(name, "-", "-", "[dim]None[/dim]")

    console.print(table)


@app.command("benchmark")
def benchmark_all(
    episodes: int = typer.Option(100, help="Episodes per game"),
    output_dir: str = typer.Option("./benchmark_results/art", help="Output directory"),
) -> None:
    """Run baseline benchmarks across all games."""
    from elizaos_art.benchmark_runner import run_baselines

    console.print(f"\n[bold]Running baseline benchmarks[/bold]")
    console.print(f"Episodes per game: {episodes}\n")

    asyncio.run(run_baselines(episodes=episodes, output_dir=output_dir))


@app.command("train-all")
def train_all(
    steps: int = typer.Option(50, help="Training steps per game"),
    eval_episodes: int = typer.Option(50, help="Evaluation episodes"),
    model: str = typer.Option(
        "meta-llama/Llama-3.2-3B-Instruct",
        help="Model to train",
    ),
    output_dir: str = typer.Option("./benchmark_results/art", help="Output directory"),
) -> None:
    """Run full training pipelines for all games."""
    from elizaos_art.benchmark_runner import run_pipelines

    console.print(f"\n[bold]Running training pipelines[/bold]")
    console.print(f"Model: {model}")
    console.print(f"Steps per game: {steps}")
    console.print(f"Evaluation episodes: {eval_episodes}\n")

    asyncio.run(
        run_pipelines(
            model=model,
            steps=steps,
            eval_episodes=eval_episodes,
            output_dir=output_dir,
        )
    )


@app.command()
def clean(
    confirm: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation"),
) -> None:
    """Clean all checkpoints and results."""
    if not confirm:
        confirm = typer.confirm("Delete all checkpoints and results?")

    if confirm:
        import shutil

        for path in [Path("checkpoints"), Path("results"), Path("benchmark_results/art")]:
            if path.exists():
                shutil.rmtree(path)
                console.print(f"[yellow]Deleted {path}[/yellow]")

        console.print("[green]Cleanup complete[/green]")


@app.command()
def info() -> None:
    """Show information about supported models and configuration."""
    console.print("\n[bold cyan]ElizaOS ART - Adaptive Reinforcement Training[/bold cyan]\n")

    console.print("[bold]Supported Local Models:[/bold]")
    models_table = Table(show_header=True)
    models_table.add_column("Model")
    models_table.add_column("Parameters")
    models_table.add_column("Best For")
    models_table.add_row(
        "meta-llama/Llama-3.2-1B-Instruct",
        "1B",
        "Fast iteration, testing",
    )
    models_table.add_row(
        "meta-llama/Llama-3.2-3B-Instruct",
        "3B",
        "Production training",
    )
    console.print(models_table)

    console.print("\n[bold]Training Pipeline:[/bold]")
    console.print("  1. Baseline evaluation (vanilla model)")
    console.print("  2. Trajectory rollout with current model")
    console.print("  3. RULER scoring (LLM-as-judge ranking)")
    console.print("  4. GRPO training (update weights)")
    console.print("  5. Checkpoint (save progress)")
    console.print("  6. Final evaluation")
    console.print("  7. Comparison report")

    console.print("\n[bold]Environment Variables:[/bold]")
    console.print("  OPENAI_API_KEY    - For RULER judge (OpenAI)")
    console.print("  ANTHROPIC_API_KEY - For RULER judge (Claude)")
    console.print("  HF_TOKEN          - For downloading Llama models")

    console.print("\n[bold]Quick Start:[/bold]")
    console.print("  # Run baselines")
    console.print("  elizaos-art benchmark --episodes 100")
    console.print("")
    console.print("  # Train all games")
    console.print("  elizaos-art train-all --steps 50")
    console.print("")
    console.print("  # Train single game")
    console.print("  elizaos-art-2048 pipeline --steps 100")


if __name__ == "__main__":
    app()
