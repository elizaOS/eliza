"""CLI for VisualWebBench."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
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
    # Source ------------------------------------------------------------------
    parser.add_argument(
        "--use-sample-tasks",
        action="store_true",
        help=(
            "Use the bundled labeled JSONL helper (one row per subtask, no images). "
            "Offline-CI only — scores are not comparable to upstream."
        ),
    )
    parser.add_argument("--fixture-path", type=str, default=None)
    parser.add_argument("--hf-repo", type=str, default="visualwebbench/VisualWebBench")
    parser.add_argument("--split", type=str, default="test")
    parser.add_argument(
        "--image-cache-dir",
        type=str,
        default=None,
        help="Where to materialise HF screenshots as PNG (default: ~/.cache/elizaos/visualwebbench/images).",
    )
    parser.add_argument(
        "--no-image-cache",
        dest="cache_images_to_disk",
        action="store_false",
        default=True,
        help="Keep image bytes in memory instead of caching to disk.",
    )

    # Tasks -------------------------------------------------------------------
    parser.add_argument(
        "--task-types",
        type=str,
        default=",".join(t.value for t in VISUALWEBBENCH_TASK_TYPES),
    )
    parser.add_argument("--max-tasks", type=int, default=None)
    parser.add_argument("--output", type=str, default=None)

    # Agent -------------------------------------------------------------------
    parser.add_argument(
        "--mock",
        action="store_true",
        help=(
            "Run the offline oracle agent that reads task.answer directly. "
            "Use ONLY for smoke tests and CI — guarantees 100% score, so it is "
            "never appropriate for real measurements."
        ),
    )
    parser.add_argument(
        "--provider",
        type=str,
        choices=[
            "eliza",
            "eliza-bridge",
            "eliza-ts",
            "eliza-app-harness",
            "eliza-app",
            "eliza-browser-app",
            "app-harness",
        ],
        default="eliza",
        help="Eliza integration mode (ignored when --mock is set).",
    )
    parser.add_argument("--model", type=str, default=None)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--timeout", type=int, default=120000)
    parser.add_argument("--bbox-iou-threshold", type=float, default=0.5)

    # App harness passthrough (unchanged) ------------------------------------
    parser.add_argument("--app-harness-script", type=str, default=None)
    parser.add_argument("--app-harness-runtime", type=str, default="bun")
    parser.add_argument(
        "--app-harness-no-launch",
        dest="app_harness_no_launch",
        action="store_true",
        default=True,
    )
    parser.add_argument(
        "--app-harness-launch",
        dest="app_harness_no_launch",
        action="store_false",
    )
    parser.add_argument(
        "--app-harness-prompt-via-ui",
        dest="app_harness_prompt_via_ui",
        action="store_true",
        default=True,
    )
    parser.add_argument(
        "--app-harness-prompt-via-api",
        dest="app_harness_prompt_via_ui",
        action="store_false",
    )
    parser.add_argument("--app-harness-dry-run", action="store_true")
    parser.add_argument("--app-harness-api-base", type=str, default=None)
    parser.add_argument("--app-harness-ui-url", type=str, default=None)
    parser.add_argument("--app-harness-poll-interval", type=int, default=None)

    parser.add_argument("--no-traces", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def create_config(args: argparse.Namespace) -> VisualWebBenchConfig:
    if args.output:
        output_dir = args.output
    else:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = f"./benchmark_results/visualwebbench/{ts}"

    task_types = _parse_task_types(args.task_types)
    use_sample = bool(args.use_sample_tasks)

    return VisualWebBenchConfig(
        output_dir=output_dir,
        fixture_path=Path(args.fixture_path).resolve() if args.fixture_path else None,
        hf_repo=args.hf_repo,
        split=args.split,
        task_types=task_types,
        max_tasks=args.max_tasks,
        mock=bool(args.mock),
        use_huggingface=not use_sample,
        use_sample_tasks=use_sample,
        cache_images_to_disk=bool(args.cache_images_to_disk),
        image_cache_dir=Path(args.image_cache_dir).resolve() if args.image_cache_dir else None,
        provider=args.provider,
        model=args.model,
        temperature=args.temperature,
        timeout_ms=max(1000, args.timeout),
        bbox_iou_threshold=args.bbox_iou_threshold,
        save_traces=not args.no_traces,
        app_harness_script=Path(args.app_harness_script).resolve()
        if args.app_harness_script
        else None,
        app_harness_runtime=args.app_harness_runtime,
        app_harness_no_launch=args.app_harness_no_launch,
        app_harness_prompt_via_ui=args.app_harness_prompt_via_ui,
        app_harness_dry_run=args.app_harness_dry_run,
        app_harness_api_base=args.app_harness_api_base,
        app_harness_ui_url=args.app_harness_ui_url,
        app_harness_poll_interval_ms=args.app_harness_poll_interval,
        verbose=args.verbose,
    )


async def run(config: VisualWebBenchConfig) -> dict[str, object]:
    runner = VisualWebBenchRunner(config)
    report = await runner.run_benchmark()
    return {
        "total_tasks": report.total_tasks,
        "overall_accuracy": report.overall_accuracy,
        "by_task_type": report.by_task_type,
        "average_latency_ms": report.average_latency_ms,
        "summary": report.summary,
        "output_dir": config.output_dir,
    }


def main() -> int:
    args = parse_args()
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    config = create_config(args)
    server_mgr = None
    provider = (config.provider or "").strip().lower()
    needs_eliza_bridge = (
        not config.mock
        and provider in {"eliza", "eliza-bridge", "eliza-ts"}
        and os.environ.get("BENCHMARK_HARNESS", "").strip().lower()
        not in {"hermes", "openclaw"}
    )

    try:
        if needs_eliza_bridge and (
            not os.environ.get("ELIZA_BENCH_URL") or not os.environ.get("ELIZA_BENCH_TOKEN")
        ):
            from eliza_adapter.server_manager import ElizaServerManager

            server_mgr = ElizaServerManager()
            server_mgr.start()
            os.environ["ELIZA_BENCH_TOKEN"] = server_mgr.token
            os.environ["ELIZA_BENCH_URL"] = f"http://localhost:{server_mgr.port}"
        results = asyncio.run(run(config))
    except KeyboardInterrupt:
        logger.info("VisualWebBench interrupted")
        return 130
    except Exception as exc:
        logger.error("VisualWebBench failed: %s", exc)
        if args.json:
            print(json.dumps({"error": str(exc)}, indent=2))
        return 1
    finally:
        if server_mgr is not None:
            server_mgr.stop()

    if args.json:
        print(json.dumps(results, indent=2, default=str))
    else:
        print("\n" + "=" * 60)
        print("VisualWebBench Results")
        print("=" * 60)
        print(f"Tasks: {results['total_tasks']}")
        print(f"Overall Score: {float(results['overall_accuracy']) * 100:.1f}")
        summary = results.get("summary", {}) or {}
        if isinstance(summary, dict):
            print(f"ROUGE mean: {float(summary.get('rouge_score', 0)) * 100:.1f}")
            print(f"F1 (webqa): {float(summary.get('f1_score', 0)) * 100:.1f}")
            print(f"Choice accuracy: {float(summary.get('choice_accuracy', 0)) * 100:.1f}")
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
