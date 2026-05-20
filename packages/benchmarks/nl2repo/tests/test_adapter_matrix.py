from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmarks.nl2repo.adapter_matrix import (
    NL2RepoTask,
    load_tasks,
    run_agent_generation,
    token_metrics_from_usage,
)
from benchmarks.orchestrator.code_agent_matrix import collect_token_metrics


def test_load_tasks_reads_canonical_metadata() -> None:
    tasks = load_tasks(max_tasks=1)

    assert len(tasks) == 1
    assert tasks[0].name
    assert tasks[0].prompt_md_path.endswith("/start.md")
    assert tasks[0].test_case_count > 0
    assert tasks[0].eval_image.endswith(f"/{tasks[0].name}:1.0")


def test_token_metrics_from_usage_sums_nested_calls() -> None:
    metrics = token_metrics_from_usage(
        {
            "calls": [
                {
                    "promptTokens": 100,
                    "completionTokens": 10,
                    "totalTokens": 110,
                    "cachedTokens": 20,
                    "cacheCreationInputTokens": 5,
                },
                {
                    "prompt_tokens": 50,
                    "completion_tokens": 15,
                    "total_tokens": 65,
                    "cache_read_input_tokens": 10,
                    "cache_creation_input_tokens": 2,
                },
            ]
        }
    )

    assert metrics["input_tokens"] == 150
    assert metrics["output_tokens"] == 25
    assert metrics["total_tokens"] == 175
    assert metrics["cached_tokens"] == 30
    assert metrics["cache_creation_tokens"] == 7
    assert metrics["cached_token_percent"] == 20.0
    assert metrics["llm_call_count"] == 2


def test_run_agent_generation_writes_result_and_reviewable_trajectory(
    tmp_path: Path,
) -> None:
    task_dir = tmp_path / "task"
    task_dir.mkdir()
    prompt = task_dir / "start.md"
    prompt.write_text("Build a package.", encoding="utf-8")
    task = NL2RepoTask(
        name="demo",
        prompt_md_path=str(prompt),
        test_commands=["pytest"],
        strip_paths=[],
        test_case_count=3,
        eval_image="example/demo:1.0",
    )
    script = tmp_path / "agent.py"
    script.write_text(
        "\n".join(
            [
                "import json, pathlib, sys",
                "result = pathlib.Path(sys.argv[1])",
                "result.parent.mkdir(parents=True, exist_ok=True)",
                "result.write_text(json.dumps({",
                "  'status': 'completed',",
                "  'usage': {'calls': [",
                "    {'promptTokens': 40, 'completionTokens': 6, 'totalTokens': 46, 'cachedTokens': 8},",
                "    {'promptTokens': 10, 'completionTokens': 4, 'totalTokens': 14, 'cachedTokens': 2},",
                "  ]},",
                "}), encoding='utf-8')",
            ]
        ),
        encoding="utf-8",
    )

    results = run_agent_generation(
        output_dir=tmp_path / "out",
        trajectory_dir=tmp_path / "trajectories",
        tasks=[task],
        task_agent="elizaos",
        model_provider="cerebras",
        model="gpt-oss-120b",
        command_template=f"{sys.executable} {script} {{result_json}}",
        timeout_seconds=30,
    )

    assert results[0]["status"] == "generated"
    assert results[0]["token_metrics"]["input_tokens"] == 50
    assert results[0]["token_metrics"]["output_tokens"] == 10
    assert results[0]["token_metrics"]["cached_token_percent"] == 20.0
    assert Path(results[0]["trajectory_path"]).exists()

    collected = collect_token_metrics(tmp_path / "trajectories")
    assert collected["input_tokens"] == 50
    assert collected["output_tokens"] == 10
    assert collected["cached_token_percent"] == 20.0
    assert collected["llm_call_count"] == 2
    assert collected["trajectory_turn_count"] == 1
    assert collected["trajectory_file_count"] == 1
