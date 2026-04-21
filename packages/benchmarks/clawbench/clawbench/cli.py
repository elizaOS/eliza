"""
CLI for ClawBench.

Thin wrapper around the YAML-based scenario runner.
"""

import json
import os
import sys
from pathlib import Path

import httpx
import typer
import yaml
from rich.console import Console
from rich.table import Table

from .scoring import score_episode, format_score_summary

app = typer.Typer(help="ClawBench - Evaluate AGENTS.md policies")
console = Console()

SANDBOX_DIR = Path(__file__).resolve().parent.parent
SCENARIOS_DIR = SANDBOX_DIR / "scenarios"
FIXTURES_DIR = SANDBOX_DIR / "fixtures"
CLAWBENCH_MODEL = os.getenv("CLAWBENCH_MODEL", "anthropic/claude-sonnet-4-5-20250929")


def _load_scenario(name_or_path: str) -> dict:
    """Load a scenario YAML by name or file path."""
    path = Path(name_or_path)
    if not path.exists():
        path = SCENARIOS_DIR / f"{name_or_path}.yaml"
    if not path.exists():
        console.print(f"[red]Scenario not found:[/red] {name_or_path}")
        console.print(f"Available: {[p.stem for p in sorted(SCENARIOS_DIR.glob('*.yaml'))]}")
        raise typer.Exit(1)
    with open(path) as f:
        return yaml.safe_load(f)


@app.command()
def run(
    scenario: str = typer.Argument(..., help="Scenario name or path to YAML file"),
    variant: str = typer.Option("baseline", help="AGENTS.md variant: baseline or optimized"),
    openclaw_url: str = typer.Option(
        None, envvar="OPENCLAW_URL", help="OpenClaw Gateway URL"
    ),
    mock_tools_url: str = typer.Option(
        None, envvar="MOCK_TOOLS_URL", help="Mock tools server URL"
    ),
):
    """Run a single scenario and print the score."""
    openclaw_url = openclaw_url or os.getenv("OPENCLAW_URL", "http://localhost:18790")
    mock_tools_url = mock_tools_url or os.getenv("MOCK_TOOLS_URL", "http://localhost:3001")
    token = os.getenv("OPENCLAW_GATEWAY_TOKEN", "sandbox-token-12345")

    sc = _load_scenario(scenario)
    name = sc["name"]
    prompt = sc.get("prompt", "Help me with my tasks.").strip()

    console.print(f"[bold blue]Running:[/bold blue] {name}/{variant}")
    console.print(f"  Prompt: {prompt[:80]}...")

    # Set mock scenario
    try:
        httpx.post(f"{mock_tools_url}/set_scenario/{name}", timeout=5)
    except httpx.RequestError as e:
        console.print(f"[red]Mock server unreachable:[/red] {e}")
        raise typer.Exit(1)

    # Send message
    try:
        resp = httpx.post(
            f"{openclaw_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={
                "model": CLAWBENCH_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
            },
            timeout=180,
        )
        raw = resp.json()
    except httpx.RequestError as e:
        console.print(f"[red]OpenClaw unreachable:[/red] {e}")
        raise typer.Exit(1)

    # Extract response
    assistant_message = ""
    if "choices" in raw:
        assistant_message = raw["choices"][0].get("message", {}).get("content", "")

    # Collect tool calls
    tool_calls = []
    try:
        r = httpx.get(f"{mock_tools_url}/tool_calls", timeout=5)
        if r.status_code == 200:
            tool_calls = r.json().get("calls", [])
    except httpx.RequestError:
        pass

    tool_counts: dict[str, int] = {}
    for tc in tool_calls:
        tool_counts[tc["tool"]] = tool_counts.get(tc["tool"], 0) + 1

    result = {
        "response": assistant_message,
        "tool_calls_raw": tool_calls,
        "tool_calls_by_type": tool_counts,
        "tool_calls_total": len(tool_calls),
    }

    # Score
    scoring_config = sc.get("scoring")
    if scoring_config:
        score = score_episode(result, scoring_config)
        console.print(f"\n[bold]Result:[/bold]")
        console.print(format_score_summary(score))
    else:
        console.print("  (no scoring rubric)")


@app.command()
def list_scenarios():
    """List available scenarios."""
    table = Table(title="Available Scenarios")
    table.add_column("Name", style="cyan")
    table.add_column("Description")
    table.add_column("Checks", justify="right")
    table.add_column("Points", justify="right")
    table.add_column("Variants")

    for path in sorted(SCENARIOS_DIR.glob("*.yaml")):
        with open(path) as f:
            sc = yaml.safe_load(f)
        checks = sc.get("scoring", {}).get("checks", [])
        total_pts = sum(c.get("points", 1) for c in checks)
        variants = ", ".join(sc.get("variants", {}).keys())
        table.add_row(
            sc.get("name", path.stem),
            (sc.get("description", "")[:60] + "...") if len(sc.get("description", "")) > 60 else sc.get("description", ""),
            str(len(checks)),
            str(total_pts),
            variants,
        )

    console.print(table)


@app.command()
def check_health(
    openclaw_url: str = typer.Option(None, envvar="OPENCLAW_URL", help="OpenClaw Gateway URL"),
    mock_tools_url: str = typer.Option(None, envvar="MOCK_TOOLS_URL", help="Mock tools server URL"),
):
    """Check if services are running."""
    openclaw_url = openclaw_url or os.getenv("OPENCLAW_URL", "http://localhost:18790")
    mock_tools_url = mock_tools_url or os.getenv("MOCK_TOOLS_URL", "http://localhost:3001")

    console.print("[bold]Health Check[/bold]")

    # Mock tools
    try:
        r = httpx.get(f"{mock_tools_url}/health", timeout=3)
        health = r.json()
        console.print(f"  Mock Tools ({mock_tools_url}): [green]OK[/green] ({health.get('tools_available', '?')} tools)")
    except Exception:
        console.print(f"  Mock Tools ({mock_tools_url}): [red]FAILED[/red]")

    # OpenClaw
    try:
        r = httpx.get(f"{openclaw_url}/health", timeout=3)
        console.print(f"  OpenClaw ({openclaw_url}): [green]OK[/green]")
    except Exception:
        console.print(f"  OpenClaw ({openclaw_url}): [red]FAILED[/red]")


if __name__ == "__main__":
    app()
