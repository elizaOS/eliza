"""Claw-Eval deterministic-slice wrapper for code-agent matrix comparisons."""

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

import yaml

from benchmarks.nl2repo.adapter_matrix import token_metrics_from_usage


DATASET_VERSION = "claw-eval-deterministic-yaml-slice-v2"
EDGE_VARIANTS: tuple[str, ...] = (
    "handle missing optional context without asking for clarification",
    "preserve exact category and keyword wording in the final answer",
    "avoid relying on external web access unless the task explicitly requires it",
    "use available tools only when they materially support the answer",
    "keep the final response concise while satisfying all scoring components",
    "handle unicode names, punctuation, and mixed-case labels",
    "separate assumptions from verified facts in the response",
    "recover when a referenced fixture or artifact is absent",
    "prioritize scoring rubric requirements over conversational filler",
    "include enough detail for deterministic graders to match the answer",
)
SUPPORTED_CHECK_TYPES = {
    "categories_present",
    "keywords_present",
    "min_length",
    "tool_called",
}


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "benchmarks" / "claw-eval").exists():
            return parent
    raise FileNotFoundError("Could not locate repository root")


def _claw_eval_root() -> Path:
    return _repo_root() / "packages" / "benchmarks" / "claw-eval"


def _adapter_command_env_name(task_agent: str) -> str:
    normalized = "".join(char if char.isalnum() else "_" for char in task_agent).upper()
    return f"CLAW_EVAL_AGENT_COMMAND_TEMPLATE_{normalized}"


