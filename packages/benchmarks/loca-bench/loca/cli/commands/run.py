# Copyright 2025 LOCA-bench Contributors. All Rights Reserved.
#
# Licensed under the MIT License.

"""Run command for LOCA-bench CLI."""

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
    Strategy,
    resolve_config_path,
)
from loca.cli.utils.output_builder import (
    build_output_dir,
    build_task_dir,
)
from loca.cli.utils.strategy_injector import inject_strategy_servers

console = Console()


def run_command(
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
    strategy: Annotated[
        Strategy,
        typer.Option(
            "--strategy",
            "-s",
            help="Context management strategy.",
            rich_help_panel="Core Configuration",
        ),
    ] = Strategy.REACT,
    output_dir: Annotated[
        Optional[str],
        typer.Option(
            "--output-dir",
            "-o",
            help="Output directory (auto-constructed if not specified).",
            rich_help_panel="Core Configuration",
        ),
    ] = None,
    resume_dir: Annotated[
        Optional[str],
        typer.Option(
            "--resume-dir",
            help="Resume from existing output directory. Use 'true' to auto-construct path.",
            rich_help_panel="Core Configuration",
        ),
    ] = None,
    # API Settings
    model: Annotated[
        str,
        typer.Option(
            "--model",
            "-m",
            help="Model name.",
            rich_help_panel="API Settings",
        ),
    ] = "deepseek-reasoner",
    max_tokens: Annotated[
        int,
        typer.Option(
            "--max-tokens",
            help="Maximum tokens per generation.",
            rich_help_panel="API Settings",
        ),
    ] = 32768,
    timeout: Annotated[
        int,
        typer.Option(
            "--timeout",
            help="API request timeout in seconds.",
            rich_help_panel="API Settings",
        ),
    ] = 600,
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
    ] = 500,
    max_retries: Annotated[
        int,
        typer.Option(
            "--max-retries",
            help="Maximum API retry attempts.",
            rich_help_panel="Execution",
        ),
    ] = 50,
    initial_retry_delay: Annotated[
        float,
        typer.Option(
            "--initial-retry-delay",
            help="Initial delay between retries in seconds.",
            rich_help_panel="Execution",
        ),
    ] = 2.0,
    # Context Editing (Tool-result)
    context_reset: Annotated[
        bool,
        typer.Option(
            "--context-reset/--no-context-reset",
            help="Enable context reset - removes past tool outputs when context exceeds threshold.",
            rich_help_panel="Context Editing (Tool-result)",
        ),
    ] = False,
    reset_size: Annotated[
        int,
        typer.Option(
            "--reset-size",
            help="Context threshold in tokens for reset.",
            rich_help_panel="Context Editing (Tool-result)",
        ),
    ] = 200000,
    reset_ratio: Annotated[
        float,
        typer.Option(
            "--reset-ratio",
            help="Ratio of context to keep after reset (0.0-1.0).",
            rich_help_panel="Context Editing (Tool-result)",
        ),
    ] = 0.5,
    # Context Editing (Thinking)
    thinking_reset: Annotated[
        bool,
        typer.Option(
            "--thinking-reset/--no-thinking-reset",
            help="Enable thinking-block clearing - removes prior reasoning content after threshold.",
            rich_help_panel="Context Editing (Thinking)",
        ),
    ] = False,
    keep_thinking: Annotated[
        int,
        typer.Option(
            "--keep-thinking",
            help="Number of recent thinking traces to retain.",
            rich_help_panel="Context Editing (Thinking)",
        ),
    ] = 1,
    # Context Compaction
    context_summary: Annotated[
        bool,
        typer.Option(
            "--context-summary/--no-context-summary",
            help="Enable context compaction - prompts model to summarize conversation history.",
            rich_help_panel="Context Compaction",
        ),
    ] = False,
    # Context Awareness
    context_awareness: Annotated[
        bool,
        typer.Option(
            "--context-awareness/--no-context-awareness",
            help="Enable context awareness - provides real-time feedback on remaining context capacity.",
            rich_help_panel="Context Awareness",
        ),
    ] = False,
    max_context_size: Annotated[
        int,
        typer.Option(
            "--max-context-size",
            help="Maximum context window size in tokens.",
            rich_help_panel="Context Awareness",
        ),
    ] = 128000,
    memory_warning_threshold: Annotated[
        float,
        typer.Option(
            "--memory-warning-threshold",
            help="Threshold for memory warnings (0.0-1.0).",
            rich_help_panel="Context Awareness",
        ),
    ] = 0.5,
    # Reasoning
    reasoning_effort: Annotated[
        Optional[str],
        typer.Option(
            "--reasoning-effort",
            help="Reasoning effort: none|minimal|low|medium|high|xhigh.",
            rich_help_panel="Reasoning",
        ),
    ] = None,
    reasoning_max_tokens: Annotated[
        Optional[int],
        typer.Option(
            "--reasoning-max-tokens",
            help="Reasoning token limit.",
            rich_help_panel="Reasoning",
        ),
    ] = None,
    reasoning_enabled: Annotated[
        bool,
        typer.Option(
            "--reasoning-enabled/--no-reasoning-enabled",
            help="Enable reasoning.",
            rich_help_panel="Reasoning",
        ),
    ] = True,
    reasoning_exclude: Annotated[
        bool,
        typer.Option(
            "--reasoning-exclude/--no-reasoning-exclude",
            help="Exclude reasoning tokens from context.",
            rich_help_panel="Reasoning",
        ),
    ] = False,
) -> None:
    """Run evaluations on benchmark tasks.

    This command runs the inference pipeline on configured benchmark tasks,
    supporting various context management strategies.

    Example:
        loca run -c task-configs/final_8k_set_config.json -m gpt-4
    """
    # Read API settings from environment variables
    api_key = os.environ.get("LOCA_OPENAI_API_KEY", "")
    base_url = os.environ.get("LOCA_OPENAI_BASE_URL", "")

    if not api_key:
        console.print("[red]Error:[/red] LOCA_OPENAI_API_KEY environment variable is not set.")
        raise typer.Exit(1)
    if not base_url:
        console.print("[red]Error:[/red] LOCA_OPENAI_BASE_URL environment variable is not set.")
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
    if output_dir:
        final_output_dir = Path(output_dir).resolve()
    else:
        try:
            final_output_dir = build_output_dir(
                config_file=config_file,
                strategy=strategy,
                model=model,
                context_reset=context_reset,
                context_summary=context_summary,
                context_awareness=context_awareness,
                thinking_reset=thinking_reset,
                reset_size=reset_size,
                reset_ratio=reset_ratio,
                max_context_size=max_context_size,
                memory_warning_threshold=memory_warning_threshold,
                keep_thinking=keep_thinking,
                reasoning_effort=reasoning_effort,
                reasoning_max_tokens=reasoning_max_tokens,
                resume_dir=resume_dir,
            )
        except FileNotFoundError as e:
            console.print(f"[red]Error:[/red] {e}")
            raise typer.Exit(1)

    # Build task directory
    task_dir = build_task_dir(final_output_dir)

    # Create directories
    final_output_dir.mkdir(parents=True, exist_ok=True)
    task_dir.mkdir(parents=True, exist_ok=True)

    # Inject strategy-specific MCP servers into config
    effective_config_path = final_output_dir / f"config_{strategy.value}.json"
    inject_strategy_servers(full_config_path, strategy, effective_config_path)

    # Print configuration
    is_resume = resume_dir is not None
    title = "Starting Parallel Inference (RESUME MODE)" if is_resume else "Starting Parallel Inference"

    table = Table(show_header=False, box=None)
    table.add_column("Key", style="cyan")
    table.add_column("Value")

    table.add_row("Strategy", strategy.value)
    table.add_row("Config file", str(full_config_path))
    table.add_row("Max workers", str(max_workers))
    table.add_row("", "")
    table.add_row("[bold]Model Configuration[/bold]", "")
    table.add_row("  Base URL", base_url)
    table.add_row("  Model", model)
    table.add_row("  Max tokens", str(max_tokens))
    table.add_row("  Max context", str(max_context_size))
    table.add_row("", "")
    table.add_row("[bold]Context Management[/bold]", "")
    table.add_row("  Context reset", str(context_reset))
    if context_reset:
        table.add_row("    Reset size", str(reset_size))
        table.add_row("    Reset ratio", str(reset_ratio))
    table.add_row("  Thinking reset", str(thinking_reset))
    if thinking_reset:
        table.add_row("    Keep thinking", str(keep_thinking))
    table.add_row("  Context summary", str(context_summary))
    table.add_row("  Context awareness", str(context_awareness))
    if context_awareness:
        table.add_row("    Memory warning", str(memory_warning_threshold))
    table.add_row("", "")
    table.add_row("[bold]Directories[/bold]", "")
    table.add_row("  Tasks", str(task_dir))
    table.add_row("  Outputs", str(final_output_dir))

    console.print(Panel(table, title=title, border_style="blue"))

    # Import and run the inference
    try:
        from inference.run_react import run_config_combinations
    except ImportError as e:
        console.print(f"[red]Error importing inference module:[/red] {e}")
        console.print("Make sure you're running from the project root directory.")
        raise typer.Exit(1)

    # Run the inference
    run_config_combinations(
        config_file=str(effective_config_path),
        runs_per_config=1,
        base_task_dir=str(task_dir),
        output_dir=str(final_output_dir),
        api_key=api_key or "",
        base_url=base_url or "",
        model=model,
        max_tool_uses=max_tool_uses,
        max_tokens=max_tokens,
        timeout=timeout,
        max_workers=max_workers,
        max_retries=max_retries,
        initial_retry_delay=initial_retry_delay,
        reset_size=reset_size,
        reset_ratio=reset_ratio,
        context_reset=context_reset,
        context_summary=context_summary,
        context_awareness=context_awareness,
        group_by_seed=True,  # Always use True internally
        max_context_size=max_context_size,
        memory_warning_threshold=memory_warning_threshold,
        thinking_reset=thinking_reset,
        keep_thinking=keep_thinking,
        reasoning_effort=reasoning_effort,
        reasoning_max_tokens=reasoning_max_tokens,
        reasoning_enabled=reasoning_enabled,
        reasoning_exclude=reasoning_exclude,
        resume_dir=str(final_output_dir) if is_resume else None,
    )

    console.print()
    console.print(Panel(
        f"[green]Inference completed![/green]\nResults saved to: {final_output_dir}",
        border_style="green",
    ))
