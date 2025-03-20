#!/usr/bin/env python3
import os
import sys
import json
from pathlib import Path
import logging

# Add the parent directory to sys.path for proper imports
sys.path.append(str(Path(__file__).parent.parent.parent))

# Setup logging first
def setup_logging():
    logs_dir = Path(__file__).parent / "logs"
    logs_dir.mkdir(exist_ok=True)

    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(logs_dir / "biome.log", encoding='utf-8'),
            logging.StreamHandler()
        ]
    )
    return logging.getLogger(__name__)

# Initialize logging
logger = setup_logging()

from typing import Dict, Any, List, Optional
import asyncio
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskID
from rich.markdown import Markdown
from rich.console import Console
import typer
import esprima
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from textual.app import App, ComposeResult
from textual.containers import Container
from textual.widgets import Button, Header, Footer, Static
from textual.binding import Binding

from utils.checkpoint_manager import CheckpointManager
from utils.node_manager import NodeManager
from utils.reporting import BiomeReportGenerator

# Initialize rich console
console = Console()
app = typer.Typer(help="ElizaOS Plugin Bug Hunter CLI")
checkpoint_manager = CheckpointManager()

class PluginAnalyzerApp(App):
    """A Textual app for analyzing ElizaOS plugins."""

    BINDINGS = [
        Binding("q", "quit", "Quit", show=True),
        Binding("s", "start_analysis", "Start Analysis", show=True),
        Binding("r", "resume_session", "Resume Session", show=True),
        Binding("v", "view_reports", "View Reports", show=True),
    ]

    def compose(self) -> ComposeResult:
        """Create child widgets for the app."""
        yield Header()
        yield Container(
            Static("Welcome to ElizaOS Plugin Bug Hunter", classes="title"),
            Button("Start New Analysis", variant="primary", id="start"),
            Button("Resume Previous Session", variant="default", id="resume"),
            Button("View Analysis Reports", variant="default", id="reports"),
            Button("Configure Analysis", variant="default", id="config"),
        )
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle button press events."""
        button_id = event.button.id
        if button_id == "start":
            self.action_start_analysis()
        elif button_id == "resume":
            self.action_resume_session()
        elif button_id == "reports":
            self.action_view_reports()
        elif button_id == "config":
            self.configure_analysis()

    def action_start_analysis(self) -> None:
        """Start a new analysis session."""
        self.exit(result=("start", None))

    def action_resume_session(self) -> None:
        """Resume a previous analysis session."""
        self.exit(result=("resume", None))

    async def view_reports(self) -> None:
        """View existing analysis reports."""
        reports_dir = Path("reports")
        if not reports_dir.exists():
            console.print("[red]No reports found![/red]")
            return

        for report_file in reports_dir.glob("*.md"):
            with open(report_file, "r", encoding="utf-8") as f:
                content = f.read()
                # Use rich's Markdown renderer
                console.print(Markdown(content))
                console.print("\n---\n")

def show_main_menu() -> tuple[str, Optional[str]]:
    """Show the main TUI menu and return the selected action."""
    app = PluginAnalyzerApp()
    return app.run()

def generate_analysis_report(analysis_result: Dict[str, Any]) -> str:
    """Generate a markdown report from analysis results."""
    # Create a new report generator
    report_gen = BiomeReportGenerator()

    # Parse Biome output
    biome_results = analysis_result.get("results", {}).get("biome", {})
    report_gen.parse_biome_output(
        biome_output=biome_results.get("output", ""),
        plugin_name=analysis_result.get("plugin_name", "unknown")
    )

    return report_gen.generate_markdown_report()

@app.command()
def start(
    plugins: Optional[List[str]] = typer.Option(None, "--plugins", "-p", help="Specific plugins to analyze"),
    config_path: Path = typer.Option(
        Path("config/analysis.config.json"), "--config", "-c",
        help="Analysis configuration file"
    ),
):
    """Start a new analysis session."""
    console.print(Panel("Starting new analysis session...", title="Bug Hunter"))

    # Get workspace root
    workspace_root = Path(__file__).parent.parent.parent

    # Initialize session and managers
    session_name = Prompt.ask("Enter session name", default="bug_hunt_session")
    checkpoint_manager.start_session(session_name)

    # Initialize and setup Node environment
    console.print("[yellow]Setting up Node.js environment...[/yellow]")
    node_manager = NodeManager(work_dir=str(workspace_root))

    # Load configuration
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            config_data = json.load(f)
    except FileNotFoundError:
        console.print(f"[red]Configuration file not found: {config_path}[/red]")
        config_data = {"plugins_dir": "packages", "exclude_patterns": []}

    # Initialize progress tracking
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
    ) as progress:

        # Find plugins to analyze using absolute path
        plugins_dir = workspace_root / config_data.get("plugins_dir", "packages")
        console.print(f"Looking for plugins in: {plugins_dir}")

        if plugins:
            plugin_paths = [plugins_dir / p for p in plugins]
        else:
            # Look for plugins with TypeScript files
            plugin_paths = []
            for plugin_dir in plugins_dir.glob("plugin-*"):
                if list(plugin_dir.glob("**/*.ts")) or list(plugin_dir.glob("**/*.tsx")):
                    plugin_paths.append(plugin_dir)
                    console.print(f"[green]Found TypeScript files in {plugin_dir.name}[/green]")

        if not plugin_paths:
            console.print("[red]No plugins with TypeScript files found![/red]")
            return

        # Create analysis task
        task = progress.add_task("Analyzing plugins...", total=len(plugin_paths))

        # Analyze each plugin
        for plugin_path in plugin_paths:
            progress.update(task, description=f"Analyzing {plugin_path.name}")

            try:
                # Run TypeScript analysis with configuration
                analysis_result = node_manager.analyze_typescript(str(plugin_path), config=config_data)
                analysis_result["plugin_name"] = plugin_path.name

                # Generate and save report
                report_dir = Path("reports")
                report_dir.mkdir(exist_ok=True)

                # Create report generator
                report_gen = BiomeReportGenerator()

                # Parse Biome output - pass the entire result as JSON
                biome_results = analysis_result.get("results", {}).get("biome", {})
                report_gen.parse_biome_output(
                    biome_output=json.dumps(biome_results),
                    plugin_name=plugin_path.name
                )

                # Save report
                report_gen.save_report(report_dir)

                # Update checkpoint
                checkpoint_manager.save_plugin_progress(
                    plugin_path.name,
                    analysis_result
                )

            except Exception as e:
                logger.error(f"Failed to analyze {plugin_path.name}: {str(e)}")
                checkpoint_manager.add_error(
                    plugin_path.name,
                    str(e)
                )

            progress.advance(task)

        progress.update(task, description="Analysis complete!")

@app.command()
def resume(
    session: str = typer.Option(None, "--session", "-s", help="Session name to resume"),
):
    """Resume a previous analysis session."""
    if not session:
        # List available sessions
        checkpoints = list(Path("checkpoints").glob("*.json"))
        if not checkpoints:
            console.print("[red]No previous sessions found![/red]")
            raise typer.Exit(1)

        table = Table(title="Available Sessions")
        table.add_column("Session Name")
        table.add_column("Last Updated")
        table.add_column("Plugins Analyzed")

        for checkpoint in checkpoints:
            with open(checkpoint, 'r', encoding='utf-8') as f:
                data = json.load(f)
                table.add_row(
                    data["session_name"],
                    data["last_updated"],
                    str(len(data["plugins_analyzed"]))
                )

        console.print(table)
        session = Prompt.ask("Enter session name to resume")

    checkpoint = checkpoint_manager.load_latest_session(session)
    if not checkpoint:
        console.print(f"[red]Session '{session}' not found![/red]")
        raise typer.Exit(1)

    logger.info(f"Resumed session: {session}")
    # TODO: Continue analysis from checkpoint

@app.command()
def view_reports(
    plugin: str = typer.Option(None, "--plugin", "-p", help="View report for specific plugin"),
):
    """View analysis reports."""
    reports_dir = Path("reports")
    if not reports_dir.exists():
        console.print("[red]No reports found![/red]")
        raise typer.Exit(1)

    if plugin:
        report_file = reports_dir / f"{plugin}_report.md"
        if not report_file.exists():
            console.print(f"[red]No report found for plugin '{plugin}'![/red]")
            raise typer.Exit(1)

        with open(report_file, 'r', encoding='utf-8') as f:
            content = f.read()
            # Use rich's Markdown renderer
            console.print(Markdown(content))
    else:
        # List all reports
        table = Table(title="Available Reports")
        table.add_column("Plugin")
        table.add_column("Last Updated")
        table.add_column("Issues Found")

        for report in reports_dir.glob("*_report.md"):
            # TODO: Parse report metadata
            table.add_row(report.stem.replace("_report", ""), "N/A", "N/A")

        console.print(table)

def main():
    """Main entry point for the CLI."""
    try:
        action, params = show_main_menu()
        if action == "start":
            # Call start with default values when coming from menu
            start(plugins=None, config_path=Path("config/analysis.config.json"))
        elif action == "resume":
            resume()
        elif action == "reports":
            view_reports()
    except Exception as e:
        logger.error(f"An error occurred: {str(e)}")
        console.print_exception()
        sys.exit(1)

if __name__ == "__main__":
    main()
