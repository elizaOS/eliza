from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmarks.orchestrator.code_agent_matrix import (
    build_cell,
    classify_failure,
    redact_text,
    run_cell,
    summarize_existing,
    summarize_results,
)


def _root() -> Path:
    return Path(__file__).resolve().parents[3]


def test_builds_swe_bench_elizaos_cell_without_secret_values(tmp_path: Path) -> None:
    cell = build_cell(
        root=_root(),
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
    cell = build_cell(
        root=_root(),
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
            stdout="",
            stderr="",
        )[0]
        == "pass"
    )
    assert (
        classify_failure(
            exit_code=1,
            result_payload=None,
            stdout="401 unauthorized: missing API key",
            stderr="",
        )[0]
        == "auth_or_provider"
    )
    assert (
        classify_failure(
            exit_code=2,
            result_payload={"error": "[router] No provider registered for TEXT_LARGE"},
            stdout="",
            stderr="",
        )[0]
        == "auth_or_provider"
    )
    assert (
        classify_failure(
            exit_code=0,
            result_payload={"results": [{"patch_status": "not_generated"}]},
            stdout="",
            stderr="",
        )[0]
        == "no_patch"
    )
    assert (
        classify_failure(
            exit_code=0,
            result_payload={"results": [{"success": False, "status": "failed"}]},
            stdout="",
            stderr="",
        )[0]
        == "tests_failed"
    )
    assert (
        classify_failure(exit_code=124, result_payload=None, stdout="", stderr="timeout after model call")[0]
        == "timeout"
    )


def test_redacts_secret_values_from_logs() -> None:
    env = {
        "CEREBRAS_API_KEY": "super-secret-key-123456",
        "OTHER": "visible",
    }

    out = redact_text("token=abc123456789012345 CEREBRAS_API_KEY=super-secret-key-123456", env)

    assert "super-secret-key-123456" not in out
    assert "abc123456789012345" not in out
    assert "[REDACTED]" in out


def test_dry_run_writes_resumable_cell_result(tmp_path: Path) -> None:
    cell = build_cell(
        root=_root(),
        run_root=tmp_path,
        benchmark="swe_bench",
        adapter="opencode",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=True,
        no_docker=True,
    )

    first = run_cell(cell, dry_run=True, timeout_seconds=1)
    second = run_cell(cell, dry_run=True, timeout_seconds=1)

    assert first.status == "dry_run"
    assert second.resumed is True
    assert (Path(cell.output_dir).parent / "cell-result.json").exists()
    assert (Path(cell.output_dir).parent / "command.json").exists()


def test_summarizes_existing_run_artifacts(tmp_path: Path) -> None:
    cell_dir = tmp_path / "swe_bench" / "elizaos"
    output_dir = cell_dir / "output"
    output_dir.mkdir(parents=True)
    (cell_dir / "command.json").write_text(
        json.dumps(
            {
                "benchmark": "swe_bench",
                "adapter": "elizaos",
                "command": ["python", "-m", "benchmarks.swe_bench"],
                "output_dir": str(output_dir),
            }
        ),
        encoding="utf-8",
    )
    (output_dir / "orchestrated-test.json").write_text(
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
