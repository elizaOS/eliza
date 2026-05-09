#!/usr/bin/env python3
"""
MINT Benchmark CLI Runner

Run the MINT benchmark evaluation with a local runner or the TypeScript bridge.

Usage:
    python run_benchmark.py [options]

Examples:
    # Run full benchmark with default settings
    python run_benchmark.py

    # Run quick test with limited tasks
    python run_benchmark.py --max-tasks 2 --no-ablation

    # Run specific categories only
    python run_benchmark.py --categories reasoning coding

    # Run without Docker (local execution)
    python run_benchmark.py --no-docker
"""

import argparse
import asyncio
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path

# Add paths for imports
benchmark_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(benchmark_root))
sys.path.insert(0, str(benchmark_root / "benchmarks" / "eliza-adapter"))

# Now we can import
from benchmarks.mint.types import MINTCategory, MINTConfig
from benchmarks.mint.runner import MINTRunner


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[logging.StreamHandler()],
    )


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Run MINT benchmark with a local runner or the Eliza TypeScript bridge",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument(
        "--dotenv",
        type=str,
        default=None,
        help="Optional path to a .env file to load before running",
    )

    # Task selection
    parser.add_argument(
        "--categories",
        nargs="+",
        choices=["reasoning", "coding", "decision_making", "information_seeking"],
        help="Categories to evaluate (default: all)",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Maximum tasks per category (default: all)",
    )

    # Execution settings
    parser.add_argument(
        "--max-turns",
        type=int,
        default=5,
        help="Maximum turns per task (default: 5)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120,
        help="Timeout per task in seconds (default: 120)",
    )
    parser.add_argument(
        "--no-docker",
        action="store_true",
        help="Run code locally instead of in Docker",
    )

    # Feature flags
    parser.add_argument(
        "--no-tools",
        action="store_true",
        help="Disable tool (code) execution",
    )
    parser.add_argument(
        "--no-feedback",
        action="store_true",
        help="Disable feedback generation",
    )
    parser.add_argument(
        "--no-ablation",
        action="store_true",
        help="Skip ablation study (just run full config)",
    )

    # Output
    parser.add_argument(
        "--output-dir",
        type=str,
        default="./benchmark_results/mint",
        help="Output directory for results (default: ./benchmark_results/mint)",
    )
    parser.add_argument(
        "--no-report",
        action="store_true",
        help="Don't generate markdown report",
    )
    parser.add_argument(
        "--save-trajectories",
        action="store_true",
        help="Save detailed trajectories to file",
    )
    parser.add_argument(
        "--llm-feedback",
        action="store_true",
        help="Generate feedback using the selected model provider (costly; default: rule-based)",
    )
    parser.add_argument(
        "--provider",
        choices=["mock", "eliza", "openai", "groq", "openrouter"],
        default="mock",
        help=(
            "Agent provider to use: local mock, eliza TS benchmark bridge, "
            "or direct OpenAI-compatible provider (default: mock)"
        ),
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Model name for direct OpenAI-compatible providers",
    )
    parser.add_argument(
        "--base-url",
        type=str,
        default=None,
        help=(
            "Override the OpenAI-compatible chat completions base URL "
            "(defaults to provider env such as OPENAI_BASE_URL, then provider default)"
        ),
    )

    parser.add_argument(
        "--no-trajectory-logging",
        action="store_true",
        help="Disable bridge-side trajectory logging export metadata",
    )
    parser.add_argument(
        "--trajectory-dataset",
        type=str,
        default="mint-benchmark",
        help="Dataset name used when exporting ART / GRPO trajectories",
    )

    # Misc
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    return parser.parse_args()


def create_config(args: argparse.Namespace) -> MINTConfig:
    """Create benchmark configuration from arguments."""
    categories = None
    if args.categories:
        categories = [MINTCategory(c) for c in args.categories]

    return MINTConfig(
        output_dir=args.output_dir,
        max_tasks_per_category=args.max_tasks,
        timeout_per_task_ms=args.timeout * 1000,
        max_turns=args.max_turns,
        use_docker=not args.no_docker,
        categories=categories,
        enable_tools=not args.no_tools,
        enable_feedback=not args.no_feedback,
        run_ablation=not args.no_ablation,
        save_detailed_logs=True,
        save_trajectories=args.save_trajectories,
        generate_report=not args.no_report,
        use_llm_feedback=args.llm_feedback,
    )


@dataclass
class _TextResponse:
    text: str


