"""QwenClawBench wrapper for code-agent matrix comparisons."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from benchmarks.nl2repo.adapter_matrix import token_metrics_from_usage


DATASET_VERSION = "qwenclawbench-v1.1-100-supported-slice-v2"
DEFAULT_DATASET = "qwenclawbench-v1.1-100"
SUPPORTED_GRADING_SCOPES = {"automated", "hybrid", "supported"}
EDGE_VARIANTS: tuple[str, ...] = (
    "cold-start workspace",
    "partial previous attempt",
    "ambiguous artifact naming",
    "missing optional asset",
    "large output handling",
    "retry after command failure",
    "strict no-network execution",
    "unicode content or path",
    "minimal-change requirement",
    "explicit validation required",
)


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "benchmarks" / "qwen-claw-bench").exists():
            return parent
    raise FileNotFoundError("Could not locate repository root")


def _qwen_root() -> Path:
    return _repo_root() / "packages" / "benchmarks" / "qwen-claw-bench"


def _add_paths() -> Path:
    root = _repo_root()
    for relative in (
        "packages",
        "packages/benchmarks/qwen-claw-bench/scripts",
        "packages/benchmarks/eliza-adapter",
        "packages/benchmarks/hermes-adapter",
        "packages/benchmarks/openclaw-adapter",
    ):
        path = str(root / relative)
        if path not in sys.path:
            sys.path.insert(0, path)
    return root


def _adapter_command_env_name(task_agent: str) -> str:
    normalized = "".join(char if char.isalnum() else "_" for char in task_agent).upper()
    return f"QWEN_CLAW_BENCH_AGENT_COMMAND_TEMPLATE_{normalized}"


def _builtin_agent_command_template(task_agent: str, provider: str, model: str, timeout_seconds: int) -> str:
    helper = Path(__file__).resolve().parent / "agent_command.py"
    return " ".join(
        shlex.quote(part)
        for part in (
            sys.executable,
            str(helper),
            "--adapter",
            task_agent,
            "--workspace",
            "{workspace}",
            "--task-path",
            "{task_path}",
            "--task",
            "{task}",
            "--provider",
            provider,
            "--model",
            model,
            "--timeout-seconds",
            str(timeout_seconds),
            "--result-json",
            "{result_json}",
        )
    )


def agent_command_template(
    task_agent: str,
    *,
    explicit: str = "",
    provider: str,
    model: str,
    timeout_seconds: int,
) -> str:
    configured = (
        explicit
        or os.environ.get(_adapter_command_env_name(task_agent), "")
        or os.environ.get("QWEN_CLAW_BENCH_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    if os.environ.get("QWEN_CLAW_BENCH_DISABLE_BUILTIN_AGENT_COMMAND", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return ""
    return _builtin_agent_command_template(task_agent, provider, model, timeout_seconds)


def _safe_task_id(task_id: str) -> str:
    return "".join(char if char.isalnum() else "-" for char in task_id).strip("-") or "task"


def _task_in_scope(task: Any, grading_scope: str) -> bool:
    if grading_scope == "automated":
        return task.grading_type == "automated"
    if grading_scope == "hybrid":
        return task.grading_type == "hybrid"
    if grading_scope == "supported":
        return task.grading_type in {"automated", "hybrid"}
    raise ValueError(f"Unsupported QwenClawBench grading scope: {grading_scope}")


def load_tasks(
    *,
    dataset: str = DEFAULT_DATASET,
    max_tasks: int | None = None,
    grading_scope: str = "supported",
) -> list[Any]:
    _add_paths()
    from lib_tasks import TaskLoader

    tasks_dir = _qwen_root() / "data" / dataset / "tasks"
    tasks = [
        task
        for task in TaskLoader(tasks_dir).load_all_tasks()
        if _task_in_scope(task, grading_scope)
    ]
    return tasks[:max_tasks] if max_tasks is not None else tasks


def available_task_count(
    *,
    dataset: str = DEFAULT_DATASET,
    grading_scope: str = "supported",
) -> int:
    return len(load_tasks(dataset=dataset, max_tasks=None, grading_scope=grading_scope))


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def expanded_task_ids(tasks: list[Any], *, expand: bool = False) -> list[dict[str, str]]:
    base = [
        {"task_id": str(task.task_id), "source_task_id": str(task.task_id), "edge_condition": ""}
        for task in tasks
    ]
    if not expand:
        return base
    expanded = list(base)
    for task in tasks:
        source = str(task.task_id)
        for index, edge_condition in enumerate(EDGE_VARIANTS, start=1):
            expanded.append(
                {
                    "task_id": f"{source}__edge_{index:02d}",
                    "source_task_id": source,
                    "edge_condition": edge_condition,
                }
            )
    return expanded


def count_tasks(tasks: list[Any], *, expand: bool = False) -> dict[str, int]:
    base = len(tasks)
    edge = base * len(EDGE_VARIANTS) if expand else 0
    return {"base": base, "edge": edge, "total": base + edge}


def validate_tasks(tasks: list[Any], *, expand: bool = False) -> dict[str, Any]:
    expanded = expanded_task_ids(tasks, expand=expand)
    ids = [item["task_id"] for item in expanded]
    duplicate_count = len(ids) - len(set(ids))
    return {"valid": duplicate_count == 0, "duplicate_count": duplicate_count, "total": len(ids)}


def _copy_workspace_files(task: Any, *, dataset: str, workspace: Path) -> None:
    assets_dir = _qwen_root() / "data" / dataset / "assets"
    if workspace.exists():
        shutil.rmtree(workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    for file_spec in task.workspace_files:
        if "content" in file_spec:
            target = workspace / file_spec["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(str(file_spec["content"]), encoding="utf-8")
            continue
        source_rel = str(file_spec["source"])
        source = assets_dir / task.task_id / source_rel
        if not source.exists():
            source = assets_dir / source_rel
        if not source.exists():
            raise FileNotFoundError(f"missing QwenClawBench asset for {task.task_id}: {source_rel}")
        target = workspace / str(file_spec["dest"])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def _format_command(template: str, values: dict[str, str]) -> list[str]:
    return shlex.split(template.format(**values))


def _read_agent_result(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _action_to_tool_use(action: Any) -> dict[str, Any] | None:
    if isinstance(action, str):
        return {"type": "tool_use", "name": "action", "input": {"command": action}}
    if not isinstance(action, dict):
        return None
    command = (
        action.get("command")
        or action.get("cmd")
        or action.get("input")
        or action.get("args")
        or action.get("description")
        or action.get("name")
    )
    return {
        "type": "tool_use",
        "name": str(action.get("name") or action.get("type") or "action"),
        "input": {"command": command if isinstance(command, str) else json.dumps(command, sort_keys=True)},
    }


def _transcript_from_agent_result(agent_result: dict[str, Any], task: Any) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    for action in agent_result.get("actions") or []:
        tool_use = _action_to_tool_use(action)
        if tool_use is not None:
            content.append(tool_use)
    response_text = str(agent_result.get("response_text") or "")
    if response_text:
        content.append({"type": "text", "text": response_text})
    return [
        {
            "type": "message",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": task.prompt}],
            },
        },
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": content or [{"type": "text", "text": response_text}],
            },
        },
    ]


def _configure_judge_defaults(*, model_provider: str, model: str) -> None:
    if model_provider == "cerebras":
        if not os.environ.get("JUDGE_API_KEY") and os.environ.get("CEREBRAS_API_KEY"):
            os.environ["JUDGE_API_KEY"] = os.environ["CEREBRAS_API_KEY"]
        os.environ.setdefault("JUDGE_BASE_URL", "https://api.cerebras.ai/v1")
    os.environ.setdefault("QWEN_CLAW_BENCH_JUDGE_MODEL", model)
    os.environ.setdefault("QWEN_CLAW_BENCH_JUDGE_MAX_RETRIES", "2")
    os.environ.setdefault("QWEN_CLAW_BENCH_JUDGE_RETRY_BASE_SECONDS", "1")


def _grade_task(
    task: Any,
    *,
    transcript: list[dict[str, Any]],
    workspace: Path,
    model_provider: str,
    model: str,
    judge_model: str,
    judge_timeout_seconds: int,
) -> dict[str, Any]:
    _add_paths()
    import lib_grading

    _configure_judge_defaults(model_provider=model_provider, model=model)
    lib_grading.JUDGE_API_MAX_RETRIES = int(
        os.environ.get("QWEN_CLAW_BENCH_JUDGE_MAX_RETRIES", "2")
    )
    lib_grading.JUDGE_API_RETRY_BASE_SECONDS = float(
        os.environ.get("QWEN_CLAW_BENCH_JUDGE_RETRY_BASE_SECONDS", "1")
    )
    execution_result = {"transcript": transcript, "workspace": str(workspace)}
    if task.grading_type == "automated":
        grade = lib_grading._grade_automated(task, execution_result)
    else:
        grade = lib_grading.grade_task(
            task=task,
            execution_result=execution_result,
            skill_dir=workspace,
            judge_model=judge_model or model,
            judge_timeout_seconds=judge_timeout_seconds,
        )
    return grade.to_dict()


def _write_trajectory(
    *,
    trajectory_dir: Path | None,
    task_id: str,
    transcript: list[dict[str, Any]],
    agent_result: dict[str, Any],
) -> str:
    if trajectory_dir is None:
        return ""
    trajectory_dir.mkdir(parents=True, exist_ok=True)
    path = trajectory_dir / f"trajectory-{_safe_task_id(task_id)}.jsonl"
    path.write_text(
        json.dumps(
            {
                "task": task_id,
                "transcript": transcript,
                "usage": agent_result.get("usage", {}),
                "agent_status": agent_result.get("status"),
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return str(path)


def _mock_results(
    tasks: list[Any],
    *,
    max_tasks: int | None,
    trajectory_dir: Path | None,
    grading_scope: str,
    expand: bool = False,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not tasks:
        return rows
    selected = tasks[:max_tasks] if max_tasks is not None else tasks
    id_rows = expanded_task_ids(selected, expand=expand)
    task_by_id = {str(task.task_id): task for task in selected}
    for item in id_rows:
        task = task_by_id[item["source_task_id"]]
        task_id = item["task_id"]
        transcript = [
            {
                "type": "message",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": task.prompt}],
                },
            },
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": f"Mock QwenClawBench response for {task_id}"}],
                },
            },
        ]
        trajectory_path = _write_trajectory(
            trajectory_dir=trajectory_dir,
            task_id=task_id,
            transcript=transcript,
            agent_result={"usage": {}, "status": "mock"},
        )
        rows.append(
            {
                "task": task_id,
                "source_task_id": item["source_task_id"],
                "edge_condition": item["edge_condition"],
                "status": "completed",
                "success": True,
                "score": 1.0,
                "passed": 1,
                "failed": 0,
                "total": 1,
                "grading": {
                    "task_id": task_id,
                    "score": 1.0,
                    "score_simple": 1.0,
                    "max_score": 1.0,
                    "grading_type": task.grading_type,
                    "breakdown": {"mock": 1.0},
                    "notes": f"mock QwenClawBench {grading_scope} slice result",
                },
                "token_metrics": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "total_tokens": 0,
                    "cached_tokens": 0,
                    "cache_creation_tokens": 0,
                    "cached_token_percent": None,
                    "llm_call_count": 0,
                },
                "trajectory_path": trajectory_path,
            }
        )
    return rows


def run_qwen_claw_bench_matrix(
    *,
    task_agent: str,
    model_provider: str,
    model: str,
    output_dir: Path,
    trajectory_dir: Path | None,
    dataset: str,
    max_tasks: int | None,
    command_template: str,
    timeout_seconds: int,
    mock: bool,
    grading_scope: str,
    judge_model: str,
    judge_timeout_seconds: int,
    expand_scenarios: bool = False,
    scenario_counts: dict[str, int] | None = None,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    tasks = load_tasks(dataset=dataset, max_tasks=max_tasks, grading_scope=grading_scope)
    if mock:
        results = _mock_results(
            tasks,
            max_tasks=max_tasks,
            trajectory_dir=trajectory_dir,
            grading_scope=grading_scope,
            expand=expand_scenarios,
        )
        return build_result(
            results=results,
            task_agent=task_agent,
            model_provider=model_provider,
            model=model,
            mode="mock",
            dataset=dataset,
            grading_scope=grading_scope,
            scenario_counts=scenario_counts,
            include_edge_scenarios=expand_scenarios,
        )
    if expand_scenarios:
        raise ValueError("QwenClawBench expanded scenarios currently require --mock")
    if not command_template:
        raise ValueError("QwenClawBench live mode requires an agent command template")

    logs_dir = output_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for task in tasks:
        task_dir = output_dir / "tasks" / _safe_task_id(task.task_id)
        workspace = task_dir / "workspace"
        _copy_workspace_files(task, dataset=dataset, workspace=workspace)
        task_path = Path(task.file_path or "")
        agent_result_path = task_dir / "agent-result.json"
        command = _format_command(
            command_template,
            {
                "task": task.task_id,
                "task_safe": _safe_task_id(task.task_id),
                "task_path": str(task_path),
                "workspace": str(workspace),
                "result_json": str(agent_result_path),
                "output": str(output_dir),
                "adapter": task_agent,
                "model_provider": model_provider,
                "model": model,
            },
        )
        completed = subprocess.run(
            command,
            cwd=task_dir,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        stdout_path = logs_dir / f"{_safe_task_id(task.task_id)}.stdout.log"
        stderr_path = logs_dir / f"{_safe_task_id(task.task_id)}.stderr.log"
        stdout_path.write_text(completed.stdout or "", encoding="utf-8")
        stderr_path.write_text(completed.stderr or "", encoding="utf-8")
        agent_result = _read_agent_result(agent_result_path)
        transcript = _transcript_from_agent_result(agent_result, task)
        grading = _grade_task(
            task,
            transcript=transcript,
            workspace=workspace,
            model_provider=model_provider,
            model=model,
            judge_model=judge_model,
            judge_timeout_seconds=judge_timeout_seconds,
        )
        score = float(grading.get("score") or 0.0)
        usage = agent_result.get("usage") if isinstance(agent_result, dict) else None
        token_metrics = token_metrics_from_usage(usage) if isinstance(usage, dict) else {}
        trajectory_path = _write_trajectory(
            trajectory_dir=trajectory_dir,
            task_id=task.task_id,
            transcript=transcript,
            agent_result=agent_result,
        )
        results.append(
            {
                "task": task.task_id,
                "status": "completed" if completed.returncode == 0 and score >= 1.0 else "failed",
                "success": completed.returncode == 0 and score >= 1.0,
                "score": score,
                "passed": score,
                "failed": 1.0 - score,
                "total": 1,
                "agent_command": command,
                "exit_code": completed.returncode,
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "agent_result_path": str(agent_result_path),
                "agent_result_status": agent_result.get("status"),
                "error": str(agent_result.get("error") or "") if score < 1.0 else "",
                "grading": grading,
                "token_metrics": token_metrics,
                "trajectory_path": trajectory_path,
            }
        )
    return build_result(
        results=results,
        task_agent=task_agent,
        model_provider=model_provider,
        model=model,
        mode="live",
        dataset=dataset,
        grading_scope=grading_scope,
        scenario_counts=scenario_counts,
        include_edge_scenarios=expand_scenarios,
    )


def build_result(
    *,
    results: list[dict[str, Any]],
    task_agent: str,
    model_provider: str,
    model: str,
    mode: str,
    dataset: str,
    grading_scope: str,
    scenario_counts: dict[str, int] | None = None,
    include_edge_scenarios: bool = False,
) -> dict[str, Any]:
    total = len(results)
    resolved = sum(float(item.get("score") or 0.0) for item in results)
    available = available_task_count(dataset=dataset, grading_scope=grading_scope)
    return {
        "benchmark": "qwen_claw_bench",
        "adapter": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": mode,
        "dataset_version": DATASET_VERSION,
        "dataset": dataset,
        "grading_scope": grading_scope,
        "include_edge_scenarios": include_edge_scenarios,
        "scenario_counts": scenario_counts
        or {"base": total, "edge": 0, "total": total},
        "available_task_count": available,
        "coverage_note": (
            f"local QwenClawBench {grading_scope} slice exposes {available} tasks"
        ),
        "summary": {
            "total_instances": total,
            "resolved": resolved,
            "unresolved": total - resolved,
            "resolve_rate": resolved / total if total else 0.0,
            "score": resolved / total if total else 0.0,
        },
        "results": results,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run QwenClawBench tasks through a code-agent adapter.")
    parser.add_argument("--task-agent", default="elizaos")
    parser.add_argument("--model-provider", default="cerebras")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trajectory-dir", default="")
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--grading-scope", choices=sorted(SUPPORTED_GRADING_SCOPES), default="supported")
    parser.add_argument("--max-tasks", type=int)
    parser.add_argument("--agent-command-template", default="")
    parser.add_argument("--timeout-seconds", type=int, default=7200)
    parser.add_argument("--judge-model", default="")
    parser.add_argument("--judge-timeout-seconds", type=int, default=1800)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--no-docker", action="store_true", help="Accepted for matrix CLI parity.")
    parser.add_argument("--expand-scenarios", action="store_true")
    parser.add_argument("--count-scenarios", action="store_true")
    parser.add_argument("--validate-scenarios", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    expand = (
        args.expand_scenarios
        or _truthy_env("EXPAND_SCENARIOS")
        or _truthy_env("INCLUDE_EDGE_SCENARIOS")
    )
    base_tasks = load_tasks(
        dataset=args.dataset,
        max_tasks=args.max_tasks,
        grading_scope=args.grading_scope,
    )
    counts = count_tasks(base_tasks, expand=expand)
    if args.count_scenarios or _truthy_env("COUNT_SCENARIOS"):
        print(
            "QwenClawBench scenario counts: "
            f"base={counts['base']} edge={counts['edge']} total={counts['total']}"
        )
    if args.validate_scenarios or _truthy_env("VALIDATE_SCENARIOS"):
        validation = validate_tasks(base_tasks, expand=expand)
        if not validation["valid"]:
            raise ValueError(f"Invalid QwenClawBench scenario expansion: {validation}")
        print(f"QwenClawBench scenario validation passed: {counts['total']} task(s)")
    template = agent_command_template(
        args.task_agent,
        explicit=args.agent_command_template,
        provider=args.model_provider,
        model=args.model,
        timeout_seconds=args.timeout_seconds,
    )
    result = run_qwen_claw_bench_matrix(
        task_agent=args.task_agent,
        model_provider=args.model_provider,
        model=args.model,
        output_dir=Path(args.output),
        trajectory_dir=Path(args.trajectory_dir) if args.trajectory_dir else None,
        dataset=args.dataset,
        max_tasks=args.max_tasks,
        command_template=template,
        timeout_seconds=args.timeout_seconds,
        mock=bool(args.mock),
        grading_scope=args.grading_scope,
        judge_model=args.judge_model or args.model,
        judge_timeout_seconds=args.judge_timeout_seconds,
        expand_scenarios=expand,
        scenario_counts=counts,
    )
    result_path = Path(args.output) / "qwen-claw-bench-results.json"
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"wrote {result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
