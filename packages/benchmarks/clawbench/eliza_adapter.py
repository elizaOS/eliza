"""Eliza adapter for ClawBench scenarios.

This adapter runs ClawBench scenarios against the eliza benchmark server
(``packages/app-core/src/benchmark/server.ts``) instead of the legacy Groq
+ mock-tools harness. It is the canonical entry point invoked by the
benchmark registry's ``_clawbench_cmd``.

Connection model:
  - By default, reads ``ELIZA_BENCH_URL`` and ``ELIZA_BENCH_TOKEN`` from the
    environment via :class:`eliza_adapter.ElizaClient`. This is what the
    registry-driven run uses (the registry boots one shared benchmark server
    for all eliza-bridge benchmarks).
  - With ``--start-server``, spins up a private :class:`ElizaServerManager`
    for ad-hoc local invocation.

Output:
  - Writes ``trajectory_<scenario>_<timestamp>.json`` into ``--output-dir``
    (defaults to ``./outputs``). The filename matches the registry's
    ``locate_result`` glob (``trajectory_*.json``).

Usage::

    python eliza_adapter.py --scenario inbox_triage --output-dir /tmp/out
    python eliza_adapter.py --list
    python eliza_adapter.py --scenario inbox_triage --start-server
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

import yaml

# Add eliza-adapter package to path for local development without install.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "eliza-adapter"))
from eliza_adapter import ElizaClient, ElizaServerManager  # noqa: E402

# Local imports
sys.path.insert(0, str(Path(__file__).resolve().parent))
from clawbench.scoring import score_episode  # noqa: E402

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
CLAWBENCH_DIR = Path(__file__).resolve().parent
SCENARIOS_DIR = CLAWBENCH_DIR / "scenarios"
FIXTURES_DIR = CLAWBENCH_DIR / "fixtures"


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
    if not path.exists() and fixture_name == "tasks.json":
        path = FIXTURES_DIR / scenario / "tasks_fixture.json"
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def build_context(scenario_config: dict, scenario: str) -> dict:
    """Build context object from scenario config and fixtures."""
    context: dict = {
        "benchmark": "clawbench",
        "scenario": scenario,
        "tools": scenario_config.get("tools", []),
    }

    # Load relevant fixtures for context
    for fixture in ("inbox.json", "calendar.json", "tasks.json", "slack_messages.json"):
        data = load_fixture(scenario, fixture)
        if data:
            context[fixture.replace(".json", "")] = data

    # Load memory files
    memory_dir = FIXTURES_DIR / scenario / "memory"
    if memory_dir.exists():
        memory: dict[str, str] = {}
        for f in memory_dir.glob("*.md"):
            memory[f.stem] = f.read_text()
        if memory:
            context["memory"] = memory

    return context


class ElizaClawBenchRunner:
    """Run ClawBench scenarios against the eliza benchmark server."""

    def __init__(self, client: ElizaClient):
        self.client = client
        self.tool_calls: list[dict] = []

    def run_scenario(self, scenario: str, variant: str = "optimized") -> dict:
        scenario_config = load_scenario(scenario)
        if not scenario_config:
            return {"error": f"Scenario '{scenario}' not found"}

        prompt = scenario_config.get("prompt", "Help me with my tasks.")
        context = build_context(scenario_config, scenario)

        self.client.reset(task_id=scenario, benchmark="clawbench")
        self.tool_calls = []

        start_time = time.time()
        response = self.client.send_message(text=prompt, context=context)
        duration_ms = (time.time() - start_time) * 1000

        for action in response.actions:
            self.tool_calls.append(
                {"tool": action, "args": response.params.get(action, {})}
            )

        result: dict = {
            "scenario": scenario,
            "variant": variant,
            "prompt": prompt,
            "response": response.text,
            "thought": response.thought,
            "tool_calls": self.tool_calls,
            "tool_calls_total": len(self.tool_calls),
            "tool_calls_by_type": dict(
                Counter(tc["tool"] for tc in self.tool_calls)
            ),
            "duration_ms": duration_ms,
        }

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
            # Success = score meets threshold (default 0.6). Old behavior
            # required zero failed checks, which is unrealistic and tied
            # success to perfection.
            threshold = scoring_config.get("success_threshold", 0.6)
            score_val = score_result.get("score") or 0.0
            result["success"] = score_val >= threshold

        return result


def list_scenarios() -> list[str]:
    return sorted(p.stem for p in SCENARIOS_DIR.glob("*.yaml"))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run ClawBench scenarios against the eliza benchmark server"
    )
    parser.add_argument("--scenario", "-s", default="inbox_triage", help="Scenario name")
    parser.add_argument("--variant", "-v", default="optimized", help="AGENTS.md variant label")
    parser.add_argument(
        "--output-dir",
        "-o",
        default=None,
        help="Directory to write trajectory_<scenario>_<ts>.json (default: ./outputs)",
    )
    parser.add_argument("--list", "-l", action="store_true", help="List available scenarios")
    parser.add_argument("--json", "-j", action="store_true", help="Print full result JSON to stdout")
    parser.add_argument(
        "--start-server",
        action="store_true",
        help="Spawn a private ElizaServerManager (otherwise honor ELIZA_BENCH_URL/TOKEN env)",
    )
    parser.add_argument(
        "--model",
        "-m",
        default=None,
        help="Ignored (model is determined by the server's runtime); accepted for CLI compat",
    )

    args = parser.parse_args()

    if args.list:
        print("Available ClawBench scenarios:")
        for name in list_scenarios():
            cfg = load_scenario(name) or {}
            print(f"  {name:25s} - {str(cfg.get('description', '')).strip()[:60]}")
        return 0

    mgr: ElizaServerManager | None = None
    # Auto-spawn the eliza benchmark server when no external URL is configured.
    # Matches the pattern used by swe_bench, gaia, rlm-bench, etc., so the
    # orchestrator can run clawbench without manually starting a server.
    if args.start_server or not os.environ.get("ELIZA_BENCH_URL"):
        mgr = ElizaServerManager()
        mgr.start()
        client = mgr.client
    else:
        client = ElizaClient(os.environ.get("ELIZA_BENCH_URL"))
        client.wait_until_ready()

    try:
        runner = ElizaClawBenchRunner(client)
        result = runner.run_scenario(args.scenario, args.variant)
    finally:
        if mgr is not None:
            mgr.stop()

    if "error" in result:
        print(f"Error: {result['error']}", file=sys.stderr)
        return 1

    output_dir = Path(args.output_dir) if args.output_dir else CLAWBENCH_DIR / "outputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / f"trajectory_{args.scenario}_{int(time.time())}.json"
    with open(output_file, "w") as f:
        json.dump(result, f, indent=2, default=str)

    if args.json:
        print(json.dumps(result, default=str))
    else:
        score = result.get("score") or {}
        print(f"\nScenario: {args.scenario}")
        print(f"Tool calls: {result.get('tool_calls_total', 0)}")
        if score:
            print(
                f"Score: {score.get('score', 0):.2f} "
                f"({score.get('passed', 0)}/{score.get('total_checks', 0)} checks passed)"
            )
        print(f"Trajectory: {output_file}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
