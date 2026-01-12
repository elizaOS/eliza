#!/usr/bin/env python3
"""
Run AgentBench benchmark and generate results report.

Usage:
    python run_benchmark.py                  # Run with mock runtime
    python run_benchmark.py --elizaos        # Run with ElizaOS runtime
    python run_benchmark.py --env os db      # Run specific environments
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
        # repo_root/benchmarks/agentbench/python/run_benchmark.py -> repo_root is parents[3]
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
    parser = argparse.ArgumentParser(description="Run AgentBench benchmark")
    parser.add_argument(
        "--elizaos",
        action="store_true",
        help="Use ElizaOS runtime (requires elizaos package)",
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
    args = parser.parse_args()

    print("=" * 60)
    print("AgentBench Evaluation - ElizaOS Python")
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

    # Initialize runtime
    runtime = None
    if args.elizaos:
        try:
            from elizaos.runtime import AgentRuntime
            from elizaos.types.model import LLMMode, ModelType

            _load_dotenv()

            plugins = []
            try:
                from elizaos_plugin_openai import get_openai_plugin

                if os.environ.get("OPENAI_API_KEY"):
                    plugins = [get_openai_plugin()]
                else:
                    print("Warning: OPENAI_API_KEY not set; cannot run AgentBench with OpenAI models.")
            except ImportError as e:
                print(f"Warning: OpenAI plugin not available ({e}); cannot run real model evaluation.")
            except Exception as e:
                print(f"Warning: Failed to initialize OpenAI plugin ({e}); cannot run real model evaluation.")

            if not plugins:
                print("Falling back to deterministic mock runtime")
                runtime = SmartMockRuntime()
            else:
                print("\nInitializing ElizaOS runtime (OpenAI)...")
                # AgentBench is iterative; default to SMALL to reduce latency/cost.
                runtime = AgentRuntime(plugins=plugins, llm_mode=LLMMode.SMALL)
                await runtime.initialize()

                if not runtime.has_model(ModelType.TEXT_LARGE):
                    print("Warning: No TEXT_LARGE model handler registered; falling back to mock runtime.")
                    await runtime.stop()
                    runtime = SmartMockRuntime()
                else:
                    print("ElizaOS runtime ready")
        except ImportError as e:
            print(f"Warning: ElizaOS not available ({e})")
            print("Falling back to deterministic mock runtime")
            runtime = SmartMockRuntime()
    else:
        print("\nUsing deterministic mock runtime (for harness validation)")
        runtime = SmartMockRuntime()

    # Baseline comparisons are only meaningful for real model runs
    if isinstance(runtime, SmartMockRuntime):
        config.enable_baseline_comparison = False

    # Show enabled environments
    enabled = config.get_enabled_environments()
    print(f"\nEnvironments to evaluate: {[e.value for e in enabled]}")

    # Run benchmark
    print("\nStarting benchmark...")
    runner = AgentBenchRunner(config=config, runtime=runtime)
    report = await runner.run_benchmarks()

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

    print("\n" + "=" * 60)

    # Return exit code based on performance
    return 0 if report.overall_success_rate >= 0.3 else 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
