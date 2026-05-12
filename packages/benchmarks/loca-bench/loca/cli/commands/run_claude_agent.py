# Copyright 2025 LOCA-bench Contributors. All Rights Reserved.
#
# Licensed under the MIT License.

"""Run Claude Agent SDK command for LOCA-bench CLI."""

import os
import sys
from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from loca.cli.utils.config_resolver import (
    PROJECT_ROOT,
    resolve_config_path,
)
from loca.cli.utils.output_builder import (
    build_claude_agent_output_dir,
    build_task_dir,
)

console = Console()


def run_claude_agent_command(
    # Core Configuration
    config_file: Annotated[
        str,
        typer.Option(
            "--config-file",
            "-c",
            help="Configuration JSON filename or absolute path.",
            rich_help_panel="Core Configuration",
        ),
    ],
    # Execution
    max_workers: Annotated[
        int,
        typer.Option(
            "--max-workers",
            help="Number of parallel workers.",
            rich_help_panel="Execution",
        ),
    ] = 20,
    max_tool_uses: Annotated[
        int,
        typer.Option(
            "--max-tool-uses",
            help="Maximum tool uses per episode.",
            rich_help_panel="Execution",
        ),
    ] = 100,
    # Context Management
    use_clear_tool_uses: Annotated[
        bool,
        typer.Option(
            "--use-clear-tool-uses/--no-use-clear-tool-uses",
            help="Enable clearing old tool uses when context exceeds threshold.",
            rich_help_panel="Context Management",
        ),
    ] = False,
    use_clear_tool_results: Annotated[
        bool,
        typer.Option(
            "--use-clear-tool-results/--no-use-clear-tool-results",
            help="Enable clearing tool results with tool inputs.",
            rich_help_panel="Context Management",
        ),
    ] = False,
    api_max_input_tokens: Annotated[
        int,
        typer.Option(
            "--api-max-input-tokens",
            help="Token threshold to trigger clearing.",
            rich_help_panel="Context Management",
        ),
    ] = 180000,
    api_target_input_tokens: Annotated[
        int,
        typer.Option(
            "--api-target-input-tokens",
            help="Target tokens to keep after clearing.",
            rich_help_panel="Context Management",
        ),
    ] = 40000,
    # Prompt Caching
    disable_prompt_caching: Annotated[
        bool,
        typer.Option(
            "--disable-prompt-caching/--no-disable-prompt-caching",
            help="Disable prompt caching.",
            rich_help_panel="Prompt Caching",
        ),
    ] = False,
    # Compaction
    disable_compact: Annotated[
        bool,
        typer.Option(
            "--disable-compact/--no-disable-compact",
            help="Disable SDK-side auto-compaction.",
            rich_help_panel="Compaction",
        ),
    ] = False,
    autocompact_pct: Annotated[
        int,
        typer.Option(
            "--autocompact-pct",
            help="Percentage of context to trigger compaction.",
            rich_help_panel="Compaction",
        ),
    ] = 80,
    # API Settings
    model: Annotated[
        Optional[str],
        typer.Option(
            "--model",
            "-m",
            help="Model name for Claude Agent SDK / Anthropic-compatible endpoints.",
            rich_help_panel="API Settings",
        ),
    ] = None,
) -> None:
    """Run evaluations using the Claude Agent SDK.

    This command runs inference using Claude's Agent SDK with MCP tools,
    supporting context management, prompt caching, and auto-compaction.

    Example:
        loca run-claude-agent -c task-configs/final_8k_set_config.json
    """
    # Read API key from environment
    api_key = os.environ.get("LOCA_ANTHROPIC_API_KEY", "")
    base_url = os.environ.get("LOCA_ANTHROPIC_BASE_URL", "") or os.environ.get("ANTHROPIC_BASE_URL", "")
    effective_model = model or os.environ.get("ANTHROPIC_MODEL", "")
    if not api_key:
        console.print(
            "[red]Error:[/red] LOCA_ANTHROPIC_API_KEY environment variable is not set."
        )
        raise typer.Exit(1)

    # Set auth env vars for Claude Agent SDK
    os.environ["ANTHROPIC_AUTH_TOKEN"] = api_key
    os.environ["ANTHROPIC_API_KEY"] = ""
    if base_url:
        os.environ["ANTHROPIC_BASE_URL"] = base_url
    else:
        os.environ.pop("ANTHROPIC_BASE_URL", None)
    if effective_model:
        os.environ["ANTHROPIC_MODEL"] = effective_model

    # Set up PYTHONPATH
    mcp_convert_path = PROJECT_ROOT / "mcp-convert"
    pythonpath = os.environ.get("PYTHONPATH", "")
    new_paths = [str(PROJECT_ROOT), str(mcp_convert_path)]
    for path in new_paths:
        if path not in pythonpath:
            pythonpath = f"{path}:{pythonpath}" if pythonpath else path
    os.environ["PYTHONPATH"] = pythonpath

    # Add to sys.path for imports
    for path in new_paths:
        if path not in sys.path:
            sys.path.insert(0, path)

    # Resolve config path
    try:
        full_config_path = resolve_config_path(config_file)
    except FileNotFoundError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(1)

    # Build output directory
    final_output_dir = build_claude_agent_output_dir(
        config_file=config_file,
        model=effective_model or None,
        use_clear_tool_uses=use_clear_tool_uses,
        use_clear_tool_results=use_clear_tool_results,
        disable_prompt_caching=disable_prompt_caching,
        disable_compact=disable_compact,
        autocompact_pct=autocompact_pct,
    )

    # Build task directory
    task_dir = build_task_dir(final_output_dir)

    # Create directories
    final_output_dir.mkdir(parents=True, exist_ok=True)
    task_dir.mkdir(parents=True, exist_ok=True)

    # Print configuration
    table = Table(show_header=False, box=None)
    table.add_column("Key", style="cyan")
    table.add_column("Value")

    table.add_row("Config file", str(full_config_path))
    table.add_row("Max workers", str(max_workers))
    if effective_model:
        table.add_row("Model", effective_model)
    if base_url:
        table.add_row("Base URL", base_url)
    table.add_row("", "")
    table.add_row("[bold]Context Management[/bold]", "")
    table.add_row("  Clear tool uses", str(use_clear_tool_uses))
    table.add_row("  Clear tool results", str(use_clear_tool_results))
    table.add_row("  Max input tokens", str(api_max_input_tokens))
    table.add_row("  Target input tokens", str(api_target_input_tokens))
    table.add_row("", "")
    table.add_row("[bold]Caching & Compaction[/bold]", "")
    table.add_row("  Prompt caching", "disabled" if disable_prompt_caching else "enabled")
    table.add_row("  Compaction", "disabled" if disable_compact else "enabled")
    table.add_row("  Autocompact pct", f"{autocompact_pct}%")
    table.add_row("", "")
    table.add_row("[bold]Directories[/bold]", "")
    table.add_row("  Tasks", str(task_dir))
    table.add_row("  Outputs", str(final_output_dir))

    console.print(Panel(table, title="Starting Claude Agent SDK Inference", border_style="blue"))

    # Import and run the inference
    try:
        from inference.run_claude_agent import run_config_combinations
    except ImportError as e:
        console.print(f"[red]Error importing inference module:[/red] {e}")
        console.print("Make sure you're running from the project root directory.")
        raise typer.Exit(1)

    # Run the inference
    run_config_combinations(
        config_file=str(full_config_path),
        runs_per_config=1,
        base_task_dir=str(task_dir),
        output_dir=str(final_output_dir),
        model=effective_model or None,
        max_tool_uses=max_tool_uses,
        max_workers=max_workers,
        group_by_seed=True,
        use_clear_tool_uses=use_clear_tool_uses,
        use_clear_tool_results=use_clear_tool_results,
        api_max_input_tokens=api_max_input_tokens,
        api_target_input_tokens=api_target_input_tokens,
        disable_prompt_caching=disable_prompt_caching,
        disable_compact=disable_compact,
        autocompact_pct=autocompact_pct,
    )

    console.print()
    console.print(Panel(
        f"[green]Inference completed![/green]\nResults saved to: {final_output_dir}",
        border_style="green",
    ))
