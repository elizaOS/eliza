#!/usr/bin/env python3
"""
Run the Context Benchmark against ElizaOS Python.

This script runs a comprehensive context benchmark evaluation
and generates results for comparison with published leaderboards.

Modes:
- mock: Fast testing with heuristic-based mock LLM
- openai: Direct OpenAI API calls
- anthropic: Direct Anthropic API calls
- eliza-mock: Eliza runtime with mock model
- eliza-openai: Eliza runtime with OpenAI model plugin
- eliza-agent: FULL Eliza agent loop (Provider -> Action -> Evaluator)
"""

import asyncio
import argparse
import os
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from elizaos_context_bench import (
    ContextBenchConfig,
    ContextBenchRunner,
    ContextBenchReporter,
    NeedlePosition,
    save_results,
)


# Mock LLM for testing when no real LLM is available
async def mock_llm_query(context: str, question: str) -> str:
    """
    Mock LLM that extracts answers from context using simple heuristics.
    Used for testing the benchmark framework.
    """
    import re
    
    # Try to find patterns that look like answers
    patterns = [
        r"secret code[^.]*?is[^.]*?(\w+)",
        r"password[^.]*?is[^.]*?(\w+)",
        r"codename[^.]*?is[^.]*?(\w+)",
        r"located at[^.]*?(\w+)",
        r"exactly \$?([\d,]+(?:\.\d+)?)",
        r"(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:degrees|%|kilometers|dollars)",
        r"deadline[^.]*?is[^.]*?(\w+\s+\d+,?\s*\d+)",
        r"scheduled for[^.]*?(\w+\s+\d+,?\s*\d+)",
        r"Dr\.\s+(\w+\s+\w+)",
        r"CEO[^.]*?is[^.]*?(\w+\s+\w+)",
        r"revenue[^.]*?\$([\d.]+\s*million)",
        r"(\d+%)\s*success rate",
        r"Q[1-4]\s*\d{4}",
    ]
    
    context_lower = context.lower()
    question_lower = question.lower()
    
    for pattern in patterns:
        matches = re.findall(pattern, context, re.IGNORECASE)
        if matches:
            return matches[0] if isinstance(matches[0], str) else matches[0][0]
    
    # If no pattern matches, try to find any capitalized code-like strings
    codes = re.findall(r"\b[A-Z][A-Z0-9]{5,}\b", context)
    if codes:
        return codes[0]
    
    # Fallback
    return "Unable to find answer"


async def openai_llm_query(context: str, question: str) -> str:
    """Query OpenAI API for answer."""
    try:
        import openai
        
        client = openai.AsyncOpenAI()
        
        model_name = os.environ.get("OPENAI_SMALL_MODEL", "gpt-4o-mini")
        # gpt-5 reasoning models don't support temperature; only pass it for
        # older models.
        extra_params: dict[str, object] = {}
        if not model_name.startswith(("gpt-5", "o1", "o3")):
            extra_params["temperature"] = 0.0

        response = await client.chat.completions.create(
            model=model_name,
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful assistant that answers questions based on the provided context. Give brief, precise answers."
                },
                {
                    "role": "user",
                    "content": f"Context:\n{context}\n\nQuestion: {question}\n\nAnswer (be brief and precise):"
                }
            ],
            max_completion_tokens=100,
            **extra_params,
        )
        
        return response.choices[0].message.content or ""
    except Exception as e:
        raise RuntimeError(f"OpenAI API error: {e}") from e


async def anthropic_llm_query(context: str, question: str) -> str:
    """Query Anthropic API for answer."""
    try:
        import anthropic
        
        client = anthropic.AsyncAnthropic()
        
        message = await client.messages.create(
            model="claude-3-haiku-20240307",  # Use cheaper model for benchmark
            max_tokens=100,
            messages=[
                {
                    "role": "user",
                    "content": f"Context:\n{context}\n\nQuestion: {question}\n\nAnswer (be brief and precise):"
                }
            ],
        )
        
        return message.content[0].text if message.content else ""
    except Exception as e:
        raise RuntimeError(f"Anthropic API error: {e}") from e


def _load_env_file(env_path: Path) -> None:
    """
    Minimal .env loader (no external dependency).

    - Only sets keys that are not already present in os.environ.
    - Ignores blank lines and comments.
    """
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
            key = key[len("export ") :].strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        if key not in os.environ:
            os.environ[key] = value


