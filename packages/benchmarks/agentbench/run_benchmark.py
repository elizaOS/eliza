#!/usr/bin/env python3
"""
Run AgentBench benchmark and generate results report.

Usage:
    python run_benchmark.py                  # Run with mock runtime
    python run_benchmark.py --runtime bridge # Run through the Eliza TS bridge
    python run_benchmark.py --env os db      # Run specific environments
    python run_benchmark.py --runtime bridge --trajectories
"""

import asyncio
import argparse
import sys
import os
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from elizaos_agentbench import (
    AgentBenchRunner,
    AgentBenchConfig,
    AgentBenchEnvironment,
)
from elizaos_agentbench.types import EnvironmentConfig
from elizaos_agentbench.mock_runtime import SmartMockRuntime


def _load_dotenv() -> None:
    """
    Best-effort .env loader.

    We avoid adding a dependency on python-dotenv for benchmarks and keep
    behavior conservative:
    - only set vars that are not already set in the environment
    - ignore comments/blank lines
    - support simple KEY=VALUE lines (optionally quoted)
    """

    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parents[3] / ".env",
    ]

    for path in candidates:
        if not path.is_file():
            continue

        try:
            for raw_line in path.read_text().splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                k = key.strip()
                if not k or k in os.environ:
                    continue
                v = value.strip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                os.environ[k] = v
        except OSError:
            # If .env can't be read, silently ignore.
            pass


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run AgentBench benchmark via the eliza TS bridge"
    )
    parser.add_argument(
        "--runtime",
        choices=["mock", "bridge", "elizaos"],
        default="mock",
        help="Runtime backend: mock for offline smoke tests, bridge/elizaos for the Eliza TS benchmark bridge",
    )
    parser.add_argument(
        "--elizaos",
        action="store_true",
        help="Deprecated alias for --runtime bridge",
    )
    parser.add_argument(
        "--env",
        nargs="+",
        choices=["os", "db", "kg", "ws", "lt", "all"],
        default=["all"],
        help="Environments to run",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="./benchmark_results",
        help="Output directory",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Max tasks per environment",
    )
    parser.add_argument(
        "--trajectories",
        action="store_true",
        help="Enable trajectory logging for RL training export",
    )
    parser.add_argument(
        "--trajectory-format",
        choices=["art", "grpo"],
        default="art",
        help="Trajectory export format (art=OpenPipe ART, grpo=GRPO groups)",
    )
    args = parser.parse_args()

    print("=" * 60)
    if args.elizaos:
        args.runtime = "bridge"

    print("AgentBench Evaluation")
    print("=" * 60)

    # Create configuration
    config = AgentBenchConfig(
        output_dir=args.output,
        save_detailed_logs=True,
        enable_metrics=True,
        enable_memory_tracking=True,
        use_docker=False,  # Use local execution for safety
    )

    # Map environment names
    env_map = {
        "os": AgentBenchEnvironment.OS,
        "db": AgentBenchEnvironment.DATABASE,
        "kg": AgentBenchEnvironment.KNOWLEDGE_GRAPH,
        "ws": AgentBenchEnvironment.WEB_SHOPPING,
        "lt": AgentBenchEnvironment.LATERAL_THINKING,
    }

    # Configure environments
    implemented_envs = [
        AgentBenchEnvironment.OS,
        AgentBenchEnvironment.DATABASE,
        AgentBenchEnvironment.KNOWLEDGE_GRAPH,
        AgentBenchEnvironment.WEB_SHOPPING,
        AgentBenchEnvironment.LATERAL_THINKING,
    ]

    for env in AgentBenchEnvironment:
        env_config = config.get_env_config(env)

        if "all" in args.env:
            env_config.enabled = env in implemented_envs
        else:
            env_key = next((k for k, v in env_map.items() if v == env), None)
            env_config.enabled = env_key in args.env

        if args.max_tasks:
            env_config.max_tasks = args.max_tasks

        # OS-specific settings
        if env == AgentBenchEnvironment.OS:
            env_config.additional_settings["use_docker"] = False

    # Initialize runtime.
    print("\n" + "=" * 60)
    print(
        "Using deterministic mock runtime"
        if args.runtime == "mock"
        else "Using ELIZA TypeScript agent via benchmark server"
    )
    print("=" * 60)
    eliza_server = None
    runtime = SmartMockRuntime()
    if args.runtime != "mock":
        from eliza_adapter import ElizaServerManager
        from eliza_adapter.agentbench import ElizaAgentHarness

        _load_dotenv()
        eliza_server = ElizaServerManager()
        eliza_server.start()
        eliza_harness = ElizaAgentHarness(eliza_server.client)
        runtime._app_harness = eliza_harness  # type: ignore[attr-defined]
        print("Eliza benchmark server connected")

    # Show enabled environments
    enabled = config.get_enabled_environments()
    print(f"\nEnvironments to evaluate: {[e.value for e in enabled]}")

    # Run benchmark
    print("\nStarting benchmark...")
    runner = AgentBenchRunner(config=config, runtime=runtime)
    try:
        report = await runner.run_benchmarks()
    finally:
        if eliza_server is not None:
            eliza_server.stop()

    # Print detailed results
    print("\n" + "=" * 60)
    print("BENCHMARK RESULTS")
    print("=" * 60)

    print(f"\n📊 Overall Performance:")
    print(f"   Success Rate: {report.overall_success_rate * 100:.1f}%")
    print(f"   Total Tasks:  {report.total_tasks}")
    print(f"   Passed:       {report.passed_tasks}")
    print(f"   Failed:       {report.failed_tasks}")
    print(f"   Avg Duration: {report.average_duration_ms:.0f}ms")

    print(f"\n📋 Per-Environment Breakdown:")
    for env, env_report in report.environment_reports.items():
        icon = "✅" if env_report.success_rate >= 0.5 else "⚠️" if env_report.success_rate >= 0.3 else "❌"
        print(f"\n   {icon} {env.value.upper()}")
        print(f"      Success Rate: {env_report.success_rate * 100:.1f}%")
        print(f"      Tasks: {env_report.passed_tasks}/{env_report.total_tasks}")
        print(f"      Avg Steps: {env_report.average_steps:.1f}")
        print(f"      Avg Duration: {env_report.average_duration_ms:.0f}ms")

    # Comparison with baselines
    if config.enable_baseline_comparison:
        print(f"\n📈 Comparison with GPT-4 Baseline:")
        gpt4_comp = report.comparison_to_baseline.get("gpt4_comparison", {})
        for env_name, data in gpt4_comp.items():
            our_score = data.get("our_score", 0) * 100
            gpt4_score = data.get("gpt4_score", 0) * 100
            diff = data.get("difference", 0) * 100
            icon = "↑" if diff > 0 else "↓" if diff < 0 else "="
            print(f"   {env_name}: {our_score:.1f}% vs {gpt4_score:.1f}% ({icon}{abs(diff):.1f}%)")

    # Key findings
    print(f"\n💡 Key Findings:")
    for finding in report.summary.get("key_findings", []):
        print(f"   • {finding}")

    # Recommendations
    if report.summary.get("recommendations"):
        print(f"\n🎯 Recommendations:")
        for rec in report.summary.get("recommendations", []):
            print(f"   • {rec}")

    print(f"\n📁 Results saved to: {args.output}")
    print("   - agentbench-results.json")
    print("   - agentbench-report.md")
    print("   - agentbench-detailed.json")

    if args.trajectories:
        if args.runtime != "mock":
            print("\nTrajectory export is handled by the TypeScript bridge; no local Python export is available.")
        else:
            print("\nTrajectory export skipped in mock mode.")

    print("\n" + "=" * 60)

    # Return exit code based on performance
    return 0 if report.overall_success_rate >= 0.3 else 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
