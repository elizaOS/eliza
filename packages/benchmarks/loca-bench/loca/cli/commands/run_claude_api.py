# Copyright 2025 LOCA-bench Contributors. All Rights Reserved.
#
# Licensed under the MIT License.

"""Run Claude API command for LOCA-bench CLI."""

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
    build_claude_api_output_dir,
    build_task_dir,
)

console = Console()


def run_claude_api_command(
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
    # API Settings
    model: Annotated[
        str,
        typer.Option(
            "--model",
            "-m",
            help="Claude model name.",
            rich_help_panel="API Settings",
        ),
    ] = "claude-sonnet-4-5",
    max_tokens: Annotated[
        int,
        typer.Option(
            "--max-tokens",
            help="Maximum tokens per generation.",
            rich_help_panel="API Settings",
        ),
    ] = 4096,
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
    # Extended Thinking
    enable_thinking: Annotated[
        bool,
        typer.Option(
            "--enable-thinking/--no-enable-thinking",
            help="Enable extended thinking mode.",
            rich_help_panel="Extended Thinking",
        ),
    ] = False,
    thinking_budget_tokens: Annotated[
        int,
        typer.Option(
            "--thinking-budget-tokens",
            help="Maximum tokens for thinking budget.",
            rich_help_panel="Extended Thinking",
        ),
    ] = 10000,
    # Context Management (Tool Uses)
    use_clear_tool_uses: Annotated[
        bool,
        typer.Option(
            "--use-clear-tool-uses/--no-use-clear-tool-uses",
            help="Enable clear_tool_uses feature.",
            rich_help_panel="Context Management",
        ),
    ] = False,
    clear_trigger_tokens: Annotated[
        int,
        typer.Option(
            "--clear-trigger-tokens",
            help="Token threshold to trigger clearing.",
            rich_help_panel="Context Management",
        ),
    ] = 180000,
    clear_keep_tool_uses: Annotated[
        int,
        typer.Option(
            "--clear-keep-tool-uses",
            help="Number of tool uses to keep after clearing.",
            rich_help_panel="Context Management",
        ),
    ] = 3,
    clear_at_least_tokens: Annotated[
        int,
        typer.Option(
            "--clear-at-least-tokens",
            help="Minimum tokens to clear.",
            rich_help_panel="Context Management",
        ),
    ] = 5000,
    # Context Management (Thinking)
    use_clear_thinking: Annotated[
        bool,
        typer.Option(
            "--use-clear-thinking/--no-use-clear-thinking",
            help="Enable clear_thinking feature.",
            rich_help_panel="Context Management",
        ),
    ] = False,
    clear_keep_thinking_turns: Annotated[
        int,
        typer.Option(
            "--clear-keep-thinking-turns",
            help="Number of thinking turns to keep.",
            rich_help_panel="Context Management",
        ),
    ] = 2,
    # Code Execution
    enable_code_execution: Annotated[
        bool,
        typer.Option(
            "--enable-code-execution/--no-enable-code-execution",
            help="Enable code_execution tool for Bash and file operations.",
            rich_help_panel="Code Execution",
        ),
    ] = False,
    enable_programmatic_tool_calling: Annotated[
        bool,
        typer.Option(
            "--enable-programmatic-tool-calling/--no-enable-programmatic-tool-calling",
            help="Enable Claude's official programmatic tool calling.",
            rich_help_panel="Code Execution",
        ),
    ] = False,
    # Context Trimming
    max_context_size: Annotated[
        Optional[int],
        typer.Option(
            "--max-context-size",
            help="Maximum context size in tokens for message trimming.",
            rich_help_panel="Context Trimming",
        ),
    ] = None,
) -> None:
    """Run evaluations using the Claude API directly.

    This command runs inference using Claude's native API with MCP tools,
    supporting extended thinking, context management, and programmatic tool calling.

    Example:
        loca run-claude-api -c task-configs/final_8k_set_config.json -m claude-sonnet-4-5
    """
    # Read API key from environment
    api_key = os.environ.get("LOCA_ANTHROPIC_API_KEY", "")
    base_url = os.environ.get("LOCA_ANTHROPIC_BASE_URL", "") or os.environ.get("ANTHROPIC_BASE_URL", "")
    if not api_key:
        console.print(
            "[red]Error:[/red] LOCA_ANTHROPIC_API_KEY environment variable is not set."
        )
        raise typer.Exit(1)

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
    final_output_dir = build_claude_api_output_dir(
        config_file=config_file,
        model=model,
        enable_thinking=enable_thinking,
        use_clear_tool_uses=use_clear_tool_uses,
        use_clear_thinking=use_clear_thinking,
        enable_code_execution=enable_code_execution,
        enable_programmatic_tool_calling=enable_programmatic_tool_calling,
        max_context_size=max_context_size,
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
    table.add_row("", "")
    table.add_row("[bold]Model Configuration[/bold]", "")
    table.add_row("  Model", model)
    table.add_row("  Max tokens", str(max_tokens))
    if base_url:
        table.add_row("  Base URL", base_url)
    table.add_row("", "")
    table.add_row("[bold]Extended Thinking[/bold]", "")
    table.add_row("  Enabled", str(enable_thinking))
    if enable_thinking:
        table.add_row("  Budget tokens", str(thinking_budget_tokens))
    table.add_row("", "")
    table.add_row("[bold]Context Management[/bold]", "")
    table.add_row("  Clear tool uses", str(use_clear_tool_uses))
    if use_clear_tool_uses:
        table.add_row("    Trigger tokens", str(clear_trigger_tokens))
        table.add_row("    Keep tool uses", str(clear_keep_tool_uses))
        table.add_row("    Clear at least tokens", str(clear_at_least_tokens))
    table.add_row("  Clear thinking", str(use_clear_thinking))
    if use_clear_thinking:
        table.add_row("    Keep thinking turns", str(clear_keep_thinking_turns))
    table.add_row("", "")
    table.add_row("[bold]Code Execution[/bold]", "")
    table.add_row("  Code execution", str(enable_code_execution))
    table.add_row("  Programmatic tool calling", str(enable_programmatic_tool_calling))
    if max_context_size is not None:
        table.add_row("", "")
        table.add_row("[bold]Context Trimming[/bold]", "")
        table.add_row("  Max context size", f"{max_context_size:,}")
    table.add_row("", "")
    table.add_row("[bold]Directories[/bold]", "")
    table.add_row("  Tasks", str(task_dir))
    table.add_row("  Outputs", str(final_output_dir))

    console.print(Panel(table, title="Starting Claude API Inference", border_style="blue"))

    # Import and run the inference
    try:
        from inference.run_claude_api import run_config_combinations
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
        api_key=api_key,
        base_url=base_url or None,
        model=model,
        max_tool_uses=max_tool_uses,
        max_tokens=max_tokens,
        max_workers=max_workers,
        group_by_seed=True,
        enable_thinking=enable_thinking,
        thinking_budget_tokens=thinking_budget_tokens,
        use_clear_tool_uses=use_clear_tool_uses,
        clear_trigger_tokens=clear_trigger_tokens,
        clear_keep_tool_uses=clear_keep_tool_uses,
        clear_at_least_tokens=clear_at_least_tokens,
        use_clear_thinking=use_clear_thinking,
        clear_keep_thinking_turns=clear_keep_thinking_turns,
        enable_code_execution=enable_code_execution,
        enable_programmatic_tool_calling=enable_programmatic_tool_calling,
        max_context_size=max_context_size,
    )

    console.print()
    console.print(Panel(
        f"[green]Inference completed![/green]\nResults saved to: {final_output_dir}",
        border_style="green",
    ))
