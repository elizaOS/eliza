"""Adapter-facing NL2Repo smoke harness for the code-agent matrix.

The upstream NL2Repo runner is OpenHands-specific. This module keeps the
dataset/task contract reusable for Eliza/OpenCode matrix plumbing while live
agent execution is still being wired.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import shlex
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable


@dataclass(frozen=True)
class NL2RepoTask:
    name: str
    prompt_md_path: str
    test_commands: list[str]
    strip_paths: list[str]
    test_case_count: int
    eval_image: str


PostProcessFn = Callable[[str, str, Any, Any], dict[str, Any]]


def nl2repo_root() -> Path:
    return Path(__file__).resolve().parent


def canonical_task_names(root: Path | None = None) -> list[str]:
    root = nl2repo_root() if root is None else root
    config_path = root / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    start_pro = config.get("startPro")
    if not isinstance(start_pro, list) or not start_pro:
        raise ValueError("NL2Repo config.json is missing startPro")
    names = start_pro[0].get("proNameList")
    if not isinstance(names, list):
        raise ValueError("NL2Repo config.json is missing startPro[0].proNameList")
    return [str(name) for name in names]


def load_tasks(root: Path | None = None, *, max_tasks: int | None = None) -> list[NL2RepoTask]:
    root = nl2repo_root() if root is None else root
    tasks: list[NL2RepoTask] = []
    for name in canonical_task_names(root):
        task_dir = root / "test_files" / name
        prompt = task_dir / "start.md"
        commands_path = task_dir / "test_commands.json"
        strip_paths_path = task_dir / "test_files.json"
        count_path = task_dir / "test_case_count.txt"
        if not (prompt.exists() and commands_path.exists() and strip_paths_path.exists() and count_path.exists()):
            raise FileNotFoundError(f"NL2Repo task is incomplete: {name}")
        commands = json.loads(commands_path.read_text(encoding="utf-8"))
        strip_paths = json.loads(strip_paths_path.read_text(encoding="utf-8"))
        if not isinstance(commands, list) or not isinstance(strip_paths, list):
            raise ValueError(f"NL2Repo task metadata must be JSON arrays: {name}")
        tasks.append(
            NL2RepoTask(
                name=name,
                prompt_md_path=str(prompt),
                test_commands=[str(command) for command in commands],
                strip_paths=[str(path) for path in strip_paths],
                test_case_count=int(count_path.read_text(encoding="utf-8").strip()),
                eval_image=f"ghcr.io/multimodal-art-projection/nl2repobench/{name}:1.0",
            )
        )
        if max_tasks is not None and len(tasks) >= max_tasks:
            break
    return tasks


def build_mock_result(
    *,
    tasks: list[NL2RepoTask],
    task_agent: str,
    model_provider: str,
    model: str,
) -> dict[str, Any]:
    results = [
        {
            "task": task.name,
            "status": "mock",
            "success": True,
            "score": 1.0,
            "passed": task.test_case_count,
            "failed": 0,
            "errors": 0,
            "total": task.test_case_count,
            "eval_image": task.eval_image,
        }
        for task in tasks
    ]
    total = len(results)
    return {
        "benchmark": "nl2repo",
        "adapter": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": "mock",
        "summary": {
            "total_instances": total,
            "resolved": total,
            "unresolved": 0,
            "resolve_rate": 1.0 if total else 0.0,
            "score": 1.0 if total else 0.0,
        },
        "results": results,
    }


def _adapter_command_env_name(task_agent: str) -> str:
    normalized = "".join(char if char.isalnum() else "_" for char in task_agent).upper()
    return f"NL2REPO_AGENT_COMMAND_TEMPLATE_{normalized}"


def agent_command_template(task_agent: str, explicit: str = "") -> str:
    return (
        explicit
        or os.environ.get(_adapter_command_env_name(task_agent), "")
        or os.environ.get("NL2REPO_AGENT_COMMAND_TEMPLATE", "")
    ).strip()


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


def _number(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def _first_present(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload:
            return payload.get(key)
    return None


def _token_detail_value(usage: dict[str, Any], *keys: str) -> Any:
    for container_key in ("prompt_tokens_details", "input_token_details", "token_details"):
        details = usage.get(container_key)
        if not isinstance(details, dict):
            continue
        value = _first_present(details, *keys)
        if value is not None:
            return value
    return None


def _single_usage_token_metrics(usage: dict[str, Any]) -> dict[str, int]:
    tokens = usage.get("tokens")
    token_payload = tokens if isinstance(tokens, dict) else usage
    cache_payload = token_payload.get("cache") if isinstance(token_payload, dict) else None
    cache_payload = cache_payload if isinstance(cache_payload, dict) else {}
    input_tokens = _number(
        _first_present(
            token_payload,
            "promptTokens",
            "prompt_tokens",
            "input_tokens",
            "input",
        )
    )
    output_tokens = _number(
        _first_present(
            token_payload,
            "completionTokens",
            "completion_tokens",
            "output_tokens",
            "output",
        )
    )
    total_tokens = _number(
        _first_present(token_payload, "totalTokens", "total_tokens", "total")
    )
    cached_raw = _first_present(
        token_payload,
        "cachedTokens",
        "cached_tokens",
        "cacheReadInputTokens",
        "cache_read_input_tokens",
    )
    if cached_raw is None:
        cached_raw = _token_detail_value(
            usage,
            "cached_tokens",
            "cache_read_input_tokens",
            "prompt_cache_hit_tokens",
        )
    if cached_raw is None:
        cached_raw = _first_present(cache_payload, "read", "cached", "hit")
    cache_creation_raw = _first_present(
        token_payload,
        "cacheCreationInputTokens",
        "cache_creation_input_tokens",
    )
    if cache_creation_raw is None:
        cache_creation_raw = _token_detail_value(
            usage,
            "cache_creation_input_tokens",
            "cache_write_tokens",
            "prompt_cache_miss_tokens",
        )
    if cache_creation_raw is None:
        cache_creation_raw = _first_present(cache_payload, "write", "created", "miss")
    if not total_tokens and (input_tokens or output_tokens):
        total_tokens = input_tokens + output_tokens
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cached_tokens": _number(cached_raw),
        "cache_creation_tokens": _number(cache_creation_raw),
    }


def token_metrics_from_usage(usage: dict[str, Any]) -> dict[str, int | float | None]:
    calls = usage.get("calls")
    call_items = [call for call in calls if isinstance(call, dict)] if isinstance(calls, list) else []
    if call_items:
        call_metrics = [_single_usage_token_metrics(call) for call in call_items]
        input_tokens = sum(metric["input_tokens"] for metric in call_metrics)
        output_tokens = sum(metric["output_tokens"] for metric in call_metrics)
        total_tokens = sum(metric["total_tokens"] for metric in call_metrics)
        cached_tokens = sum(metric["cached_tokens"] for metric in call_metrics)
        cache_creation_tokens = sum(metric["cache_creation_tokens"] for metric in call_metrics)
        if not total_tokens and (input_tokens or output_tokens):
            total_tokens = input_tokens + output_tokens
    else:
        metrics = _single_usage_token_metrics(usage)
        input_tokens = metrics["input_tokens"]
        output_tokens = metrics["output_tokens"]
        total_tokens = metrics["total_tokens"]
        cached_tokens = metrics["cached_tokens"]
        cache_creation_tokens = metrics["cache_creation_tokens"]
    cached_token_percent = (
        (cached_tokens / input_tokens) * 100.0 if input_tokens else None
    )
    explicit_calls = _number(_first_present(usage, "llm_call_count", "llmCallCount"))
    llm_call_count = (
        explicit_calls
        if explicit_calls
        else len(call_items)
        if call_items
        else 1
        if input_tokens or output_tokens
        else 0
    )
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cached_tokens": cached_tokens,
        "cache_creation_tokens": cache_creation_tokens,
        "cached_token_percent": cached_token_percent,
        "llm_call_count": llm_call_count,
    }


def _write_agent_trajectory(
    *,
    trajectory_dir: Path | None,
    task: NL2RepoTask,
    agent_result: dict[str, Any],
) -> str:
    if trajectory_dir is None:
        return ""
    usage = agent_result.get("usage")
    if not isinstance(usage, dict) or not usage:
        return ""
    trajectory_dir.mkdir(parents=True, exist_ok=True)
    path = trajectory_dir / f"trajectory-{task.name}.jsonl"
    path.write_text(
        json.dumps(
            {
                "task": task.name,
                "prompt": agent_result.get("prompt") or "",
                "usage": usage,
                "agent_status": agent_result.get("status"),
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return str(path)


def build_agent_instruction(task: NL2RepoTask, workspace: Path) -> str:
    return "\n".join(
        [
            "You are running NL2Repo-Bench.",
            "",
            f"Task: {task.name}",
            f"Workspace: {workspace}",
            f"Requirements document: {workspace / 'start.md'}",
            "",
            "Implement the complete Python project described in start.md inside this workspace.",
            "Create or edit files only under the workspace unless your agent runtime needs temporary files.",
            "Do not rely on hidden tests being present; the evaluator will remove any generated test files listed by the benchmark and run the canonical tests from the Docker image.",
            "Make the project installable and runnable from the workspace root.",
            "When finished, leave the generated repository contents in the workspace and exit successfully.",
        ]
    )


def _prepare_workspace(output_dir: Path, task: NL2RepoTask) -> Path:
    workspace = output_dir / "workspaces" / task.name / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    shutil.copy2(task.prompt_md_path, workspace / "start.md")
    (workspace / "NL2REPO_TASK.md").write_text(
        build_agent_instruction(task, workspace),
        encoding="utf-8",
    )
    return workspace


def run_agent_generation(
    *,
    output_dir: Path,
    trajectory_dir: Path | None,
    tasks: list[NL2RepoTask],
    task_agent: str,
    model_provider: str,
    model: str,
    command_template: str,
    timeout_seconds: int,
) -> list[dict[str, Any]]:
    logs_dir = output_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    if trajectory_dir is not None:
        trajectory_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for task in tasks:
        workspace = _prepare_workspace(output_dir, task)
        agent_result_path = workspace / ".nl2repo-agent-result.json"
        command = _format_command(
            command_template,
            {
                "task": task.name,
                "workspace": str(workspace),
                "prompt": str(workspace / "start.md"),
                "instruction": str(workspace / "NL2REPO_TASK.md"),
                "result_json": str(agent_result_path),
                "task_dir": str(Path(task.prompt_md_path).parent),
                "output": str(output_dir),
                "adapter": task_agent,
                "model_provider": model_provider,
                "model": model,
            },
        )
        completed = subprocess.run(
            command,
            cwd=workspace,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        stdout_path = logs_dir / f"{task.name}.stdout.log"
        stderr_path = logs_dir / f"{task.name}.stderr.log"
        stdout_path.write_text(completed.stdout or "", encoding="utf-8")
        stderr_path.write_text(completed.stderr or "", encoding="utf-8")
        agent_result = _read_agent_result(agent_result_path)
        usage = agent_result.get("usage") if isinstance(agent_result, dict) else None
        token_metrics = token_metrics_from_usage(usage) if isinstance(usage, dict) else {}
        trajectory_path = _write_agent_trajectory(
            trajectory_dir=trajectory_dir,
            task=task,
            agent_result=agent_result,
        )
        results.append(
            {
                "task": task.name,
                "status": "generated" if completed.returncode == 0 else "generation_failed",
                "success": completed.returncode == 0,
                "score": 0.0,
                "passed": 0,
                "failed": task.test_case_count,
                "errors": 0 if completed.returncode == 0 else 1,
                "total": task.test_case_count,
                "workspace": str(workspace),
                "eval_image": task.eval_image,
                "agent_command": command,
                "exit_code": completed.returncode,
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "agent_result_path": str(agent_result_path),
                "agent_result_status": agent_result.get("status"),
                "token_metrics": token_metrics,
                "trajectory_path": trajectory_path,
            }
        )
    return results


def build_generation_only_result(
    *,
    tasks: list[NL2RepoTask],
    task_agent: str,
    model_provider: str,
    model: str,
    results: list[dict[str, Any]],
) -> dict[str, Any]:
    generated = sum(1 for item in results if item.get("success") is True)
    total = len(tasks)
    return {
        "benchmark": "nl2repo",
        "adapter": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": "generation_only",
        "summary": {
            "total_instances": total,
            "resolved": 0,
            "unresolved": total,
            "resolve_rate": 0.0,
            "score": 0.0,
            "generated": generated,
        },
        "results": results,
        "error": "NL2Repo Docker post-processing was skipped; scores are not release-comparable",
        "required_next_step": "run without --no-docker after the adapter command can generate workspaces",
    }


def _docker_safe_id(value: str) -> str:
    normalized = "".join(char.lower() if char.isalnum() else "-" for char in value)
    return "-".join(part for part in normalized.split("-") if part) or "task"


def _make_test_data(task: NL2RepoTask) -> Any:
    root = nl2repo_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from test_data_service import TestData  # type: ignore

    return TestData(
        pro_name=task.name,
        test_case_count=task.test_case_count,
        test_shell=task.test_commands,
        py_test_file_list=task.strip_paths,
        image_tar="",
        md=task.prompt_md_path,
    )


def _load_post_processor() -> PostProcessFn:
    root = nl2repo_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from openhands.post_processor import post_process_task  # type: ignore

    return post_process_task


def _result_from_postprocess(
    *,
    task: NL2RepoTask,
    generation: dict[str, Any],
    post_process_result: dict[str, Any],
) -> dict[str, Any]:
    pytest_results = post_process_result.get("pytest_results") or {}
    passed = int(pytest_results.get("passed") or 0)
    failed = int(pytest_results.get("failed") or 0)
    errors = int(pytest_results.get("errors") or 0)
    total = int(pytest_results.get("total") or task.test_case_count)
    score = min(passed / total, 1.0) if total else 0.0
    status = "completed" if post_process_result.get("status") == "success" else "scoring_failed"
    return {
        **generation,
        "status": status,
        "success": status == "completed",
        "score": score,
        "passed": passed,
        "failed": failed,
        "errors": errors,
        "total": total,
        "post_process_result": post_process_result,
    }


def score_generated_workspaces(
    *,
    tasks: list[NL2RepoTask],
    task_agent: str,
    generation_results: list[dict[str, Any]],
    post_process: PostProcessFn | None = None,
) -> list[dict[str, Any]]:
    post_process = _load_post_processor() if post_process is None else post_process
    logger = logging.getLogger("nl2repo.adapter_matrix")
    task_by_name = {task.name: task for task in tasks}
    scored: list[dict[str, Any]] = []
    for generation in generation_results:
        task_name = str(generation.get("task") or "")
        task = task_by_name[task_name]
        if generation.get("success") is not True:
            scored.append(generation)
            continue
        task_uuid = f"{_docker_safe_id(task.name)}-{_docker_safe_id(task_agent)}-{os.getpid()}"
        post_process_result = post_process(
            task_uuid,
            str(generation["workspace"]),
            _make_test_data(task),
            logger,
        )
        scored.append(
            _result_from_postprocess(
                task=task,
                generation=generation,
                post_process_result=post_process_result,
            )
        )
    return scored


def build_scored_result(
    *,
    tasks: list[NL2RepoTask],
    task_agent: str,
    model_provider: str,
    model: str,
    results: list[dict[str, Any]],
) -> dict[str, Any]:
    total = len(tasks)
    resolved = sum(1 for item in results if item.get("status") == "completed")
    total_score = sum(float(item.get("score") or 0.0) for item in results)
    return {
        "benchmark": "nl2repo",
        "adapter": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": "live",
        "summary": {
            "total_instances": total,
            "resolved": resolved,
            "unresolved": total - resolved,
            "resolve_rate": resolved / total if total else 0.0,
            "score": total_score / total if total else 0.0,
        },
        "results": results,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run NL2Repo through a code-agent adapter.")
    parser.add_argument("--agent-harness", default="eliza")
    parser.add_argument("--task-agent", default="elizaos")
    parser.add_argument("--model-provider", default="cerebras")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trajectory-dir", default="")
    parser.add_argument("--max-tasks", type=int, default=1)
    parser.add_argument("--agent-command-template", default="")
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--no-docker", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output_dir = Path(args.output)
    trajectory_dir = Path(args.trajectory_dir) if args.trajectory_dir else None
    output_dir.mkdir(parents=True, exist_ok=True)
    tasks = load_tasks(max_tasks=args.max_tasks)
    if args.mock:
        result = build_mock_result(
            tasks=tasks,
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
        )
        result_path = output_dir / "result.json"
        result_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    command_template = agent_command_template(args.task_agent, args.agent_command_template)
    if not command_template:
        result = {
            "benchmark": "nl2repo",
            "adapter": args.task_agent,
            "model_provider": args.model_provider,
            "model": args.model,
            "mode": "live",
            "summary": {
                "total_instances": len(tasks),
                "resolved": 0,
                "unresolved": len(tasks),
                "resolve_rate": 0.0,
                "score": 0.0,
            },
            "error": "NL2Repo live adapter command template is not configured",
            "required_next_step": (
                "set NL2REPO_AGENT_COMMAND_TEMPLATE or "
                f"{_adapter_command_env_name(args.task_agent)}"
            ),
        }
        (output_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True), file=sys.stderr)
        return 2

    generated_results = run_agent_generation(
        output_dir=output_dir,
        trajectory_dir=trajectory_dir,
        tasks=tasks,
        task_agent=args.task_agent,
        model_provider=args.model_provider,
        model=args.model,
        command_template=command_template,
        timeout_seconds=args.timeout_seconds,
    )
    if args.no_docker:
        result = build_generation_only_result(
            tasks=tasks,
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
            results=generated_results,
        )
        (output_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True), file=sys.stderr)
        return 2

    try:
        scored_results = score_generated_workspaces(
            tasks=tasks,
            task_agent=args.task_agent,
            generation_results=generated_results,
        )
        result = build_scored_result(
            tasks=tasks,
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
            results=scored_results,
        )
    except Exception as exc:
        result = build_generation_only_result(
            tasks=tasks,
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
            results=generated_results,
        )
        result["mode"] = "postprocess_failed"
        result["error"] = f"NL2Repo Docker post-processing failed: {exc}"
        result["required_next_step"] = (
            "install NL2Repo Docker dependencies and verify Docker can pull/run the eval image"
        )
    (output_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    if args.json:
        stream = sys.stdout if result.get("mode") == "live" else sys.stderr
        print(json.dumps(result, indent=2, sort_keys=True), file=stream)
    return 0 if result.get("mode") == "live" else 2


if __name__ == "__main__":
    raise SystemExit(main())
