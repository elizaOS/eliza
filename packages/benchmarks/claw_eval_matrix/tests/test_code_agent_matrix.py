from __future__ import annotations

import json
from pathlib import Path

from benchmarks.claw_eval_matrix.code_agent_matrix import (
    agent_command_template,
    load_tasks,
    run_claw_eval_matrix,
    score_task,
)


def test_load_tasks_selects_deterministic_coding_slice() -> None:
    tasks = load_tasks()

    assert [task["task_id"] for task in tasks] == [
        "T068zh_llama_w8a8_cuda_bug",
        "T070zh_js_async_generator_trace",
    ]
    assert all(task["category"] == "coding" for task in tasks)


def test_score_task_uses_yaml_keyword_components() -> None:
    task = load_tasks(max_tasks=1)[0]
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
    )

    assert result["benchmark"] == "claw_eval"
    assert result["adapter"] == "elizaos"
    assert result["summary"]["total_instances"] == 1
    assert result["summary"]["resolved"] == 1
    json.dumps(result)

