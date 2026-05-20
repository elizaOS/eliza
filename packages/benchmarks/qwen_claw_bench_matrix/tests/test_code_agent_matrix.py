from __future__ import annotations

import json
from pathlib import Path

from benchmarks.qwen_claw_bench_matrix.code_agent_matrix import (
    agent_command_template,
    load_tasks,
    run_qwen_claw_bench_matrix,
)


def test_load_tasks_selects_automated_slice() -> None:
    tasks = load_tasks(max_tasks=5)

    assert [task.task_id for task in tasks] == [
        "task_00036_find_largest_file_in_downloads_directory"
    ]
    assert tasks[0].grading_type == "automated"


def test_builtin_agent_command_template_points_at_helper() -> None:
    template = agent_command_template(
        "elizaos",
        provider="cerebras",
        model="gpt-oss-120b",
        timeout_seconds=120,
    )

    assert "qwen_claw_bench_matrix/agent_command.py" in template
    assert "--adapter elizaos" in template
    assert "--workspace" in template
    assert "--task-path" in template
    assert "{result_json}" in template


def test_mock_run_writes_normalized_result(tmp_path: Path) -> None:
    result = run_qwen_claw_bench_matrix(
        task_agent="opencode",
        model_provider="cerebras",
        model="gpt-oss-120b",
        output_dir=tmp_path / "out",
        trajectory_dir=tmp_path / "traj",
        dataset="qwenclawbench-v1.1-100",
        max_tasks=1,
        command_template="",
        timeout_seconds=120,
        mock=True,
    )

    assert result["benchmark"] == "qwen_claw_bench"
    assert result["adapter"] == "opencode"
    assert result["summary"]["total_instances"] == 1
    assert result["summary"]["resolved"] == 1
    assert result["results"][0]["task"] == "task_00036_find_largest_file_in_downloads_directory"
    json.dumps(result)

