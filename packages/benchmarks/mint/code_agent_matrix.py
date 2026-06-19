"""MINT coding-subtask wrapper for code-agent matrix comparisons."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
from pathlib import Path
from typing import Any

from benchmarks.mint.runner import MINTRunner
from benchmarks.mint.types import ConfigurationResult, MINTConfig, MINTSubtask
from benchmarks.mint.dataset import count_tasks, expand_tasks, validate_tasks


DATASET_VERSION = "mint-coding-v1"
EXPANDED_DATASET_VERSION = "mint-coding-edge-v1"
CODING_SUBTASKS = (MINTSubtask.HUMANEVAL, MINTSubtask.MBPP)


def _result_items(config_result: ConfigurationResult | None) -> list[dict[str, Any]]:
    if config_result is None:
        return []
    items: list[dict[str, Any]] = []
    for result in config_result.results:
        items.append(
            {
                "task": result.task_id,
                "subtask": result.subtask.value,
                "status": "completed" if result.success else "failed",
                "success": bool(result.success),
                "score": float(result.score),
                "turns_used": int(result.turns_used),
                "tool_uses": int(result.tool_uses),
                "feedback_turns": int(result.feedback_turns),
                "latency_ms": float(result.latency_ms),
                "error": result.error or "",
                "cumulative_success_per_turn": list(result.cumulative_success_per_turn),
            }
        )
    return items


def _build_result(
    *,
    raw_results: Any,
    task_agent: str,
    model_provider: str,
    model: str,
    mode: str,
    include_edge_scenarios: bool,
) -> dict[str, Any]:
    canonical = (
        raw_results.full_results
        or raw_results.feedback_only_results
        or raw_results.tools_only_results
        or raw_results.baseline_results
    )
    metrics = canonical.metrics
    return {
        "benchmark": "mint",
        "adapter": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": mode,
        "dataset_version": EXPANDED_DATASET_VERSION if include_edge_scenarios else DATASET_VERSION,
        "summary": {
            "total_instances": int(metrics.total_tasks),
            "resolved": int(metrics.passed_tasks),
            "unresolved": int(metrics.failed_tasks),
            "resolve_rate": float(metrics.overall_success_rate),
            "score": float(metrics.overall_success_rate),
            "turn_1_success_rate": float(metrics.turn_1_success_rate),
            "turn_3_success_rate": float(metrics.turn_3_success_rate),
            "turn_5_success_rate": float(metrics.turn_5_success_rate),
        },
        "results": _result_items(canonical),
        "mint_summary": raw_results.summary,
    }


def _configure_agent_env(task_agent: str, model_provider: str, model: str, timeout_seconds: int) -> None:
    os.environ["BENCHMARK_TASK_AGENT"] = task_agent
    os.environ["BENCHMARK_MODEL_PROVIDER"] = model_provider
    os.environ["BENCHMARK_MODEL_NAME"] = model
    os.environ.setdefault("ELIZA_AGENT_ORCHESTRATOR", "1")
    os.environ.setdefault("ELIZA_AGENT_SELECTION_STRATEGY", "fixed")
    os.environ.setdefault("ELIZA_ACP_DEFAULT_AGENT", task_agent)
    os.environ.setdefault("ELIZA_DEFAULT_AGENT_TYPE", task_agent)
    os.environ.setdefault("ELIZA_BENCH_HTTP_TIMEOUT", str(timeout_seconds))
    os.environ.setdefault("ELIZA_BENCH_START_TIMEOUT", "300")
    for key in (
        "OPENAI_LARGE_MODEL",
        "OPENAI_SMALL_MODEL",
        "GROQ_LARGE_MODEL",
        "GROQ_SMALL_MODEL",
        "OPENROUTER_LARGE_MODEL",
        "OPENROUTER_SMALL_MODEL",
        "CEREBRAS_LARGE_MODEL",
        "CEREBRAS_SMALL_MODEL",
        "CEREBRAS_MODEL",
    ):
        os.environ.setdefault(key, model)


async def run_mint_coding(
    *,
    output_dir: Path,
    trajectory_dir: Path | None,
    task_agent: str,
    model_provider: str,
    model: str,
    max_tasks: int | None,
    timeout_seconds: int,
    use_docker: bool,
    mock: bool,
    include_edge_scenarios: bool,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    if trajectory_dir is not None:
        trajectory_dir.mkdir(parents=True, exist_ok=True)
        os.environ["BENCHMARK_RUN_DIR"] = str(trajectory_dir)
        os.environ["BENCHMARK_TELEMETRY_JSONL"] = str(trajectory_dir / "telemetry.jsonl")

    if mock:
        base_total = max(1, int(max_tasks or 1))
        total = base_total * 11 if include_edge_scenarios else base_total
        results = [
            {
                "task": (
                    f"humaneval-smoke-{index // 11}--edge-{index % 11:02d}"
                    if include_edge_scenarios and index % 11
                    else f"humaneval-smoke-{index // 11 if include_edge_scenarios else index}"
                ),
                "subtask": "humaneval",
                "status": "mock",
                "success": True,
                "score": 1.0,
                "turns_used": 1,
                "tool_uses": 0,
                "feedback_turns": 0,
                "latency_ms": 0.0,
                "error": "",
                "cumulative_success_per_turn": [True],
            }
            for index in range(total)
        ]
        return {
            "benchmark": "mint",
            "adapter": task_agent,
            "model_provider": model_provider,
            "model": model,
            "mode": "mock",
            "dataset_version": EXPANDED_DATASET_VERSION if include_edge_scenarios else DATASET_VERSION,
            "summary": {
                "total_instances": total,
                "resolved": total,
                "unresolved": 0,
                "resolve_rate": 1.0,
                "score": 1.0,
                "turn_1_success_rate": 1.0,
                "turn_3_success_rate": 1.0,
                "turn_5_success_rate": 1.0,
            },
            "results": results,
            "mint_summary": {"status": "mock", "best_configuration": "full"},
        }

    max_tasks_per_subtask = max_tasks
    if max_tasks is not None:
        max_tasks_per_subtask = max(1, math.ceil(max_tasks / len(CODING_SUBTASKS)))

    config = MINTConfig(
        output_dir=str(output_dir),
        max_tasks_per_subtask=max_tasks_per_subtask,
        max_total_tasks=max_tasks,
        include_edge_scenarios=include_edge_scenarios,
        timeout_per_task_ms=max(1, timeout_seconds) * 1000,
        subtasks=list(CODING_SUBTASKS),
        use_docker=use_docker,
        use_mock_executor=False,
        use_sample_tasks=False,
        auto_fetch_upstream=True,
        run_ablation=False,
        enable_tools=True,
        enable_feedback=True,
        save_trajectories=True,
        generate_report=False,
        feedback_mode="templated",
        allow_ground_truth_mock=False,
    )
    runner = MINTRunner(config=config)

    bridge_manager = None
    _configure_agent_env(task_agent, model_provider, model, timeout_seconds)
    from eliza_adapter.client import ElizaClient
    from eliza_adapter.mint import ElizaMINTAgent
    from eliza_adapter.server_manager import ElizaServerManager

    if not os.environ.get("ELIZA_BENCH_URL"):
        bridge_manager = ElizaServerManager()
        bridge_manager.start()
        client = bridge_manager.client
    else:
        client = ElizaClient()
    runner.agent = ElizaMINTAgent(
        client=client,
        tool_executor=runner.executor,
        feedback_generator=runner.feedback_generator,
        temperature=config.temperature,
    )

    try:
        raw_results = await runner.run_benchmark()
    finally:
        if bridge_manager is not None:
            bridge_manager.stop()

    return _build_result(
        raw_results=raw_results,
        task_agent=task_agent,
        model_provider=model_provider,
        model=model,
        mode="mock" if mock else "live",
        include_edge_scenarios=include_edge_scenarios,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run MINT coding subtasks through a code-agent adapter.")
    parser.add_argument("--task-agent", default="elizaos")
    parser.add_argument("--model-provider", default="cerebras")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trajectory-dir", default="")
    parser.add_argument("--max-tasks", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--no-docker", action="store_true")
    parser.add_argument("--expand-scenarios", action="store_true")
    parser.add_argument("--count-scenarios", action="store_true")
    parser.add_argument("--validate-scenarios", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.count_scenarios or args.validate_scenarios:
        from benchmarks.mint.dataset import MINTDataset

        async def _count() -> tuple[list[Any], list[Any]]:
            dataset = MINTDataset(auto_fetch=True)
            await dataset.load(subtasks=list(CODING_SUBTASKS))
            base_tasks = dataset.get_tasks(
                subtasks=list(CODING_SUBTASKS),
                limit=max(1, math.ceil(args.max_tasks / len(CODING_SUBTASKS)))
                if args.max_tasks is not None
                else None,
            )
            if args.max_tasks is not None:
                base_tasks = base_tasks[: max(0, int(args.max_tasks))]
            selected = expand_tasks(base_tasks) if args.expand_scenarios else list(base_tasks)
            return base_tasks, selected

        base_tasks, selected_tasks = asyncio.run(_count())
        if args.validate_scenarios:
            validate_tasks(selected_tasks)
            if args.expand_scenarios and len(selected_tasks) != len(base_tasks) * 11:
                raise RuntimeError(
                    f"Expanded MINT coding count mismatch: base={len(base_tasks)} total={len(selected_tasks)}"
                )
            print("Scenario validation: ok")
        if args.count_scenarios:
            print(json.dumps(count_tasks(base_tasks, selected_tasks), sort_keys=True))
        return 0

    result = asyncio.run(
        run_mint_coding(
            output_dir=Path(args.output),
            trajectory_dir=Path(args.trajectory_dir) if args.trajectory_dir else None,
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
            max_tasks=args.max_tasks,
            timeout_seconds=args.timeout_seconds,
            use_docker=not args.no_docker,
            mock=bool(args.mock),
            include_edge_scenarios=bool(args.expand_scenarios),
        )
    )
    result_path = Path(args.output) / "mint-code-agent-results.json"
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"wrote {result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
