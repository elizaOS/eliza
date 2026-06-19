"""SWE-bench Pro wrapper for code-agent matrix comparisons."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from benchmarks.nl2repo.adapter_matrix import token_metrics_from_usage


DATASET_VERSION = "swe-bench-pro-public-vendored"
EDGE_VARIANTS: tuple[str, ...] = (
    "preserve public API compatibility while fixing the issue",
    "handle empty, missing, and malformed inputs gracefully",
    "avoid broad rewrites unrelated to failing tests",
    "keep existing pass-to-pass tests stable",
    "handle unicode paths, labels, or user-visible strings",
    "maintain performance for large collections or fixtures",
    "avoid network access and nondeterminism during tests",
    "preserve documented errors and exception classes",
    "handle nested, composed, or plugin-provided objects",
    "keep packaging, imports, and build metadata stable",
)


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "benchmarks" / "swe-bench-pro").exists():
            return parent
    raise FileNotFoundError("Could not locate repository root")


def _swe_pro_root() -> Path:
    return _repo_root() / "packages" / "benchmarks" / "swe-bench-pro"


def _adapter_command_env_name(task_agent: str) -> str:
    normalized = "".join(char if char.isalnum() else "_" for char in task_agent).upper()
    return f"SWE_BENCH_PRO_AGENT_COMMAND_TEMPLATE_{normalized}"


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
            "--prompt",
            "{prompt}",
            "--task",
            "{task}",
            "--repo",
            "{repo}",
            "--base-commit",
            "{base_commit}",
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
        or os.environ.get("SWE_BENCH_PRO_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    if os.environ.get("SWE_BENCH_PRO_DISABLE_BUILTIN_AGENT_COMMAND", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return ""
    return _builtin_agent_command_template(task_agent, provider, model, timeout_seconds)


def _safe_task_id(task_id: str) -> str:
    return "".join(char if char.isalnum() else "-" for char in task_id).strip("-") or "task"


def load_tasks(*, max_tasks: int | None = None) -> list[dict[str, Any]]:
    dataset = _swe_pro_root() / "helper_code" / "sweap_eval_full_v2.jsonl"
    tasks: list[dict[str, Any]] = []
    with dataset.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            if isinstance(payload, dict):
                tasks.append(payload)
            if max_tasks is not None and len(tasks) >= max_tasks:
                break
    return tasks


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def expand_tasks(tasks: list[dict[str, Any]], *, expand_scenarios: bool = False) -> list[dict[str, Any]]:
    if not expand_scenarios:
        return [dict(task) for task in tasks]
    expanded = [dict(task) for task in tasks]
    for task in tasks:
        source_id = str(task.get("instance_id") or "")
        for index, edge_condition in enumerate(EDGE_VARIANTS, start=1):
            clone = dict(task)
            clone["source_instance_id"] = source_id
            clone["scenario_id"] = f"{source_id}__edge_{index:02d}"
            clone["edge_condition"] = edge_condition
            clone["problem_statement"] = (
                str(task.get("problem_statement") or "")
                + "\n\n"
                + f"Additional benchmark edge condition {index:02d}: {edge_condition}."
            )
            expanded.append(clone)
    return expanded


def count_tasks(tasks: list[dict[str, Any]], *, expand_scenarios: bool = False) -> dict[str, int]:
    base = len(tasks)
    edge = base * len(EDGE_VARIANTS) if expand_scenarios else 0
    return {"base": base, "edge": edge, "total": base + edge}


def validate_tasks(tasks: list[dict[str, Any]], *, expand_scenarios: bool = False) -> dict[str, Any]:
    expanded = expand_tasks(tasks, expand_scenarios=expand_scenarios)
    ids = [str(task.get("scenario_id") or task.get("instance_id") or "") for task in expanded]
    missing_ids = [task_id for task_id in ids if not task_id]
    duplicate_count = len(ids) - len(set(ids))
    return {
        "valid": not missing_ids and duplicate_count == 0,
        "missing_ids": missing_ids,
        "duplicate_count": duplicate_count,
        "total": len(expanded),
    }


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


def _patch_from_agent_result(agent_result: dict[str, Any]) -> str:
    for key in ("patch", "model_patch", "response_text"):
        value = agent_result.get(key)
        if isinstance(value, str) and value.strip():
            text = value.strip()
            fence = re.search(r"```(?:diff|patch)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
            return (fence.group(1).strip() if fence else text) + "\n"
    return ""


def _patch_from_workspace(workspace: Path) -> str:
    if not (workspace / ".git").exists():
        return ""
    completed = subprocess.run(
        ["git", "diff", "--binary"],
        cwd=workspace,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=120,
        check=False,
    )
    if completed.returncode != 0:
        return ""
    return completed.stdout or ""


def _write_prompt(task: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fail_to_pass = task.get("FAIL_TO_PASS") or []
    pass_to_pass = task.get("PASS_TO_PASS") or []
    path.write_text(
        "\n\n".join(
            [
                str(task.get("problem_statement") or ""),
                "Fail-to-pass tests:",
                json.dumps(fail_to_pass, indent=2, ensure_ascii=False),
                "Pass-to-pass tests:",
                json.dumps(pass_to_pass, indent=2, ensure_ascii=False),
            ]
        ),
        encoding="utf-8",
    )


def _prepare_workspace(task: dict[str, Any], workspace: Path, *, skip_clone: bool) -> None:
    if workspace.exists():
        shutil.rmtree(workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    repo = str(task.get("repo") or "")
    base_commit = str(task.get("base_commit") or "")
    if skip_clone:
        (workspace / "SWE_BENCH_PRO_WORKSPACE_SKIPPED.txt").write_text(
            f"repo={repo}\nbase_commit={base_commit}\n",
            encoding="utf-8",
        )
        return
    if not repo or not base_commit:
        raise ValueError("SWE-bench Pro task is missing repo/base_commit")
    subprocess.run(
        ["git", "clone", f"https://github.com/{repo}.git", str(workspace)],
        cwd=workspace.parent,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=1800,
        check=True,
    )
    subprocess.run(
        ["git", "checkout", base_commit],
        cwd=workspace,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=300,
        check=True,
    )


def _write_trajectory(
    *,
    trajectory_dir: Path | None,
    task_id: str,
    prompt: str,
    agent_result: dict[str, Any],
    patch: str,
) -> str:
    if trajectory_dir is None:
        return ""
    trajectory_dir.mkdir(parents=True, exist_ok=True)
    path = trajectory_dir / f"trajectory-{_safe_task_id(task_id)}.jsonl"
    path.write_text(
        json.dumps(
            {
                "task": task_id,
                "prompt": prompt,
                "patch_chars": len(patch),
                "actions": agent_result.get("actions", []),
                "usage": agent_result.get("usage", {}),
                "agent_status": agent_result.get("status"),
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return str(path)


def _write_evaluator_raw_sample(tasks: list[dict[str, Any]], output_dir: Path) -> Path:
    path = output_dir / "raw_sample.normalized.jsonl"
    with path.open("w", encoding="utf-8") as handle:
        for task in tasks:
            row = dict(task)
            row["fail_to_pass"] = repr(list(row.get("fail_to_pass") or row.get("FAIL_TO_PASS") or []))
            row["pass_to_pass"] = repr(list(row.get("pass_to_pass") or row.get("PASS_TO_PASS") or []))
            handle.write(json.dumps(row, sort_keys=True) + "\n")
    return path


def _evaluator_command(
    *,
    patches_json: Path,
    raw_sample_path: Path,
    output_dir: Path,
    evaluator_backend: str,
    num_workers: int,
) -> list[str]:
    eval_dir = output_dir / "eval"
    command = [
        sys.executable,
        str(_swe_pro_root() / "swe_bench_pro_eval.py"),
        "--raw_sample_path",
        str(raw_sample_path),
        "--patch_path",
        str(patches_json),
        "--output_dir",
        str(eval_dir),
        "--scripts_dir",
        str(_swe_pro_root() / "run_scripts"),
        "--dockerhub_username",
        "jefzda",
        "--num_workers",
        str(num_workers),
    ]
    if evaluator_backend == "local-docker":
        command.append("--use_local_docker")
    return command


def _run_evaluator(
    *,
    patches_json: Path,
    raw_sample_path: Path,
    output_dir: Path,
    timeout_seconds: int,
    evaluator_backend: str,
    num_workers: int,
) -> dict[str, bool]:
    eval_dir = output_dir / "eval"
    eval_dir.mkdir(parents=True, exist_ok=True)
    command = _evaluator_command(
        patches_json=patches_json,
        raw_sample_path=raw_sample_path,
        output_dir=output_dir,
        evaluator_backend=evaluator_backend,
        num_workers=num_workers,
    )
    completed = subprocess.run(
        command,
        cwd=_swe_pro_root(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    (output_dir / "evaluator.stdout.log").write_text(completed.stdout or "", encoding="utf-8")
    (output_dir / "evaluator.stderr.log").write_text(completed.stderr or "", encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(f"SWE-bench Pro evaluator failed with exit code {completed.returncode}")
    result_path = eval_dir / "eval_results.json"
    payload = json.loads(result_path.read_text(encoding="utf-8"))
    return {str(key): bool(value) for key, value in payload.items()}


def _mock_rows(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "task": str(task.get("scenario_id") or task.get("instance_id")),
            "source_instance_id": str(task.get("source_instance_id") or task.get("instance_id")),
            "edge_condition": str(task.get("edge_condition") or ""),
            "status": "mock",
            "success": True,
            "score": 1.0,
            "passed": 1,
            "failed": 0,
            "total": 1,
            "patch_path": "",
            "token_metrics": {
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "cached_tokens": 0,
                "cache_creation_tokens": 0,
                "cached_token_percent": None,
                "llm_call_count": 0,
            },
            "trajectory_path": "",
        }
        for task in tasks
    ]


def run_swe_bench_pro_matrix(
    *,
    task_agent: str,
    model_provider: str,
    model: str,
    output_dir: Path,
    trajectory_dir: Path | None,
    max_tasks: int | None,
    command_template: str,
    timeout_seconds: int,
    eval_timeout_seconds: int,
    no_docker: bool,
    skip_clone: bool,
    evaluator_backend: str,
    eval_num_workers: int,
    expand_scenarios: bool = False,
) -> list[dict[str, Any]]:
    base_tasks = load_tasks(max_tasks=max_tasks)
    if expand_scenarios and not no_docker:
        raise ValueError("SWE-bench Pro expanded scenarios require --no-docker")
    tasks = expand_tasks(base_tasks, expand_scenarios=expand_scenarios)
    predictions_dir = output_dir / "predictions"
    logs_dir = output_dir / "logs"
    predictions_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)
    patch_records: list[dict[str, str]] = []
    rows: list[dict[str, Any]] = []
    for task in tasks:
        source_task_id = str(task.get("source_instance_id") or task.get("instance_id") or "")
        task_id = str(task.get("scenario_id") or source_task_id)
        safe_id = _safe_task_id(task_id)
        task_dir = output_dir / "tasks" / safe_id
        workspace = task_dir / "workspace"
        prompt_path = task_dir / "prompt.md"
        result_path = task_dir / "agent-result.json"
        _write_prompt(task, prompt_path)
        _prepare_workspace(task, workspace, skip_clone=skip_clone)
        command = _format_command(
            command_template,
            {
                "task": task_id,
                "task_safe": safe_id,
                "workspace": str(workspace),
                "prompt": str(prompt_path),
                "repo": str(task.get("repo") or ""),
                "base_commit": str(task.get("base_commit") or ""),
                "result_json": str(result_path),
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
        stdout_path = logs_dir / f"{safe_id}.stdout.log"
        stderr_path = logs_dir / f"{safe_id}.stderr.log"
        stdout_path.write_text(completed.stdout or "", encoding="utf-8")
        stderr_path.write_text(completed.stderr or "", encoding="utf-8")
        agent_result = _read_agent_result(result_path)
        patch = _patch_from_agent_result(agent_result)
        patch_source = "agent_result" if patch else ""
        if not patch:
            patch = _patch_from_workspace(workspace)
            patch_source = "workspace_diff" if patch else ""
        pred_dir = predictions_dir / task_id
        pred_dir.mkdir(parents=True, exist_ok=True)
        pred_path = pred_dir / f"{task_agent}.pred"
        pred_path.write_text(patch, encoding="utf-8")
        patch_records.append({"instance_id": source_task_id, "patch": patch, "prefix": task_agent})
        token_metrics = token_metrics_from_usage(agent_result.get("usage", {}))
        trajectory_path = _write_trajectory(
            trajectory_dir=trajectory_dir,
            task_id=task_id,
            prompt=prompt_path.read_text(encoding="utf-8"),
            agent_result=agent_result,
            patch=patch,
        )
        rows.append(
            {
                "task": task_id,
                "source_instance_id": source_task_id,
                "edge_condition": str(task.get("edge_condition") or ""),
                "status": "generated" if completed.returncode == 0 and patch else "failed",
                "success": False,
                "score": 0.0,
                "passed": 0,
                "failed": 1,
                "total": 1,
                "agent_command": command,
                "exit_code": completed.returncode,
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "agent_result_path": str(result_path),
                "agent_result_status": agent_result.get("status"),
                "patch_path": str(pred_path),
                "patch_chars": len(patch),
                "patch_source": patch_source,
                "token_metrics": token_metrics,
                "trajectory_path": trajectory_path,
            }
        )
    patches_json = output_dir / "patches.json"
    patches_json.write_text(json.dumps(patch_records, indent=2, sort_keys=True), encoding="utf-8")
    if no_docker:
        for row in rows:
            row["status"] = "patch_generated" if row["patch_chars"] else "failed"
            row["evaluation_skipped"] = True
            row["evaluation_skip_reason"] = "--no-docker skips SWE-bench Pro test-pass evaluation"
        return rows
    raw_sample_path = _write_evaluator_raw_sample(tasks, output_dir)
    eval_results = _run_evaluator(
        patches_json=patches_json,
        raw_sample_path=raw_sample_path,
        output_dir=output_dir,
        timeout_seconds=eval_timeout_seconds,
        evaluator_backend=evaluator_backend,
        num_workers=eval_num_workers,
    )
    for row in rows:
        resolved = bool(eval_results.get(str(row["task"])))
        row["status"] = "completed" if resolved else "failed"
        row["success"] = resolved
        row["score"] = 1.0 if resolved else 0.0
        row["passed"] = 1 if resolved else 0
        row["failed"] = 0 if resolved else 1
        row["evaluation_skipped"] = False
    return rows


def build_result(
    *,
    results: list[dict[str, Any]],
    task_agent: str,
    model_provider: str,
    model: str,
    mode: str,
    scenario_counts: dict[str, int] | None = None,
    include_edge_scenarios: bool = False,
) -> dict[str, Any]:
    total = sum(int(row.get("total") or 0) for row in results)
    passed = sum(int(row.get("passed") or 0) for row in results)
    failed = sum(int(row.get("failed") or 0) for row in results)
    input_tokens = sum(int((row.get("token_metrics") or {}).get("input_tokens") or 0) for row in results)
    output_tokens = sum(int((row.get("token_metrics") or {}).get("output_tokens") or 0) for row in results)
    total_tokens = sum(int((row.get("token_metrics") or {}).get("total_tokens") or 0) for row in results)
    cached_tokens = sum(int((row.get("token_metrics") or {}).get("cached_tokens") or 0) for row in results)
    llm_calls = sum(int((row.get("token_metrics") or {}).get("llm_call_count") or 0) for row in results)
    return {
        "benchmark": "swe_bench_pro",
        "dataset_version": DATASET_VERSION,
        "task_agent": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": mode,
        "include_edge_scenarios": include_edge_scenarios,
        "scenario_counts": scenario_counts
        or {"base": len(results), "edge": 0, "total": len(results)},
        "summary": {
            "total": total,
            "passed": passed,
            "failed": failed,
            "score": passed / total if total else 0.0,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "cached_tokens": cached_tokens,
            "cached_token_percent": (cached_tokens / input_tokens * 100.0) if input_tokens else None,
            "llm_call_count": llm_calls,
        },
        "results": results,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run SWE-bench Pro through the code-agent matrix wrapper.")
    parser.add_argument("--task-agent", required=True, choices=["elizaos", "opencode"])
    parser.add_argument("--model-provider", default="cerebras")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trajectory-dir", default="")
    parser.add_argument("--max-tasks", type=int, default=1)
    parser.add_argument("--agent-command-template", default="")
    parser.add_argument("--timeout-seconds", type=int, default=14400)
    parser.add_argument("--eval-timeout-seconds", type=int, default=7200)
    parser.add_argument("--evaluator-backend", choices=["local-docker", "modal"], default="local-docker")
    parser.add_argument("--eval-num-workers", type=int, default=50)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--no-docker", action="store_true")
    parser.add_argument("--skip-clone", action="store_true")
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
    expand_scenarios = (
        args.expand_scenarios
        or _truthy_env("EXPAND_SCENARIOS")
        or _truthy_env("INCLUDE_EDGE_SCENARIOS")
    )
    counts = count_tasks(base_tasks, expand_scenarios=expand_scenarios)
    if args.count_scenarios or _truthy_env("COUNT_SCENARIOS"):
        print(
            "SWE-bench Pro scenario counts: "
            f"base={counts['base']} edge={counts['edge']} total={counts['total']}"
        )
    if args.validate_scenarios or _truthy_env("VALIDATE_SCENARIOS"):
        validation = validate_tasks(base_tasks, expand_scenarios=expand_scenarios)
        if not validation["valid"]:
            raise ValueError(f"Invalid SWE-bench Pro scenario expansion: {validation}")
        print(f"SWE-bench Pro scenario validation passed: {counts['total']} task(s)")
    if expand_scenarios and not (args.mock or args.no_docker):
        raise ValueError("SWE-bench Pro expanded scenarios require --mock or --no-docker")
    tasks = expand_tasks(base_tasks, expand_scenarios=expand_scenarios)
    if args.mock:
        result = build_result(
            results=_mock_rows(tasks),
            task_agent=args.task_agent,
            model_provider=args.model_provider,
            model=args.model,
            mode="mock",
            scenario_counts=counts,
            include_edge_scenarios=expand_scenarios,
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
            scenario_counts=counts,
            include_edge_scenarios=expand_scenarios,
        )
        result["error"] = "SWE-bench Pro code-agent command template is not configured"
        (output_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True), file=sys.stderr)
        return 2
    results = run_swe_bench_pro_matrix(
        task_agent=args.task_agent,
        model_provider=args.model_provider,
        model=args.model,
        output_dir=output_dir,
        trajectory_dir=trajectory_dir,
        max_tasks=args.max_tasks,
        command_template=command_template,
        timeout_seconds=args.timeout_seconds,
        eval_timeout_seconds=args.eval_timeout_seconds,
        no_docker=args.no_docker,
        skip_clone=args.skip_clone,
        evaluator_backend=args.evaluator_backend,
        eval_num_workers=args.eval_num_workers,
        expand_scenarios=expand_scenarios,
    )
    result = build_result(
        results=results,
        task_agent=args.task_agent,
        model_provider=args.model_provider,
        model=args.model,
        mode="live_no_docker" if args.no_docker else "live",
        scenario_counts=counts,
        include_edge_scenarios=expand_scenarios,
    )
    (output_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
