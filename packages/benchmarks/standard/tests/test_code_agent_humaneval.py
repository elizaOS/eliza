from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from benchmarks.orchestrator.code_agent_matrix import collect_outcome_metrics, collect_token_metrics
from benchmarks.standard.code_agent_humaneval import (
    agent_command_template,
    run_agent_humaneval,
)
from benchmarks.standard.humaneval import SMOKE_FIXTURES


def test_agent_command_template_uses_builtin_by_default(monkeypatch) -> None:
    monkeypatch.delenv("STANDARD_HUMANEVAL_AGENT_COMMAND_TEMPLATE", raising=False)
    monkeypatch.delenv("STANDARD_HUMANEVAL_AGENT_COMMAND_TEMPLATE_ELIZAOS", raising=False)
    monkeypatch.delenv("STANDARD_HUMANEVAL_DISABLE_BUILTIN_AGENT_COMMAND", raising=False)

    template = agent_command_template(
        "elizaos",
        provider="cerebras",
        model="gpt-oss-120b",
        timeout_seconds=30,
    )

    assert "packages/benchmarks/standard/agent_command.py" in template
    assert "--adapter elizaos" in template
    assert "{result_json}" in template


def test_run_agent_humaneval_scores_completion_and_writes_trajectory(tmp_path: Path) -> None:
    script = tmp_path / "agent.py"
    script.write_text(
        "\n".join(
            [
                "import json, pathlib, sys",
                "result = pathlib.Path(sys.argv[1])",
                "result.parent.mkdir(parents=True, exist_ok=True)",
                "result.write_text(json.dumps({",
                "  'status': 'completed',",
                "  'response_text': '    return a + b\\n',",
                "  'usage': {'calls': [",
                "    {'promptTokens': 20, 'completionTokens': 4, 'totalTokens': 24, 'cachedTokens': 5}",
                "  ]}",
                "}), encoding='utf-8')",
            ]
        ),
        encoding="utf-8",
    )

    results = run_agent_humaneval(
        output_dir=tmp_path / "out",
        trajectory_dir=tmp_path / "trajectories",
        examples=[dict(SMOKE_FIXTURES[0])],
        task_agent="elizaos",
        model_provider="cerebras",
        model="gpt-oss-120b",
        command_template=f"{sys.executable} {script} {{result_json}}",
        timeout_seconds=30,
        eval_timeout_seconds=10.0,
    )

    assert results[0]["success"] is True
    assert results[0]["passed"] == 1
    assert results[0]["token_metrics"]["input_tokens"] == 20
    assert Path(results[0]["trajectory_path"]).exists()
    token_metrics = collect_token_metrics(tmp_path / "trajectories")
    assert token_metrics["input_tokens"] == 20
    assert token_metrics["cached_token_percent"] == 25.0
    outcome = collect_outcome_metrics(
        {
            "summary": {
                "total_instances": 1,
                "resolved": 1,
                "unresolved": 0,
                "resolve_rate": 1.0,
            }
        }
    )
    assert outcome["right"] == 1
    assert outcome["wrong"] == 0


def test_code_agent_humaneval_expanded_mock_count(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "packages"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmarks.standard.code_agent_humaneval",
            "--output",
            str(tmp_path / "out"),
            "--max-tasks",
            "1",
            "--mock",
            "--expand-scenarios",
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
    assert payload["dataset_version"].endswith("+edge-v1")
    assert payload["summary"]["total_instances"] == 11
    assert payload["summary"]["resolved"] == 11