def get_llm_query_fn(provider: str):
    """Get the appropriate LLM query function."""
    if provider == "mock":
        return mock_llm_query
    elif provider == "openai":
        if not os.environ.get("OPENAI_API_KEY"):
            raise ValueError(
                "OPENAI_API_KEY is not set. Add it to the repo-root .env or export it."
            )
        return openai_llm_query
    elif provider == "anthropic":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise ValueError(
                "ANTHROPIC_API_KEY is not set. Add it to the repo-root .env or export it."
            )
        return anthropic_llm_query
    elif provider == "eliza-openai":
        if not os.environ.get("OPENAI_API_KEY"):
            raise ValueError(
                "OPENAI_API_KEY is not set. Add it to the repo-root .env or export it."
            )
        # Avoid accidentally benchmarking with extremely expensive defaults.
        # Users can override with OPENAI_LARGE_MODEL / OPENAI_SMALL_MODEL in .env.
        os.environ.setdefault("OPENAI_LARGE_MODEL", "gpt-5-mini")
        os.environ.setdefault("OPENAI_SMALL_MODEL", "gpt-5-mini")
        # Uses Eliza's runtime + the OpenAI model plugin (requires OPENAI_API_KEY).
        from elizaos.runtime import AgentRuntime
        from elizaos.types.model import ModelType
        from elizaos_plugin_openai import get_openai_plugin

        runtime = AgentRuntime()

        # Register plugin models without requiring async plugin init.
        plugin = get_openai_plugin()
        if plugin.models:
            for model_type, handler in plugin.models.items():
                runtime.register_model(model_type, handler, provider=plugin.name)

        async def eliza_openai_query(context: str, question: str) -> str:
            system = (
                "You are a helpful assistant that answers questions based ONLY on the provided context. "
                "Return ONLY the answer text (no extra words, no markdown)."
            )
            prompt = (
                "Given the following context, answer the question precisely and concisely.\n\n"
                f"Context:\n{context}\n\n"
                f"Question: {question}\n\n"
                "Answer (be brief and precise):"
            )
            result = await runtime.use_model(
                ModelType.TEXT_LARGE,
                {"prompt": prompt, "system": system, "maxTokens": 256, "temperature": 0.0},
            )
            return str(result)

        return eliza_openai_query
    elif provider == "eliza-mock":
        # Uses the Eliza runtime model interface (runtime.use_model) with an in-process heuristic model.
        from elizaos.runtime import AgentRuntime
        from elizaos.types.model import ModelType

        runtime = AgentRuntime()

        async def model_handler(_rt: object, params: dict[str, object]) -> str:
            prompt = str(params.get("prompt", ""))
            return await mock_llm_query(prompt, "")

        runtime.register_model(ModelType.TEXT_LARGE, model_handler, provider="eliza-mock")

        async def eliza_mock_query(context: str, question: str) -> str:
            prompt = (
                "Given the following context, answer the question precisely and concisely.\n\n"
                f"Context:\n{context}\n\n"
                f"Question: {question}\n\n"
                "Answer (be brief and precise):"
            )
            result = await runtime.use_model(
                ModelType.TEXT_LARGE,
                {"prompt": prompt, "maxTokens": 100, "temperature": 0.0},
            )
            return str(result)

        return eliza_mock_query
    elif provider == "milady":
        from milady_adapter.context_bench import make_milady_llm_query

        return make_milady_llm_query()
    else:
        raise ValueError(f"Unknown provider: {provider}")


async def run_benchmark(
    provider: str = "mock",
    quick: bool = False,
    output_dir: str = "./benchmark_results",
) -> None:
    """Run the context benchmark."""

    # Load repo-root .env if present (for real providers)
    # benchmarks/context-bench/run_benchmark.py -> repo root is parents[2]
    repo_root = Path(__file__).resolve().parents[2]
    _load_env_file(repo_root / ".env")
    
    print("=" * 60)
    print("ElizaOS Context Benchmark")
    print("=" * 60)
    print(f"Provider: {provider}")
    print(f"Mode: {'Quick' if quick else 'Full'}")
    print(f"Output: {output_dir}")
    print()
    
    # Configure benchmark
    if quick:
        config = ContextBenchConfig(
            context_lengths=[1024, 4096],
            positions=[NeedlePosition.START, NeedlePosition.MIDDLE, NeedlePosition.END],
            tasks_per_position=2,
            run_niah_basic=True,
            run_niah_semantic=False,
            run_multi_hop=False,
            output_dir=output_dir,
        )
    else:
        config = ContextBenchConfig(
            context_lengths=[1024, 2048, 4096, 8192, 16384],
            positions=[
                NeedlePosition.START,
                NeedlePosition.EARLY,
                NeedlePosition.MIDDLE,
                NeedlePosition.LATE,
                NeedlePosition.END,
            ],
            tasks_per_position=3,
            run_niah_basic=True,
            run_niah_semantic=True,
            run_multi_hop=True,
            multi_hop_depths=[2, 3],
            output_dir=output_dir,
        )
    
    # Progress callback
    def on_progress(suite: str, completed: int, total: int) -> None:
        pct = completed / total * 100 if total > 0 else 0
        bar_len = 30
        filled = int(bar_len * completed / total) if total > 0 else 0
        bar = "█" * filled + "░" * (bar_len - filled)
        print(f"\r{suite}: [{bar}] {completed}/{total} ({pct:.1f}%)", end="", flush=True)
    
    # Special handling for eliza-agent mode (FULL canonical agent loop)
    if provider == "eliza-agent":
        await run_eliza_agent_benchmark_mode(
            config=config,
            output_dir=output_dir,
            on_progress=on_progress,
        )
        return
    
    # Get LLM function for other providers
    llm_fn = get_llm_query_fn(provider)
    
    # Create runner
    runner = ContextBenchRunner(
        config=config,
        llm_query_fn=llm_fn,
        seed=42,
    )
    
    # Run benchmark
    print("Running benchmark...")
    print()
    
    # Note: quick mode uses a smaller config and still runs the full runner so the
    # CLI configuration is respected. (runner.run_quick_eval() uses an internal
    # fixed subset intended for quick developer smoke tests.)
    results = await runner.run_full_benchmark(progress_callback=on_progress)
    
    print("\n")
    
    # Generate report
    reporter = ContextBenchReporter(results)
    reporter.print_report()
    
    # Save results
    os.makedirs(output_dir, exist_ok=True)
    paths = save_results(results, output_dir, prefix=f"context_bench_{provider}")
    
    print("\nResults saved to:")
    for file_type, path in paths.items():
        print(f"  {file_type}: {path}")
    
    # Return summary for programmatic use
    return results


