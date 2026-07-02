#!/usr/bin/env python3
"""Run framework benchmark scenarios through real benchmark harness clients.

The TypeScript framework benchmark measures local elizaOS runtime overhead with
mock LLM handlers. This runner is the cross-harness counterpart: it exercises
the real Eliza, Hermes, or OpenClaw client surface on the same framework
scenario fixtures and writes a framework-results.json compatible summary.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, median, pstdev
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
BENCH_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eliza-adapter"))
sys.path.insert(0, str(ROOT / "hermes-adapter"))
sys.path.insert(0, str(ROOT / "openclaw-adapter"))


SYSTEM_PROMPT = "\n".join(
    [
        "You are BenchmarkAgent, a concise assistant in a framework benchmark.",
        "Reply to the user's benchmark message in one short sentence.",
        "Do not call external tools unless the benchmark context explicitly provides them.",
    ]
)


def _load_scenarios(selected: set[str]) -> list[dict[str, Any]]:
    data = json.loads((BENCH_DIR / "shared" / "scenarios.json").read_text(encoding="utf-8"))
    scenarios = [item for item in data.get("scenarios", []) if isinstance(item, dict)]
    return [item for item in scenarios if str(item.get("id")) in selected]


def _messages(raw: object, *, generated_limit: int) -> list[dict[str, str]]:
    if isinstance(raw, str) and raw.startswith("_generate:"):
        count = min(generated_limit, max(1, int(raw.split(":", 1)[1])))
        return [
            {
                "role": "user",
                "content": f"BenchmarkAgent, benchmark message number {index + 1}.",
            }
            for index in range(count)
        ]
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if isinstance(content, str) and content.strip():
            out.append({"role": str(item.get("role") or "user"), "content": content})
    return out


def _build_client(harness: str, provider: str, model: str):
    timeout_s = float(os.environ.get("FRAMEWORK_HARNESS_TIMEOUT_S", "180"))
    if harness == "hermes":
        from hermes_adapter.client import HermesClient

        return HermesClient(provider=provider, model=model, timeout_s=timeout_s), None
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient

        return (
            OpenClawClient(
                provider=provider,
                model=model,
                timeout_s=timeout_s,
                direct_openai_compatible=True,
                reasoning_effort=os.environ.get("FRAMEWORK_OPENCLAW_THINKING", "low"),
            ),
            None,
        )
    if harness == "eliza":
        from eliza_adapter import ElizaClient, ElizaServerManager

        if os.environ.get("ELIZA_BENCH_URL") and os.environ.get("ELIZA_BENCH_TOKEN"):
            return (
                ElizaClient(
                    os.environ["ELIZA_BENCH_URL"],
                    token=os.environ.get("ELIZA_BENCH_TOKEN"),
                ),
                None,
            )
        manager = ElizaServerManager()
        manager.start()
        return manager.client, manager
    raise ValueError(f"unsupported harness: {harness}")


def _latency_stats(values: list[float]) -> dict[str, Any]:
    if not values:
        return {
            "min_ms": 0,
            "max_ms": 0,
            "avg_ms": 0,
            "median_ms": 0,
            "p95_ms": 0,
            "p99_ms": 0,
            "stddev_ms": 0,
            "raw_ms": [],
        }
    sorted_values = sorted(values)

    def percentile(p: float) -> float:
        index = min(len(sorted_values) - 1, int(round((len(sorted_values) - 1) * p)))
        return sorted_values[index]

    return {
        "min_ms": sorted_values[0],
        "max_ms": sorted_values[-1],
        "avg_ms": mean(sorted_values),
        "median_ms": median(sorted_values),
        "p95_ms": percentile(0.95),
        "p99_ms": percentile(0.99),
        "stddev_ms": pstdev(sorted_values) if len(sorted_values) > 1 else 0,
        "raw_ms": sorted_values,
    }


def _empty_pipeline(total_ms: float) -> dict[str, float]:
    return {
        "compose_state_avg_ms": 0,
        "provider_execution_avg_ms": 0,
        "should_respond_avg_ms": 0,
        "model_call_avg_ms": total_ms,
        "action_dispatch_avg_ms": 0,
        "evaluator_avg_ms": 0,
        "memory_create_avg_ms": 0,
        "memory_get_avg_ms": 0,
        "model_time_total_ms": total_ms,
        "framework_time_total_ms": 0,
    }


def _resources() -> dict[str, float]:
    return {
        "memory_rss_start_mb": 0,
        "memory_rss_peak_mb": 0,
        "memory_rss_end_mb": 0,
        "memory_delta_mb": 0,
        "heap_used_start_mb": 0,
        "heap_used_peak_mb": 0,
        "heap_used_end_mb": 0,
    }


def _send(client: Any, scenario_id: str, text: str, model: str) -> tuple[bool, float, str]:
    context = {
        "benchmark": "framework",
        "task_id": scenario_id,
        "system_prompt": SYSTEM_PROMPT,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "temperature": 0.0,
        "max_tokens": int(os.environ.get("FRAMEWORK_HARNESS_MAX_TOKENS", "128")),
        "model": model,
    }
    started = time.perf_counter()
    response = client.send_message(text, context=context)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    output = str(getattr(response, "text", "") or "").strip()
    actions = getattr(response, "actions", [])
    params = getattr(response, "params", {})
    tool_calls = params.get("tool_calls") if isinstance(params, dict) else None
    ok = bool(output or actions or tool_calls)
    return ok, elapsed_ms, output


def _run_scenario(
    client: Any,
    scenario: dict[str, Any],
    *,
    model: str,
    iterations: int,
    generated_limit: int,
) -> tuple[dict[str, Any], int, int]:
    scenario_id = str(scenario.get("id") or "scenario")
    config = scenario.get("config") if isinstance(scenario.get("config"), dict) else {}
    if config.get("startupOnly") is True:
        latencies: list[float] = []
        successes = 0
        for _ in range(iterations):
            started = time.perf_counter()
            if hasattr(client, "reset"):
                client.reset(f"framework-{scenario_id}", "framework")
            latencies.append((time.perf_counter() - started) * 1000.0)
            successes += 1
        total_time = sum(latencies)
        return _scenario_result(iterations, 0, latencies, iterations, total_time, successes, iterations), successes, iterations

    msgs = _messages(scenario.get("messages"), generated_limit=generated_limit)
    latencies: list[float] = []
    successes = 0
    total = 0
    for iteration in range(iterations):
        if hasattr(client, "reset"):
            client.reset(f"framework-{scenario_id}-{iteration}", "framework")
        for message in msgs:
            total += 1
            ok, elapsed_ms, _output = _send(client, scenario_id, message["content"], model)
            latencies.append(elapsed_ms)
            if ok:
                successes += 1
    total_time = sum(latencies)
    return _scenario_result(iterations, 0, latencies, total, total_time, successes, total), successes, total


def _scenario_result(
    iterations: int,
    warmup: int,
    latencies: list[float],
    total_messages: int,
    total_time_ms: float,
    successes: int,
    total_checks: int,
) -> dict[str, Any]:
    return {
        "iterations": iterations,
        "warmup": warmup,
        "latency": _latency_stats(latencies),
        "throughput": {
            "messages_per_second": (total_messages / total_time_ms) * 1000.0
            if total_time_ms > 0
            else 0,
            "total_messages": total_messages,
            "total_time_ms": total_time_ms,
        },
        "pipeline": _empty_pipeline(total_time_ms),
        "resources": _resources(),
        "success_rate": successes / total_checks if total_checks else 1.0,
        "successful_messages": successes,
        "total_checks": total_checks,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--harness", choices=["eliza", "hermes", "openclaw"], required=True)
    parser.add_argument("--provider", default=os.environ.get("BENCHMARK_MODEL_PROVIDER", "cerebras"))
    parser.add_argument("--model", default=os.environ.get("BENCHMARK_MODEL_NAME", "gemma-4-31b"))
    parser.add_argument("--scenarios", default="single-message")
    parser.add_argument("--iterations", type=int, default=1)
    parser.add_argument("--generated-limit", type=int, default=3)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    selected = {item.strip() for item in args.scenarios.split(",") if item.strip()}
    scenarios = _load_scenarios(selected)
    if not scenarios:
        raise SystemExit(f"no framework scenarios selected from: {sorted(selected)}")

    client, manager = _build_client(args.harness, args.provider, args.model)
    results: dict[str, Any] = {}
    successes = 0
    total = 0
    try:
        for scenario in scenarios:
            result, scenario_successes, scenario_total = _run_scenario(
                client,
                scenario,
                model=args.model,
                iterations=max(1, args.iterations),
                generated_limit=max(1, args.generated_limit),
            )
            results[str(scenario.get("id"))] = result
            successes += scenario_successes
            total += scenario_total
    finally:
        if manager is not None:
            manager.stop()

    report = {
        "runtime": "framework-harness",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "harness": args.harness,
        "provider": args.provider,
        "model": args.model,
        "system": {
            "os": platform.system().lower(),
            "arch": platform.machine(),
            "cpus": os.cpu_count() or 1,
            "memory_gb": 0,
            "runtime_version": platform.python_version(),
            "platform": "python",
        },
        "scenarios": results,
        "overall_score": successes / total if total else 1.0,
        "score_basis": "real harness non-empty/action response rate",
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
