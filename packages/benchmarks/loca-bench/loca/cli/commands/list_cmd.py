# Copyright 2025 LOCA-bench Contributors. All Rights Reserved.
#
# Licensed under the MIT License.

"""List commands for LOCA-bench CLI."""

from rich.console import Console
from rich.table import Table

from loca.cli.utils.config_resolver import Strategy, list_all_strategies

console = Console()


def list_strategies_command() -> None:
    """Show available context management strategies.

    Lists all supported strategies with their descriptions.

    Example:
        loca list-strategies
    """
    strategies_info = {
        Strategy.REACT: (
            "Basic reactive agent without special context management. "
            "The default strategy for standard evaluations.",
            "None (base tools only)"
        ),
        Strategy.PTC: (
            "Programmatic Tool Calling - orchestrate tools by executing code "
            "rather than individual tool calls.",
            "programmatic_tool_calling"
        ),
        Strategy.MEMORY_TOOL: (
            "Memory Tool - persistent storage and retrieval across conversations "
            "for long-running tasks.",
            "memory_tool"
        ),
    }

    table = Table(title="Available Strategies", show_header=True)
    table.add_column("Strategy", style="cyan")
    table.add_column("Description")
    table.add_column("Additional MCP Server", style="dim")

    for strategy in list_all_strategies():
        description, server = strategies_info.get(strategy, ("No description", ""))
        table.add_row(strategy.value, description, server)

    console.print(table)
