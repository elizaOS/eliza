"""CLI for VisualWebBench."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

from benchmarks.visualwebbench.runner import VisualWebBenchRunner
from benchmarks.visualwebbench.types import (
    VISUALWEBBENCH_TASK_TYPES,
    VisualWebBenchConfig,
    VisualWebBenchTaskType,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="VisualWebBench benchmark for ElizaOS")
    parser.add_argument("--fixture", action="store_true", help="Use local JSONL fixture")
    parser.add_argument("--fixture-path", type=str, default=None, help="Path to local JSONL fixture")
    parser.add_argument("--hf", action="store_true", help="Stream from Hugging Face")
    parser.add_argument("--hf-repo", type=str, default="visualwebbench/VisualWebBench")
    parser.add_argument("--split", type=str, default="test")
    parser.add_argument(
        "--task-types",
        type=str,
        default=",".join(t.value for t in VISUALWEBBENCH_TASK_TYPES),
        help="Comma-separated task config names",
    )
    parser.add_argument("--max-tasks", type=int, default=None)
    parser.add_argument("--output", type=str, default=None)
    parser.add_argument("--dry-run", action="store_true", default=False)
    parser.add_argument(
        "--provider",
        type=str,
        choices=["eliza", "eliza-bridge", "eliza-ts"],
        default=None,
        help="Use the Eliza benchmark server bridge",
    )
    parser.add_argument("--model", type=str, default=None)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--timeout", type=int, default=120000)
    parser.add_argument("--bbox-iou-threshold", type=float, default=0.5)
    parser.add_argument("--no-traces", action="store_true")
    parser.add_argument("--json", action="store_true", help="Print aggregate JSON")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def create_config(args: argparse.Namespace) -> VisualWebBenchConfig:
    if args.output:
        output_dir = args.output
    else:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = f"./benchmark_results/visualwebbench/{ts}"

    task_types = _parse_task_types(args.task_types)
    use_hf = bool(args.hf)
    use_fixture = bool(args.fixture or not use_hf)
    dry_run = bool(args.dry_run or not args.provider)

    return VisualWebBenchConfig(
        output_dir=output_dir,
        fixture_path=Path(args.fixture_path).resolve() if args.fixture_path else None,
        hf_repo=args.hf_repo,
        split=args.split,
        task_types=task_types,
        max_tasks=args.max_tasks,
        dry_run=dry_run,
        use_huggingface=use_hf,
        use_fixture=use_fixture,
        provider=args.provider,
        model=args.model,
        temperature=args.temperature,
        timeout_ms=max(1000, args.timeout),
        bbox_iou_threshold=args.bbox_iou_threshold,
        save_traces=not args.no_traces,
        verbose=args.verbose,
    )


async def run(config: VisualWebBenchConfig) -> dict[str, object]:
    runner = VisualWebBenchRunner(config)
    report = await runner.run_benchmark()
    return {
        "total_tasks": report.total_tasks,
        "overall_accuracy": report.overall_accuracy,
        "exact_accuracy": report.exact_accuracy,
        "choice_accuracy": report.choice_accuracy,
        "bbox_accuracy": report.bbox_accuracy,
        "average_latency_ms": report.average_latency_ms,
        "summary": report.summary,
        "output_dir": config.output_dir,
    }


def main() -> int:
    args = parse_args()
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    config = create_config(args)

    try:
        results = asyncio.run(run(config))
    except KeyboardInterrupt:
        logger.info("VisualWebBench interrupted")
        return 130
    except Exception as exc:
        logger.error("VisualWebBench failed: %s", exc)
        if args.json:
            print(json.dumps({"error": str(exc)}, indent=2))
        return 1

    if args.json:
        print(json.dumps(results, indent=2, default=str))
    else:
        print("\n" + "=" * 60)
        print("VisualWebBench Results")
        print("=" * 60)
        print(f"Tasks: {results['total_tasks']}")
        print(f"Overall Accuracy: {float(results['overall_accuracy']) * 100:.1f}%")
        print(f"Exact Accuracy: {float(results['exact_accuracy']) * 100:.1f}%")
        print(f"Choice Accuracy: {float(results['choice_accuracy']) * 100:.1f}%")
        print(f"BBox Accuracy: {float(results['bbox_accuracy']) * 100:.1f}%")
        print(f"Results saved to: {config.output_dir}")
        print("=" * 60)
    return 0


def _parse_task_types(raw: str) -> tuple[VisualWebBenchTaskType, ...]:
    values: list[VisualWebBenchTaskType] = []
    for part in raw.split(","):
        value = part.strip()
        if not value:
            continue
        try:
            values.append(VisualWebBenchTaskType(value))
        except ValueError as exc:
            allowed = ", ".join(t.value for t in VISUALWEBBENCH_TASK_TYPES)
            raise argparse.ArgumentTypeError(
                f"Unknown VisualWebBench task type {value!r}; expected one of {allowed}"
            ) from exc
    return tuple(values) or VISUALWEBBENCH_TASK_TYPES


if __name__ == "__main__":
    raise SystemExit(main())
