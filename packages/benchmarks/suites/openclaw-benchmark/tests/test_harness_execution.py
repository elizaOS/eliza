"""Exercises native-harness turn routing and full-run completeness accounting."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from openclaw import runner as execution_runner

PACKAGE_DIR = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "openclaw_benchmark_eliza_adapter", PACKAGE_DIR / "eliza_adapter.py"
)
assert SPEC and SPEC.loader
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)


class _FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def send_message(self, text: str, context: dict) -> SimpleNamespace:
        self.calls.append((text, context))
        index = len(self.calls)
        return SimpleNamespace(
            text=f"turn {index}",
            params={
                "tool_calls": [
                    {
                        "function": {
                            "name": "write",
                            "arguments": '{"path":"src/index.ts","content":"ok"}',
                        }
                    }
                ]
            },
        )


def test_harness_runner_calls_model_on_every_turn_with_real_task_history() -> None:
    runner = ADAPTER.HarnessExecutionRunner.__new__(ADAPTER.HarnessExecutionRunner)
    runner._client = _FakeClient()
    runner._scenario_name = "implementation"
    messages = [
        {"role": "system", "content": "sandbox instructions"},
        {"role": "user", "content": "implement the weather client"},
    ]

    first = runner.call_llm(messages)
    second = runner.call_llm(messages + [{"role": "user", "content": "tool results"}])

    assert len(runner._client.calls) == 2
    assert runner._client.calls[0][0] == "implement the weather client"
    assert runner._client.calls[0][1]["messages"] == messages
    assert runner._client.calls[0][1]["tools"] == ADAPTER._BENCHMARK_TOOLS
    assert '"tool": "write"' in first
    assert '"tool": "write"' in second


def test_run_all_marks_partial_execution_incomplete(monkeypatch) -> None:
    runner = ADAPTER.BenchmarkRunner.__new__(ADAPTER.BenchmarkRunner)
    runner.model = "test-model"
    runner.sandbox_config = object()
    runner._ordered_scenarios = lambda: ["one", "two"]

    def run_scenario(name: str, *, sandbox: object) -> dict:
        del sandbox
        if name == "two":
            raise RuntimeError("transport failed")
        return {"score": {"score": 1.0}}

    runner.run_scenario = run_scenario

    class _Sandbox:
        def __init__(self, _config: object) -> None:
            pass

        def __enter__(self) -> object:
            return object()

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setitem(ADAPTER.BenchmarkRunner.run_all.__globals__, "SandboxExecutor", _Sandbox)
    result = runner.run_all()

    assert result["expected_tasks"] == 2
    assert result["tasks_completed"] == 1
    assert result["failed_tasks"] == 1
    assert result["complete"] is False


def test_run_all_isolates_edge_cohorts_in_fresh_sandboxes(monkeypatch) -> None:
    runner = ADAPTER.BenchmarkRunner.__new__(ADAPTER.BenchmarkRunner)
    runner.model = "test-model"
    runner.sandbox_config = object()
    runner._ordered_scenarios = lambda: [
        "setup",
        "setup--edge-alpha",
        "implementation--edge-alpha",
        "setup--edge-beta",
    ]
    observed: list[tuple[str, object]] = []

    def run_scenario(name: str, *, sandbox: object) -> dict:
        observed.append((name, sandbox))
        return {"score": {"score": 1.0}}

    runner.run_scenario = run_scenario

    class _Sandbox:
        def __init__(self, _config: object) -> None:
            self.identity = object()

        def __enter__(self) -> object:
            return self.identity

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setitem(ADAPTER.BenchmarkRunner.run_all.__globals__, "SandboxExecutor", _Sandbox)
    result = runner.run_all()

    by_name = dict(observed)
    assert by_name["setup"] is not by_name["setup--edge-alpha"]
    assert by_name["setup--edge-alpha"] is by_name["implementation--edge-alpha"]
    assert by_name["setup--edge-alpha"] is not by_name["setup--edge-beta"]
    assert result["scenario_cohorts"] == 3
    assert result["complete"] is True


def test_scenario_step_exhaustion_is_not_scored(monkeypatch) -> None:
    runner = execution_runner.BenchmarkRunner.__new__(
        execution_runner.BenchmarkRunner
    )
    runner.model = "test-model"
    runner.tool_calls = []
    runner.executed_commands = []
    runner.sandbox_config = object()
    runner.load_scenario = lambda _name: {
        "name": "endless",
        "prompt": "Keep working.",
        "scoring": {"checks": [{"type": "response_contains", "pattern": "."}]},
    }
    runner.call_llm = lambda _messages: (
        '<tool_call>{"tool":"read","args":{"path":"x"}}</tool_call>'
    )
    runner.execute_tool = lambda _tool, _args, _sandbox: {"success": False}
    monkeypatch.setattr(execution_runner, "MAX_STEPS", 2)

    with pytest.raises(RuntimeError, match="exhausted 2 steps"):
        runner.run_scenario("endless", sandbox=object())


def test_runner_cli_does_not_write_partial_full_result(
    monkeypatch,
    tmp_path: Path,
) -> None:
    output_dir = tmp_path / "runner-output"

    class _PartialRunner:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def run_all(self) -> dict:
            return {
                "complete": False,
                "tasks": {"setup": {"score": {"score": 1.0}}},
                "tasks_completed": 1,
                "expected_tasks": 55,
                "failed_tasks": 54,
            }

    monkeypatch.setattr(execution_runner, "BenchmarkRunner", _PartialRunner)
    monkeypatch.setattr(
        sys,
        "argv",
        ["openclaw.runner", "--all", "--output-dir", str(output_dir)],
    )
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    with pytest.raises(RuntimeError, match="refusing to publish incomplete"):
        execution_runner.main()
    assert not output_dir.exists()


def test_adapter_cli_does_not_write_partial_full_result(
    monkeypatch,
    tmp_path: Path,
) -> None:
    output_dir = tmp_path / "adapter-output"

    class _PartialRunner:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def run_all(self) -> dict:
            return {
                "complete": False,
                "tasks": {"setup": {"score": {"score": 1.0}}},
                "tasks_completed": 1,
                "expected_tasks": 55,
                "failed_tasks": 54,
            }

    monkeypatch.setattr(ADAPTER, "BenchmarkRunner", _PartialRunner)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "eliza_adapter.py",
            "--all",
            "--mode",
            "execution",
            "--output-dir",
            str(output_dir),
        ],
    )
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    with pytest.raises(RuntimeError, match="refusing to publish incomplete"):
        ADAPTER.main()
    assert not output_dir.exists()
