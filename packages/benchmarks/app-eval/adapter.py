"""
elizaOS app benchmark adapter for the benchmarks orchestrator.

This adapter allows the benchmarks suite to evaluate an elizaOS app agent
by invoking its ``benchmark`` CLI subcommand.

Usage:
    Copy this file to the elizaOS/benchmarks repo's orchestrator/adapters/
    directory, or add it to the adapter discovery path.

    The adapter expects the app repo root to be passed as
    ``app_root`` in the config, or set via the ``ELIZA_APP_ROOT``
    environment variable.  The legacy ``ELIZA_ROOT`` env var is
    also accepted for backwards compatibility.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


@dataclass
class AppBenchmarkConfig:
    """Configuration for running elizaOS app benchmarks."""

    app_root: str = ""
    model: str = "claude-sonnet-4-6"
    provider: str = "anthropic"
    timeout_seconds: int = 120
    server_mode: bool = False

    def __post_init__(self) -> None:
        if not self.app_root:
            self.app_root = (
                os.environ.get("ELIZA_APP_ROOT")
                or os.environ.get("ELIZA_ROOT")
                or ""
            )
        if not self.app_root:
            raise ValueError(
                "app_root must be set via config or ELIZA_APP_ROOT env var"
            )


def build_benchmark_command(
    task_file: str,
    config: AppBenchmarkConfig,
) -> list[str]:
    """Build the CLI command to run a benchmark task against the app agent."""
    root = Path(config.app_root)
    cmd = [
        "bun",
        "run",
        str(root / "packages" / "agent" / "src" / "bin.ts"),
        "benchmark",
        "--task",
        task_file,
        "--timeout",
        str(config.timeout_seconds * 1000),
    ]
    return cmd


def _build_env(config: AppBenchmarkConfig) -> dict[str, str]:
    """Build the subprocess environment, forwarding relevant API keys."""
    env = os.environ.copy()
    env["ELIZA_HEADLESS"] = "1"
    env["NODE_ENV"] = "production"
    if config.provider == "anthropic":
        env.setdefault("ANTHROPIC_API_KEY", os.environ.get("ANTHROPIC_API_KEY", ""))
    elif config.provider == "openai":
        env.setdefault("OPENAI_API_KEY", os.environ.get("OPENAI_API_KEY", ""))
    return env


def _parse_json_objects(text: str) -> list[dict[str, Any]]:
    """Extract JSON objects from mixed CLI stdout."""
    decoder = json.JSONDecoder()
    objects: list[dict[str, Any]] = []
    for index, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            parsed, _end = decoder.raw_decode(text, index)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            objects.append(parsed)
    return objects


def _failure_result(
    task: dict[str, Any],
    *,
    duration_ms: int,
    error: str,
) -> dict[str, Any]:
    return {
        "id": task.get("id", "unknown"),
        "response": "",
        "actions_taken": [],
        "duration_ms": duration_ms,
        "success": False,
        "error": error,
    }


def run_benchmark(
    task: dict[str, Any],
    config: AppBenchmarkConfig,
    output_dir: str,
) -> dict[str, Any]:
    """
    Run a single benchmark task against the app agent.

    Args:
        task: Task dictionary with 'id', 'prompt', and optional 'context'.
        config: App benchmark configuration.
        output_dir: Directory to write temporary task files.

    Returns:
        Result dictionary with 'id', 'response', 'actions_taken',
        'duration_ms', and 'success'.
    """
    task_file = Path(output_dir) / f"task-{task['id']}.json"
    task_file.parent.mkdir(parents=True, exist_ok=True)
    task_file.write_text(json.dumps(task))

    cmd = build_benchmark_command(str(task_file), config)
    env = _build_env(config)

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=config.timeout_seconds + 30,  # Extra buffer for startup
            env=env,
            cwd=config.app_root,
        )

        if result.returncode == 0:
            parsed = _parse_json_objects(result.stdout)
            if parsed:
                return parsed[-1]

            return {
                "id": task["id"],
                "response": result.stdout,
                "actions_taken": [],
                "duration_ms": 0,
                "success": False,
                "error": "No JSON result found in output",
            }
        else:
            return {
                "id": task["id"],
                "response": "",
                "actions_taken": [],
                "duration_ms": 0,
                "success": False,
                "error": (
                    f"Process exited with code {result.returncode}: "
                    f"{result.stderr[:500]}"
                ),
            }
    except subprocess.TimeoutExpired:
        return _failure_result(
            task,
            duration_ms=config.timeout_seconds * 1000,
            error="Timeout",
        )
    except Exception as e:
        return _failure_result(task, duration_ms=0, error=str(e))


def run_benchmark_batch(
    tasks: list[dict[str, Any]],
    config: AppBenchmarkConfig,
    output_dir: str,
) -> list[dict[str, Any]]:
    """
    Run multiple benchmark tasks using server mode for efficiency.

    Boots the runtime once and streams tasks via stdin.

    Args:
        tasks: List of task dictionaries.
        config: App benchmark configuration.
        output_dir: Directory to write temporary task files.

    Returns:
        List of result dictionaries.
    """
    root = Path(config.app_root)
    cmd = [
        "bun",
        "run",
        str(root / "packages" / "agent" / "src" / "bin.ts"),
        "benchmark",
        "--server",
        "--timeout",
        str(config.timeout_seconds * 1000),
    ]
    env = _build_env(config)

    # Total timeout: startup buffer + per-task timeout
    total_timeout = 60 + (config.timeout_seconds + 5) * len(tasks)

    try:
        stdin_data = "\n".join(json.dumps(t) for t in tasks) + "\n"
        result = subprocess.run(
            cmd,
            input=stdin_data,
            capture_output=True,
            text=True,
            timeout=total_timeout,
            env=env,
            cwd=config.app_root,
        )

        results = _parse_json_objects(result.stdout)
        seen_ids = {
            str(r.get("id"))
            for r in results
            if isinstance(r.get("id"), (str, int, float))
        }
        error_suffix = ""
        if result.returncode != 0:
            error_suffix = (
                f"Process exited with code {result.returncode}: "
                f"{result.stderr[:500]}"
            )
        for task in tasks:
            task_id = str(task.get("id", "unknown"))
            if task_id in seen_ids:
                continue
            results.append(
                _failure_result(
                    task,
                    duration_ms=0,
                    error=error_suffix or "No JSON result found in batch output",
                )
            )
        return results

    except subprocess.TimeoutExpired:
        return [
            _failure_result(
                t,
                duration_ms=config.timeout_seconds * 1000,
                error="Batch timeout",
            )
            for t in tasks
        ]
    except Exception as e:
        return [
            _failure_result(t, duration_ms=0, error=str(e))
            for t in tasks
        ]


def extract_score(result_path: str) -> dict[str, Any]:
    """
    Extract a normalized score from benchmark results.

    Compatible with the elizaOS benchmarks ScoreExtraction format.
    """
    with open(result_path) as f:
        data = json.load(f)

    if isinstance(data, list):
        total = len(data)
        passed = sum(1 for r in data if r.get("success"))
        score = passed / total if total > 0 else 0.0
        return {
            "score": score,
            "unit": "ratio",
            "higher_is_better": True,
            "metrics": {
                "total_tasks": total,
                "passed_tasks": passed,
                "failed_tasks": total - passed,
                "overall_success_rate": score,
            },
        }
    elif isinstance(data, dict):
        if isinstance(data.get("overall_score"), (int, float)):
            raw_score = float(data["overall_score"])
            score = max(0.0, min(raw_score / 10.0, 1.0))
            return {
                "score": score,
                "unit": "ratio",
                "higher_is_better": True,
                "metrics": {
                    "overall_score": raw_score,
                    "total_tasks": data.get("total_tasks", 0),
                    "completed": data.get("completed", 0),
                    "failed": data.get("failed", 0),
                    "timed_out": data.get("timed_out", 0),
                    "avg_duration_ms": data.get("avg_duration_ms", 0),
                },
            }

        return {
            "score": 1.0 if data.get("success") else 0.0,
            "unit": "ratio",
            "higher_is_better": True,
            "metrics": {
                "success": data.get("success", False),
                "duration_ms": data.get("duration_ms", 0),
                "actions_taken": len(data.get("actions_taken", [])),
            },
        }

    return {"score": 0.0, "unit": "ratio", "higher_is_better": True, "metrics": {}}


# Adapter registration for elizaOS benchmarks orchestrator
APP_EVAL_ADAPTER: dict[str, Any] = {
    "id": "app-eval",
    "display_name": "elizaOS App Agent",
    "description": "Evaluate an elizaOS app agent on benchmark tasks",
    "command_builder": build_benchmark_command,
    "runner": run_benchmark,
    "batch_runner": run_benchmark_batch,
    "score_extractor": extract_score,
    "required_env": [],
    "default_timeout_seconds": 120,
    "default_extra_config": {
        "model": "claude-sonnet-4-6",
        "provider": "anthropic",
    },
}
