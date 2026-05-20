"""ClawBench wrapper for ElizaOS/OpenCode matrix comparisons."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any


DATASET_VERSION = "clawbench-scenarios-v1"


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "benchmarks" / "clawbench").exists():
            return parent
    raise FileNotFoundError("Could not locate repository root")


def _add_paths() -> Path:
    root = _repo_root()
    for relative in (
        "packages",
        "packages/benchmarks/eliza-adapter",
        "packages/benchmarks/hermes-adapter",
        "packages/benchmarks/openclaw-adapter",
        "packages/benchmarks/clawbench",
    ):
        path = str(root / relative)
        if path not in sys.path:
            sys.path.insert(0, path)
    return root


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
        "CLAWBENCH_MODEL",
    ):
        os.environ.setdefault(key, model)


def _available_scenarios() -> list[str]:
    _add_paths()
    from clawbench.multi_harness_runner import SCENARIOS_DIR

    return sorted(path.stem for path in SCENARIOS_DIR.glob("*.yaml"))


def _select_scenarios(scenario: str, max_tasks: int | None) -> list[str]:
    scenarios = _available_scenarios() if scenario == "all" else [scenario]
    if max_tasks is not None:
        scenarios = scenarios[:max_tasks]
    return scenarios


async def _run_live_scenario(name: str, model: str) -> dict[str, Any]:
    _add_paths()
    from clawbench.multi_harness_runner import load_fixtures, load_scenario, run_scenario

    scenario = load_scenario(name)
    fixtures = load_fixtures(scenario.get("name") or name)
    return await run_scenario(
        harness="eliza",
        scenario=scenario,
        fixtures=fixtures,
        model_name=model,
    )


def _score_value(result: dict[str, Any]) -> float:
    score = result.get("score") if isinstance(result.get("score"), dict) else {}
    value = score.get("score") if isinstance(score, dict) else None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return 0.0
    return max(0.0, min(1.0, float(value)))


def _result_row(result: dict[str, Any]) -> dict[str, Any]:
    score = result.get("score") if isinstance(result.get("score"), dict) else {}
    bounded = _score_value(result)
    passed = score.get("passed") if isinstance(score, dict) else None
    total_checks = score.get("total_checks") if isinstance(score, dict) else None
    return {
        "task": str(result.get("scenario") or "scenario"),
        "status": "completed" if not result.get("error") else "failed",
        "success": bounded >= 1.0,
        "score": bounded,
        "passed": passed,
        "failed": (
            int(total_checks - passed)
            if isinstance(total_checks, int) and isinstance(passed, int)
            else None
        ),
        "total": total_checks,
        "error": str(result.get("error") or ""),
        "duration_ms": result.get("latency_ms") or result.get("duration_ms"),
        "tool_call_count": result.get("tool_calls_total"),
        "tool_calls_by_type": result.get("tool_calls_by_type") or {},
        "usage": result.get("usage") or {},
    }


def _normalize_result(
    *,
    task_agent: str,
    model_provider: str,
    model: str,
    mode: str,
    scenario_results: list[dict[str, Any]],
) -> dict[str, Any]:
    rows = [_result_row(result) for result in scenario_results]
    total = len(rows)
    resolved = sum(float(row.get("score") or 0.0) for row in rows)
    return {
        "benchmark": "clawbench",
        "adapter": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": mode,
        "dataset_version": DATASET_VERSION,
        "summary": {
            "total_instances": total,
            "resolved": resolved,
            "unresolved": total - resolved,
            "resolve_rate": resolved / total if total else 0.0,
            "score": resolved / total if total else 0.0,
        },
        "results": rows,
        "raw_results": scenario_results,
    }


def _mock_result(
    *,
    task_agent: str,
    model_provider: str,
    model: str,
    scenarios: list[str],
) -> dict[str, Any]:
    raw = [
        {
            "scenario": name,
            "score": {"score": 1.0, "passed": 1, "total_checks": 1},
            "latency_ms": 0,
            "tool_calls_total": 0,
            "tool_calls_by_type": {},
            "usage": {"prompt_tokens": 0, "completion_tokens": 0},
        }
        for name in scenarios
    ]
    return _normalize_result(
        task_agent=task_agent,
        model_provider=model_provider,
        model=model,
        mode="mock",
        scenario_results=raw,
    )


def run_clawbench_matrix(
    *,
    task_agent: str,
    model_provider: str,
    model: str,
    output_dir: Path,
    trajectory_dir: Path | None,
    scenario: str,
    max_tasks: int | None,
    timeout_seconds: int,
    mock: bool,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    scenarios = _select_scenarios(scenario, max_tasks)
    if trajectory_dir is not None:
        trajectory_dir.mkdir(parents=True, exist_ok=True)
        os.environ["BENCHMARK_RUN_DIR"] = str(trajectory_dir)
        os.environ["BENCHMARK_TELEMETRY_JSONL"] = str(trajectory_dir / "telemetry.jsonl")
    if mock:
        return _mock_result(
            task_agent=task_agent,
            model_provider=model_provider,
            model=model,
            scenarios=scenarios,
        )

    _configure_agent_env(task_agent, model_provider, model, timeout_seconds)
    results: list[dict[str, Any]] = []
    for name in scenarios:
        try:
            results.append(asyncio.run(_run_live_scenario(name, model)))
        except Exception as exc:  # noqa: BLE001 - report per-task harness failures.
            results.append({"scenario": name, "error": f"{type(exc).__name__}: {exc}"})
    return _normalize_result(
        task_agent=task_agent,
        model_provider=model_provider,
        model=model,
        mode="live",
        scenario_results=results,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run ClawBench through a code-agent adapter.")
    parser.add_argument("--task-agent", default="elizaos")
    parser.add_argument("--model-provider", default="cerebras")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trajectory-dir", default="")
    parser.add_argument("--scenario", default="all")
    parser.add_argument("--max-tasks", type=int)
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--no-docker", action="store_true", help="Accepted for matrix CLI parity.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    result = run_clawbench_matrix(
        task_agent=args.task_agent,
        model_provider=args.model_provider,
        model=args.model,
        output_dir=Path(args.output),
        trajectory_dir=Path(args.trajectory_dir) if args.trajectory_dir else None,
        scenario=args.scenario,
        max_tasks=args.max_tasks,
        timeout_seconds=args.timeout_seconds,
        mock=bool(args.mock),
    )
    result_path = Path(args.output) / "clawbench-results.json"
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"wrote {result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
