"""Milady adapter for ClawBench scenarios.

This adapter allows running ClawBench scenarios against the milady benchmark server
instead of the OpenClaw gateway. It translates between ClawBench's scenario format
and milady's benchmark API.

Usage:
    python milady_adapter.py --scenario client_escalation
    python milady_adapter.py --scenario inbox_triage --list
"""

import argparse
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

import yaml

# Add parent directory to path for milady_adapter imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "milaidy-adapter"))
from milady_adapter import MiladyClient, MiladyServerManager

# Local imports
from clawbench.scoring import score_episode

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
CLAWBENCH_DIR = Path(__file__).resolve().parent
SCENARIOS_DIR = CLAWBENCH_DIR / "scenarios"
FIXTURES_DIR = CLAWBENCH_DIR / "fixtures"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MILADY_URL = os.getenv("MILADY_BENCH_URL", "http://localhost:3939")


def load_scenario(name: str) -> dict | None:
    """Load scenario YAML config."""
    path = SCENARIOS_DIR / f"{name}.yaml"
    if not path.exists():
        return None
    with open(path) as f:
        return yaml.safe_load(f)


def load_fixture(scenario: str, fixture_name: str) -> dict | list | None:
    """Load a fixture file for a scenario."""
    path = FIXTURES_DIR / scenario / fixture_name
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def build_context(scenario_config: dict, scenario: str) -> dict:
    """Build context object from scenario config and fixtures."""
    context = {
        "benchmark": "clawbench",
        "scenario": scenario,
        "tools": scenario_config.get("tools", []),
    }

    # Load relevant fixtures for context
    fixtures_to_load = ["inbox.json", "calendar.json", "tasks.json", "slack_messages.json"]
    for fixture in fixtures_to_load:
        data = load_fixture(scenario, fixture)
        if data:
            key = fixture.replace(".json", "")
            context[key] = data

    # Load memory files
    memory_dir = FIXTURES_DIR / scenario / "memory"
    if memory_dir.exists():
        memory = {}
        for f in memory_dir.glob("*.md"):
            memory[f.stem] = f.read_text()
        if memory:
            context["memory"] = memory

    return context


class MiladyClawBenchRunner:
    """Run ClawBench scenarios against milady benchmark server."""

    def __init__(self, client: MiladyClient):
        self.client = client
        self.tool_calls: list[dict] = []

    def run_scenario(self, scenario: str, variant: str = "optimized") -> dict:
        """Run a single scenario and return results."""
        scenario_config = load_scenario(scenario)
        if not scenario_config:
            return {"error": f"Scenario '{scenario}' not found"}

        prompt = scenario_config.get("prompt", "Help me with my tasks.")
        context = build_context(scenario_config, scenario)

        # Reset milady session
        self.client.reset(task_id=scenario, benchmark="clawbench")
        self.tool_calls = []

        start_time = time.time()

        # Send the scenario prompt
        response = self.client.send_message(
            text=prompt,
            context=context,
        )

        duration_ms = (time.time() - start_time) * 1000

        # Extract tool calls from response
        for action in response.actions:
            self.tool_calls.append({
                "tool": action,
                "args": response.params.get(action, {}),
            })

        # Build result
        result = {
            "scenario": scenario,
            "variant": variant,
            "prompt": prompt,
            "response": response.text,
            "thought": response.thought,
            "tool_calls": self.tool_calls,
            "tool_calls_total": len(self.tool_calls),
            "tool_calls_by_type": dict(Counter(tc["tool"] for tc in self.tool_calls)),
            "duration_ms": duration_ms,
        }

        # Score against rubric
        scoring_config = scenario_config.get("scoring")
        if scoring_config:
            scorable = {
                "response": response.text,
                "tool_calls_raw": self.tool_calls,
                "tool_calls_by_type": result["tool_calls_by_type"],
                "tool_calls_total": len(self.tool_calls),
            }
            score_result = score_episode(scorable, scoring_config)
            result["score"] = score_result
            result["success"] = score_result.get("failed", 1) == 0

        return result


def main():
    parser = argparse.ArgumentParser(description="Run ClawBench scenarios against milady")
    parser.add_argument("--scenario", "-s", type=str, default="inbox_triage",
                        help="Scenario name")
    parser.add_argument("--variant", "-v", type=str, default="optimized",
                        help="AGENTS.md variant")
    parser.add_argument("--list", "-l", action="store_true",
                        help="List available scenarios")
    parser.add_argument("--json", "-j", action="store_true",
                        help="Output JSON")
    parser.add_argument("--start-server", action="store_true",
                        help="Auto-start milady benchmark server")

    args = parser.parse_args()

    if args.list:
        scenarios = sorted(SCENARIOS_DIR.glob("*.yaml"))
        print("Available ClawBench scenarios:")
        for p in scenarios:
            with open(p) as f:
                s = yaml.safe_load(f)
            print(f"  {p.stem:25s} — {s.get('description', '').strip()[:60]}")
        return

    # Setup client
    if args.start_server:
        mgr = MiladyServerManager()
        mgr.start()
        client = mgr.client
    else:
        client = MiladyClient(MILADY_URL)
        client.wait_until_ready()

    runner = MiladyClawBenchRunner(client)
    result = runner.run_scenario(args.scenario, args.variant)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"\n{'='*60}")
        print(f"CLAWBENCH SCENARIO: {args.scenario}")
        print(f"{'='*60}")
        print(f"\nPrompt: {result.get('prompt', '')[:100]}...")
        print(f"\nResponse: {result.get('response', '')[:300]}...")
        print(f"\nTool Calls ({result.get('tool_calls_total', 0)}):")
        for tc in result.get("tool_calls", []):
            print(f"  - {tc['tool']}")
        if "score" in result:
            score = result["score"]
            print(f"\nScore: {score.get('score', 0):.2f}")
            print(f"Passed: {score.get('passed', 0)}/{score.get('total', 0)}")
            if score.get("failures"):
                print(f"Failures:")
                for f in score["failures"]:
                    print(f"  - {f}")

    if args.start_server:
        mgr.stop()


if __name__ == "__main__":
    main()
