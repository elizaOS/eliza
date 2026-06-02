from __future__ import annotations

import json
from pathlib import Path

from benchmarks.claw_eval_matrix.code_agent_matrix import (
    agent_command_template,
    count_tasks,
    expand_tasks,
    load_tasks,
    run_claw_eval_matrix,
    score_task,
    validate_tasks,
)


def test_load_tasks_selects_deterministic_coding_slice() -> None:
    tasks = load_tasks()

    assert len(tasks) >= 5
    assert {
        "T068zh_llama_w8a8_cuda_bug",
        "T070zh_js_async_generator_trace",
    }.issubset({task["task_id"] for task in tasks})
    assert all(
        ((component or {}).get("check") or {}).get("type") != "llm_judge"
        for task in tasks
        for component in task.get("scoring_components") or []
    )


def test_score_task_uses_yaml_keyword_components() -> None:
    task = next(
        task
        for task in load_tasks()
        if task["task_id"] == "T068zh_llama_w8a8_cuda_bug"
    )
    result = score_task(
        task,
        {
            "response_text": (
                "The int8 accumulator will overflow; use int32. Per-tensor "
                "quantization fails on LLaMA outlier activations, use "
                "per-channel. Improve coalesced loads with shared memory tiling."
            )
        },
    )

    assert result["score"] == 1.0
    assert result["grading_type"] == "deterministic_yaml"


def test_builtin_agent_command_template_points_at_helper() -> None:
    template = agent_command_template(
        "opencode",
        provider="cerebras",
        model="gpt-oss-120b",
        timeout_seconds=120,
    )

    assert "claw_eval_matrix/agent_command.py" in template
    assert "--adapter opencode" in template
    assert "--task-yaml" in template
    assert "{result_json}" in template


def test_expand_tasks_adds_ten_edge_variants_per_task() -> None:
    tasks = load_tasks(max_tasks=1)

    expanded = expand_tasks(tasks, expand_scenarios=True)

    assert count_tasks(tasks, expand_scenarios=True) == {"base": 1, "edge": 10, "total": 11}
    assert len(expanded) == 11
    assert expanded[0]["task_id"] == tasks[0]["task_id"]
    assert expanded[1]["task_id"].endswith("__edge_01")
    assert expanded[1]["source_task_id"] == tasks[0]["task_id"]
    assert expanded[1]["edge_condition"]
    assert validate_tasks(tasks, expand_scenarios=True)["valid"] is True


def test_mock_run_writes_normalized_result(tmp_path: Path) -> None:
    result = run_claw_eval_matrix(
        task_agent="elizaos",
        model_provider="cerebras",
        model="gpt-oss-120b",
        output_dir=tmp_path / "out",
        trajectory_dir=tmp_path / "traj",
        max_tasks=1,
        command_template="",
        timeout_seconds=120,
        mock=True,
        expand_scenarios=True,
        scenario_counts={"base": 1, "edge": 10, "total": 11},
    )

    assert result["benchmark"] == "claw_eval"
    assert result["adapter"] == "elizaos"
    assert result["scenario_counts"] == {"base": 1, "edge": 10, "total": 11}
    assert result["summary"]["total_instances"] == 11
    assert result["summary"]["resolved"] == 11
    json.dumps(result)


def test_mock_run_expands_to_requested_task_count_with_trajectories(tmp_path: Path) -> None:
    result = run_claw_eval_matrix(
        task_agent="elizaos",
        model_provider="cerebras",
        model="gpt-oss-120b",
        output_dir=tmp_path / "out",
        trajectory_dir=tmp_path / "traj",
        max_tasks=5,
        command_template="",
        timeout_seconds=120,
        mock=True,
    )

    assert result["summary"]["total_instances"] == 5
    assert result["summary"]["resolved"] == 5
    assert len(result["results"]) == 5
    assert all(Path(item["trajectory_path"]).exists() for item in result["results"])
