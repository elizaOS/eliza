#!/usr/bin/env python3
"""Run the experience benchmark suite.

Usage:
    # Direct mode (existing behavior - no LLM required):
    python run_benchmark.py
    python run_benchmark.py --experiences 2000 --queries 200 --output results.json

    # Eliza agent mode (TypeScript bridge):
    python run_benchmark.py --mode eliza-agent --provider groq --model qwen3-32b
    python run_benchmark.py --mode eliza-agent --learning-cycles 20 --output results.json

Modes:
    direct:      Direct ExperienceService testing (default, no LLM)
    eliza-agent: Eliza TypeScript bridge loop (Provider -> Model -> Action -> Evaluator)
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

# Add paths
sys.path.insert(0, str(Path(__file__).parent))

from elizaos_experience_bench.runner import ExperienceBenchmarkRunner
from elizaos_experience_bench.types import BenchmarkConfig, BenchmarkResult


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


def _load_workspace_env_files(start: Path) -> None:
    """Load the first .env files found while walking from benchmark dir to repo root."""
    seen: set[Path] = set()
    for root in (start, *start.parents):
        env_path = root / ".env"
        if env_path in seen:
            continue
        seen.add(env_path)
        _load_env_file(env_path)
        if (root / ".git").exists():
            break


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


async def _chat_completion(
    *,
    provider: str,
    model_name: str,
    api_key: str,
    key_var: str,
    prompt: str,
    system: str = "",
    temperature: float = 0.2,
    max_tokens: int = 512,
) -> str:
    """Call an OpenAI-compatible chat endpoint for the local agent fallback."""
    import aiohttp

    base_urls = {
        "openai": "https://api.openai.com/v1",
        "groq": "https://api.groq.com/openai/v1",
        "openrouter": "https://openrouter.ai/api/v1",
        "cerebras": "https://api.cerebras.ai/v1",
    }
    if provider not in base_urls:
        raise RuntimeError(f"Local experience agent does not support provider '{provider}'")

    messages: list[dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "eliza-experience-benchmark/1.0",
    }

    async with aiohttp.ClientSession() as session, session.post(
        f"{base_urls[provider]}/chat/completions",
        headers=headers,
        json={
            "model": model_name,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        },
    ) as resp:
        data = await resp.json(content_type=None)
        if resp.status >= 400 or "error" in data:
            detail = data.get("error", data) if isinstance(data, dict) else data
            raise RuntimeError(f"{provider} chat completion failed using {key_var}: {detail}")
        text = str(data.get("choices", [{}])[0].get("message", {}).get("content", ""))

    return re.sub(r"<think>[\s\S]*?</think>", "", text).strip()


async def _run_local_agent_fallback(
    config: BenchmarkConfig,
    call_model: Callable[[str, str], Awaitable[str]],
    progress_callback: Callable[[str, int, int], None] | None = None,
) -> "BenchmarkResult":
    """Run agent-mode semantics without the removed Python Eliza runtime."""
    from elizaos_experience_bench.generator import ExperienceGenerator
    from elizaos_experience_bench.service import ExperienceQuery, ExperienceService
    from elizaos_experience_bench.types import (
        BenchmarkResult,
        ElizaAgentMetrics,
        RetrievalMetrics,
    )

    generator = ExperienceGenerator(seed=config.seed)
    service = ExperienceService()
    recorded_ids: list[str] = []
    learning_latencies: list[float] = []
    retrieval_latencies: list[float] = []

    now_ms = int(time.time() * 1000)
    background = generator.generate_experiences(
        count=min(config.num_experiences, 200),
        domains=config.domains,
    )
    for exp in background:
        offset_ms = int(exp.created_at_offset_days * 24 * 60 * 60 * 1000)
        service.record_experience(
            agent_id="bench-agent",
            context=exp.context,
            action=exp.action,
            result=exp.result,
            learning=exp.learning,
            domain=exp.domain,
            tags=exp.tags,
            confidence=exp.confidence,
            importance=exp.importance,
            created_at=now_ms - offset_ms,
        )

    scenarios = generator.generate_learning_scenarios(config.num_learning_cycles)
    learning_successes = 0

    for i, scenario in enumerate(scenarios):
        if progress_callback:
            progress_callback("Learning", i, len(scenarios))
        start = time.time()
        prompt = (
            "You are an agent that learns from experience. The user has shared "
            "a notable outcome. If this should be saved, include the literal "
            "action RECORD_EXPERIENCE and then acknowledge the learning.\n\n"
            f"Problem: {scenario.problem_context}\n"
            f"Action tried: {scenario.problem_action}\n"
            f"Result: {scenario.problem_result}\n"
            f"Learning to remember: {scenario.learned_experience.learning}"
        )
        response = await call_model(
            "Decide whether to save user-provided operational learnings.",
            prompt,
        )
        learning_latencies.append((time.time() - start) * 1000)

        response_upper = response.upper()
        should_record = (
            "RECORD_EXPERIENCE" in response_upper
            or "REMEMBER" in response_upper
            or "SAVE" in response_upper
        )
        if should_record:
            recorded = service.record_experience(
                agent_id="bench-agent",
                context=scenario.problem_context,
                action=scenario.problem_action,
                result=scenario.problem_result,
                learning=scenario.learned_experience.learning,
                domain=scenario.expected_domain,
                tags=["learning", scenario.expected_domain],
                confidence=0.85,
                importance=0.8,
            )
            recorded_ids.append(recorded.id)
            learning_successes += 1

    if progress_callback:
        progress_callback("Learning", len(scenarios), len(scenarios))

    agent_recall_hits = 0
    agent_keyword_hits = 0
    retrieval_count = 0

    retrieval_scenarios = [
        scenarios[i % len(scenarios)]
        for i in range(config.num_retrieval_queries)
    ] if scenarios else []

    for i, scenario in enumerate(retrieval_scenarios):
        if progress_callback:
            progress_callback("Retrieval", i, len(retrieval_scenarios))
        query_results = service.query_experiences(
            ExperienceQuery(query=scenario.similar_query, limit=max(config.top_k_values))
        )
        context_lines = [
            f"- [{exp.domain}] {exp.context}; learned: {exp.learning}"
            for exp in query_results[:5]
        ]
        prompt = (
            "The user is facing a familiar problem. Use relevant past "
            "experiences from the context when answering.\n\n"
            f"User problem: {scenario.similar_query}\n\n"
            "Past experiences:\n"
            + ("\n".join(context_lines) if context_lines else "- none")
        )
        start = time.time()
        response = await call_model(
            "Recall and apply relevant past operational experiences.",
            prompt,
        )
        retrieval_latencies.append((time.time() - start) * 1000)
        retrieval_count += 1

        response_lower = response.lower()
        expected_keywords = [
            keyword.lower()
            for keyword in scenario.expected_learning_keywords
        ]
        keywords_found = bool(expected_keywords) and all(
            keyword in response_lower for keyword in expected_keywords
        )
        if keywords_found:
            agent_keyword_hits += 1
        if expected_keywords and any(keyword in response_lower for keyword in expected_keywords):
            agent_recall_hits += 1

    if progress_callback:
        progress_callback("Retrieval", len(retrieval_scenarios), len(retrieval_scenarios))

    direct_recall_hits = 0
    direct_precision_hits = 0
    direct_mrr_sum = 0.0
    direct_hit_sums: dict[int, int] = dict.fromkeys(config.top_k_values, 0)

    for scenario in retrieval_scenarios:
        results = service.query_experiences(
            ExperienceQuery(query=scenario.similar_query, limit=max(config.top_k_values))
        )
        found = False
        for rank, exp in enumerate(results, 1):
            text = f"{exp.context} {exp.learning}".lower()
            if all(keyword.lower() in text for keyword in scenario.expected_learning_keywords):
                found = True
                if rank == 1:
                    direct_precision_hits += 1
                direct_mrr_sum += 1.0 / rank
                for k in config.top_k_values:
                    if rank <= k:
                        direct_hit_sums[k] += 1
                break
        if found:
            direct_recall_hits += 1

    n_scenarios = max(len(scenarios), 1)
    n_direct = max(len(retrieval_scenarios), 1)
    n_retrieval = max(retrieval_count, 1)
    direct_metrics = RetrievalMetrics(
        precision_at_k={1: direct_precision_hits / n_direct},
        recall_at_k={k: direct_hit_sums.get(k, 0) / n_direct for k in config.top_k_values},
        mean_reciprocal_rank=direct_mrr_sum / n_direct,
        hit_rate_at_k={k: direct_hit_sums.get(k, 0) / n_direct for k in config.top_k_values},
    )
    agent_metrics = ElizaAgentMetrics(
        learning_success_rate=learning_successes / n_scenarios,
        total_experiences_recorded=len(recorded_ids),
        total_experiences_in_service=service.experience_count,
        avg_learning_latency_ms=sum(learning_latencies) / max(len(learning_latencies), 1),
        agent_recall_rate=agent_recall_hits / n_retrieval,
        agent_keyword_incorporation_rate=agent_keyword_hits / n_retrieval,
        avg_retrieval_latency_ms=sum(retrieval_latencies) / max(len(retrieval_latencies), 1),
        direct_recall_rate=direct_recall_hits / n_direct,
        direct_mrr=direct_mrr_sum / n_direct,
    )
    return BenchmarkResult(
        config=config,
        retrieval=direct_metrics,
        eliza_agent=agent_metrics,
        total_experiences=service.experience_count,
        total_queries=len(retrieval_scenarios),
    )


def _configure_bridge_model_env(args: argparse.Namespace) -> None:
    """Expose provider/model settings to the TypeScript benchmark bridge."""
    _load_workspace_env_files(Path(__file__).resolve().parent)

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
        model_name = "openai/gpt-oss-120b"

    os.environ["BENCHMARK_MODEL_PROVIDER"] = provider
    os.environ["BENCHMARK_MODEL_NAME"] = model_name
    os.environ["OPENAI_LARGE_MODEL"] = model_name
    os.environ["OPENAI_SMALL_MODEL"] = model_name
    os.environ["GROQ_LARGE_MODEL"] = model_name
    os.environ["GROQ_SMALL_MODEL"] = model_name
    os.environ["OPENROUTER_LARGE_MODEL"] = model_name
    os.environ["OPENROUTER_SMALL_MODEL"] = model_name



async def run_eliza_agent(args: argparse.Namespace) -> None:
    """Run the Eliza agent benchmark mode via the TypeScript bridge."""
    print("eliza-agent mode now routes through the Eliza TypeScript benchmark bridge.")
    await run_eliza_bridge(args)


async def run_eliza_bridge(args: argparse.Namespace) -> None:
    """Run the experience benchmark via the elizaOS TS benchmark bridge."""
    _configure_bridge_model_env(args)
    from eliza_adapter.experience import (
        ElizaBridgeExperienceRunner,
        ElizaExperienceConfig,
    )
    from eliza_adapter.server_manager import ElizaServerManager

    print("=" * 60)
    print("ElizaOS Experience Benchmark - Bridge Mode")
    print("=" * 60)
    print("Routing LLM calls through the elizaOS TypeScript benchmark bridge.")
    print()

    config = ElizaExperienceConfig(
        num_learning_scenarios=args.learning_cycles,
        num_retrieval_queries=args.queries,
        num_background_experiences=min(args.experiences, 200),
        seed=args.seed,
    )

    def on_progress(phase: str, completed: int, total: int) -> None:
        pct = completed / total * 100 if total > 0 else 0
        bar_len = 30
        filled = int(bar_len * completed / total) if total > 0 else 0
        bar = "█" * filled + "░" * (bar_len - filled)
        print(f"\r  {phase}: [{bar}] {completed}/{total} ({pct:.1f}%)", end="", flush=True)
        if completed >= total:
            print()

    bridge_manager = ElizaServerManager()
    bridge_manager.start()
    try:
        runner = ElizaBridgeExperienceRunner(
            config=config,
            client=bridge_manager.client,
        )
        result = await runner.run(progress_callback=on_progress)
    finally:
        bridge_manager.stop()

    import json

    if args.output:
        with open(args.output, "w") as f:
            json.dump(result, f, indent=2, default=str)
        print(f"\n[ExperienceBench] Bridge report written to {args.output}")
    else:
        print(json.dumps(result, indent=2, default=str))


def _serialize_agent_result(result: "BenchmarkResult") -> dict:
    """Serialize agent benchmark result to JSON-friendly dict."""
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
        choices=["direct", "eliza-agent", "eliza-bridge"],
        default="direct",
        help=(
            "Benchmark mode: 'direct' tests ExperienceService directly (default), "
            "'eliza-agent' is an alias for the TypeScript bridge, "
            "'eliza-bridge' routes the LLM call through the elizaOS TypeScript "
            "benchmark bridge (requires ELIZA_BENCH_URL/ELIZA_BENCH_TOKEN)."
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
        choices=["openai", "groq", "openrouter", "anthropic", "google", "ollama", "cerebras"],
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
    elif args.mode == "eliza-bridge":
        asyncio.run(run_eliza_bridge(args))
    else:
        parser.error(f"Unknown mode: {args.mode}")


if __name__ == "__main__":
    main()
