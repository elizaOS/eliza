#!/usr/bin/env python3
"""REALM-Bench CLI."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

from benchmarks.realm.runner import REALMRunner
from benchmarks.realm.types import (
    LEADERBOARD_NOTE,
    LEADERBOARD_SCORES,
    PROBLEM_DESCRIPTIONS,
    ExecutionModel,
    REALMConfig,
    REALMReport,
    RealmProblem,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# .env loader (kept stable for the tests that import from here)
# ---------------------------------------------------------------------------


def _parse_env_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[len("export "):].strip()
    if "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    value = value.strip()
    if not key:
        return None
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        value = value[1:-1]
    return key, value


def load_env_file(path: Path, *, override: bool = False) -> dict[str, str]:
    loaded: dict[str, str] = {}
    if not path.exists() or not path.is_file():
        return loaded
    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            parsed = _parse_env_line(raw_line)
            if not parsed:
                continue
            key, value = parsed
            if not override and key in os.environ:
                continue
            os.environ[key] = value
            loaded[key] = value
    except Exception as exc:
        logger.debug("[REALM CLI] env load failed: %s", exc)
    return loaded


def load_root_env() -> None:
    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parents[2] / ".env",
    ]
    for c in candidates:
        if c.exists() and c.is_file():
            load_env_file(c, override=False)
            return


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="REALM-Bench: Real-World Planning Benchmark (P1..P11)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--data-path",
        default=str(Path(__file__).resolve().parent / "upstream" / "datasets"),
    )
    parser.add_argument("--output", default=None)
    parser.add_argument(
        "--problems",
        nargs="+",
        choices=[p.value for p in RealmProblem],
        default=None,
        help="Problem types to run (default: all P1..P11)",
    )
    parser.add_argument(
        "--categories",
        nargs="+",
        choices=[p.value for p in RealmProblem],
        default=None,
        help="Alias for --problems (back-compat).",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Max instances per problem type",
    )
    parser.add_argument("--max-steps", type=int, default=32)
    parser.add_argument("--timeout", type=int, default=300_000)
    parser.add_argument(
        "--execution-model",
        choices=["sequential", "parallel", "dag"],
        default="dag",
    )
    parser.add_argument("--no-adaptation", action="store_true")
    parser.add_argument("--model", default="gpt-4")
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument(
        "--provider",
        choices=["eliza", "mock", "local"],
        default="eliza",
    )
    parser.add_argument("--mock", action="store_true")
    parser.add_argument(
        "--use-sample-tasks",
        action="store_true",
        help="Use the tiny built-in P1 + P11 smoke instances",
    )
    parser.add_argument("--leaderboard", action="store_true")
    parser.add_argument("--no-save", action="store_true")
    parser.add_argument("--check-env", action="store_true")
    parser.add_argument("--export-trajectories", action="store_true")
    parser.add_argument("--no-trajectory-logging", action="store_true")
    return parser.parse_args()


def print_banner() -> None:
    print(
        """
REALM-Bench: Real-World Planning Benchmark
  Paper:  https://arxiv.org/abs/2502.18836
  GitHub: https://github.com/genglongling/REALM-Bench
