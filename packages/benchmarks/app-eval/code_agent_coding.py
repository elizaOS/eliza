"""App Eval coding wrapper for code-agent matrix comparisons."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from benchmarks.nl2repo.adapter_matrix import token_metrics_from_usage


DATASET_VERSION = "app-eval-coding-v1"
EXPANDED_DATASET_VERSION = "app-eval-coding-edge-v1"
EDGE_VARIANTS = (
    (
        "edge-ambiguous-user-wording",
        "The request contains mildly ambiguous wording; preserve the original deliverable and resolve ambiguity using explicit requirements.",
    ),
    (
        "edge-distractor-requirement",
        "Ignore one plausible but irrelevant adjacent requirement; only implement what the task actually asks.",
    ),
    (
        "edge-tight-output-budget",
        "Prioritize the minimum complete implementation and verification because review time is limited.",
    ),
    (
        "edge-format-noise",
        "Treat odd punctuation, casing, or markdown formatting as noise around the same task.",
    ),
    (
        "edge-conflicting-style-request",
        "A surrounding style request may conflict with tests; the benchmark task and assertions remain authoritative.",
    ),
    (
        "edge-missing-context-check",
        "If a detail appears missing, use the narrowest assumption instead of inventing unsupported APIs.",
    ),
    (
        "edge-regression-risk",
        "Avoid changing unrelated behavior while satisfying the requested feature or refactor.",
    ),
    (
        "edge-accessibility-or-safety",
        "Maintain accessibility, safety, and input-validation expectations even when the prompt emphasizes speed.",
    ),
    (
        "edge-order-independence",
        "Do not rely on the order that requirements are presented; satisfy all explicit acceptance criteria.",
    ),
    (
        "edge-verification-focus",
        "Include or perform a concise verification step that matches the task type and rubric.",
    ),
)


def app_eval_root() -> Path:
    return Path(__file__).resolve().parent


def _adapter_command_env_name(task_agent: str) -> str:
    normalized = "".join(char if char.isalnum() else "_" for char in task_agent).upper()
    return f"APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE_{normalized}"


def _builtin_agent_command_template(task_agent: str, provider: str, model: str, timeout_seconds: int) -> str:
    helper = app_eval_root() / "agent_command.py"
    return " ".join(
        shlex.quote(part)
        for part in (
            sys.executable,
            str(helper),
            "--adapter",
            task_agent,
            "--workspace",
            "{workspace}",
            "--prompt",
            "{prompt}",
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
        or os.environ.get("APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    if os.environ.get("APP_EVAL_CODING_DISABLE_BUILTIN_AGENT_COMMAND", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return ""
    return _builtin_agent_command_template(task_agent, provider, model, timeout_seconds)


def expand_tasks(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    expanded = list(tasks)
    for task in tasks:
        task_id = str(task.get("id") or "app-eval-code")
        prompt = str(task.get("prompt") or "")
        for index, (variant_id, variant_note) in enumerate(EDGE_VARIANTS, start=1):
            clone = dict(task)
            clone["id"] = f"{task_id}--edge-{index:02d}"
            clone["prompt"] = f"{prompt}\n\nEdge condition: {variant_note}"
            clone["edge_variant"] = variant_id
            clone["edge_source_id"] = task_id
            expanded.append(clone)
    return expanded


def validate_tasks(tasks: list[dict[str, Any]]) -> None:
    seen: set[str] = set()
    for task in tasks:
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            raise ValueError("task is missing id")
        if task_id in seen:
            raise ValueError(f"duplicate task id: {task_id}")
        seen.add(task_id)
        if not str(task.get("prompt") or "").strip():
            raise ValueError(f"{task_id}: missing prompt")


def load_tasks(
    *,
    max_tasks: int | None = None,
    include_edge_scenarios: bool = False,
) -> list[dict[str, Any]]:
    path = app_eval_root() / "tasks" / "coding-tasks.json"
    tasks = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(tasks, list):
        raise ValueError("App Eval coding task file must contain a JSON array")
    selected = [task for task in tasks if isinstance(task, dict)]
    if max_tasks is not None:
        selected = selected[:max_tasks]
    return expand_tasks(selected) if include_edge_scenarios else selected


def _safe_task_id(task_id: str) -> str:
    return "".join(char if char.isalnum() else "-" for char in task_id).strip("-") or "task"


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


def _write_task_workspace(task: dict[str, Any], workspace: Path) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    files = (
        task.get("context", {})
        .get("workspace", {})
        .get("files", {})
    )
    if not isinstance(files, dict):
        return
    for relative, content in files.items():
        target = workspace / str(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(content), encoding="utf-8")


def _write_prompt(task: dict[str, Any], prompt_path: Path) -> None:
    prompt_path.parent.mkdir(parents=True, exist_ok=True)
    evaluation = task.get("evaluation") if isinstance(task.get("evaluation"), dict) else {}
    payload = {
        "id": task.get("id"),
        "prompt": task.get("prompt"),
        "context": task.get("context", {}),
        "must_produce_files": evaluation.get("must_produce_files", []),
        "test_commands": evaluation.get("test_commands", []),
        "test_assertions": evaluation.get("test_assertions", []),
        "quality_criteria": evaluation.get("quality_criteria", {}),
    }
    prompt_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _command_output(command: str, *, cwd: Path, timeout_seconds: int) -> tuple[int, str, str]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    return completed.returncode, completed.stdout, completed.stderr


def _evaluate_assertion(assertion: dict[str, Any], *, workspace: Path, timeout_seconds: int) -> dict[str, Any]:
    kind = str(assertion.get("type", ""))
    target = str(assertion.get("target", ""))
    expected = assertion.get("expected")
    result: dict[str, Any] = {
        "type": kind,
        "target": target,
        "expected": expected,
        "passed": False,
    }
    if kind == "file_exists":
        result["passed"] = (workspace / target).exists() is bool(expected)
    elif kind == "file_contains":
        path = workspace / target
        text = path.read_text(encoding="utf-8") if path.exists() else ""
        result["passed"] = bool(re.search(str(expected), text))
    elif kind == "command_output":
        code, stdout, stderr = _command_output(target, cwd=workspace, timeout_seconds=timeout_seconds)
        combined = stdout + stderr
        actual = combined.strip()
        result.update({"exit_code": code, "actual": actual[-2000:]})
        result["passed"] = str(expected) in actual
    elif kind == "test_passes":
        code, stdout, stderr = _command_output(target, cwd=workspace, timeout_seconds=timeout_seconds)
        result.update({"exit_code": code, "stdout": stdout[-2000:], "stderr": stderr[-2000:]})
        result["passed"] = code == 0
    else:
        result["error"] = f"unsupported assertion type: {kind}"
    return result


def evaluate_workspace(task: dict[str, Any], *, workspace: Path, timeout_seconds: int) -> dict[str, Any]:
    evaluation = task.get("evaluation") if isinstance(task.get("evaluation"), dict) else {}
    assertions = evaluation.get("test_assertions", [])
    assertion_items = [item for item in assertions if isinstance(item, dict)]
    results = [
        _evaluate_assertion(assertion, workspace=workspace, timeout_seconds=timeout_seconds)
        for assertion in assertion_items
    ]
    passed = sum(1 for item in results if item.get("passed") is True)
    total = len(results)
    return {
        "passed": passed,
        "failed": total - passed,
        "total": total,
        "score": passed / total if total else 0.0,
        "success": bool(total and passed == total),
        "assertions": results,
    }


def _write_trajectory(
    *,
    trajectory_dir: Path | None,
    task_id: str,
    prompt_path: Path,
    agent_result: dict[str, Any],
) -> str:
    usage = agent_result.get("usage")
    if trajectory_dir is None or not isinstance(usage, dict) or not usage:
        return ""
    trajectory_dir.mkdir(parents=True, exist_ok=True)
    path = trajectory_dir / f"trajectory-{_safe_task_id(task_id)}.jsonl"
    path.write_text(
        json.dumps(
            {
                "task": task_id,
                "prompt_path": str(prompt_path),
                "usage": usage,
                "agent_status": agent_result.get("status"),
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return str(path)


def run_agent_app_eval_coding(
    *,
    output_dir: Path,
    trajectory_dir: Path | None,
    tasks: list[dict[str, Any]],
    task_agent: str,
    model_provider: str,
    model: str,
    command_template: str,
    timeout_seconds: int,
    eval_timeout_seconds: int,
) -> list[dict[str, Any]]:
    logs_dir = output_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for index, task in enumerate(tasks):
        task_id = str(task.get("id") or f"app-eval-code-{index}")
        task_dir = output_dir / "tasks" / _safe_task_id(task_id)
        workspace = task_dir / "workspace"
        _write_task_workspace(task, workspace)
        prompt_path = task_dir / "prompt.json"
        _write_prompt(task, prompt_path)
        agent_result_path = task_dir / "agent-result.json"
        command = _format_command(
            command_template,
            {
                "task": task_id,
                "task_safe": _safe_task_id(task_id),
                "prompt": str(prompt_path),
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
            cwd=workspace,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        stdout_path = logs_dir / f"{_safe_task_id(task_id)}.stdout.log"
        stderr_path = logs_dir / f"{_safe_task_id(task_id)}.stderr.log"
        stdout_path.write_text(completed.stdout or "", encoding="utf-8")
        stderr_path.write_text(completed.stderr or "", encoding="utf-8")
        agent_result = _read_agent_result(agent_result_path)
        usage = agent_result.get("usage") if isinstance(agent_result, dict) else None
        token_metrics = token_metrics_from_usage(usage) if isinstance(usage, dict) else {}
        workspace_eval = evaluate_workspace(task, workspace=workspace, timeout_seconds=eval_timeout_seconds)
        success = completed.returncode == 0 and workspace_eval["success"]
        trajectory_path = _write_trajectory(
            trajectory_dir=trajectory_dir,
            task_id=task_id,
            prompt_path=prompt_path,
            agent_result=agent_result,
        )
        results.append(
            {
                "task": task_id,
                "status": "completed" if success else "failed",
                "success": success,
                "score": 1.0 if success else 0.0,
                "passed": workspace_eval["passed"] if completed.returncode == 0 else 0,
                "failed": workspace_eval["failed"] if completed.returncode == 0 else workspace_eval["total"],
                "errors": 0 if completed.returncode == 0 else 1,
                "total": workspace_eval["total"],
                "workspace_score": workspace_eval["score"],
                "assertions": workspace_eval["assertions"],
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


def build_result(
    *,
    results: list[dict[str, Any]],
    task_agent: str,
    model_provider: str,
    model: str,
    mode: str,
    include_edge_scenarios: bool = False,
) -> dict[str, Any]:
    total = len(results)
    resolved = sum(1 for item in results if item.get("success") is True)
    return {
        "benchmark": "app_eval_coding",
        "adapter": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": mode,
        "dataset_version": EXPANDED_DATASET_VERSION if include_edge_scenarios else DATASET_VERSION,
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
    parser = argparse.ArgumentParser(description="Run App Eval coding tasks through a code-agent adapter.")
    parser.add_argument("--task-agent", default="elizaos")
    parser.add_argument("--model-provider", default="cerebras")
    parser.add_argument("--model", default="gemma-4-31b")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trajectory-dir", default="")
    parser.add_argument("--max-tasks", type=int, default=1)
    parser.add_argument("--agent-command-template", default="")
    parser.add_argument("--timeout-seconds", type=int, default=7200)
    parser.add_argument("--eval-timeout-seconds", type=int, default=120)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--expand-scenarios", action="store_true")
    parser.add_argument("--count-scenarios", action="store_true")
    parser.add_argument("--validate-scenarios", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output_dir = Path(args.output)
    trajectory_dir = Path(args.trajectory_dir) if args.trajectory_dir else None
    output_dir.mkdir(parents=True, exist_ok=True)
    base_tasks = load_tasks(max_tasks=args.max_tasks)
    tasks = load_tasks(max_tasks=args.max_tasks, include_edge_scenarios=args.expand_scenarios)
    if args.validate_scenarios:
        validate_tasks(tasks)
    if args.count_scenarios or args.validate_scenarios:
        print(
            json.dumps(
                {
                    "base": len(base_tasks),
                    "edge": len(tasks) - len(base_tasks),
                    "total": len(tasks),
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0

    if args.mock:
        results = [
            {
                "task": str(task.get("id") or f"app-eval-code-{i}"),
                "status": "mock",
                "success": True,
                "score": 1.0,
                "passed": 1,
                "failed": 0,
                "errors": 0,
                "total": 1,
            }
            for i, task in enumerate(tasks)
        ]
        result = build_result(
            results=results,
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
            mode="mock",
            include_edge_scenarios=args.expand_scenarios,
        )
    else:
        command_template = agent_command_template(
            args.task_agent,
            explicit=args.agent_command_template,
            provider=args.model_provider,
            model=args.model,
            timeout_seconds=args.timeout_seconds,
        )
        if not command_template:
            raise SystemExit(
                "Missing App Eval coding agent command template. Set "
                "APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE or unset "
                "APP_EVAL_CODING_DISABLE_BUILTIN_AGENT_COMMAND."
            )
        results = run_agent_app_eval_coding(
            output_dir=output_dir,
            trajectory_dir=trajectory_dir,
            tasks=tasks,
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
            command_template=command_template,
            timeout_seconds=args.timeout_seconds,
            eval_timeout_seconds=args.eval_timeout_seconds,
        )
        result = build_result(
            results=results,
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
            mode="live",
            include_edge_scenarios=args.expand_scenarios,
        )

    result_path = output_dir / "app-eval-coding-results.json"
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"wrote {result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
