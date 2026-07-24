"""App-eval runner backed by the eliza TypeScript benchmark server."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from eliza_adapter.client import ElizaClient
from eliza_adapter.server_manager import ElizaServerManager


EXPECTED_TASKS_PER_TYPE = 10
TASK_FILES: tuple[tuple[str, str], ...] = (
    ("research-tasks.json", "research"),
    ("coding-tasks.json", "coding"),
)
CODING_RUNNER = "packages/benchmarks/app-eval/code_agent_coding.py"


def _mapping(value: object) -> Mapping[str, object] | None:
    return value if isinstance(value, Mapping) else None


def _research_runtime_provenance(response: object) -> dict[str, object]:
    params = _mapping(getattr(response, "params", None)) or {}
    metadata = _mapping(getattr(response, "metadata", None)) or {}
    adapter_meta = _mapping(params.get("_meta")) or {}
    return {
        "metadata": dict(metadata),
        "adapter_meta": dict(adapter_meta),
    }


def _require_publishable_research_provenance(
    harness: str,
    response: object,
) -> dict[str, object]:
    provenance = _research_runtime_provenance(response)
    metadata = _mapping(provenance["metadata"]) or {}
    adapter_meta = _mapping(provenance["adapter_meta"]) or {}
    if harness == "eliza":
        valid = (
            metadata.get("agent_label") == "eliza"
            and metadata.get("native_runtime_class") == "@elizaos/core.AgentRuntime"
            and metadata.get("native_runtime_api") == "messageService.handleMessage"
            and metadata.get("transport") == "eliza_benchmark_http"
            and metadata.get("tool_bridge")
            in {"native_action_capture", "runtime_model_native_tools", "runtime_model_text"}
            and metadata.get("release_evidence") is True
            and metadata.get("direct_model_bypass") is False
            and metadata.get("stand_in") is False
        )
    elif harness == "hermes":
        valid = (
            adapter_meta.get("agent_runtime") == "hermes"
            and adapter_meta.get("native_runtime_class") == "run_agent.AIAgent"
            and adapter_meta.get("native_runtime_api") == "run_conversation"
            and adapter_meta.get("transport")
            == "subprocess_loopback_openai_compatible"
            and adapter_meta.get("native_agent_instantiated") is True
            and adapter_meta.get("publishable_native") is True
            and adapter_meta.get("legacy_raw_openai_bypass") is False
        )
    elif harness == "openclaw":
        openclaw_meta = _mapping(adapter_meta.get("openclaw_adapter")) or {}
        valid = (
            openclaw_meta.get("agent_runtime") == "openclaw"
            and openclaw_meta.get("native_runtime_class") == "openclaw.agent.embedded"
            and openclaw_meta.get("native_runtime_api")
            == "openclaw agent --local --json"
            and openclaw_meta.get("publishable_native") is True
            and openclaw_meta.get("transport") == "openclaw_embedded_runtime"
            and openclaw_meta.get("tool_bridge") == "native_plugin"
        )
    else:
        raise ValueError(f"unsupported App Eval research harness {harness!r}")
    if not valid:
        raise RuntimeError(
            f"{harness} returned missing or nonpublishable native runtime provenance"
        )
    return provenance


def _selected_task_files(task_type: str | None) -> list[tuple[str, str]]:
    return [
        (filename, default_type)
        for filename, default_type in TASK_FILES
        if task_type in (None, default_type)
    ]


def _load_json_list(path: Path) -> list[object]:
    if not path.is_file():
        raise FileNotFoundError(f"required app-eval task manifest is missing: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"app-eval task manifest must contain a JSON list: {path}")
    return data


def _load_tasks(
    tasks_dir: Path,
    task_type: str | None,
    task_id: str | None,
) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for filename, default_type in _selected_task_files(task_type):
        path = tasks_dir / filename
        data = _load_json_list(path)
        if len(data) != EXPECTED_TASKS_PER_TYPE:
            raise ValueError(
                f"app-eval {default_type} manifest must contain exactly "
                f"{EXPECTED_TASKS_PER_TYPE} tasks, found {len(data)} in {path}"
            )
        for index, item in enumerate(data):
            if not isinstance(item, dict):
                raise ValueError(f"{path}: task at index {index} is not a JSON object")
            task = dict(item)
            task.setdefault("type", default_type)
            if task.get("type") != default_type:
                raise ValueError(
                    f"{path}: task {task.get('id')!r} has type {task.get('type')!r}, "
                    f"expected {default_type!r}"
                )
            if not isinstance(task.get("id"), str) or not str(task["id"]).strip():
                raise ValueError(f"{path}: task at index {index} has no non-empty id")
            if not isinstance(task.get("prompt"), str) or not str(task["prompt"]).strip():
                raise ValueError(f"{path}: task {task['id']!r} has no non-empty prompt")
            if task_id and str(task.get("id")) != task_id:
                continue
            tasks.append(task)
    ids = [str(task["id"]) for task in tasks]
    if len(ids) != len(set(ids)):
        raise ValueError("app-eval selected task manifests contain duplicate task ids")
    if task_id and len(tasks) != 1:
        raise ValueError(f"app-eval task id {task_id!r} did not match exactly one task")
    return tasks


def _task_provenance(tasks_dir: Path, task_type: str | None) -> dict[str, Any]:
    manifests: list[dict[str, Any]] = []
    for filename, default_type in _selected_task_files(task_type):
        path = tasks_dir / filename
        content = path.read_bytes()
        manifests.append(
            {
                "file": filename,
                "type": default_type,
                "task_count": len(_load_json_list(path)),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    return {
        "source": "packages/benchmarks/app-eval/tasks",
        "expected_tasks_per_type": EXPECTED_TASKS_PER_TYPE,
        "manifests": manifests,
    }


def _selected_harness() -> str:
    raw = (
        os.environ.get("ELIZA_BENCH_HARNESS")
        or os.environ.get("BENCHMARK_HARNESS")
        or os.environ.get("BENCHMARK_AGENT")
        or "eliza"
    ).strip().lower()
    harness = "eliza" if raw in {"eliza", "elizaos", "eliza-os"} else raw
    if harness not in {"eliza", "hermes", "openclaw"}:
        raise ValueError(
            f"app-eval workspace runner does not support harness {raw!r}; "
            "expected eliza, hermes, or openclaw"
        )
    return harness


def _load_coding_runner(tasks_dir: Path) -> Any:
    runner_path = tasks_dir.parent / "code_agent_coding.py"
    if not runner_path.is_file():
        raise FileNotFoundError(f"required App Eval coding runner is missing: {runner_path}")
    packages_root = str(tasks_dir.parents[2])
    if packages_root not in sys.path:
        sys.path.insert(0, packages_root)
    module_name = "_eliza_adapter_app_eval_coding_runner"
    spec = importlib.util.spec_from_file_location(module_name, runner_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load App Eval coding runner from {runner_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    for export in ("agent_command_template", "run_agent_app_eval_coding"):
        if not callable(getattr(module, export, None)):
            raise ImportError(f"App Eval coding runner has no callable {export}: {runner_path}")
    return module


def _load_evaluate_result(
    tasks_dir: Path,
) -> Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]:
    evaluator_path = tasks_dir.parent / "evaluate.py"
    if not evaluator_path.is_file():
        raise FileNotFoundError(f"required app-eval evaluator is missing: {evaluator_path}")
    module_name = "_eliza_adapter_app_eval_evaluator"
    spec = importlib.util.spec_from_file_location(module_name, evaluator_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load app-eval evaluator from {evaluator_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    evaluator = getattr(module, "evaluate_result", None)
    if not callable(evaluator):
        raise ImportError(
            f"app-eval evaluator does not export evaluate_result: {evaluator_path}"
        )
    return evaluator


def _augment_prompt(task: dict[str, Any]) -> str:
    prompt = str(task.get("prompt") or "")
    task_type = str(task.get("type") or "research")
    if task_type == "coding":
        raise RuntimeError(
            "coding tasks must use the materialized workspace runner, not the chat "
            f"response path ({CODING_RUNNER})"
        )
    return (
        prompt
        + "\n\nGive a thorough, structured answer with headings, bullets, and a concise conclusion."
    )


def _score_groups(results: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for result in results:
        groups.setdefault(str(result.get("type") or "unknown"), []).append(result)

    out: dict[str, dict[str, Any]] = {}
    for group, items in groups.items():
        scores = [float(item.get("score") or 0.0) for item in items]
        passed = sum(1 for item in items if item.get("success") is True)
        out[group] = {
            "avg": sum(scores) / len(scores) if scores else 0.0,
            "min": min(scores) if scores else 0.0,
            "max": max(scores) if scores else 0.0,
            "total": len(items),
            "completed": passed,
            "tasks": [
                {
                    "id": item.get("id"),
                    "success": item.get("success", False),
                    "score": item.get("score", 0.0),
                    "duration_ms": item.get("duration_ms", 0),
                    "error": item.get("error"),
                }
                for item in items
            ],
        }
    return out


def _run_task(
    client: ElizaClient,
    task: dict[str, Any],
    timeout_ms: int,
    evaluate_result: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    task_id = str(task.get("id") or "unknown")
    task_type = str(task.get("type") or "research")
    started = time.perf_counter()
    try:
        client.reset(task_id=task_id, benchmark="app-eval")
        response = client.send_message(
            text=_augment_prompt(task),
            context={
                "benchmark": "app-eval",
                "task_id": task_id,
                "type": task_type,
                "difficulty": task.get("difficulty"),
                "timeout_ms": timeout_ms,
            },
        )
        provenance = _require_publishable_research_provenance(
            _selected_harness(),
            response,
        )
        text = response.text or ""
        success = bool(text.strip())
        result: dict[str, Any] = {
            "id": task_id,
            "type": task_type,
            "response": text,
            "actions_taken": response.actions,
            "runtime_provenance": provenance,
            "usage": dict(_mapping(getattr(response, "params", None)) or {}).get(
                "usage",
                {},
            ),
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "success": success,
            "error": None if success else "empty response",
        }
        evaluation = evaluate_result(task, result)
        score = evaluation.get("score")
        if not isinstance(score, (int, float)):
            raise ValueError(f"app-eval evaluator returned no numeric score for {task_id}")
        result["score"] = float(score)
        result["evaluation"] = evaluation
        return result
    except Exception as exc:  # noqa: BLE001
        # error-policy:J1 Per-task boundary records a structured failure; main exits nonzero.
        return {
            "id": task_id,
            "type": task_type,
            "response": "",
            "actions_taken": [],
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "success": False,
            "score": 0.0,
            "error": str(exc),
            "infrastructure_error": True,
        }


def app_eval_exit_code(*, publishable: bool, structural_mock_ok: bool) -> int:
    """Process exit code for an app-eval run.

    A benchmark's job is to *measure* performance, so a low model score (the
    model wrote failing code, answered a research task poorly) is a valid
    result and exits 0. Exit non-zero only when the run produced no publishable
    measurement — an infrastructure failure (already folded into
    ``publishable``) or a mock run that structurally cannot score coding
    (``structural_mock_ok`` is False for mock+coding). Requiring every task to
    pass would demand a perfect model to exit 0, which defeats the point and
    made the orchestrator treat a real low score as a cohort failure.
    """
    return 0 if (publishable or structural_mock_ok) else 1


def _coding_failure(raw: Mapping[str, Any]) -> str | None:
    if raw.get("success") is True:
        return None
    if raw.get("infrastructure_error"):
        return str(raw["infrastructure_error"])
    exit_code = raw.get("exit_code")
    if exit_code not in (None, 0):
        return f"coding agent command exited with code {exit_code}"
    agent_status = raw.get("agent_result_status")
    if agent_status != "completed":
        return f"coding agent did not complete explicitly (status={agent_status!r})"
    passed = raw.get("passed")
    total = raw.get("total")
    return f"hidden workspace assertions failed ({passed}/{total} passed)"


def _coding_summary_result(
    task: dict[str, Any],
    raw: dict[str, Any],
    *,
    duration_ms: int,
) -> dict[str, Any]:
    task_id = str(task["id"])
    ratio = raw.get("workspace_score")
    if not isinstance(ratio, (int, float)) or isinstance(ratio, bool):
        raw["infrastructure_error"] = (
            f"{task_id}: workspace runner returned no numeric assertion ratio"
        )
        ratio = 0.0
    ratio = float(ratio)
    if ratio < 0.0 or ratio > 1.0:
        raw["infrastructure_error"] = (
            f"{task_id}: workspace assertion ratio {ratio} is outside 0..1"
        )
        ratio = 0.0

    total = raw.get("total")
    passed = raw.get("passed")
    failed = raw.get("failed")
    valid_assertion_counts = (
        isinstance(total, int)
        and not isinstance(total, bool)
        and total > 0
        and isinstance(passed, int)
        and not isinstance(passed, bool)
        and isinstance(failed, int)
        and not isinstance(failed, bool)
        and passed >= 0
        and failed >= 0
        and passed + failed == total
    )
    if not valid_assertion_counts:
        raw["infrastructure_error"] = (
            f"{task_id}: workspace runner returned inconsistent assertion counts"
        )
        ratio = 0.0

    agent_result: dict[str, Any] = {}
    agent_result_path = raw.get("agent_result_path")
    if isinstance(agent_result_path, str) and agent_result_path:
        path = Path(agent_result_path)
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                raise ValueError("agent result is not a JSON object")
            agent_result = loaded
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            raw["infrastructure_error"] = f"{task_id}: unreadable agent result: {exc}"
            ratio = 0.0
    else:
        raw.setdefault(
            "infrastructure_error",
            f"{task_id}: coding runner omitted agent_result_path",
        )
        ratio = 0.0

    success = raw.get("success") is True and "infrastructure_error" not in raw
    return {
        "id": task_id,
        "type": "coding",
        "response": "",
        "actions_taken": [],
        "duration_ms": duration_ms,
        "success": success,
        "score": ratio * 10.0,
        "error": _coding_failure(raw),
        "evaluation": {
            "task_id": task_id,
            "score": ratio * 10.0,
            "max_score": 10.0,
            "pass": success,
            "workspace_assertion_ratio": ratio,
            "passed": passed if valid_assertion_counts else 0,
            "failed": failed if valid_assertion_counts else 0,
            "total": total if valid_assertion_counts else 0,
            "assertions": raw.get("assertions", []),
        },
        "workspace_execution": {
            "exit_code": raw.get("exit_code"),
            "agent_result_status": raw.get("agent_result_status"),
            "agent_result_path": agent_result_path,
            "stdout_path": raw.get("stdout_path"),
            "stderr_path": raw.get("stderr_path"),
            "trajectory_path": raw.get("trajectory_path"),
            "turn_count": agent_result.get("turn_count"),
            "commands_executed": agent_result.get("commands_executed"),
            "completed_marker": agent_result.get("completed_marker"),
            "turns": agent_result.get("turns", []),
            "usage": agent_result.get("usage", {}),
            "infrastructure_error": raw.get("infrastructure_error"),
        },
    }


def _run_coding_tasks(
    tasks_dir: Path,
    tasks: list[dict[str, Any]],
    *,
    output_parent: Path,
    timeout_seconds: int,
) -> tuple[list[dict[str, Any]], str]:
    runner = _load_coding_runner(tasks_dir)
    harness = _selected_harness()
    provider = os.environ.get("BENCHMARK_MODEL_PROVIDER", "cerebras").strip()
    model = (
        os.environ.get("BENCHMARK_MODEL_NAME")
        or os.environ.get("MODEL_NAME")
        or "gemma-4-31b"
    ).strip()
    command_template = runner.agent_command_template(
        harness,
        provider=provider,
        model=model,
        timeout_seconds=timeout_seconds,
    )
    if not command_template:
        raise RuntimeError("App Eval coding runner returned no agent command template")

    output_parent.mkdir(parents=True, exist_ok=True)
    artifact_root = Path(
        tempfile.mkdtemp(prefix="app-eval-coding-", dir=str(output_parent))
    )
    trajectory_dir = artifact_root / "trajectories"
    results: list[dict[str, Any]] = []
    for task in tasks:
        task_started = time.perf_counter()
        try:
            raw_results = runner.run_agent_app_eval_coding(
                output_dir=artifact_root,
                trajectory_dir=trajectory_dir,
                tasks=[task],
                task_agent=harness,
                model_provider=provider,
                model=model,
                command_template=command_template,
                timeout_seconds=timeout_seconds,
                eval_timeout_seconds=120,
            )
            if not isinstance(raw_results, list) or len(raw_results) != 1:
                raise RuntimeError(
                    f"coding runner returned {len(raw_results) if isinstance(raw_results, list) else 'non-list'} "
                    f"results for task {task['id']!r}; expected exactly one"
                )
            raw = raw_results[0]
            if not isinstance(raw, dict):
                raise RuntimeError(
                    f"coding runner returned a non-object result for {task['id']!r}"
                )
        except Exception as exc:  # noqa: BLE001
            # error-policy:J1 Preserve a per-task infrastructure failure in the final nonzero summary.
            raw = {
                "success": False,
                "workspace_score": 0.0,
                "passed": 0,
                "failed": 1,
                "total": 1,
                "infrastructure_error": f"{type(exc).__name__}: {exc}",
            }
        results.append(
            _coding_summary_result(
                task,
                raw,
                duration_ms=int((time.perf_counter() - task_started) * 1000),
            )
        )
    return results, str(artifact_root)


def _mock_coding_result(task: dict[str, Any]) -> dict[str, Any]:
    task_id = str(task["id"])
    reason = "nonpublishable mock: coding workspace and hidden assertions were not executed"
    return {
        "id": task_id,
        "type": "coding",
        "response": "",
        "actions_taken": [],
        "duration_ms": 0,
        "success": False,
        "score": 0.0,
        "error": reason,
        "evaluation": {
            "task_id": task_id,
            "score": 0.0,
            "max_score": 10.0,
            "pass": False,
            "feedback": reason,
        },
        "workspace_execution": {"nonpublishable": True},
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run App Eval research and workspace coding tasks"
    )
    parser.add_argument("--tasks-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--type", choices=["research", "coding"], default=None)
    parser.add_argument("--task", default=None)
    parser.add_argument("--timeout-ms", type=int, default=120000)
    parser.add_argument("--mock", action="store_true", help="Return deterministic smoke responses without starting a harness")
    args = parser.parse_args()

    tasks = _load_tasks(Path(args.tasks_dir), args.type, args.task)
    if not tasks:
        raise SystemExit("no app-eval tasks matched filters")
    tasks_dir = Path(args.tasks_dir).resolve()
    provenance = _task_provenance(tasks_dir, args.type)
    research_tasks = [task for task in tasks if task["type"] == "research"]
    coding_tasks = [task for task in tasks if task["type"] == "coding"]
    evaluate_result = _load_evaluate_result(tasks_dir) if research_tasks else None
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc)
    results: list[dict[str, Any]] = []
    coding_artifact_root: str | None = None

    if args.mock:
        if evaluate_result is not None:
            for task in research_tasks:
                result: dict[str, Any] = {
                    "id": str(task.get("id") or "unknown"),
                    "type": "research",
                    "response": "mock app-eval response",
                    "actions_taken": [],
                    "duration_ms": 0,
                    "success": True,
                    "error": None,
                }
                evaluation = evaluate_result(task, result)
                result["score"] = float(evaluation["score"])
                result["evaluation"] = evaluation
                results.append(result)
        results.extend(_mock_coding_result(task) for task in coding_tasks)
    else:
        # Research stays on the shared message path; coding is deliberately
        # separated because only the workspace runner can execute files and
        # hidden assertions without leaking them into model context.
        if research_tasks:
            if evaluate_result is None:
                raise RuntimeError("research evaluator was not loaded")
            manager = ElizaServerManager()
            manager.start()
            client = manager.client
            try:
                results.extend(
                    _run_task(client, task, args.timeout_ms, evaluate_result)
                    for task in research_tasks
                )
            finally:
                manager.stop()
        if coding_tasks:
            coding_results, coding_artifact_root = _run_coding_tasks(
                tasks_dir,
                coding_tasks,
                output_parent=output.parent,
                timeout_seconds=max(1, args.timeout_ms // 1000),
            )
            results.extend(coding_results)

    completed_at = datetime.now(timezone.utc)
    result_ids = [str(result.get("id")) for result in results]
    expected_ids = [str(task["id"]) for task in tasks]
    if result_ids != expected_ids:
        raise RuntimeError(
            "app-eval result cohort does not exactly match the selected authored tasks: "
            f"expected {expected_ids}, received {result_ids}"
        )

    passed = sum(1 for result in results if result["success"] is True)
    timed_out = sum(
        1
        for result in results
        if "timeout" in str(result.get("error") or "").lower()
    )
    avg_duration = sum(int(result["duration_ms"]) for result in results) / len(results)
    overall = sum(float(result["score"]) for result in results) / len(results)
    infrastructure_failures = sum(
        1
        for result in results
        if result.get("infrastructure_error") is True
        or (
            isinstance(result.get("workspace_execution"), dict)
            and result["workspace_execution"].get("infrastructure_error")
        )
    )
    if args.mock and coding_tasks:
        mode = "mock-nonpublishable"
    elif research_tasks and coding_tasks:
        mode = "bridge+workspace"
    elif coding_tasks:
        mode = "workspace"
    else:
        mode = "mock" if args.mock else "bridge"
    publishable = not args.mock and infrastructure_failures == 0
    summary = {
        "run_id": started.isoformat(),
        "started_at": started.isoformat(),
        "completed_at": completed_at.isoformat(),
        "overall_score": overall,
        "total_tasks": len(results),
        "completed": passed,
        "failed": len(results) - passed - timed_out,
        "timed_out": timed_out,
        "avg_duration_ms": avg_duration,
        "mode": mode,
        "harness": _selected_harness(),
        "publishable": publishable,
        "infrastructure_failures": infrastructure_failures,
        "dataset_provenance": {
            **provenance,
            "execution_lanes": {
                "research": "native message response + authored research rubric",
                "coding": "materialized workspace + native captured bash + hidden assertions",
            },
        },
        "coding_artifact_root": coding_artifact_root,
        "scores": _score_groups(results),
        "results": results,
    }

    output.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    structural_mock_ok = args.mock and not coding_tasks
    return app_eval_exit_code(
        publishable=publishable, structural_mock_ok=structural_mock_ok
    )


if __name__ == "__main__":
    raise SystemExit(main())
