from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmarks.orchestrator.code_agent_matrix import (
    DEFAULT_ADAPTERS,
    DEFAULT_BENCHMARKS,
    build_cell,
    classify_failure,
    default_swe_bench_repo_cache_dir,
    redact_text,
    run_cell,
    summarize_existing,
    summarize_results,
    truncate_log_text,
)
from benchmarks.orchestrator.code_agent_coverage import (
    DEFERRED_STATUS,
    INCLUDED_STATUS,
    coverage_status_by_id,
    deferred_benchmark_ids,
    included_benchmark_ids,
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
    assert cell.env_overrides["SWE_BENCH_REPO_CACHE_DIR"] == str(
        default_swe_bench_repo_cache_dir()
    )
    assert "CEREBRAS_API_KEY" not in cell.env_overrides
    assert "--providers" in cell.command
    assert "elizaos" in cell.command
    assert "--no-docker" in cell.command
    assert "--max-instances" in cell.command


def test_swe_bench_repo_cache_dir_can_be_overridden(
    tmp_path: Path, monkeypatch
) -> None:
    cache_dir = tmp_path / "repo-cache"
    monkeypatch.setenv("SWE_BENCH_REPO_CACHE_DIR", str(cache_dir))

    cell = build_cell(
        root=_root(),
        run_root=tmp_path / "run",
        benchmark="swe_bench",
        adapter="opencode",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=False,
        no_docker=True,
    )

    assert cell.env_overrides["SWE_BENCH_REPO_CACHE_DIR"] == str(cache_dir)


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


def test_builds_browser_and_computer_use_cells(tmp_path: Path) -> None:
    mind2web = build_cell(
        root=_root(),
        run_root=tmp_path,
        benchmark="mind2web",
        adapter="opencode",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=True,
        no_docker=True,
    )
    visual = build_cell(
        root=_root(),
        run_root=tmp_path,
        benchmark="visualwebbench",
        adapter="opencode",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=True,
        no_docker=True,
    )
    webshop = build_cell(
        root=_root(),
        run_root=tmp_path,
        benchmark="webshop",
        adapter="opencode",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=True,
        no_docker=True,
    )
    osworld = build_cell(
        root=_root(),
        run_root=tmp_path,
        benchmark="osworld",
        adapter="opencode",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=True,
        no_docker=True,
    )

    assert mind2web.command[:3] == [sys.executable, "-m", "benchmarks.mind2web"]
    assert "--sample" in mind2web.command
    assert "--mock" in mind2web.command
    assert visual.command[:3] == [sys.executable, "-m", "benchmarks.visualwebbench"]
    assert "--use-sample-tasks" in visual.command
    assert "--mock" in visual.command
    assert webshop.command[:3] == [sys.executable, "-m", "elizaos_webshop"]
    assert "--use-sample-tasks" in webshop.command
    assert "--mock" in webshop.command
    assert "--bridge" not in webshop.command
    assert "run_multienv_eliza.py" in " ".join(osworld.command)
    assert "--dry_run" in osworld.command
    assert "--result_dir" in osworld.command


def test_builds_real_webshop_cell_with_bridge(tmp_path: Path) -> None:
    cell = build_cell(
        root=_root(),
        run_root=tmp_path,
        benchmark="webshop",
        adapter="elizaos",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=False,
        no_docker=True,
    )

    assert "--bridge" in cell.command
    assert "--mock" not in cell.command
    assert "--use-sample-tasks" not in cell.command


def test_default_matrix_covers_code_terminal_browser_and_computer_use() -> None:
    assert DEFAULT_ADAPTERS == ("elizaos", "opencode")
    assert DEFAULT_BENCHMARKS == included_benchmark_ids()
    assert DEFAULT_BENCHMARKS == (
        "swe_bench",
        "terminal_bench",
        "mind2web",
        "visualwebbench",
        "webshop",
        "osworld",
    )

    entries = coverage_status_by_id()
    for benchmark in DEFAULT_BENCHMARKS:
        assert entries[benchmark].status == INCLUDED_STATUS
        assert entries[benchmark].domains
        assert entries[benchmark].reason
    assert "swe_bench_multilingual" in deferred_benchmark_ids()
    assert entries["swe_bench_multilingual"].status == DEFERRED_STATUS


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
            exit_code=0,
            result_payload={
                "summary": {"resolve_rate": 0.6},
                "results": [{"success": False, "status": "not_generated"}],
            },
            stdout="",
            stderr="",
        )[0]
        == "no_patch"
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
        classify_failure(
            exit_code=0,
            result_payload={
                "results": [
                    {
                        "success": False,
                        "error": "Harness did not produce a report.json. Exit code=0",
                    }
                ]
            },
            stdout="",
            stderr="",
        )[0]
        == "harness_error"
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


def test_truncates_large_logs_from_the_tail() -> None:
    text = "prefix-secret\n" + ("x" * 200) + "\nimportant-tail"

    out = truncate_log_text(text, limit_bytes=100)

    assert "log truncated" in out
    assert "prefix-secret" not in out
    assert out.endswith("important-tail")


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
