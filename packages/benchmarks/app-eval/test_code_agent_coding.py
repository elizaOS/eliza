from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

# `code_agent_coding` imports `benchmarks.*`, so put both the app-eval dir (for
# the module itself) and `packages/` (for the `benchmarks` package) on the path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from code_agent_coding import (  # noqa: E402
    agent_command_template,
    evaluate_workspace,
    load_tasks,
    run_agent_app_eval_coding,
)

# The real coding module, invoked by file path (the app-eval dir is hyphenated
# and therefore not importable via `python -m benchmarks.app_eval...`; the
# underscore import shim was removed in #9475).
_CODE_AGENT_CODING = str(Path(__file__).resolve().parent / "code_agent_coding.py")


def test_builtin_agent_command_template_points_at_helper(monkeypatch) -> None:
    monkeypatch.delenv("APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE", raising=False)
    monkeypatch.delenv("APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE_ELIZAOS", raising=False)
    monkeypatch.delenv("APP_EVAL_CODING_DISABLE_BUILTIN_AGENT_COMMAND", raising=False)

    template = agent_command_template(
        "elizaos",
        provider="cerebras",
        model="gpt-oss-120b",
        timeout_seconds=123,
    )

    assert "packages/benchmarks/app-eval/agent_command.py" in template
    assert "--workspace" in template
    assert "{result_json}" in template


def test_evaluate_workspace_checks_file_and_command_assertions(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    script = workspace / "hello.ts"
    script.write_text("console.log('hello')\n", encoding="utf-8")
    task = {
        "id": "code-local",
        "evaluation": {
            "test_assertions": [
                {"type": "file_exists", "target": "hello.ts", "expected": True},
                {"type": "file_contains", "target": "hello.ts", "expected": "hello"},
                {
                    "type": "command_output",
                    "target": f"{sys.executable} -c \"print('hello')\"",
                    "expected": "hello",
                },
            ]
        },
    }

    result = evaluate_workspace(task, workspace=workspace, timeout_seconds=10)

    assert result["success"] is True
    assert result["passed"] == 3
    assert result["total"] == 3


def test_run_agent_app_eval_coding_writes_results_and_token_metrics(tmp_path: Path) -> None:
    fake_agent = tmp_path / "fake_agent.py"
    fake_agent.write_text(
        "\n".join(
            [
                "import argparse, json, pathlib",
                "p = argparse.ArgumentParser()",
                "p.add_argument('--workspace')",
                "p.add_argument('--result-json')",
                "p.add_argument('--prompt')",
                "p.add_argument('--task')",
                "args = p.parse_args()",
                "pathlib.Path(args.workspace, 'src').mkdir(parents=True, exist_ok=True)",
                "pathlib.Path(args.workspace, 'src/answer.ts').write_text('export const answer = 42\\n')",
                "pathlib.Path(args.result_json).write_text(json.dumps({",
                "  'status': 'completed',",
                "  'usage': {'promptTokens': 10, 'completionTokens': 5, 'cachedTokens': 2},",
                "}))",
            ]
        ),
        encoding="utf-8",
    )
    task = {
        "id": "code-local",
        "prompt": "write src/answer.ts",
        "context": {"workspace": {"files": {"package.json": "{}"}}},
        "evaluation": {
            "test_assertions": [
                {"type": "file_exists", "target": "src/answer.ts", "expected": True},
                {"type": "file_contains", "target": "src/answer.ts", "expected": "answer"},
            ]
        },
    }

    results = run_agent_app_eval_coding(
        output_dir=tmp_path / "out",
        trajectory_dir=tmp_path / "traj",
        tasks=[task],
        task_agent="elizaos",
        model_provider="cerebras",
        model="gpt-oss-120b",
        command_template=(
            f"{sys.executable} {fake_agent} --workspace {{workspace}} "
            "--prompt {prompt} --task {task} --result-json {result_json}"
        ),
        timeout_seconds=10,
        eval_timeout_seconds=10,
    )

    assert results[0]["success"] is True
    assert results[0]["token_metrics"]["input_tokens"] == 10
    assert results[0]["token_metrics"]["cached_token_percent"] == 20.0
    assert Path(results[0]["trajectory_path"]).exists()


def test_cli_mock_outputs_matrix_summary(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "packages"
    completed = subprocess.run(
        [
            sys.executable,
            _CODE_AGENT_CODING,
            "--task-agent",
            "opencode",
            "--output",
            str(tmp_path / "out"),
            "--max-tasks",
            "1",
            "--mock",
            "--json",
        ],
        cwd=Path(__file__).resolve().parents[3],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["benchmark"] == "app_eval_coding"
    assert payload["summary"]["resolved"] == 1
    assert load_tasks(max_tasks=1)


def test_cli_expanded_count_and_validate(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "packages"
    completed = subprocess.run(
        [
            sys.executable,
            _CODE_AGENT_CODING,
            "--output",
            str(tmp_path / "out"),
            "--max-tasks",
            "1",
            "--expand-scenarios",
            "--count-scenarios",
            "--validate-scenarios",
        ],
        cwd=Path(__file__).resolve().parents[3],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == {"base": 1, "edge": 10, "total": 11}
    assert len(load_tasks(max_tasks=1, include_edge_scenarios=True)) == 11
