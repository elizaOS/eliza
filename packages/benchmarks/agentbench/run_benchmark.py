#!/usr/bin/env python3
"""
Run AgentBench benchmark and generate results report.

Usage:
    python run_benchmark.py                  # Run with mock runtime
    python run_benchmark.py --elizaos        # Run with ElizaOS runtime
    python run_benchmark.py --env os db      # Run specific environments
    python run_benchmark.py --trajectories   # Export trajectories for RL training
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
        # benchmarks/agentbench/run_benchmark.py -> repo root is parents[2]
        Path(__file__).resolve().parents[2] / ".env",
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
        "--milady",
        action="store_true",
        help="Use milady TypeScript agent via benchmark server",
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
            from elizaos.bootstrap import bootstrap_plugin
            from elizaos.types.model import LLMMode, ModelType

            from elizaos_agentbench.eliza_harness import create_benchmark_character

            _load_dotenv()

            # Start with bootstrap plugin for basicCapabilities (providers, actions, etc.)
            plugins = [bootstrap_plugin]
            has_model_plugin = False

            try:
                from elizaos_plugin_openai import get_openai_plugin

                if os.environ.get("OPENAI_API_KEY"):
                    plugins.append(get_openai_plugin())
                    has_model_plugin = True
                else:
                    print("Warning: OPENAI_API_KEY not set; cannot run AgentBench with OpenAI models.")
            except ImportError as e:
                print(f"Warning: OpenAI plugin not available ({e}); cannot run real model evaluation.")
            except Exception as e:
                print(f"Warning: Failed to initialize OpenAI plugin ({e}); cannot run real model evaluation.")

            if not has_model_plugin:
                print("Falling back to deterministic mock runtime")
                runtime = SmartMockRuntime()
            else:
                print("\n" + "=" * 60)
                print("Initializing FULL ElizaOS Pipeline")
                print("=" * 60)
                print("\n📦 Loading plugins:")
                print("   • bootstrap (basicCapabilities: providers, actions, evaluators)")
                print("   • openai (model provider)")

                # Create benchmark-optimized character
                character = create_benchmark_character()
                print(f"\n🤖 Character: {character.name}")
                print(f"   System: {character.system[:80]}...")

                # Add benchmark plugin (provider + action for benchmarks)
                from elizaos_agentbench.eliza_harness import create_benchmark_plugin

                benchmark_plugin = create_benchmark_plugin()
                plugins.append(benchmark_plugin)
                print("   • agentbench (BENCHMARK provider + BENCHMARK_ACTION)")

                # Optional: register trajectory logger plugin for end-to-end capture
                if args.trajectories:
                    try:
                        from elizaos_plugin_trajectory_logger import get_trajectory_logger_plugin

                        plugins.append(get_trajectory_logger_plugin())
                        print("   • trajectory-logger (end-to-end training/benchmark capture)")
                    except ImportError:
                        print("   • trajectory-logger: disabled (python plugin not installed)")

                # Create runtime with full pipeline
                # AgentBench is iterative; default to SMALL to reduce latency/cost.
                runtime = AgentRuntime(character=character, plugins=plugins, llm_mode=LLMMode.SMALL)

                # Register in-memory database adapter for message storage
                from elizaos_agentbench.eliza_harness import BenchmarkDatabaseAdapter

                db_adapter = BenchmarkDatabaseAdapter()
                await db_adapter.initialize()
                runtime.register_database_adapter(db_adapter)  # type: ignore[arg-type]
                print("   • database: in-memory adapter (for benchmarks)")

                await runtime.initialize()

                if not runtime.has_model(ModelType.TEXT_LARGE):
                    print("Warning: No TEXT_LARGE model handler registered; falling back to mock runtime.")
                    await runtime.stop()
                    runtime = SmartMockRuntime()
                else:
                    print("\n✅ ElizaOS runtime ready")
                    print("   • message_service: enabled (full pipeline)")
                    print(f"   • providers: {len(runtime.providers)} loaded")
                    print(f"   • actions: {len(runtime.actions)} registered")
                    print("=" * 60)

        except ImportError as e:
            print(f"Warning: ElizaOS not available ({e})")
            print("Falling back to deterministic mock runtime")
            runtime = SmartMockRuntime()
    elif args.milady:
        print("\n" + "=" * 60)
        print("Using MILADY TypeScript agent via benchmark server")
        print("=" * 60)
        from milady_adapter import MiladyServerManager
        from milady_adapter.agentbench import MiladyAgentHarness

        _load_dotenv()
        milady_server = MiladyServerManager()
        milady_server.start()
        milady_harness = MiladyAgentHarness(milady_server.client)
        # Use mock runtime for the runner scaffolding; the harness overrides
        # the actual agent loop.
        runtime = SmartMockRuntime()
        runtime._milady_harness = milady_harness  # type: ignore[attr-defined]
        print("✅ Milady benchmark server connected")
    else:
        print("\nUsing deterministic mock runtime (for harness validation)")
        runtime = SmartMockRuntime()

    # Baseline comparisons are only meaningful for real model runs
    if isinstance(runtime, SmartMockRuntime) and not getattr(runtime, "_milady_harness", None):
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

    # Export trajectories if enabled (using the trajectory logger service)
    if args.trajectories and not isinstance(runtime, SmartMockRuntime):
        try:
            from typing import Protocol, runtime_checkable

            from elizaos_plugin_trajectory_logger import (
                TRAJECTORY_LOGGER_SERVICE_TYPE,
                TrajectoryLoggerRuntimeService,
            )
            from elizaos_plugin_trajectory_logger.runtime_service import TrajectoryExportConfig

            @runtime_checkable
            class _ExportableTrajectoryService(Protocol):
                def export(self, config: TrajectoryExportConfig): ...

            svc = runtime.get_service(TRAJECTORY_LOGGER_SERVICE_TYPE)
            if isinstance(svc, TrajectoryLoggerRuntimeService) or isinstance(
                svc, _ExportableTrajectoryService
            ):
                print("\n🎯 Exporting trajectories for RL training...")
                export_cfg = TrajectoryExportConfig(
                    dataset_name="agentbench_trajectories",
                    export_format=args.trajectory_format,
                    output_dir=args.output,
                )
                export_result = svc.export(export_cfg)  # type: ignore[call-arg]
                print(f"   ✅ Exported {export_result.trajectories_exported} trajectories")
                print(f"   📄 Format: {args.trajectory_format.upper()}")
                print(f"   📁 File: {export_result.dataset_url}")
            else:
                print("\n🎯 Trajectory export skipped (service not registered)")
        except ImportError:
            print("\n🎯 Trajectory export skipped (trajectory logger plugin not installed)")
        except Exception as e:
            print(f"\n🎯 Trajectory export failed: {e}")

    print("\n" + "=" * 60)

    # Return exit code based on performance
    return 0 if report.overall_success_rate >= 0.3 else 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
