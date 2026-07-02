from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from benchmarks.orchestrator.viewer_server import _load_trajectories


def _write_canonical(
    path: Path,
    *,
    agent_id: str,
    benchmark_id: str,
    task_id: str,
    responses: list[str],
    start_step: int = 0,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for offset, response in enumerate(responses):
        step_index = start_step + offset
        rows.append(
            {
                "format": "eliza_native_v1",
                "boundary": "vercel_ai_sdk.generateText",
                "request": {
                    "messages": [
                        {
                            "role": "user",
                            "content": f"{agent_id} prompt {step_index}",
                        }
                    ]
                },
                "response": {
                    "text": response,
                    "toolCalls": [
                        {
                            "name": f"{agent_id}_tool",
                            "arguments": {"step": step_index},
                            "id": f"call_{step_index}",
                            "result": None,
                        }
                    ],
                },
                "agent_id": agent_id,
                "benchmark_id": benchmark_id,
                "task_id": task_id,
                "step_index": step_index,
            }
        )
    path.write_text(
        "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


def test_load_trajectories_includes_smithers_canonical_file(tmp_path: Path) -> None:
    workspace_root = tmp_path
    task_id = "smithers_woobench_20260702T100000Z_1_abc123"
    canonical_path = (
        workspace_root
        / "benchmarks"
        / "benchmark_results"
        / "rg_live"
        / "woobench"
        / task_id
        / "output"
        / "trajectory.canonical.jsonl"
    )
    _write_canonical(
        canonical_path,
        agent_id="smithers",
        benchmark_id="woobench",
        task_id=task_id,
        responses=["open order", "confirm checkout"],
    )

    payload = _load_trajectories(
        workspace_root,
        run_group_id="rg_live",
        benchmark_id="woobench",
        task_id=task_id,
    )

    assert set(payload["harnesses"]) == {"smithers"}
    assert payload["paths"]["smithers"] == str(canonical_path)
    assert payload["task_ids"]["smithers"] == [task_id]
    assert [row["step_index"] for row in payload["harnesses"]["smithers"]] == [0, 1]
    assert payload["harnesses"]["smithers"][1]["response"]["text"] == "confirm checkout"


def test_load_trajectories_includes_sibling_harness_run_ids(tmp_path: Path) -> None:
    workspace_root = tmp_path
    result_root = workspace_root / "benchmarks" / "benchmark_results"
    eliza_task_id = "run_woobench_20260702T100000Z_1_eliza"
    smithers_task_id = "run_woobench_20260702T100001Z_1_smithers"
    eliza_path = (
        result_root
        / "rg_live"
        / "woobench"
        / eliza_task_id
        / "output"
        / "trajectory.canonical.jsonl"
    )
    smithers_path = (
        result_root
        / "rg_live"
        / "woobench"
        / smithers_task_id
        / "output"
        / "trajectory.canonical.jsonl"
    )
    _write_canonical(
        eliza_path,
        agent_id="eliza",
        benchmark_id="woobench",
        task_id=eliza_task_id,
        responses=["eliza answer"],
    )
    _write_canonical(
        smithers_path,
        agent_id="smithers",
        benchmark_id="woobench",
        task_id=smithers_task_id,
        responses=["smithers answer"],
        start_step=2,
    )

    payload = _load_trajectories(
        workspace_root,
        run_group_id="rg_live",
        benchmark_id="woobench",
        task_id=eliza_task_id,
    )

    assert set(payload["harnesses"]) == {"eliza", "smithers"}
    assert payload["paths"]["eliza"] == str(eliza_path)
    assert payload["paths"]["smithers"] == str(smithers_path)
    assert payload["task_ids"]["eliza"] == [eliza_task_id]
    assert payload["task_ids"]["smithers"] == [smithers_task_id]
    assert payload["harnesses"]["smithers"][0]["step_index"] == 2
    assert payload["harnesses"]["smithers"][0]["response"]["text"] == "smithers answer"


def test_load_trajectories_augments_latest_random_v1_baseline(tmp_path: Path) -> None:
    workspace_root = tmp_path
    task_id = "eliza_bfcl_20260702T100000Z_1_abc123"
    result_root = workspace_root / "benchmarks" / "benchmark_results"
    eliza_path = (
        result_root
        / "rg_main"
        / "bfcl"
        / task_id
        / "output"
        / "trajectory.canonical.jsonl"
    )
    older_random_path = (
        result_root
        / "rg_random_old"
        / "bfcl"
        / "random_old"
        / "output"
        / "trajectory.canonical.jsonl"
    )
    latest_random_path = (
        result_root
        / "rg_random_new"
        / "bfcl"
        / "random_new"
        / "output"
        / "trajectory.canonical.jsonl"
    )
    _write_canonical(
        eliza_path,
        agent_id="eliza",
        benchmark_id="bfcl",
        task_id=task_id,
        responses=["real harness answer"],
    )
    _write_canonical(
        older_random_path,
        agent_id="random_v1",
        benchmark_id="bfcl",
        task_id="random_old",
        responses=["older random answer"],
    )
    _write_canonical(
        latest_random_path,
        agent_id="random_v1",
        benchmark_id="bfcl",
        task_id="random_new",
        responses=["latest random answer"],
    )
    os.utime(older_random_path, (100, 100))
    os.utime(latest_random_path, (200, 200))

    payload = _load_trajectories(
        workspace_root,
        run_group_id="rg_main",
        benchmark_id="bfcl",
        task_id=task_id,
    )

    assert set(payload["harnesses"]) == {"eliza", "random_v1"}
    assert payload["paths"]["random_v1"] == str(latest_random_path)
    assert payload["task_ids"]["random_v1"] == ["random_new"]
    assert payload["harnesses"]["random_v1"][0]["response"]["text"] == "latest random answer"
