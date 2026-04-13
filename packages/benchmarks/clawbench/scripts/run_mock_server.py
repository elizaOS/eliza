#!/usr/bin/env python3
"""
Run the mock tools server standalone for testing.

Usage:
    python scripts/run_mock_server.py
    python scripts/run_mock_server.py --port 3001 --fixtures ./fixtures
"""

import os
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import typer
import uvicorn


def main(
    port: int = typer.Option(3001, help="Port to run on"),
    fixtures: str = typer.Option("./fixtures", help="Fixtures directory"),
    scenario: str = typer.Option("inbox_triage", help="Initial scenario"),
):
    """Run mock tools server."""
    os.environ["FIXTURES_PATH"] = str(Path(fixtures).absolute())
    os.environ["SCENARIO"] = scenario
    os.environ["LOG_PATH"] = str(Path("./logs").absolute())
    
    print(f"Starting mock tools server on port {port}")
    print(f"Fixtures: {fixtures}")
    print(f"Scenario: {scenario}")
    
    uvicorn.run(
        "clawbench.mock_tools.server:app",
        host="0.0.0.0",
        port=port,
        reload=True,
    )


if __name__ == "__main__":
    typer.run(main)