class OpenAICompatibleRuntime:
    """Minimal runtime adapter for direct MINT model calls."""

    def __init__(
        self,
        *,
        provider: str,
        model: str,
        api_key: str,
        base_url: str | None = None,
    ) -> None:
        self.provider = provider
        self.model = model
        self.api_key = api_key
        env_base_url = {
            "openai": os.environ.get("OPENAI_BASE_URL"),
            "groq": os.environ.get("GROQ_BASE_URL") or os.environ.get("OPENAI_BASE_URL"),
            "openrouter": os.environ.get("OPENROUTER_BASE_URL") or os.environ.get("OPENAI_BASE_URL"),
        }.get(provider)
        provider_default = {
            "openai": "https://api.openai.com/v1",
            "groq": "https://api.groq.com/openai/v1",
            "openrouter": "https://openrouter.ai/api/v1",
        }[provider]
        self.base_url = (base_url or env_base_url or provider_default).rstrip("/")

    async def use_model(
        self,
        model_type: object,
        params: dict[str, object] | None = None,
        **kwargs: object,
    ) -> _TextResponse:
        import aiohttp

        _ = model_type
        _ = kwargs
        params = params or {}
        prompt = str(params.get("prompt", ""))
        temperature_raw = params.get("temperature", 0.0)
        temperature = (
            float(temperature_raw)
            if isinstance(temperature_raw, (int, float))
            else 0.0
        )
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Accept-Encoding": "identity",
                    "User-Agent": "eliza-mint-benchmark/1.0",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You solve MINT benchmark tasks. End every "
                                "answer with exactly: Final answer: <answer>."
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": temperature,
                    "max_tokens": 1024,
                },
            ) as resp:
                data = await resp.json(content_type=None)
                if resp.status >= 400 or "error" in data:
                    detail = data.get("error", data) if isinstance(data, dict) else data
                    raise RuntimeError(f"{self.provider} chat completion failed: {detail}")
                text = str(data.get("choices", [{}])[0].get("message", {}).get("content", ""))
        return _TextResponse(text=text)


def _load_dotenv_file(path: Path) -> None:
    """
    Minimal .env loader (no external dependency).

    - Ignores blank lines and comments
    - Supports KEY=VALUE and 'export KEY=VALUE'
    - Does not override existing environment variables
    """
    if not path.exists() or not path.is_file():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        k = key.strip()
        v = value.strip().strip("'").strip('"')
        if not k:
            continue
        if k not in os.environ:
            os.environ[k] = v


