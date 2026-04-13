#!/usr/bin/env python3
"""Run the experience benchmark suite.

Usage:
    # Direct mode (existing behavior - no LLM required):
    python run_benchmark.py
    python run_benchmark.py --experiences 2000 --queries 200 --output results.json

    # Eliza agent mode:
    python run_benchmark.py --mode eliza-agent --provider groq --model qwen3-32b
    python run_benchmark.py --mode eliza-agent --learning-cycles 20 --output results.json

Modes:
    direct:      Direct ExperienceService testing (default, no LLM)
    eliza-agent: Full Eliza agent loop (Provider -> Model -> Action -> Evaluator)
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Add paths
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "plugins" / "plugin-experience" / "python"))

from elizaos_experience_bench.runner import ExperienceBenchmarkRunner
from elizaos_experience_bench.types import BenchmarkConfig, BenchmarkMode


def _load_env_file(env_path: Path) -> None:
    """Minimal .env loader (no external dependency)."""
    if not env_path.exists():
        return
    try:
        content = env_path.read_text(encoding="utf-8")
    except Exception:
        return
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        if key not in os.environ:
            os.environ[key] = value


def run_direct(args: argparse.Namespace) -> None:
    """Run the direct (non-agent) benchmark mode."""
    config = BenchmarkConfig(
        num_experiences=args.experiences,
        num_retrieval_queries=args.queries,
        num_learning_cycles=args.learning_cycles,
        seed=args.seed,
    )

    runner = ExperienceBenchmarkRunner(config)
    runner.run_and_report(output_path=args.output)


async def run_eliza_agent(args: argparse.Namespace) -> None:
    """Run the Eliza agent benchmark mode."""
    # Load .env for API keys
    repo_root = Path(__file__).resolve().parents[2]
    _load_env_file(repo_root / ".env")

    provider = (args.provider or os.environ.get("BENCHMARK_MODEL_PROVIDER", "")).strip().lower()
    model_name = (args.model or os.environ.get("BENCHMARK_MODEL_NAME", "")).strip()
    if not provider and "/" in model_name:
        provider = model_name.split("/", 1)[0].strip().lower()
    if not provider:
        if os.environ.get("GROQ_API_KEY"):
            provider = "groq"
        elif os.environ.get("OPENROUTER_API_KEY"):
            provider = "openrouter"
        elif os.environ.get("OPENAI_API_KEY"):
            provider = "openai"
        else:
            provider = "openai"
    if not model_name:
        model_name = "qwen3-32b" if provider in {"groq", "openrouter"} else "gpt-4o-mini"

    os.environ["BENCHMARK_MODEL_PROVIDER"] = provider
    os.environ["BENCHMARK_MODEL_NAME"] = model_name
    os.environ["OPENAI_LARGE_MODEL"] = model_name
    os.environ["OPENAI_SMALL_MODEL"] = model_name
    os.environ["GROQ_LARGE_MODEL"] = model_name
    os.environ["GROQ_SMALL_MODEL"] = model_name

    key_var = {
        "openai": "OPENAI_API_KEY",
        "groq": "GROQ_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "google": "GOOGLE_API_KEY",
    }.get(provider, "OPENAI_API_KEY")

    if not os.environ.get(key_var):
        print(
            f"ERROR: {key_var} is not set.\n"
            "The eliza-agent mode requires a real LLM.\n"
            "Add it to the repo-root .env or export it."
        )
        sys.exit(1)

    config = BenchmarkConfig(
        num_experiences=args.experiences,
        num_retrieval_queries=args.queries,
        num_learning_cycles=args.learning_cycles,
        seed=args.seed,
    )

    print("=" * 60)
    print("ElizaOS Experience Benchmark - Agent Mode")
    print("=" * 60)
    print("This tests the full Eliza canonical flow:")
    print("  EXPERIENCE_CONTEXT Provider -> Model -> RECORD/QUERY Actions -> Evaluator")
    print()

    def on_progress(phase: str, completed: int, total: int) -> None:
        pct = completed / total * 100 if total > 0 else 0
        bar_len = 30
        filled = int(bar_len * completed / total) if total > 0 else 0
        bar = "█" * filled + "░" * (bar_len - filled)
        print(f"\r  {phase}: [{bar}] {completed}/{total} ({pct:.1f}%)", end="", flush=True)
        if completed >= total:
            print()

    def get_model_plugin_factory():  # noqa: ANN202
        if provider == "openai":
            from elizaos_plugin_openai import get_openai_plugin

            return get_openai_plugin()

        if provider in {"groq", "openrouter"}:
            from elizaos.types.model import ModelType
            from elizaos.types.plugin import Plugin
            import aiohttp
            import re

            base_url = {
                "groq": "https://api.groq.com/openai/v1",
                "openrouter": "https://openrouter.ai/api/v1",
            }[provider]
            api_key = os.environ.get(key_var, "")

            async def _chat_completion(_runtime: object, params: dict[str, object]) -> str:
                prompt_raw = params.get("prompt", "")
                system_raw = params.get("system", "")
                prompt = str(prompt_raw) if prompt_raw is not None else ""
                system = str(system_raw) if system_raw is not None else ""
                temperature_raw = params.get("temperature", 0.2)
                temperature = float(temperature_raw) if isinstance(temperature_raw, int | float) else 0.2
                max_tokens_raw = params.get("maxTokens", 4096)
                max_tokens = int(max_tokens_raw) if isinstance(max_tokens_raw, int | float) else 4096

                messages: list[dict[str, str]] = []
                if system:
                    messages.append({"role": "system", "content": system})
                if prompt:
                    messages.append({"role": "user", "content": prompt})
                if not messages:
                    return ""

                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        f"{base_url}/chat/completions",
                        headers={
                            "Authorization": f"Bearer {api_key}",
                            "Content-Type": "application/json",
                            "Accept-Encoding": "identity",
                        },
                        json={
                            "model": model_name,
                            "messages": messages,
                            "max_tokens": max_tokens,
                            "temperature": temperature,
                        },
                    ) as resp:
                        data = await resp.json()
                        if "error" in data:
                            raise RuntimeError(f"API error: {data['error']}")
                        text = str(data.get("choices", [{}])[0].get("message", {}).get("content", ""))
                        think_match = re.search(r"<think>([\s\S]*?)</think>", text)
                        if think_match is not None:
                            thought = think_match.group(1).strip()[:800]
                            text = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
                            if "<thought>" not in text:
                                if "<response>" in text:
                                    text = text.replace("<response>", f"<response>\n  <thought>{thought}</thought>", 1)
                                else:
                                    text = f"<thought>{thought}</thought>\n{text}"
                        return text

            return Plugin(
                name=f"{provider}-model-provider",
                description=f"{provider} model provider ({model_name})",
                models={
                    ModelType.TEXT_LARGE: _chat_completion,
                    ModelType.TEXT_SMALL: _chat_completion,
                },
            )

        raise RuntimeError(f"Unsupported provider for experience benchmark: {provider}")

    runner = ExperienceBenchmarkRunner(config)
    result = await runner.run_eliza_agent(
        model_plugin_factory=get_model_plugin_factory,
        progress_callback=on_progress,
    )

    if args.output:
        import json

        report = _serialize_agent_result(result)
        with open(args.output, "w") as f:
            json.dump(report, f, indent=2, default=str)
        print(f"\n[ExperienceBench] Report written to {args.output}")


def _serialize_agent_result(result: "BenchmarkResult") -> dict:
    """Serialize agent benchmark result to JSON-friendly dict."""
    from elizaos_experience_bench.types import BenchmarkResult

    out: dict = {
        "mode": "eliza_agent",
        "total_experiences": result.total_experiences,
    }
    if result.eliza_agent:
        out["eliza_agent"] = {
            "learning_success_rate": result.eliza_agent.learning_success_rate,
            "total_experiences_recorded": result.eliza_agent.total_experiences_recorded,
            "total_experiences_in_service": result.eliza_agent.total_experiences_in_service,
            "avg_learning_latency_ms": result.eliza_agent.avg_learning_latency_ms,
            "agent_recall_rate": result.eliza_agent.agent_recall_rate,
            "agent_keyword_incorporation_rate": result.eliza_agent.agent_keyword_incorporation_rate,
            "avg_retrieval_latency_ms": result.eliza_agent.avg_retrieval_latency_ms,
            "direct_recall_rate": result.eliza_agent.direct_recall_rate,
            "direct_mrr": result.eliza_agent.direct_mrr,
        }
    if result.retrieval:
        out["direct_retrieval"] = {
            "precision_at_k": result.retrieval.precision_at_k,
            "recall_at_k": result.retrieval.recall_at_k,
            "mean_reciprocal_rank": result.retrieval.mean_reciprocal_rank,
            "hit_rate_at_k": result.retrieval.hit_rate_at_k,
        }
    return out


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Experience Plugin Benchmark")
    parser.add_argument(
        "--mode",
        choices=["direct", "eliza-agent"],
        default="direct",
        help=(
            "Benchmark mode: 'direct' tests ExperienceService directly (default), "
            "'eliza-agent' tests through a real Eliza agent with LLM"
        ),
    )
    parser.add_argument("--experiences", type=int, default=1000, help="Number of synthetic experiences")
    parser.add_argument("--queries", type=int, default=100, help="Number of retrieval queries")
    parser.add_argument("--learning-cycles", type=int, default=20, help="Number of learning cycle scenarios")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--output", type=str, default=None, help="Output JSON path")
    parser.add_argument(
        "--provider",
        type=str,
        choices=["openai", "groq", "openrouter", "anthropic", "google", "ollama"],
        default=None,
        help="Provider for eliza-agent mode (default: auto-detect)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Model name for eliza-agent mode (e.g. qwen3-32b)",
    )
    args = parser.parse_args()

    if args.mode == "direct":
        run_direct(args)
    elif args.mode == "eliza-agent":
        asyncio.run(run_eliza_agent(args))
    else:
        parser.error(f"Unknown mode: {args.mode}")


if __name__ == "__main__":
    main()
