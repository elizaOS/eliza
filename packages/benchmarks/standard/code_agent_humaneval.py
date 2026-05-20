"""HumanEval wrapper for code-agent matrix comparisons."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from benchmarks.nl2repo.adapter_matrix import token_metrics_from_usage
from benchmarks.standard.humaneval import (
    DATASET_VERSION,
    EMPTY_RETRY_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    _build_program,
    _execute_program,
    _load_dataset_examples,
)


def _adapter_command_env_name(task_agent: str) -> str:
    normalized = "".join(char if char.isalnum() else "_" for char in task_agent).upper()
    return f"STANDARD_HUMANEVAL_AGENT_COMMAND_TEMPLATE_{normalized}"


def _builtin_agent_command_template(task_agent: str, provider: str, model: str, timeout_seconds: int) -> str:
    helper = Path(__file__).resolve().parent / "agent_command.py"
    return " ".join(
        shlex.quote(part)
        for part in (
            sys.executable,
            str(helper),
            "--adapter",
            task_agent,
            "--benchmark",
            "standard_humaneval",
            "--task",
            "{task}",
            "--prompt",
            "{prompt}",
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
        or os.environ.get("STANDARD_HUMANEVAL_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    if os.environ.get("STANDARD_HUMANEVAL_DISABLE_BUILTIN_AGENT_COMMAND", "").strip() == "1":
        return ""
    return _builtin_agent_command_template(task_agent, provider, model, timeout_seconds)


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


def _write_trajectory(
    *,
    trajectory_dir: Path | None,
    task_id: str,
    prompt: str,
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
                "prompt": prompt,
                "usage": usage,
                "agent_status": agent_result.get("status"),
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return str(path)


def _prompt_for(example: dict[str, object]) -> str:
    return "\n\n".join(
        [
            SYSTEM_PROMPT,
            "Return only the Python function body for this HumanEval task.",
            str(example["prompt"]),
            "If your first answer would be empty, follow this retry instruction:",
            EMPTY_RETRY_SYSTEM_PROMPT,
        ]
    )


def run_agent_humaneval(
    *,
    output_dir: Path,
    trajectory_dir: Path | None,
    examples: list[dict[str, object]],
    task_agent: str,
    model_provider: str,
    model: str,
    command_template: str,
    timeout_seconds: int,
    eval_timeout_seconds: float,
) -> list[dict[str, Any]]:
    logs_dir = output_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for index, example in enumerate(examples):
        task_id = str(example.get("task_id") or f"humaneval-{index}")
        task_dir = output_dir / "tasks" / _safe_task_id(task_id)
        task_dir.mkdir(parents=True, exist_ok=True)
        prompt_path = task_dir / "prompt.md"
        prompt = _prompt_for(example)
        prompt_path.write_text(prompt, encoding="utf-8")
        agent_result_path = task_dir / "agent-result.json"
        command = _format_command(
            command_template,
            {
                "task": task_id,
                "task_safe": _safe_task_id(task_id),
                "prompt": str(prompt_path),
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
        stdout_path = logs_dir / f"{_safe_task_id(task_id)}.stdout.log"
        stderr_path = logs_dir / f"{_safe_task_id(task_id)}.stderr.log"
        stdout_path.write_text(completed.stdout or "", encoding="utf-8")
        stderr_path.write_text(completed.stderr or "", encoding="utf-8")
        agent_result = _read_agent_result(agent_result_path)
        usage = agent_result.get("usage") if isinstance(agent_result, dict) else None
        token_metrics = token_metrics_from_usage(usage) if isinstance(usage, dict) else {}
        completion = str(agent_result.get("response_text") or "")
        program = _build_program(
            str(example["prompt"]),
            completion,
            str(example["test"]),
            str(example["entry_point"]),
        )
        passed, error = _execute_program(program, eval_timeout_seconds)
        trajectory_path = _write_trajectory(
            trajectory_dir=trajectory_dir,
            task_id=task_id,
            prompt=prompt,
            agent_result=agent_result,
        )
        results.append(
            {
                "task": task_id,
                "status": "completed" if completed.returncode == 0 and passed else "failed",
                "success": completed.returncode == 0 and passed,
                "score": 1.0 if completed.returncode == 0 and passed else 0.0,
                "passed": 1 if completed.returncode == 0 and passed else 0,
                "failed": 0 if completed.returncode == 0 and passed else 1,
                "errors": 0 if completed.returncode == 0 else 1,
                "total": 1,
                "agent_command": command,
                "exit_code": completed.returncode,
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "agent_result_path": str(agent_result_path),
                "agent_result_status": agent_result.get("status"),
                "error": "" if passed else error,
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
) -> dict[str, Any]:
    total = len(results)
    resolved = sum(1 for item in results if item.get("success") is True)
    return {
        "benchmark": "standard_humaneval",
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
        "results": results,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run HumanEval through a code-agent adapter.")
    parser.add_argument("--task-agent", default="elizaos")
    parser.add_argument("--model-provider", default="cerebras")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trajectory-dir", default="")
    parser.add_argument("--max-tasks", type=int, default=1)
    parser.add_argument("--agent-command-template", default="")
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    parser.add_argument("--eval-timeout-seconds", type=float, default=10.0)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output_dir = Path(args.output)
    trajectory_dir = Path(args.trajectory_dir) if args.trajectory_dir else None
    output_dir.mkdir(parents=True, exist_ok=True)
    examples = _load_dataset_examples(args.max_tasks)

    if args.mock:
        results = [
            {
                "task": str(example.get("task_id") or f"humaneval-{i}"),
                "status": "mock",
                "success": True,
                "score": 1.0,
                "passed": 1,
                "failed": 0,
                "errors": 0,
                "total": 1,
            }
            for i, example in enumerate(examples)
        ]
        result = build_result(
            results=results,
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
            mode="mock",
        )
        (output_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    command_template = agent_command_template(
        args.task_agent,
        explicit=args.agent_command_template,
        provider=args.model_provider,
        model=args.model,
        timeout_seconds=args.timeout_seconds,
    )
    if not command_template:
        result = build_result(
            results=[],
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
            mode="configuration_error",
        )
        result["error"] = "HumanEval code-agent command template is not configured"
        (output_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True), file=sys.stderr)
        return 2

    results = run_agent_humaneval(
        output_dir=output_dir,
        trajectory_dir=trajectory_dir,
        examples=examples,
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
    )
    (output_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