async def run_eliza_agent_benchmark_mode(
    config: ContextBenchConfig,
    output_dir: str,
    on_progress,
) -> None:
    """Run the FULL Eliza agent loop benchmark.

    This mode exercises the complete canonical Eliza flow:
    1. CONTEXT_BENCH provider injects benchmark context
    2. MESSAGE_HANDLER_TEMPLATE generates response with actions
    3. REPLY action (from bootstrap) processes the response
    4. CONTEXT_BENCH_EVALUATOR assesses accuracy

    This tests the entire agent architecture, not just the model layer.
    """
    from elizaos_context_bench.runner import setup_and_run_agent_benchmark
    
    # Check for OpenAI API key (required for model)
    if not os.environ.get("OPENAI_API_KEY"):
        raise ValueError(
            "OPENAI_API_KEY is not set. Add it to the repo-root .env or export it.\n"
            "The eliza-agent mode requires a real LLM to run the full agent loop."
        )
    
    # Use cheaper models by default for benchmarking
    os.environ.setdefault("OPENAI_LARGE_MODEL", "gpt-5-mini")
    os.environ.setdefault("OPENAI_SMALL_MODEL", "gpt-5-mini")
    
    print("Running FULL Eliza Agent Loop benchmark...")
    print("This tests the complete canonical flow:")
    print("  Provider -> MESSAGE_HANDLER_TEMPLATE -> Actions -> Evaluators")
    print()
    
    # Import the OpenAI plugin factory
    def get_openai_plugin_factory():
        from elizaos_plugin_openai import get_openai_plugin
        return get_openai_plugin()
    
    results = await setup_and_run_agent_benchmark(
        model_plugin_factory=get_openai_plugin_factory,
        config=config,
        concurrency=1,  # Sequential for now
        progress_callback=on_progress,
    )
    
    print("\n")
    
    # Generate report
    reporter = ContextBenchReporter(results)
    reporter.print_report()
    
    # Add agent-specific summary
    print("\n" + "=" * 60)
    print("FULL AGENT LOOP SUMMARY")
    print("=" * 60)
    summary = results.summary
    print(f"Status: {summary.get('status', 'unknown')}")
    print(f"Overall Accuracy: {summary.get('overall_accuracy', 'N/A')}")
    print(f"Mode: {summary.get('mode', 'N/A')}")
    print("\nFindings:")
    for finding in summary.get("findings", []):
        print(f"  • {finding}")
    if summary.get("recommendations"):
        print("\nRecommendations:")
        for rec in summary.get("recommendations", []):
            print(f"  • {rec}")
    
    # Save results
    os.makedirs(output_dir, exist_ok=True)
    paths = save_results(results, output_dir, prefix="context_bench_eliza_agent")
    
    print("\nResults saved to:")
    for file_type, path in paths.items():
        print(f"  {file_type}: {path}")


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Run ElizaOS Context Benchmark"
    )
    parser.add_argument(
        "--provider",
        choices=["mock", "openai", "anthropic", "eliza-mock", "eliza-openai", "eliza-agent", "milady"],
        default="mock",
        help="LLM provider to use (default: mock). 'milady' uses the TS milady agent."
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Run quick evaluation with fewer tasks"
    )
    parser.add_argument(
        "--output-dir",
        default="./benchmark_results",
        help="Output directory for results"
    )
    
    args = parser.parse_args()
    
    asyncio.run(run_benchmark(
        provider=args.provider,
        quick=args.quick,
        output_dir=args.output_dir,
    ))


if __name__ == "__main__":
    main()
