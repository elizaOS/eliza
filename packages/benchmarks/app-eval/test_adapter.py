from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from typing import Any


def _load_adapter() -> Any:
    path = Path(__file__).resolve().parent / "adapter.py"
    spec = importlib.util.spec_from_file_location("app_eval_adapter", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_run_benchmark_parses_pretty_printed_json(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    adapter = _load_adapter()

    def fake_run(*_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["bun"],
            returncode=0,
            stdout=(
                'log line\n{\n  "id": "task-1",\n  "success": true,\n'
                '  "response": "ok",\n  "task_type": "research",\n'
                '  "actions_taken": [],\n'
                '  "duration_ms": 12\n}\n'
            ),
            stderr="",
        )

    monkeypatch.setattr(adapter.subprocess, "run", fake_run)
    config = adapter.AppBenchmarkConfig(app_root=str(tmp_path))

    result = adapter.run_benchmark({"id": "task-1"}, config, str(tmp_path))

    assert result["id"] == "task-1"
    assert result["success"] is True


def test_run_benchmark_ignores_json_shaped_logs(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    adapter = _load_adapter()

    def fake_run(*_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["bun"],
            returncode=0,
            stdout=(
                '{"id":"log-record","level":"info"}\n'
                '{"id":"task-1","response":"ok","task_type":"research",'
                '"actions_taken":[],'
                '"duration_ms":12,"success":true}\n'
                '{"id":"later-log","level":"debug"}\n'
            ),
            stderr="",
        )

    monkeypatch.setattr(adapter.subprocess, "run", fake_run)
    config = adapter.AppBenchmarkConfig(app_root=str(tmp_path))

    result = adapter.run_benchmark({"id": "task-1"}, config, str(tmp_path))

    assert result["id"] == "task-1"
    assert result["response"] == "ok"


def test_run_benchmark_ignores_another_tasks_valid_result(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    adapter = _load_adapter()

    def fake_run(*_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["bun"],
            returncode=0,
            stdout=(
                '{"id":"other","response":"wrong","task_type":"research",'
                '"actions_taken":[],'
                '"duration_ms":12,"success":true}\n'
            ),
            stderr="",
        )

    monkeypatch.setattr(adapter.subprocess, "run", fake_run)
    config = adapter.AppBenchmarkConfig(app_root=str(tmp_path))

    result = adapter.run_benchmark({"id": "task-1"}, config, str(tmp_path))

    assert result["id"] == "task-1"
    assert result["success"] is False
    assert result["error"] == "No JSON result found in output"


def test_benchmark_command_has_no_response_deadline(tmp_path: Path) -> None:
    adapter = _load_adapter()
    config = adapter.AppBenchmarkConfig(app_root=str(tmp_path))

    command = adapter.build_benchmark_command("task.json", config)

    assert command[-3:] == ["benchmark", "--task", "task.json"]
    assert "--timeout" not in command


def test_build_env_selects_cerebras_without_competing_openai(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    adapter = _load_adapter()
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-unrelated")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-unrelated")
    config = adapter.AppBenchmarkConfig(
        app_root=str(tmp_path),
        provider="Cerebras",
        model="gemma-4-31b",
    )

    env = adapter._build_env(config)

    assert env["CEREBRAS_API_KEY"] == "csk-test"
    assert env["CEREBRAS_MODEL"] == "gemma-4-31b"
    assert env["CEREBRAS_SMALL_MODEL"] == "gemma-4-31b"
    assert env["CEREBRAS_LARGE_MODEL"] == "gemma-4-31b"
    assert env["BENCHMARK_MODEL_PROVIDER"] == "cerebras"
    assert env["BENCHMARK_MODEL_NAME"] == "gemma-4-31b"
    assert "OPENAI_API_KEY" not in env
    assert "ANTHROPIC_API_KEY" not in env


def test_run_benchmark_batch_marks_missing_results_failed(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    adapter = _load_adapter()

    def fake_run(*_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["bun"],
            returncode=1,
            stdout=(
                '{"id":"task-1","success":true,"response":"ok",'
                '"task_type":"research",'
                '"actions_taken":[],"duration_ms":12}\n'
            ),
            stderr="server crashed",
        )

    monkeypatch.setattr(adapter.subprocess, "run", fake_run)
    config = adapter.AppBenchmarkConfig(app_root=str(tmp_path))

    results = adapter.run_benchmark_batch(
        [{"id": "task-1"}, {"id": "task-2"}],
        config,
        str(tmp_path),
    )

    by_id = {result["id"]: result for result in results}
    assert by_id["task-1"]["success"] is True
    assert by_id["task-2"]["success"] is False
    assert "Process exited with code 1" in by_id["task-2"]["error"]
