"""CLI for orchestrator lifecycle benchmark."""

from __future__ import annotations

import os
import sys

if __package__ in {None, ""}:
    package_dir = os.path.dirname(os.path.abspath(__file__))
    if sys.path and os.path.abspath(sys.path[0]) == package_dir:
        sys.path.pop(0)
    sys.path.insert(0, os.path.dirname(package_dir))
    __package__ = "orchestrator_lifecycle"

import argparse
import json

from .dataset import LifecycleDataset
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
    parser.add_argument(
        "--expand-scenarios",
        action="store_true",
        help="Compatibility flag; lifecycle scenarios are expanded by default",
    )
    parser.add_argument("--count-scenarios", action="store_true")
    parser.add_argument("--validate-scenarios", action="store_true")
    parser.add_argument(
        "--mode",
        choices=("bridge", "simulate"),
        default="bridge",
        help=(
            "How to generate replies. `bridge` (default) routes every turn "
            "through the elizaOS TS bench server so the real agent + "
            "registered actions answer. `simulate` falls back to the "
            "deterministic keyword simulator (smoke-test only — does not "
            "measure the eliza agent)."
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.count_scenarios:
        dataset = LifecycleDataset(args.scenario_dir)
        print(json.dumps(dataset.count_scenarios(), indent=2))
        return
    if args.validate_scenarios:
        dataset = LifecycleDataset(args.scenario_dir)
        validation = dataset.validate_scenarios()
        print(json.dumps(validation, indent=2))
        if not validation["valid"]:
            raise SystemExit(1)
        return

    config = LifecycleConfig(
        output_dir=args.output,
        scenario_dir=args.scenario_dir,
        max_scenarios=args.max_scenarios,
        scenario_filter=args.scenario_filter,
        provider=args.provider,
        model=args.model,
        strict=bool(args.strict),
        seed=args.seed,
        mode=args.mode,
    )
    with LifecycleRunner(config) as runner:
        results, metrics, report_path = runner.run()
    print("Orchestrator lifecycle benchmark complete")
    print(f"Mode: {config.mode}")
    print(f"Scenarios: {len(results)}")
    print(f"Overall score: {metrics.overall_score:.3f}")
    print(f"Pass rate: {metrics.scenario_pass_rate:.1%}")
    print(f"Report: {report_path}")


if __name__ == "__main__":
    main()