"""
    )


def print_leaderboard() -> None:
    print("\nREALM-Bench Reference Scores")
    print("=" * 60)
    for entry, scores in LEADERBOARD_SCORES.items():
        keys = ", ".join(f"{k}={v}" for k, v in scores.items())
        print(f"  {entry}: {keys}")
    print("=" * 60)
    print(LEADERBOARD_NOTE)
    print()


def check_environment() -> dict[str, bool]:
    results: dict[str, bool] = {}
    keys = [
        ("OPENAI_API_KEY", "OpenAI"),
        ("ANTHROPIC_API_KEY", "Anthropic"),
        ("GOOGLE_GENERATIVE_AI_API_KEY", "Google Generative AI"),
        ("GROQ_API_KEY", "Groq"),
    ]
    print("\nAPI keys:")
    for env_var, name in keys:
        has_key = bool(os.environ.get(env_var))
        results[env_var] = has_key
        print(f"   {name}: {'set' if has_key else 'unset'}")
    bench_url = os.environ.get("ELIZA_BENCH_URL")
    results["eliza_bench_url"] = bool(bench_url)
    print(f"\nELIZA_BENCH_URL: {bench_url or 'unset'}")
    return results


def create_config(args: argparse.Namespace) -> REALMConfig:
    selected = args.problems or args.categories
    problems = [RealmProblem(p) for p in selected] if selected else None

    if args.output:
        output_dir = args.output
    else:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = f"./benchmark_results/realm/{timestamp}"

    return REALMConfig(
        data_path=args.data_path,
        output_dir=output_dir,
        max_tasks_per_problem=args.max_tasks,
        timeout_per_task_ms=args.timeout,
        max_steps=args.max_steps,
        execution_model=ExecutionModel(args.execution_model),
        problems=problems,
        enable_adaptation=not args.no_adaptation,
        save_detailed_logs=True,
        save_trajectories=True,
        generate_report=not args.no_save,
        model_name=args.model,
        use_sample_tasks=args.use_sample_tasks,
    )


def print_results_summary(report: REALMReport) -> None:
    metrics = report.metrics
    summary = report.summary
    print("\n" + "=" * 70)
    print("REALM-Bench Results")
    print("=" * 70)
    print(f"Status: {str(summary.get('status', 'unknown')).upper()}")
    print(f"Success rate: {metrics.overall_success_rate:.1%}")
    print(f"Tasks: {metrics.passed_tasks}/{metrics.total_tasks}")
    print(f"Avg planning quality:        {metrics.avg_planning_quality:.2f}")
    print(f"Avg optimality ratio:        {metrics.avg_optimality_ratio:.2f}")
    print(f"Avg constraint satisfaction: {metrics.avg_constraint_satisfaction:.2f}")
    print(f"Avg adaptation success:      {metrics.avg_adaptation_success_rate:.2f}")
    print(f"Avg planning time:           {metrics.avg_planning_time_ms:.0f} ms")
    print(f"Avg execution time:          {metrics.avg_execution_time_ms:.0f} ms")
    print("\nPer-problem breakdown:")
    for problem, data in sorted(report.problem_breakdown.items()):
        print(
            f"  {problem}: {data['passed']:.0f}/{data['total']:.0f} "
            f"(success {data['success_rate']:.1%}, "
            f"quality {data['avg_planning_quality']:.2f}, "
            f"opt {data['avg_optimality_ratio']:.2f})"
        )
    print()


async def run_benchmark(
    config: REALMConfig,
    verbose: bool = False,
    enable_trajectory_logging: bool = True,
    provider: str = "eliza",
) -> REALMReport:
    if verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    eliza_server = None
    if provider in {"mock", "local"}:
        runner = REALMRunner(
            config, use_mock=True, enable_trajectory_logging=enable_trajectory_logging
        )
    else:
        from eliza_adapter import ElizaREALMAgent, ElizaServerManager

        if not os.environ.get("ELIZA_BENCH_URL"):
            eliza_server = ElizaServerManager()
            eliza_server.start()
            client = eliza_server.client
        else:
            from eliza_adapter import ElizaClient

            client = ElizaClient()
            client.wait_until_ready(timeout=120)

        agent = ElizaREALMAgent(
            client=client,
            max_steps=config.max_steps,
            execution_model=config.execution_model,
            enable_adaptation=config.enable_adaptation,
        )
        runner = REALMRunner(
            config, agent=agent, enable_trajectory_logging=enable_trajectory_logging
        )

    try:
        report = await runner.run_benchmark()
    finally:
        close = getattr(runner.agent, "close", None)
        if callable(close):
            await close()
        if eliza_server is not None:
            eliza_server.stop()
    return report


def main() -> int:
    args = parse_args()
    load_root_env()
    if not args.json:
        print_banner()
    if args.check_env:
        check_environment()
        return 0
    if args.leaderboard:
        print_leaderboard()
        return 0

    config = create_config(args)
    if not args.json:
        print("Configuration:")
        print(f"  Data path: {config.data_path}")
        print(f"  Output:    {config.output_dir}")
        print(
            f"  Problems:  {[p.value for p in config.problems] if config.problems else 'all'}"
        )
        print(f"  Sample:    {config.use_sample_tasks}")
        print()

    try:
        provider = "mock" if args.mock else args.provider
        report = asyncio.run(
            run_benchmark(
                config,
                verbose=args.verbose,
                enable_trajectory_logging=not args.no_trajectory_logging,
                provider=provider,
            )
        )

        if args.json:
            runner = REALMRunner(config, agent=object())
            print(json.dumps(runner._report_to_dict(report), indent=2, default=str))
        else:
            print_results_summary(report)
        return 0

    except KeyboardInterrupt:
        if not args.json:
            print("\nInterrupted by user")
        return 130
    except Exception as exc:
        if args.json:
            print(json.dumps({"error": str(exc)}))
        else:
            logger.error("Benchmark failed: %s", exc)
            if args.verbose:
                import traceback

                traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
