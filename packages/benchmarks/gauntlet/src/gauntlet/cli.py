"""
CLI entry point for the Solana Gauntlet.

Provides commands for:
- Running benchmark against an agent
- Listing scenarios
- Validating configuration
"""

import argparse
import asyncio
import importlib.util
import sys
from pathlib import Path

from gauntlet.harness.orchestrator import TestOrchestrator
from gauntlet.harness.surfpool import SurfpoolManager, SurfpoolConfig
from gauntlet.scoring.engine import ScoringEngine
from gauntlet.storage.sqlite import SQLiteStorage
from gauntlet.storage.export import Exporter
from gauntlet.sdk.interface import GauntletAgent


def load_agent_from_file(agent_path: Path) -> GauntletAgent:
    """
    Dynamically load an agent from a Python file.
    
    The file must define a class that implements GauntletAgent
    and be accessible as `Agent` or the first GauntletAgent subclass found.
    
    Args:
        agent_path: Path to the agent Python file
        
    Returns:
        Instantiated agent
    """
    spec = importlib.util.spec_from_file_location("agent_module", agent_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    
    # Look for Agent class or first GauntletAgent implementation
    if hasattr(module, "Agent"):
        return module.Agent()
    
    for name in dir(module):
        obj = getattr(module, name)
        if isinstance(obj, type) and hasattr(obj, "execute_task"):
            return obj()
    
    raise ValueError(f"No GauntletAgent implementation found in {agent_path}")


async def run_benchmark(args: argparse.Namespace) -> int:
    """Run benchmark against specified agent."""
    print(f"🌊 Solana Gauntlet v{args.version}")
    print(f"📁 Agent: {args.agent}")
    print(f"🎲 Seed: {args.seed or 'random'}")
    print()

    # Resolve paths
    agent_path = Path(args.agent).resolve()
    scenarios_dir = Path(args.scenarios).resolve()
    programs_dir = Path(args.programs).resolve()
    output_dir = Path(args.output).resolve()
    
    # Validate paths
    if not agent_path.exists():
        print(f"❌ Agent file not found: {agent_path}")
        return 1
    
    if not scenarios_dir.exists():
        print(f"❌ Scenarios directory not found: {scenarios_dir}")
        return 1
    
    # Load agent
    print("📦 Loading agent...")
    try:
        agent = load_agent_from_file(agent_path)
    except Exception as e:
        print(f"❌ Failed to load agent: {e}")
        return 1
    print(f"   ✅ Agent loaded: {type(agent).__name__}")
    
    # Initialize components
    orchestrator = TestOrchestrator(
        scenarios_dir=scenarios_dir,
        programs_dir=programs_dir,
        benchmark_version=args.version,
        mock_mode=args.mock,
    )
    
    storage = SQLiteStorage(output_dir / "results.db")
    exporter = Exporter(output_dir, args.version)
    scoring = ScoringEngine()
    
    # Load scenarios
    print("📋 Loading scenarios...")
    orchestrator.load_scenarios()
    
     # Start Surfpool
    print("🚀 Starting Surfpool...")
    
    # Configure Surfpool based on flags
    if args.clone_mainnet:
        print("   📡 Cloning from mainnet...")
        surfpool_config = SurfpoolConfig(
            mock_mode=False,
            offline_mode=False,
            clone_from="https://api.mainnet-beta.solana.com",
            programs_to_clone=["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],  # Jupiter
        )
        skip_validation = False
    else:
        surfpool_config = SurfpoolConfig(mock_mode=args.mock)
        # In offline mode (default), skip validation since no real programs exist
        skip_validation = args.mock or surfpool_config.offline_mode
    
    # Update orchestrator to skip validation and use mock execution if needed
    orchestrator.state_initializer.mock_mode = skip_validation
    orchestrator.mock_mode = skip_validation
    
    async with SurfpoolManager(surfpool_config) as surfpool:
        print(f"   ✅ Surfpool ready at {surfpool.rpc_url}")
        
        # Initialize storage
        storage.initialize()
        
        # Run benchmark
        print()
        print("=" * 60)
        print("🏃 Running benchmark...")
        print("=" * 60)
        
        metrics = await orchestrator.run_benchmark(
            agent=agent,
            agent_id=agent_path.stem,
            seed=args.seed,
        )
        
        # Compute scores
        overall_score = scoring.score_overall(metrics.run_metrics)
        
        # Save results
        storage.save_run(metrics.run_metrics, {"agent_path": str(agent_path)})
        storage.save_scores(metrics.run_metrics.run_id, overall_score)
        
        # Export results
        json_path = exporter.export_json(
            metrics.run_metrics,
            overall_score,
            scenarios_hash="placeholder",
            scoring_hash="placeholder",
        )
        md_path = exporter.export_markdown(
            metrics.run_metrics,
            overall_score,
            agent_name=type(agent).__name__,
        )
        
        # Export decision traces (primary evaluation artifact per design doc)
        traces_path = exporter.export_traces(metrics.run_metrics)
        
        # Export failure analysis
        failures_path = exporter.export_failure_analysis(
            metrics.run_metrics,
            overall_score,
        )
        
        # Print summary
        print()
        print("=" * 60)
        print("📊 RESULTS")
        print("=" * 60)
        print()
        print(f"Agent: {type(agent).__name__}")
        print(f"Overall Score: {overall_score.overall_score:.1f}/100")
        print(f"Status: {'✅ PASSED' if overall_score.passed else '❌ FAILED'}")
        print()
        print("Component Scores:")
        print(f"  Task Completion: {overall_score.avg_task_completion:.1f}% (min: 70%)")
        print(f"  Safety:          {overall_score.avg_safety:.1f}% (min: 80%)")
        print(f"  Efficiency:      {overall_score.avg_efficiency:.1f}% (min: 60%)")
        print(f"  Capital:         {overall_score.avg_capital:.1f}% (min: 90%)")
        print()
        
        if overall_score.failure_reason:
            print(f"⚠️ Failure Reason: {overall_score.failure_reason}")
            print()
        
        print(f"📄 Report: {md_path}")
        print(f"📊 Data: {json_path}")
        print(f"🔍 Traces: {traces_path}")
        print(f"⚠️ Failures: {failures_path}")
    
    storage.close()
    
    return 0 if overall_score.passed else 1


def list_scenarios(args: argparse.Namespace) -> int:
    """List available scenarios."""
    scenarios_dir = Path(args.scenarios).resolve()
    
    if not scenarios_dir.exists():
        print(f"❌ Scenarios directory not found: {scenarios_dir}")
        return 1
    
    print(f"📋 Scenarios in {scenarios_dir}")
    print()
    
    for level_dir in sorted(scenarios_dir.iterdir()):
        if level_dir.is_dir() and level_dir.name.startswith("level"):
            scenarios = list(level_dir.glob("*.yaml"))
            print(f"{level_dir.name}: {len(scenarios)} scenarios")
            for scenario in sorted(scenarios):
                print(f"  - {scenario.stem}")
    
    return 0


def create_parser() -> argparse.ArgumentParser:
    """Create CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="gauntlet",
        description="Solana Gauntlet - AI Agent Safety Benchmark",
    )
    parser.add_argument(
        "--version",
        default="v1.0",
        help="Benchmark version string",
    )
    
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # Run command
    run_parser = subparsers.add_parser("run", help="Run benchmark against an agent")
    run_parser.add_argument(
        "--agent", "-a",
        required=True,
        help="Path to agent Python file",
    )
    run_parser.add_argument(
        "--scenarios", "-s",
        default="./scenarios",
        help="Path to scenarios directory",
    )
    run_parser.add_argument(
        "--programs", "-p",
        default="./programs",
        help="Path to program binaries directory",
    )
    run_parser.add_argument(
        "--output", "-o",
        default="./output",
        help="Output directory for results",
    )
    run_parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Random seed for reproducibility",
    )
    run_parser.add_argument(
        "--mock",
        action="store_true",
        help="Run in mock mode without Surfpool (for testing)",
    )
    run_parser.add_argument(
        "--clone-mainnet",
        action="store_true",
        help="Clone Jupiter program from mainnet for real program testing",
    )
    run_parser.set_defaults(func=lambda args: asyncio.run(run_benchmark(args)))
    
    # List command
    list_parser = subparsers.add_parser("list", help="List available scenarios")
    list_parser.add_argument(
        "--scenarios", "-s",
        default="./scenarios",
        help="Path to scenarios directory",
    )
    list_parser.set_defaults(func=list_scenarios)
    
    return parser


def main() -> int:
    """Main entry point."""
    parser = create_parser()
    args = parser.parse_args()
    
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("\n⚠️ Interrupted")
        return 130
    except Exception as e:
        print(f"\n❌ Error: {e}")
        if "--debug" in sys.argv:
            raise
        return 1


if __name__ == "__main__":
    sys.exit(main())
