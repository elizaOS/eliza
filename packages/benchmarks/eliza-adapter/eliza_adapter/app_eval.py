"""App-eval runner backed by the eliza TypeScript benchmark server."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from eliza_adapter.client import ElizaClient
from eliza_adapter.server_manager import ElizaServerManager


def _load_tasks(tasks_dir: Path, task_type: str | None, task_id: str | None) -> list[dict[str, Any]]:
    files: list[tuple[Path, str]] = []
    if task_type in (None, "research"):
        files.append((tasks_dir / "research-tasks.json", "research"))
    if task_type in (None, "coding"):
        files.append((tasks_dir / "coding-tasks.json", "coding"))

    tasks: list[dict[str, Any]] = []
    for path, default_type in files:
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            continue
        for item in data:
            if not isinstance(item, dict):
                continue
            task = dict(item)
            task.setdefault("type", default_type)
            if task_id and str(task.get("id")) != task_id:
                continue
            tasks.append(task)
    return tasks


def _augment_prompt(task: dict[str, Any]) -> str:
    prompt = str(task.get("prompt") or "")
    task_type = str(task.get("type") or "research")
    if task_type == "coding":
        return (
            prompt
            + "\n\nWrite the complete code implementation directly in your response. "
            "Include imports, types, and error handling when relevant."
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


def _run_task(client: ElizaClient, task: dict[str, Any], timeout_ms: int) -> dict[str, Any]:
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
                "expected": task.get("expected"),
                "timeout_ms": timeout_ms,
            },
        )
        text = response.text or ""
        success = bool(text.strip())
        return {
            "id": task_id,
            "type": task_type,
            "response": text,
            "actions_taken": response.actions,
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "success": success,
            "score": 10.0 if success else 0.0,
            "error": None if success else "empty response",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "id": task_id,
            "type": task_type,
            "response": "",
            "actions_taken": [],
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "success": False,
            "score": 0.0,
            "error": str(exc),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run app-eval through the Eliza TS bridge")
    parser.add_argument("--tasks-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--type", choices=["research", "coding"], default=None)
    parser.add_argument("--task", default=None)
    parser.add_argument("--timeout-ms", type=int, default=120000)
    args = parser.parse_args()

    tasks = _load_tasks(Path(args.tasks_dir), args.type, args.task)
    if not tasks:
        raise SystemExit("no app-eval tasks matched filters")

    # Always start our own bench server so we control the bearer token. Reusing
    # a stray server from a prior benchmark leaves the client without auth and
    # every request fails with HTTP 401.
    manager = ElizaServerManager()
    manager.start()
    client = manager.client
    try:

        started = datetime.now(timezone.utc)
        results = [_run_task(client, task, args.timeout_ms) for task in tasks]
        completed = datetime.now(timezone.utc)
    finally:
        if manager is not None:
            manager.stop()

    passed = sum(1 for result in results if result["success"])
    timed_out = sum(1 for result in results if "timeout" in str(result.get("error") or "").lower())
    avg_duration = sum(int(result["duration_ms"]) for result in results) / len(results)
    overall = sum(float(result["score"]) for result in results) / len(results)
    summary = {
        "run_id": started.isoformat(),
        "started_at": started.isoformat(),
        "completed_at": completed.isoformat(),
        "overall_score": overall,
        "total_tasks": len(results),
        "completed": passed,
        "failed": len(results) - passed - timed_out,
        "timed_out": timed_out,
        "avg_duration_ms": avg_duration,
        "scores": _score_groups(results),
        "results": results,
    }

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
