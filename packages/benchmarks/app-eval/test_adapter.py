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
            stdout='log line\n{\n  "id": "task-1",\n  "success": true,\n  "response": "ok"\n}\n',
            stderr="",
        )

    monkeypatch.setattr(adapter.subprocess, "run", fake_run)
    config = adapter.AppBenchmarkConfig(app_root=str(tmp_path))

    result = adapter.run_benchmark({"id": "task-1"}, config, str(tmp_path))

    assert result["id"] == "task-1"
    assert result["success"] is True


def test_run_benchmark_batch_marks_missing_results_failed(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    adapter = _load_adapter()

    def fake_run(*_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["bun"],
            returncode=1,
            stdout='{"id": "task-1", "success": true, "response": "ok"}\n',
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
