"""AgentBench wrapper for ElizaOS/OpenCode matrix comparisons."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any


DATASET_VERSION = "agentbench-five-env-fixture-v1"
EXPANDED_DATASET_VERSION = "agentbench-five-env-fixture-edge-v1"
DEFAULT_ENVS = ("os", "webshop", "web_browsing", "database", "knowledge_graph")


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "benchmarks" / "agentbench").exists():
            return parent
    raise FileNotFoundError("Could not locate repository root")


def _add_paths() -> Path:
    root = _repo_root()
    for relative in (
        "packages",
        "packages/benchmarks/agentbench",
        "packages/benchmarks/eliza-adapter",
        "packages/benchmarks/hermes-adapter",
        "packages/benchmarks/openclaw-adapter",
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
    ):
        os.environ.setdefault(key, model)
    os.environ.setdefault("WEBSHOP_NO_AUTOFETCH", "1")
    os.environ.setdefault("WEBSHOP_ALLOW_SPACY_STUB", "1")


def _env_map() -> dict[str, Any]:
    _add_paths()
    from elizaos_agentbench.types import AgentBenchEnvironment

    return {
        "database": AgentBenchEnvironment.DATABASE,
        "db": AgentBenchEnvironment.DATABASE,
        "knowledge_graph": AgentBenchEnvironment.KNOWLEDGE_GRAPH,
        "kg": AgentBenchEnvironment.KNOWLEDGE_GRAPH,
        "os": AgentBenchEnvironment.OS,
        "webshop": AgentBenchEnvironment.WEB_SHOPPING,
        "web_shopping": AgentBenchEnvironment.WEB_SHOPPING,
        "mind2web": AgentBenchEnvironment.WEB_BROWSING,
        "web_browsing": AgentBenchEnvironment.WEB_BROWSING,
    }


def _selected_envs(envs: str, max_tasks: int | None) -> list[Any]:
    mapping = _env_map()
    labels = [part.strip() for part in envs.split(",") if part.strip()]
    if not labels or labels == ["default"]:
        labels = list(DEFAULT_ENVS)
    if max_tasks == 0:
        return []
    selected = []
    for label in labels:
        if label not in mapping:
            raise ValueError(f"unsupported AgentBench environment for matrix slice: {label}")
        selected.append(mapping[label])
    return selected


def _write_trajectory_copy(output_dir: Path, trajectory_dir: Path | None) -> None:
    if trajectory_dir is None:
        return
    _add_paths()
    from elizaos_agentbench.trajectory_integration import export_trajectories_from_results

    try:
        export_path = export_trajectories_from_results(output_dir, "art")
    except Exception:
        return
    trajectory_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(export_path, trajectory_dir / export_path.name)


async def _run_agentbench(
    *,
    task_agent: str,
    model_provider: str,
    model: str,
    output_dir: Path,
    trajectory_dir: Path | None,
    envs: str,
    max_tasks: int | None,
    timeout_seconds: int,
    mock: bool,
    include_edge_scenarios: bool,
) -> dict[str, Any]:
    _add_paths()
    from eliza_adapter import ElizaServerManager
    from eliza_adapter.agentbench import ElizaAgentHarness
    from elizaos_agentbench import (
        AgentBenchConfig,
        AgentBenchDataMode,
        AgentBenchEnvironment,
        AgentBenchRunner,
        BenchmarkSplit,
    )
    from elizaos_agentbench.mock_runtime import SmartMockRuntime

    output_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("WEBSHOP_NO_AUTOFETCH", "1")
    os.environ.setdefault("WEBSHOP_ALLOW_SPACY_STUB", "1")
    if trajectory_dir is not None:
        trajectory_dir.mkdir(parents=True, exist_ok=True)
        os.environ["BENCHMARK_RUN_DIR"] = str(trajectory_dir)
        os.environ["BENCHMARK_TELEMETRY_JSONL"] = str(trajectory_dir / "telemetry.jsonl")

    selected = _selected_envs(envs, max_tasks)
    config = AgentBenchConfig(
        output_dir=str(output_dir),
        save_detailed_logs=True,
        enable_metrics=True,
        enable_memory_tracking=True,
        use_docker=False,
        split=BenchmarkSplit.TEST,
        data_mode=AgentBenchDataMode.FIXTURE,
        allow_empty_tasks=False,
        dry_run=False,
        include_edge_scenarios=include_edge_scenarios,
    )
    for env in AgentBenchEnvironment:
        env_config = config.get_env_config(env)
        env_config.enabled = env in selected
        if max_tasks is not None:
            env_config.max_tasks = max_tasks
        if env == AgentBenchEnvironment.OS:
            env_config.additional_settings["use_docker"] = False

    runtime = SmartMockRuntime()
    manager: ElizaServerManager | None = None
    if not mock:
        _configure_agent_env(task_agent, model_provider, model, timeout_seconds)
        manager = ElizaServerManager()
        manager.start()
        runtime._app_harness = ElizaAgentHarness(manager.client)  # type: ignore[attr-defined]

    try:
        runner = AgentBenchRunner(config=config, runtime=runtime)
        report = await runner.run_benchmarks()
    finally:
        if manager is not None:
            manager.stop()

    _write_trajectory_copy(output_dir, trajectory_dir)
    return json.loads((output_dir / "agentbench-results.json").read_text(encoding="utf-8"))


def _normalize_result(
    *,
    raw: dict[str, Any],
    task_agent: str,
    model_provider: str,
    model: str,
    mode: str,
    include_edge_scenarios: bool,
) -> dict[str, Any]:
    total = int(raw.get("total_tasks") or 0)
    passed = float(raw.get("passed_tasks") or 0)
    failed = float(raw.get("failed_tasks") or max(total - passed, 0))
    return {
        "benchmark": "agentbench",
        "adapter": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": mode,
        "dataset_version": EXPANDED_DATASET_VERSION if include_edge_scenarios else DATASET_VERSION,
        "summary": {
            "total_instances": total,
            "resolved": passed,
            "unresolved": failed,
            "resolve_rate": passed / total if total else 0.0,
            "score": passed / total if total else 0.0,
        },
        "environment_reports": raw.get("environment_reports") or {},
        "overall_metrics": raw.get("overall_metrics") or {},
        "raw_summary": raw.get("summary") or {},
    }


def run_agentbench_matrix(
    *,
    task_agent: str,
    model_provider: str,
    model: str,
    output_dir: Path,
    trajectory_dir: Path | None,
    envs: str,
    max_tasks: int | None,
    timeout_seconds: int,
    mock: bool,
    include_edge_scenarios: bool = False,
) -> dict[str, Any]:
    raw = asyncio.run(
        _run_agentbench(
            task_agent=task_agent,
            model_provider=model_provider,
            model=model,
            output_dir=output_dir,
            trajectory_dir=trajectory_dir,
            envs=envs,
            max_tasks=max_tasks,
            timeout_seconds=timeout_seconds,
            mock=mock,
            include_edge_scenarios=include_edge_scenarios,
        )
    )
    return _normalize_result(
        raw=raw,
        task_agent=task_agent,
        model_provider=model_provider,
        model=model,
        mode="mock" if mock else "live",
        include_edge_scenarios=include_edge_scenarios,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run AgentBench through a code-agent adapter.")
    parser.add_argument("--task-agent", default="elizaos")
    parser.add_argument("--model-provider", default="cerebras")
    parser.add_argument("--model", default="gemma-4-31b")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trajectory-dir", default="")
    parser.add_argument("--envs", default="default")
    parser.add_argument("--max-tasks", type=int)
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--expand-scenarios", action="store_true")
    parser.add_argument("--no-docker", action="store_true", help="Accepted for matrix CLI parity.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    result = run_agentbench_matrix(
        task_agent=args.task_agent,
        model_provider=args.model_provider,
        model=args.model,
        output_dir=Path(args.output),
        trajectory_dir=Path(args.trajectory_dir) if args.trajectory_dir else None,
        envs=args.envs,
        max_tasks=args.max_tasks,
        timeout_seconds=args.timeout_seconds,
        mock=bool(args.mock),
        include_edge_scenarios=bool(args.expand_scenarios),
    )
    result_path = Path(args.output) / "agentbench-matrix-results.json"
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"wrote {result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
