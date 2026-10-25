from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest


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


@pytest.mark.parametrize("batch", [False, True])
def test_response_completion_is_not_a_task_grade(tmp_path: Path, batch: bool) -> None:
    raw = {
        "id": "failed-spawn",
        "success": True,
        "response": "Failed to spawn agent: spawn eliza-code-acp ENOENT",
        "actions_taken": ["TASKS"],
    }
    result = tmp_path / "result.json"
    result.write_text(json.dumps([raw] if batch else raw))
    with pytest.raises(ValueError, match="evaluated report"):
        _load_adapter().extract_score(str(result))


@pytest.mark.parametrize("score", [True, float("nan"), float("inf"), -1, 11])
def test_invalid_evaluated_scores_are_rejected(tmp_path: Path, score: float) -> None:
    result = tmp_path / "report.json"
    result.write_text(json.dumps({"overall_score": score, "total_tasks": 1}))
    with pytest.raises(ValueError, match="finite"):
        _load_adapter().extract_score(str(result))


@pytest.mark.parametrize("total", [0, -1, True, 1.5, None])
def test_missing_or_empty_evaluated_cohort_is_rejected(tmp_path: Path, total: object) -> None:
    result = tmp_path / "report.json"
    result.write_text(json.dumps({"overall_score": 10, "total_tasks": total}))
    with pytest.raises(ValueError, match="task count"):
        _load_adapter().extract_score(str(result))


@pytest.mark.parametrize("score", [0, 5, 10])
def test_evaluated_report_retains_its_grade(tmp_path: Path, score: float) -> None:
    result = tmp_path / "report.json"
    result.write_text(json.dumps({"overall_score": score, "total_tasks": 2}))
    assert _load_adapter().extract_score(str(result))["score"] == score / 10


@pytest.mark.parametrize("task_id,success,response,expected_positive", [
    ("code-001", False, "Failed to spawn agent: spawn eliza-code-acp ENOENT", False),
    ("research-001", True,
     "Proof-of-work validators are miners who compete using computation and energy. "
     "Proof-of-stake validators lock collateral and risk slashing for protocol violations. "
     "Security depends on attack costs and consensus assumptions in both systems. "
     "Proof-of-work has higher energy consumption; proof-of-stake needs less computational work. "
     "Decentralization depends on mining hardware and pool concentration versus stake distribution. "
     "Validator requirements differ: mining hardware and electricity versus staked capital and uptime.", True),
])
def test_evaluator_cli_report_handoff(
    tmp_path: Path, task_id: str, success: bool, response: str, expected_positive: bool
) -> None:
    root = next(
        parent for parent in Path(__file__).resolve().parents
        if (parent / "packages/benchmarks/suites/app-eval/evaluate.py").is_file()
    )
    results = tmp_path / "results"
    results.mkdir()
    (results / "task.json").write_text(json.dumps({
        "id": task_id, "success": success, "response": response,
    }))
    report = tmp_path / "evaluation.json"
    env = {**os.environ, "APP_EVAL_LLM_JUDGE": "0"}
    completed = subprocess.run(
        [sys.executable, str(root / "packages/benchmarks/suites/app-eval/evaluate.py"),
         str(results), "--output", str(report), "--format", "json"],
        env=env, capture_output=True, text=True, timeout=30,
    )
    assert completed.returncode == 0, completed.stderr
    evaluated = json.loads(report.read_text())
    extracted = _load_adapter().extract_score(str(report))
    assert evaluated["total_tasks"] == 1
    assert extracted["score"] == evaluated["overall_score"] / 10
    assert (extracted["score"] > 0) is expected_positive