async def run_benchmark(
    config: MINTConfig,
    dotenv_path: str | None,
    verbose: bool,
    *,
    provider: str,
    model: str | None,
    base_url: str | None,
    enable_trajectory_logging: bool,
    trajectory_dataset: str,
) -> int:
    """Run the benchmark via the eliza TS bridge and return exit code."""
    runtime = None
    bridge_manager = None
    try:
        # Load .env (if provided or if repo-root .env exists)
        if dotenv_path:
            _load_dotenv_file(Path(dotenv_path))
        else:
            candidate = benchmark_root / ".env"
            _load_dotenv_file(candidate)

        runtime_provider = provider.strip().lower()
        direct_runtime = None
        if runtime_provider in {"openai", "groq", "openrouter"}:
            key_var = {
                "openai": "OPENAI_API_KEY",
                "groq": "GROQ_API_KEY",
                "openrouter": "OPENROUTER_API_KEY",
            }[runtime_provider]
            api_key = os.environ.get(key_var, "")
            if not api_key:
                raise RuntimeError(f"{key_var} is required for provider={runtime_provider}")
            model_name = model or {
                "openai": "openai/gpt-oss-120b",
                "groq": "openai/gpt-oss-120b",
                "openrouter": "openai/gpt-oss-120b",
            }[runtime_provider]
            direct_runtime = OpenAICompatibleRuntime(
                provider=runtime_provider,
                model=model_name,
                api_key=api_key,
                base_url=base_url,
            )

        runner = MINTRunner(
            config=config,
            runtime=direct_runtime,
            trajectory_logger_service=None,
            trajectory_dataset=trajectory_dataset,
        )

        if runtime_provider == "eliza":
            # The bridge agent forwards every multi-turn LLM call to the TS bench
            # server; MINTRunner reuses runner.executor and runner.feedback_generator.
            from eliza_adapter.mint import ElizaMINTAgent
            from eliza_adapter.server_manager import ElizaServerManager

            provider_name = os.environ.get("BENCHMARK_MODEL_PROVIDER", "").strip().lower()
            if not provider_name:
                if os.environ.get("GROQ_API_KEY"):
                    provider_name = "groq"
                elif os.environ.get("OPENROUTER_API_KEY"):
                    provider_name = "openrouter"
                elif os.environ.get("OPENAI_API_KEY"):
                    provider_name = "openai"
            model_name = (model or os.environ.get("BENCHMARK_MODEL_NAME", "")).strip()
            if not model_name:
                model_name = "openai/gpt-oss-120b"
            if provider_name:
                os.environ["BENCHMARK_MODEL_PROVIDER"] = provider_name
            os.environ["BENCHMARK_MODEL_NAME"] = model_name
            os.environ["OPENAI_LARGE_MODEL"] = model_name
            os.environ["OPENAI_SMALL_MODEL"] = model_name
            os.environ["GROQ_LARGE_MODEL"] = model_name
            os.environ["GROQ_SMALL_MODEL"] = model_name
            os.environ["OPENROUTER_LARGE_MODEL"] = model_name
            os.environ["OPENROUTER_SMALL_MODEL"] = model_name

            bridge_manager = ElizaServerManager()
            bridge_manager.start()

            runner.agent = ElizaMINTAgent(
                client=bridge_manager.client,
                tool_executor=runner.executor,
                feedback_generator=runner.feedback_generator,
                temperature=config.temperature,
            )
            logging.getLogger(__name__).info(
                "[mint] using ElizaMINTAgent (eliza TS benchmark bridge)"
            )
        elif direct_runtime is not None:
            logging.getLogger(__name__).info(
                "[mint] using direct %s model provider", runtime_provider
            )
        else:
            logging.getLogger(__name__).info("[mint] using local mock MINTAgent")
        _ = enable_trajectory_logging  # trajectory logging now lives in the bridge
        results = await runner.run_benchmark()

        # Print summary
        print("\n" + "=" * 60)
        print("MINT BENCHMARK RESULTS")
        print("=" * 60)

        summary = results.summary
        print(f"\nStatus: {summary.get('status', 'unknown').upper()}")
        print(f"Best Configuration: {summary.get('best_configuration', 'N/A')}")
        print(f"Best Success Rate: {summary.get('best_success_rate', 'N/A')}")

        print("\nKey Findings:")
        for finding in summary.get("key_findings", []):
            print(f"  • {finding}")

        print("\nRecommendations:")
        for rec in summary.get("recommendations", []):
            print(f"  • {rec}")

        print(f"\nResults saved to: {config.output_dir}")
        print("=" * 60)

        # Return 0 for success, 1 for partial success, 2 for failure
        status = str(summary.get("status", ""))
        if status == "excellent":
            return 0
        elif status in ("good", "moderate"):
            return 1
        else:
            return 2

    except Exception as e:
        logging.error(f"Benchmark failed: {e}")
        raise
    finally:
        if bridge_manager is not None:
            bridge_manager.stop()
        if runtime is not None:
            stop = getattr(runtime, "stop", None)
            if callable(stop):
                await stop()


def main() -> int:
    """Main entry point."""
    args = parse_args()
    setup_logging(args.verbose)

    print("=" * 60)
    print("MINT BENCHMARK - ElizaOS Python Runtime Evaluation")
    print("=" * 60)
    print()

    config = create_config(args)

    print("Configuration:")
    print(f"  Provider: {args.provider}")
    if args.model:
        print(f"  Model: {args.model}")
    print(f"  Categories: {[c.value for c in (config.categories or list(MINTCategory))]}")
    print(f"  Max tasks per category: {config.max_tasks_per_category or 'all'}")
    print(f"  Max turns: {config.max_turns}")
    print(f"  Tools enabled: {config.enable_tools}")
    print(f"  Feedback enabled: {config.enable_feedback}")
    print(f"  LLM feedback: {config.use_llm_feedback}")
    print(f"  Ablation study: {config.run_ablation}")
    print(f"  Docker: {config.use_docker}")
    print()

    return asyncio.run(
        run_benchmark(
            config,
            args.dotenv,
            args.verbose,
            provider=str(args.provider),
            model=args.model,
            base_url=args.base_url,
            enable_trajectory_logging=not bool(args.no_trajectory_logging),
            trajectory_dataset=str(args.trajectory_dataset),
        )
    )


if __name__ == "__main__":
    sys.exit(main())
