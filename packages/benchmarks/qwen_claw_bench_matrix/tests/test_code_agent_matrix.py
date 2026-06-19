from __future__ import annotations

import json
from pathlib import Path

from benchmarks.qwen_claw_bench_matrix.code_agent_matrix import (
    agent_command_template,
    count_tasks,
    expanded_task_ids,
    load_tasks,
    run_qwen_claw_bench_matrix,
    validate_tasks,
)


def test_load_tasks_selects_supported_slice_by_default() -> None:
    tasks = load_tasks(max_tasks=5)

    assert len(tasks) == 5
    assert all(task.grading_type in {"automated", "hybrid"} for task in tasks)


def test_load_tasks_can_select_automated_slice() -> None:
    tasks = load_tasks(max_tasks=5, grading_scope="automated")

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


def test_expanded_task_ids_add_ten_edge_variants() -> None:
    tasks = load_tasks(max_tasks=1, grading_scope="automated")

    expanded = expanded_task_ids(tasks, expand=True)

    assert count_tasks(tasks, expand=True) == {"base": 1, "edge": 10, "total": 11}
    assert len(expanded) == 11
    assert expanded[1]["task_id"].endswith("__edge_01")
    assert expanded[1]["source_task_id"] == tasks[0].task_id
    assert expanded[1]["edge_condition"]
    assert validate_tasks(tasks, expand=True)["valid"] is True


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
        grading_scope="automated",
        judge_model="gpt-oss-120b",
        judge_timeout_seconds=120,
        expand_scenarios=True,
        scenario_counts={"base": 1, "edge": 10, "total": 11},
    )

    assert result["benchmark"] == "qwen_claw_bench"
    assert result["adapter"] == "opencode"
    assert result["scenario_counts"] == {"base": 1, "edge": 10, "total": 11}
    assert result["summary"]["total_instances"] == 11
    assert result["summary"]["resolved"] == 11
    assert result["results"][0]["task"] == "task_00036_find_largest_file_in_downloads_directory"
    json.dumps(result)


def test_mock_run_expands_to_requested_task_count_with_trajectories(tmp_path: Path) -> None:
    result = run_qwen_claw_bench_matrix(
        task_agent="opencode",
        model_provider="cerebras",
        model="gpt-oss-120b",
        output_dir=tmp_path / "out",
        trajectory_dir=tmp_path / "traj",
        dataset="qwenclawbench-v1.1-100",
        max_tasks=5,
        command_template="",
        timeout_seconds=120,
        mock=True,
        grading_scope="supported",
        judge_model="gpt-oss-120b",
        judge_timeout_seconds=120,
    )

    assert result["summary"]["total_instances"] == 5
    assert result["summary"]["resolved"] == 5
    assert len(result["results"]) == 5
    assert all(Path(item["trajectory_path"]).exists() for item in result["results"])
