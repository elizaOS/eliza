#!/usr/bin/env python3
"""
BFCL Benchmark Runner Script

Runs the BFCL benchmark against ElizaOS Python and generates results.

Usage:
    python benchmarks/bfcl/scripts/run_benchmark.py [OPTIONS]

Options:
    --sample N      Run only N sample tests
    --mock          Use mock agent (for testing)
    --output DIR    Output directory
"""

import asyncio
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(project_root))


async def main():
    """Run the BFCL benchmark."""
    import argparse

    parser = argparse.ArgumentParser(description="Run BFCL Benchmark")
    parser.add_argument("--sample", type=int, help="Number of sample tests")
    parser.add_argument("--mock", action="store_true", help="Use mock agent")
    parser.add_argument("--output", default="./benchmark_results/bfcl",
                        help="Output directory")
    parser.add_argument("--categories", help="Comma-separated categories")
    args = parser.parse_args()

    from benchmarks.bfcl import BFCLRunner, BFCLConfig, BFCLCategory
    from benchmarks.bfcl.reporting import print_results

    # Configure benchmark
    config = BFCLConfig(
        output_dir=args.output,
        generate_report=True,
        compare_baselines=True,
    )

    if args.categories:
        config.categories = [
            BFCLCategory(c.strip())
            for c in args.categories.split(",")
        ]

    # Create runner
    runner = BFCLRunner(config, use_mock_agent=args.mock)

    print("\n" + "=" * 60)
    print("BFCL BENCHMARK - ElizaOS Python")
    print("=" * 60)

    try:
        if args.sample:
            print(f"\nRunning sample of {args.sample} tests...\n")
            results = await runner.run_sample(n=args.sample)
        else:
            print("\nRunning full benchmark...\n")
            results = await runner.run()

        # Print results
        print_results(results)

        # Save results summary
        summary_path = Path(args.output) / "RESULTS.md"
        summary_path.parent.mkdir(parents=True, exist_ok=True)

        with open(summary_path, "w") as f:
            f.write("# BFCL Benchmark Results - ElizaOS Python\n\n")
            f.write(f"## Overall Score: {results.metrics.overall_score:.2%}\n\n")
            f.write("| Metric | Score |\n")
            f.write("|--------|-------|\n")
            f.write(f"| AST Accuracy | {results.metrics.ast_accuracy:.2%} |\n")
            f.write(f"| Exec Accuracy | {results.metrics.exec_accuracy:.2%} |\n")
            f.write(f"| Relevance Accuracy | {results.metrics.relevance_accuracy:.2%} |\n")
            f.write(f"\nTotal Tests: {results.metrics.total_tests}\n")
            f.write(f"Passed: {results.metrics.passed_tests}\n")
            f.write(f"Failed: {results.metrics.failed_tests}\n")

            if results.baseline_comparison:
                f.write("\n## Baseline Comparison\n\n")
                f.write("| Model | Difference |\n")
                f.write("|-------|------------|\n")
                for model, diff in sorted(
                    results.baseline_comparison.items(),
                    key=lambda x: x[1],
                    reverse=True,
                ):
                    sign = "+" if diff > 0 else ""
                    f.write(f"| {model} | {sign}{diff:.2%} |\n")

        print(f"\nResults saved to {summary_path}")
        return 0

    except Exception as e:
        print(f"\n❌ Benchmark failed: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