def _builtin_agent_command_template(task_agent: str, provider: str, model: str, timeout_seconds: int) -> str:
    helper = Path(__file__).resolve().parent / "agent_command.py"
    return " ".join(
        shlex.quote(part)
        for part in (
            sys.executable,
            str(helper),
            "--adapter",
            task_agent,
            "--task-yaml",
            "{task_yaml}",
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
        or os.environ.get("CLAW_EVAL_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    if os.environ.get("CLAW_EVAL_DISABLE_BUILTIN_AGENT_COMMAND", "").strip().lower() in {
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
    tasks: list[dict[str, Any]] = []
    for task_yaml in sorted((_claw_eval_root() / "tasks").glob("*/task.yaml")):
        data = yaml.safe_load(task_yaml.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            continue
        data["task_yaml"] = str(task_yaml)
        checks = [
            ((component or {}).get("check") or {}).get("type")
            for component in data.get("scoring_components") or []
        ]
        if (
            not checks
            or any(check == "llm_judge" for check in checks)
            or any(check not in SUPPORTED_CHECK_TYPES for check in checks)
        ):
            continue
        data.setdefault("task_id", task_yaml.parent.name)
        tasks.append(data)
    return tasks[:max_tasks] if max_tasks is not None else tasks


def available_task_count() -> int:
    return len(load_tasks(max_tasks=None))


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def expand_tasks(tasks: list[dict[str, Any]], *, expand_scenarios: bool = False) -> list[dict[str, Any]]:
    if not expand_scenarios:
        return [dict(task) for task in tasks]
    expanded = [dict(task) for task in tasks]
    for task in tasks:
        source_id = str(task.get("task_id") or "")
        for index, edge_condition in enumerate(EDGE_VARIANTS, start=1):
            clone = dict(task)
            clone["source_task_id"] = source_id
            clone["task_id"] = f"{source_id}__edge_{index:02d}"
            clone["edge_condition"] = edge_condition
            expanded.append(clone)
    return expanded


def count_tasks(tasks: list[dict[str, Any]], *, expand_scenarios: bool = False) -> dict[str, int]:
    base = len(tasks)
    edge = base * len(EDGE_VARIANTS) if expand_scenarios else 0
    return {"base": base, "edge": edge, "total": base + edge}


def validate_tasks(tasks: list[dict[str, Any]], *, expand_scenarios: bool = False) -> dict[str, Any]:
    expanded = expand_tasks(tasks, expand_scenarios=expand_scenarios)
    ids = [str(task.get("task_id") or "") for task in expanded]
    duplicate_count = len(ids) - len(set(ids))
    missing_ids = [task_id for task_id in ids if not task_id]
    return {
        "valid": duplicate_count == 0 and not missing_ids,
        "duplicate_count": duplicate_count,
        "missing_ids": missing_ids,
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


def _action_texts(agent_result: dict[str, Any]) -> list[str]:
    texts: list[str] = []
    for action in agent_result.get("actions") or []:
        if isinstance(action, str):
            texts.append(action)
        elif isinstance(action, dict):
            texts.append(json.dumps(action, ensure_ascii=False, sort_keys=True))
    return texts


def _score_check(check: dict[str, Any], *, final_text: str, action_text: str) -> float:
    kind = str(check.get("type") or "")
    text = final_text.lower()
    actions = action_text.lower()
    if kind == "keywords_present":
        keywords = [str(item) for item in check.get("keywords") or []]
        if not keywords:
            return 0.0
        hits = sum(1 for keyword in keywords if keyword.lower() in text)
        return hits / len(keywords)
    if kind == "min_length":
        min_length = int(check.get("min_length") or 0)
        return 1.0 if min_length and len(final_text) >= min_length else 0.0
    if kind == "tool_called":
        tool_name = str(check.get("tool_name") or "").lower()
        min_calls = int(check.get("min_calls") or 1)
        if not tool_name:
            return 0.0
        calls = actions.count(tool_name)
        return min(1.0, calls / max(min_calls, 1))
    if kind == "categories_present":
        categories = [str(item) for item in check.get("categories") or []]
        if not categories:
            return 0.0
        hits = sum(1 for category in categories if re.search(rf"\b{re.escape(category.lower())}\b", text))
        return hits / len(categories)
    return 0.0


def score_task(task: dict[str, Any], agent_result: dict[str, Any]) -> dict[str, Any]:
    final_text = str(agent_result.get("response_text") or "")
    action_text = "\n".join(_action_texts(agent_result))
    scores: dict[str, float] = {}
    total_weight = 0.0
    weighted = 0.0
    for component in task.get("scoring_components") or []:
        if not isinstance(component, dict):
            continue
        name = str(component.get("name") or "component")
        weight = float(component.get("weight") or 0.0)
        check = component.get("check") if isinstance(component.get("check"), dict) else {}
        score = _score_check(check, final_text=final_text, action_text=action_text)
        scores[name] = score
        weighted += weight * score
        total_weight += weight
    score = weighted / total_weight if total_weight else 0.0
    return {
        "task_id": task.get("task_id"),
        "score": score,
        "max_score": 1.0,
        "grading_type": "deterministic_yaml",
        "breakdown": scores,
        "notes": "scored from Claw-Eval deterministic YAML components",
    }


def _write_trajectory(
    *,
    trajectory_dir: Path | None,
    task_id: str,
    task_yaml: str,
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
                "task_yaml": task_yaml,
                "response_text": agent_result.get("response_text", ""),
                "actions": agent_result.get("actions", []),
                "usage": agent_result.get("usage", {}),
                "agent_status": agent_result.get("status"),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return str(path)


def _scenario_task_yaml(task: dict[str, Any], task_dir: Path) -> str:
    source = Path(str(task.get("task_yaml") or ""))
    edge_condition = str(task.get("edge_condition") or "")
    if not edge_condition:
        return str(source)
    data = yaml.safe_load(source.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return str(source)
    prompt = data.get("prompt")
    if isinstance(prompt, dict):
        prompt["text"] = (
            str(prompt.get("text") or "")
            + "\n\n"
            + f"Additional benchmark edge condition: {edge_condition}."
        )
    target = task_dir / "task.expanded.yaml"
    target.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return str(target)


def _mock_results(
    tasks: list[dict[str, Any]],
    *,
    max_tasks: int | None,
    trajectory_dir: Path | None,
) -> list[dict[str, Any]]:
    if not tasks:
        return []
    total = max_tasks if max_tasks is not None else len(tasks)
    rows: list[dict[str, Any]] = []
    for index in range(total):
        task = tasks[index % len(tasks)]
        base_task_id = str(task["task_id"])
        task_id = base_task_id if index < len(tasks) else f"{base_task_id}__mock_{index + 1}"
        trajectory_path = ""
        if trajectory_dir is not None:
            trajectory_path = _write_trajectory(
                trajectory_dir=trajectory_dir,
                task_id=task_id,
                task_yaml=str(task.get("task_yaml") or ""),
                agent_result={
                    "response_text": f"Mock Claw-Eval response for {task_id}",
                    "actions": [],
                    "usage": {},
                    "status": "mock",
                },
            )
        rows.append(
            {
                "task": task_id,
                "source_task_id": str(task.get("source_task_id") or base_task_id),
                "edge_condition": str(task.get("edge_condition") or ""),
                "status": "completed",
                "success": True,
                "score": 1.0,
                "passed": 1,
                "failed": 0,
                "total": 1,
                "grading": {
                    "task_id": task_id,
                    "score": 1.0,
                    "max_score": 1.0,
                    "grading_type": "deterministic_yaml",
                    "breakdown": {"mock": 1.0},
                    "notes": "mock Claw-Eval deterministic slice result",
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


def run_claw_eval_matrix(
    *,
    task_agent: str,
    model_provider: str,
    model: str,
    output_dir: Path,
    trajectory_dir: Path | None,
    max_tasks: int | None,
    command_template: str,
    timeout_seconds: int,
    mock: bool,
    expand_scenarios: bool = False,
    scenario_counts: dict[str, int] | None = None,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    base_tasks = load_tasks(max_tasks=max_tasks)
    tasks = expand_tasks(base_tasks, expand_scenarios=expand_scenarios)
    if mock:
        return build_result(
            results=_mock_results(tasks, max_tasks=None, trajectory_dir=trajectory_dir),
            task_agent=task_agent,
            model_provider=model_provider,
            model=model,
            mode="mock",
            scenario_counts=scenario_counts,
            include_edge_scenarios=expand_scenarios,
        )
    if not command_template:
        raise ValueError("Claw-Eval live mode requires an agent command template")

    logs_dir = output_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for task in tasks:
        task_id = str(task.get("task_id") or "task")
        task_dir = output_dir / "tasks" / _safe_task_id(task_id)
        task_dir.mkdir(parents=True, exist_ok=True)
        agent_result_path = task_dir / "agent-result.json"
        task_yaml = _scenario_task_yaml(task, task_dir)
        command = _format_command(
            command_template,
            {
                "task": task_id,
                "task_safe": _safe_task_id(task_id),
                "task_yaml": task_yaml,
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
        grading = score_task(task, agent_result)
        score = float(grading.get("score") or 0.0)
        usage = agent_result.get("usage") if isinstance(agent_result, dict) else None
        token_metrics = token_metrics_from_usage(usage) if isinstance(usage, dict) else {}
        trajectory_path = _write_trajectory(
            trajectory_dir=trajectory_dir,
            task_id=task_id,
            task_yaml=task_yaml,
            agent_result=agent_result,
        )
        results.append(
            {
                "task": task_id,
                "source_task_id": str(task.get("source_task_id") or task_id),
                "edge_condition": str(task.get("edge_condition") or ""),
                "status": "completed" if completed.returncode == 0 and score >= 0.75 else "failed",
                "success": completed.returncode == 0 and score >= 0.75,
                "score": score,
                "passed": 1 if completed.returncode == 0 and score >= 0.75 else 0,
                "failed": 0 if completed.returncode == 0 and score >= 0.75 else 1,
                "total": 1,
                "agent_command": command,
                "exit_code": completed.returncode,
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "agent_result_path": str(agent_result_path),
                "agent_result_status": agent_result.get("status"),
                "error": str(agent_result.get("error") or "") if score < 0.75 else "",
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
    scenario_counts: dict[str, int] | None = None,
    include_edge_scenarios: bool = False,
) -> dict[str, Any]:
    total = len(results)
    resolved = sum(1 for item in results if item.get("success") is True)
    available = available_task_count()
    return {
        "benchmark": "claw_eval",
        "adapter": task_agent,
        "model_provider": model_provider,
        "model": model,
        "mode": mode,
        "dataset_version": DATASET_VERSION,
        "include_edge_scenarios": include_edge_scenarios,
        "scenario_counts": scenario_counts
        or {"base": total, "edge": 0, "total": total},
        "available_task_count": available,
        "coverage_note": (
            f"local deterministic Claw-Eval slice exposes {available} non-LLM-judge tasks"
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
    parser = argparse.ArgumentParser(description="Run deterministic Claw-Eval tasks through a code-agent adapter.")
    parser.add_argument("--task-agent", default="elizaos")
    parser.add_argument("--model-provider", default="cerebras")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trajectory-dir", default="")
    parser.add_argument("--max-tasks", type=int)
    parser.add_argument("--agent-command-template", default="")
    parser.add_argument("--timeout-seconds", type=int, default=7200)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--no-docker", action="store_true", help="Accepted for matrix CLI parity.")
    parser.add_argument("--expand-scenarios", action="store_true")
    parser.add_argument("--count-scenarios", action="store_true")
    parser.add_argument("--validate-scenarios", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    expand_scenarios = (
        args.expand_scenarios
        or _truthy_env("EXPAND_SCENARIOS")
        or _truthy_env("INCLUDE_EDGE_SCENARIOS")
    )
    base_tasks = load_tasks(max_tasks=args.max_tasks)
    counts = count_tasks(base_tasks, expand_scenarios=expand_scenarios)
    if args.count_scenarios or _truthy_env("COUNT_SCENARIOS"):
        print(
            "Claw-Eval scenario counts: "
            f"base={counts['base']} edge={counts['edge']} total={counts['total']}"
        )
    if args.validate_scenarios or _truthy_env("VALIDATE_SCENARIOS"):
        validation = validate_tasks(base_tasks, expand_scenarios=expand_scenarios)
        if not validation["valid"]:
            raise ValueError(f"Invalid Claw-Eval scenario expansion: {validation}")
        print(f"Claw-Eval scenario validation passed: {counts['total']} task(s)")
    template = agent_command_template(
        args.task_agent,
        explicit=args.agent_command_template,
        provider=args.model_provider,
        model=args.model,
        timeout_seconds=args.timeout_seconds,
    )
    result = run_claw_eval_matrix(
        task_agent=args.task_agent,
        model_provider=args.model_provider,
        model=args.model,
        output_dir=Path(args.output),
        trajectory_dir=Path(args.trajectory_dir) if args.trajectory_dir else None,
        max_tasks=args.max_tasks,
        command_template=template,
        timeout_seconds=args.timeout_seconds,
        mock=bool(args.mock),
        expand_scenarios=expand_scenarios,
        scenario_counts=counts,
    )
    result_path = Path(args.output) / "claw-eval-results.json"
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"wrote {result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
