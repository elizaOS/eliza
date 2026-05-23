"""OpenClaw benchmark wrapper for ElizaOS/OpenCode matrix comparisons."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


DATASET_VERSION = "openclaw-benchmark-execution-v1"
DEFAULT_MOCK_SCENARIOS = ("setup", "implementation", "testing")


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "benchmarks" / "openclaw-benchmark").exists():
            return parent
    raise FileNotFoundError("Could not locate repository root")


def _benchmark_root() -> Path:
    return _repo_root() / "packages" / "benchmarks" / "openclaw-benchmark"


def _add_paths() -> Path:
    root = _repo_root()
    for relative in (
        "packages/benchmarks/openclaw-benchmark",
        "packages/benchmarks/openclaw-adapter",
        "packages/benchmarks/hermes-adapter",
        "packages/benchmarks/eliza-adapter",
        "packages",
    ):
        path = str(root / relative)
        while path in sys.path:
            sys.path.remove(path)
        sys.path.insert(0, path)
    return root


def available_scenario_names() -> list[str]:
    _add_paths()
    from openclaw.runner import BenchmarkRunner

    runner = BenchmarkRunner(model="dummy", api_key="dummy", use_docker=False)
    return list(runner._ordered_scenarios())


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


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return str(message.get("content") or "")
    return ""


def _first_system_text(messages: list[dict[str, Any]]) -> str:
    for message in messages:
        if message.get("role") == "system":
            return str(message.get("content") or "")
    return ""


class MatrixOpenClawRunner:
    """Small composition wrapper around the existing OpenClaw BenchmarkRunner."""

    def __init__(
        self,
        *,
        task_agent: str,
        model_provider: str,
        model: str,
        timeout_seconds: int,
        use_docker: bool,
    ) -> None:
        _add_paths()
        _configure_agent_env(task_agent, model_provider, model, timeout_seconds)

        loaded_adapter = sys.modules.get("eliza_adapter")
        loaded_adapter_path = str(getattr(loaded_adapter, "__file__", ""))
        if loaded_adapter is not None and "benchmarks/openclaw-benchmark/eliza_adapter.py" in loaded_adapter_path:
            del sys.modules["eliza_adapter"]

        from eliza_adapter import ElizaClient, ElizaServerManager
        from openclaw.runner import BenchmarkRunner

        self._manager = None
        self._current_scenario = ""
        self._turn_index = 0
        if not os.environ.get("ELIZA_BENCH_URL"):
            self._manager = ElizaServerManager()
            self._manager.start()
            self.client = self._manager.client
        else:
            self.client = ElizaClient()

        outer = self

        class _Runner(BenchmarkRunner):
            def run_scenario(self, scenario_name: str, sandbox: Any = None) -> dict:  # type: ignore[override]
                outer._current_scenario = scenario_name
                outer._turn_index = 0
                return super().run_scenario(scenario_name, sandbox=sandbox)

            def call_llm(self, messages: list) -> str:  # type: ignore[override]
                outer._turn_index += 1
                context = {
                    "benchmark": "openclaw_benchmark",
                    "task_id": outer._current_scenario or "openclaw-benchmark",
                    "messages": messages,
                    "system_prompt": _first_system_text(messages),
                    "temperature": 0.1,
                    "max_tokens": 4000,
                }
                response = outer.client.send_message(_last_user_text(messages), context=context)
                return str(response.text or "")

        self.runner = _Runner(
            model=model,
            api_key=os.environ.get("OPENAI_API_KEY")
            or os.environ.get("CEREBRAS_API_KEY")
            or "harness",
            use_docker=use_docker,
        )

    def close(self) -> None:
        if self._manager is not None:
            self._manager.stop()
            self._manager = None

    def run_scenario(self, scenario: str) -> dict[str, Any]:
        return self.runner.run_scenario(scenario)

    def run_all(self) -> dict[str, Any]:
        raw = self.runner.run_all()
        raw["benchmark"] = "openclaw_benchmark"
        return raw

    def run_selected(self, max_tasks: int) -> dict[str, Any]:
        from openclaw.sandbox import SandboxExecutor

        results: dict[str, Any] = {}
        total_score = 0.0
        task_count = 0
        scenarios = list(self.runner._ordered_scenarios())[:max_tasks]
        with SandboxExecutor(self.runner.sandbox_config) as sandbox:
            for scenario in scenarios:
                try:
                    result = self.runner.run_scenario(scenario, sandbox=sandbox)
                except Exception as exc:
                    result = {"scenario": scenario, "error": f"{type(exc).__name__}: {exc}"}
                results[scenario] = result
                score = result.get("score") if isinstance(result, dict) else None
                value = score.get("score") if isinstance(score, dict) else None
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    total_score += float(value)
                    task_count += 1
        return {
            "benchmark": "openclaw_benchmark",
            "scoring_type": "execution_validation",
            "tasks": results,
            "overall_score": total_score / task_count if task_count else 0.0,
            "tasks_completed": task_count,
        }


def _task_results(raw: dict[str, Any]) -> list[dict[str, Any]]:
    task_map = raw.get("tasks")
    if isinstance(task_map, dict):
        items = task_map.items()
    else:
        items = [(str(raw.get("scenario") or "scenario"), raw)]
    results: list[dict[str, Any]] = []
    for scenario, payload in items:
        payload = payload if isinstance(payload, dict) else {"error": str(payload)}
        score = payload.get("score") if isinstance(payload.get("score"), dict) else {}
        score_value = score.get("score") if isinstance(score, dict) else None
        passed = score.get("passed") if isinstance(score, dict) else None
        total_checks = score.get("total_checks") if isinstance(score, dict) else None
        bounded = max(0.0, min(1.0, float(score_value))) if isinstance(score_value, (int, float)) else 0.0
        results.append(
            {
                "task": str(scenario),
                "status": "completed" if "error" not in payload else "failed",
                "success": bounded >= 1.0,
                "score": bounded,
                "passed": passed,
                "failed": (
                    int(total_checks - passed)
                    if isinstance(total_checks, int) and isinstance(passed, int)
                    else None
                ),
                "total": total_checks,
                "error": str(payload.get("error") or ""),
                "duration_ms": payload.get("duration_ms"),
                "steps": payload.get("steps"),
                "trajectory_path": payload.get("trajectory_path"),
                "tool_call_count": len(payload.get("tool_calls", []))
                if isinstance(payload.get("tool_calls"), list)
                else None,
            }
        )
    return results


def _normalize_result(
    *,
    raw: dict[str, Any],
    task_agent: str,
    model_provider: str,
    model: str,
    mode: str,
) -> dict[str, Any]:
    results = _task_results(raw)
    total = len(results)
    resolved = sum(float(item.get("score") or 0.0) for item in results)
    available = len(available_scenario_names())
    return {
        "benchmark": "openclaw_benchmark",
        "adapter": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": mode,
        "dataset_version": DATASET_VERSION,
        "available_task_count": available,
        "coverage_note": (
            f"local OpenCLAW benchmark exposes {available} ordered scenarios"
        ),
        "summary": {
            "total_instances": total,
            "resolved": resolved,
            "unresolved": total - resolved,
            "resolve_rate": resolved / total if total else 0.0,
            "score": resolved / total if total else 0.0,
        },
        "results": results,
        "raw_summary": {
            "overall_score": raw.get("overall_score"),
            "tasks_completed": raw.get("tasks_completed"),
            "scoring_type": raw.get("scoring_type"),
        },
    }


def _mock_result(task_agent: str, model_provider: str, model: str, scenario: str) -> dict[str, Any]:
    raw = {
        "scenario": scenario,
        "score": {"score": 1.0, "passed": 1, "total_checks": 1},
        "duration_ms": 0,
        "steps": 1,
        "tool_calls": [],
    }
    return _normalize_result(
        raw=raw,
        task_agent=task_agent,
        model_provider=model_provider,
        model=model,
        mode="mock",
    )


def _write_mock_trajectory(
    trajectory_dir: Path | None,
    *,
    scenario: str,
    task_agent: str,
) -> str:
    if trajectory_dir is None:
        return ""
    trajectory_dir.mkdir(parents=True, exist_ok=True)
    path = trajectory_dir / f"trajectory-{scenario}.jsonl"
    path.write_text(
        json.dumps(
            {
                "scenario": scenario,
                "task_agent": task_agent,
                "messages": [
                    {"role": "user", "content": f"Run OpenClaw scenario {scenario}."},
                    {"role": "assistant", "content": f"Mock OpenClaw response for {scenario}."},
                ],
                "usage": {},
                "agent_status": "mock",
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return str(path)


def _mock_selected_result(
    task_agent: str,
    model_provider: str,
    model: str,
    *,
    scenario: str,
    max_tasks: int | None,
    trajectory_dir: Path | None,
) -> dict[str, Any]:
    if scenario != "all":
        scenarios = [scenario]
    else:
        available = available_scenario_names()
        total = max_tasks if max_tasks is not None else len(available)
        scenarios = [
            (
                available[index]
                if index < len(available)
                else f"{available[index % len(available)]}__mock_{index + 1}"
            )
            for index in range(total)
        ]
    raw = {
        "benchmark": "openclaw_benchmark",
        "scoring_type": "execution_validation_mock",
        "tasks": {
            item: {
                "scenario": item,
                "score": {"score": 1.0, "passed": 1, "total_checks": 1},
                "duration_ms": 0,
                "steps": 1,
                "tool_calls": [],
                "trajectory_path": _write_mock_trajectory(
                    trajectory_dir,
                    scenario=item,
                    task_agent=task_agent,
                ),
            }
            for item in scenarios
        },
        "overall_score": 1.0 if scenarios else 0.0,
        "tasks_completed": len(scenarios),
    }
    return _normalize_result(
        raw=raw,
        task_agent=task_agent,
        model_provider=model_provider,
        model=model,
        mode="mock",
    )


def run_openclaw_benchmark(
    *,
    task_agent: str,
    model_provider: str,
    model: str,
    output_dir: Path,
    trajectory_dir: Path | None,
    scenario: str,
    max_tasks: int | None,
    timeout_seconds: int,
    use_docker: bool,
    mock: bool,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    if trajectory_dir is not None:
        trajectory_dir.mkdir(parents=True, exist_ok=True)
        os.environ["BENCHMARK_RUN_DIR"] = str(trajectory_dir)
        os.environ["BENCHMARK_TELEMETRY_JSONL"] = str(trajectory_dir / "telemetry.jsonl")
    if mock:
        return _mock_selected_result(
            task_agent,
            model_provider,
            model,
            scenario=scenario,
            max_tasks=max_tasks,
            trajectory_dir=trajectory_dir,
        )

    runner = MatrixOpenClawRunner(
        task_agent=task_agent,
        model_provider=model_provider,
        model=model,
        timeout_seconds=timeout_seconds,
        use_docker=use_docker,
    )
    try:
        if scenario == "all" and max_tasks is not None:
            raw = runner.run_selected(max_tasks)
        else:
            raw = runner.run_all() if scenario == "all" else runner.run_scenario(scenario)
    finally:
        runner.close()
    return _normalize_result(
        raw=raw,
        task_agent=task_agent,
        model_provider=model_provider,
        model=model,
        mode="live",
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run OpenClaw benchmark scenarios through a code-agent adapter.")
    parser.add_argument("--task-agent", default="elizaos")
    parser.add_argument("--model-provider", default="cerebras")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trajectory-dir", default="")
    parser.add_argument("--scenario", default="all")
    parser.add_argument("--max-tasks", type=int)
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--no-docker", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    result = run_openclaw_benchmark(
        task_agent=args.task_agent,
        model_provider=args.model_provider,
        model=args.model,
        output_dir=Path(args.output),
        trajectory_dir=Path(args.trajectory_dir) if args.trajectory_dir else None,
        scenario=args.scenario,
        max_tasks=args.max_tasks,
        timeout_seconds=args.timeout_seconds,
        use_docker=not args.no_docker,
        mock=bool(args.mock),
    )
    result_path = Path(args.output) / "openclaw-benchmark-results.json"
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"wrote {result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
