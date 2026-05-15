from __future__ import annotations

import json
from pathlib import Path

from benchmarks.orchestrator.code_agent_matrix import (
    build_cell,
    classify_failure,
    summarize_existing,
    summarize_results,
)


def test_builds_swe_bench_elizaos_cell_without_secret_values(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[3]
    cell = build_cell(
        root=root,
        run_root=tmp_path,
        benchmark="swe_bench",
        adapter="elizaos",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=2,
        smoke=False,
        no_docker=True,
    )

    assert cell.env_overrides["BENCHMARK_TASK_AGENT"] == "elizaos"
    assert cell.env_overrides["BENCHMARK_MODEL_PROVIDER"] == "cerebras"
    assert cell.env_overrides["BENCHMARK_MODEL_NAME"] == "gpt-oss-120b"
    assert "CEREBRAS_API_KEY" not in cell.env_overrides
    assert "--providers" in cell.command
    assert "elizaos" in cell.command
    assert "--no-docker" in cell.command
    assert "--max-instances" in cell.command


def test_builds_terminal_bench_cell_via_env_task_agent(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[3]
    cell = build_cell(
        root=root,
        run_root=tmp_path,
        benchmark="terminal_bench",
        adapter="opencode",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=True,
        no_docker=False,
    )

    assert cell.env_overrides["BENCHMARK_TASK_AGENT"] == "opencode"
    assert "--task-agent" in cell.command
    assert "opencode" in cell.command
    assert "--use-sample-tasks" in cell.command
    assert "--local-sandbox" in cell.command
    assert "--mock" in cell.command


def test_classifies_common_failure_shapes() -> None:
    assert (
        classify_failure(
            exit_code=0,
            result_payload={"summary": {"resolve_rate": 1.0}},
        )[0]
        == "pass"
    )
    assert (
        classify_failure(
            exit_code=1,
            result_payload=None,
            stderr="401 unauthorized: missing API key",
        )[0]
        == "auth_or_provider"
    )
    assert (
        classify_failure(
            exit_code=0,
            result_payload={"error": "timeout after model call"},
            stdout="[router] No provider registered for TEXT_LARGE",
        )[0]
        == "auth_or_provider"
    )
    assert (
        classify_failure(
            exit_code=0,
            result_payload={"results": [{"patch_status": "not_generated"}]},
        )[0]
        == "no_patch"
    )
    assert (
        classify_failure(
            exit_code=0,
            result_payload={"results": [{"test_exit_code": 1, "test_output": "failed"}]},
        )[0]
        == "tests_failed"
    )


def test_summarizes_existing_run_artifacts(tmp_path: Path) -> None:
    cell_dir = tmp_path / "swe_bench" / "elizaos"
    cell_dir.mkdir(parents=True)
    (cell_dir / "command.json").write_text(
        json.dumps(
            {
                "benchmark": "swe_bench",
                "adapter": "elizaos",
                "command": ["python", "-m", "benchmarks.swe_bench"],
            }
        ),
        encoding="utf-8",
    )
    (cell_dir / "orchestrated-test.json").write_text(
        json.dumps({"metrics": {"provider_scores": {"elizaos": 0.0}}}),
        encoding="utf-8",
    )

    results = summarize_existing(tmp_path)
    summary = summarize_results(results)

    assert len(results) == 1
    assert results[0].benchmark == "swe_bench"
    assert results[0].adapter == "elizaos"
    assert results[0].failure_class == "unknown_failure"
    assert summary["by_adapter"]["elizaos"]["unknown_failure"] == 1
