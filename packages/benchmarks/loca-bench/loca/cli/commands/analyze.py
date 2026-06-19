# Copyright 2025 LOCA-bench Contributors. All Rights Reserved.
#
# Licensed under the MIT License.

"""Analyze command for LOCA-bench CLI."""

import subprocess
import sys
from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.console import Console

from loca.cli.utils.config_resolver import PROJECT_ROOT

console = Console()

# Path to the analysis script
ANALYSIS_SCRIPT = PROJECT_ROOT / "inference" / "ana_all_configs.py"


def analyze_command(
    input_dir: Annotated[
        str,
        typer.Option(
            "--input",
            "-i",
            help="Input directory containing benchmark results (with config_* subdirectories).",
        ),
    ],
    output_dir: Annotated[
        Optional[str],
        typer.Option(
            "--output",
            "-o",
            help="Output directory for analysis results (defaults to input directory's parent).",
        ),
    ] = None,
) -> None:
    """Analyze benchmark results.

    This command analyzes the results from a benchmark run, computing
    accuracy, token usage, costs, and other statistics.

    Example:
        loca analyze --input /path/to/benchmark/results
    """
    # Validate input directory
    input_path = Path(input_dir)
    if not input_path.is_dir():
        console.print(f"[red]Error:[/red] Input directory does not exist: {input_dir}")
        raise typer.Exit(1)

    # Check for task subdirectories (supports multiple layouts):
    #   - New: tasks/TaskName/stateN/trajectory.json
    #   - Mid: tasks/config_*/run_*/trajectory.json
    #   - Old: config_*/*.json
    tasks_dir = input_path / "tasks"
    if tasks_dir.is_dir():
        scan_dir = tasks_dir
    else:
        scan_dir = input_path

    config_dirs = [d for d in scan_dir.iterdir() if d.is_dir()]

    if not config_dirs:
        console.print(
            f"[red]Error:[/red] No task subdirectories found in: {scan_dir}"
        )
        console.print("Make sure this is a valid benchmark output directory.")
        raise typer.Exit(1)

    # Validate analysis script exists
    if not ANALYSIS_SCRIPT.is_file():
        console.print(
            f"[red]Error:[/red] Analysis script not found: {ANALYSIS_SCRIPT}"
        )
        raise typer.Exit(1)

    # Build command
    cmd = [sys.executable, str(ANALYSIS_SCRIPT), "--input", str(input_path)]
    if output_dir:
        cmd.extend(["--output", output_dir])

    console.print(f"[blue]Analyzing results in:[/blue] {input_path}")
    if output_dir:
        console.print(f"[blue]Output directory:[/blue] {output_dir}")
    else:
        console.print(f"[blue]Output directory:[/blue] {input_path.parent}")
    console.print()

    # Run the analysis script
    try:
        result = subprocess.run(
            cmd,
            cwd=str(PROJECT_ROOT),
            check=False,
        )
        if result.returncode != 0:
            raise typer.Exit(result.returncode)
    except KeyboardInterrupt:
        console.print("\n[yellow]Analysis interrupted.[/yellow]")
        raise typer.Exit(130)
    except Exception as e:
        console.print(f"[red]Error running analysis:[/red] {e}")
        raise typer.Exit(1)
