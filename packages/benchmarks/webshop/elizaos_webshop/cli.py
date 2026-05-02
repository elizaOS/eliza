#!/usr/bin/env python3
"""
WebShop Benchmark CLI for ElizaOS.

Examples:
  python -m elizaos_webshop --sample
  python -m elizaos_webshop --sample --max-tasks 3
  python -m elizaos_webshop --sample --mock
  python -m elizaos_webshop --sample --trajectories --trajectory-format grpo
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

from elizaos_webshop.runner import WebShopRunner
from elizaos_webshop.types import WebShopConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


def _maybe_load_dotenv() -> None:
    """
    Best-effort loading of environment variables from .env.

    This is optional (no hard dependency on python-dotenv). When available, we load:
    - A benchmark-specific env file next to the benchmark: `.env.webshop` (if present)
    - The nearest `.env` found by searching upwards from CWD
    """
    try:
        from dotenv import find_dotenv, load_dotenv  # type: ignore[import-not-found]
    except Exception:
        return

    try:
        local_env = Path(__file__).resolve().parent.parent / ".env.webshop"
        if local_env.exists():
            load_dotenv(local_env, override=False)

        env_path = find_dotenv(usecwd=True)
        if env_path:
            load_dotenv(env_path, override=False)
    except Exception:
        return


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="ElizaOS WebShop Benchmark CLI")
    p.add_argument("--sample", action="store_true", help="Use built-in sample tasks/products")
    p.add_argument("--hf", action="store_true", help="Load tasks from HuggingFace (tasks only)")
    p.add_argument("--split", type=str, default="test", help="HF split (default: test)")
    p.add_argument("--max-tasks", type=int, default=None, help="Maximum tasks to run")
    p.add_argument("--trials", type=int, default=1, help="Trials per task (default: 1)")
    p.add_argument("--max-turns", type=int, default=20, help="Max turns per task (default: 20)")
    p.add_argument("--timeout", type=int, default=120000, help="Timeout per task in ms")
    p.add_argument("--output", type=str, default=None, help="Output directory")
    p.add_argument("--verbose", action="store_true", help="Verbose logging")
    p.add_argument("--no-details", action="store_true", help="Disable detailed json output")
    p.add_argument("--json", action="store_true", help="Print results json to stdout")

    # Eliza integration
    p.add_argument("--mock", action="store_true", help="Use mock agent instead of real LLM (for testing)")
    p.add_argument("--real-llm", action="store_true", help="(deprecated, now the default) Use real LLM via ElizaOS runtime")
    p.add_argument("--temperature", type=float, default=0.0, help="LLM temperature")
    p.add_argument("--model", type=str, default=None, help="Model name (e.g. qwen3-32b)")
    p.add_argument(
        "--model-provider",
        type=str,
        choices=["openai", "groq", "openrouter", "anthropic", "google", "ollama"],
        default=None,
        help="Force provider (auto-detect if unset)",
    )

    # Trajectories
    p.add_argument(
        "--trajectories",
        action="store_true",
        help="Enable trajectory logging + export (requires elizaos-plugin-trajectory-logger)",
    )
    p.add_argument("--no-trajectories", action="store_true", help="Disable trajectory logging")
    p.add_argument(
        "--trajectory-format",
        type=str,
        choices=["art", "grpo"],
        default="art",
        help="Trajectory export format",
    )
    return p.parse_args()


def create_config(args: argparse.Namespace) -> WebShopConfig:
    if args.output:
        out = args.output
    else:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        out = f"./benchmark_results/webshop/{ts}"

    use_mock = bool(args.mock)

    return WebShopConfig(
        output_dir=out,
        max_tasks=args.max_tasks,
        num_trials=max(1, int(args.trials)),
        max_turns_per_task=max(1, int(args.max_turns)),
        timeout_ms=max(1, int(args.timeout)),
        verbose=bool(args.verbose),
        save_detailed_logs=not bool(args.no_details),
        use_mock=use_mock,
        temperature=float(args.temperature),
        model_provider=args.model_provider,
        enable_trajectory_logging=(bool(args.trajectories) or not use_mock)
        and not bool(args.no_trajectories),
        trajectory_export_format=str(args.trajectory_format),
    )


async def run(config: WebShopConfig, *, split: str, use_hf: bool) -> dict[str, object]:
    runner = WebShopRunner(config, split=split, use_hf=use_hf)
    report = await runner.run_benchmark()
    # For stdout, keep this short; full files are written to disk.
    return {
        "total_tasks": report.total_tasks,
        "total_trials": report.total_trials,
        "success_rate": report.success_rate,
        "average_reward": report.average_reward,
        "summary": report.summary,
        "output_dir": config.output_dir,
    }


def main() -> int:
    _maybe_load_dotenv()
    args = parse_args()
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Default behavior: sample unless HF explicitly requested.
    use_hf = bool(args.hf)
    if not args.sample and not args.hf:
        args.sample = True

    config = create_config(args)
    if config.model_provider:
        os.environ["BENCHMARK_MODEL_PROVIDER"] = config.model_provider
    if args.model:
        os.environ["BENCHMARK_MODEL_NAME"] = args.model
        os.environ["OPENAI_LARGE_MODEL"] = args.model
        os.environ["OPENAI_SMALL_MODEL"] = args.model
        os.environ["GROQ_LARGE_MODEL"] = args.model
        os.environ["GROQ_SMALL_MODEL"] = args.model

    if config.use_mock:
        logger.warning(
            "WARNING: Running in mock mode. Results are not representative of real agent performance."
        )
    else:
        provider = (config.model_provider or os.environ.get("BENCHMARK_MODEL_PROVIDER", "")).strip().lower()
        if not provider:
            if os.environ.get("GROQ_API_KEY"):
                provider = "groq"
            elif os.environ.get("OPENROUTER_API_KEY"):
                provider = "openrouter"
            elif os.environ.get("OPENAI_API_KEY"):
                provider = "openai"
        key_var = {
            "openai": "OPENAI_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
            "google": "GOOGLE_API_KEY",
        }.get(provider, "OPENAI_API_KEY")
        if not os.environ.get(key_var):
            logger.error(
                "ERROR: No API key found for provider '%s'. Set %s or use --mock.",
                provider or "auto",
                key_var,
            )
            return 1

    try:
        results = asyncio.run(run(config, split=str(args.split), use_hf=use_hf))
        if args.json:
            print(json.dumps(results, indent=2, default=str))
        else:
            print(f"Success rate: {results.get('success_rate', 0.0) * 100:.1f}%")
            print(f"Average reward: {results.get('average_reward', 0.0):.3f}")
            print(f"Output: {config.output_dir}")
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as e:
        logger.error(f"WebShop benchmark failed: {e}")
        if args.json:
            print(json.dumps({"error": str(e)}, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
