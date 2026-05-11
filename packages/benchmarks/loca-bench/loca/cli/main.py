# Copyright 2025 LOCA-bench Contributors. All Rights Reserved.
#
# Licensed under the MIT License.

"""Main LOCA-bench CLI application."""

from typing import Optional

import typer
from rich.console import Console

from loca import __version__
from loca.cli.commands import run, analyze, list_cmd, run_claude_api, run_claude_agent

console = Console()

app = typer.Typer(
    name="loca",
    help="LOCA-bench: Benchmark Language Agents Under Controllable and Extreme Context Growth",
    add_completion=False,
    no_args_is_help=True,
    rich_markup_mode="rich",
)


def version_callback(value: bool) -> None:
    """Print version and exit."""
    if value:
        console.print(f"loca version {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: Optional[bool] = typer.Option(
        None,
        "--version",
        "-v",
        help="Show version and exit.",
        callback=version_callback,
        is_eager=True,
    ),
) -> None:
    """LOCA-bench CLI for running and analyzing long-context agent benchmarks."""
    pass


# Register subcommands
app.command(name="run", help="Run evaluations on benchmark tasks.")(run.run_command)
app.command(name="analyze", help="Analyze benchmark results.")(analyze.analyze_command)
app.command(name="list-strategies", help="Show available strategies.")(
    list_cmd.list_strategies_command
)
app.command(name="run-claude-api", help="Run evaluations using Claude API directly.")(
    run_claude_api.run_claude_api_command
)
app.command(name="run-claude-agent", help="Run evaluations using Claude Agent SDK.")(
    run_claude_agent.run_claude_agent_command
)


if __name__ == "__main__":
    app()
