"""CLI for orchestrator lifecycle benchmark."""

from __future__ import annotations

import argparse

from .runner import LifecycleRunner
from .types import LifecycleConfig


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run orchestrator lifecycle scenario benchmark",
    )
    parser.add_argument("--output", type=str, default="./benchmark_results/orchestrator-lifecycle")
    parser.add_argument(
        "--scenario-dir",
        type=str,
        default="benchmarks/orchestrator_lifecycle/scenarios",
    )
    parser.add_argument("--max-scenarios", type=int, default=None)
    parser.add_argument("--scenario-filter", type=str, default=None)
    parser.add_argument("--provider", type=str, default="openai")
    parser.add_argument("--model", type=str, default="gpt-4o")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = LifecycleConfig(
        output_dir=args.output,
        scenario_dir=args.scenario_dir,
        max_scenarios=args.max_scenarios,
        scenario_filter=args.scenario_filter,
        provider=args.provider,
        model=args.model,
        strict=bool(args.strict),
        seed=args.seed,
    )
    runner = LifecycleRunner(config)
    results, metrics, report_path = runner.run()
    print("Orchestrator lifecycle benchmark complete")
    print(f"Scenarios: {len(results)}")
    print(f"Overall score: {metrics.overall_score:.3f}")
    print(f"Pass rate: {metrics.scenario_pass_rate:.1%}")
    print(f"Report: {report_path}")


if __name__ == "__main__":
    main()
