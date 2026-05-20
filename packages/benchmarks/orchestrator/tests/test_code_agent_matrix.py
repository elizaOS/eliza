from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmarks.orchestrator.code_agent_matrix import (
    CellResult,
    DEFAULT_ADAPTERS,
    DEFAULT_BENCHMARKS,
    build_previous_summary_comparison,
    build_head_to_head,
    build_benchmark_gate,
    build_coverage_gate,
    build_coverage_summary,
    build_improvement_queue,
    build_required_stats_gate,
    build_report_gate,
    build_token_evidence,
    build_run_config,
    build_cell,
    classify_failure,
    collect_outcome_metrics,
    collect_token_metrics,
    default_swe_bench_repo_cache_dir,
    find_latest_result,
    preflight_matrix,
    queue_cell_pairs,
    redact_text,
    render_markdown,
    main,
    parse_args,
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
        root=_root().parent,
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
        root=_root().parent,
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


def test_webshop_smoke_enables_spacy_stub(tmp_path: Path) -> None:
    cell = build_cell(
        root=_root(),
        run_root=tmp_path,
        benchmark="webshop",
        adapter="elizaos",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=True,
        no_docker=True,
    )

    assert cell.env_overrides["WEBSHOP_ALLOW_SPACY_STUB"] == "1"


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


def test_coverage_summary_reports_selected_and_deferred_benchmarks() -> None:
    coverage = build_coverage_summary(list(DEFAULT_BENCHMARKS))

    assert coverage["selection_complete"] is True
    assert coverage["status_counts"] == {
        "included": 6,
        "included_selected": 6,
        "included_unselected": 0,
        "deferred": 2,
    }
    assert coverage["unselected_included_benchmarks"] == []
    assert {item["benchmark"] for item in coverage["deferred_benchmarks"]} == {
        "swe_bench_multilingual",
        "nl2repo",
    }

    partial = build_coverage_summary(["swe_bench"])

    assert partial["selection_complete"] is False
    assert "terminal_bench" in partial["unselected_included_benchmarks"]


def test_coverage_gate_blocks_partial_benchmark_selection() -> None:
    complete_summary = {"coverage": build_coverage_summary(list(DEFAULT_BENCHMARKS))}
    partial_summary = {"coverage": build_coverage_summary(["swe_bench"])}

    assert build_coverage_gate(complete_summary)["ok"] is True
    partial_gate = build_coverage_gate(partial_summary)
    assert partial_gate["ok"] is False
    assert "terminal_bench" in partial_gate["blocking_benchmarks"]
    assert "nl2repo" in partial_gate["deferred_benchmarks"]


def test_report_gate_combines_coverage_benchmark_and_required_stats() -> None:
    ok_summary = {
        "coverage_gate": {"ok": True},
        "benchmark_gate": {"ok": True},
        "required_stats_gate": {"ok": True},
    }
    blocked_summary = {
        "coverage_gate": {"ok": False},
        "benchmark_gate": {"ok": True},
        "required_stats_gate": {"ok": False},
    }

    assert build_report_gate(ok_summary) == {
        "ok": True,
        "blocking_gates": [],
        "gate_status": {
            "coverage_gate": True,
            "benchmark_gate": True,
            "required_stats_gate": True,
        },
        "message": "benchmark report satisfies coverage, comparability, and required stats",
    }
    blocked = build_report_gate(blocked_summary)
    assert blocked["ok"] is False
    assert blocked["blocking_gates"] == ["benchmark coverage", "required stats"]
    assert blocked["gate_status"] == {
        "coverage_gate": False,
        "benchmark_gate": True,
        "required_stats_gate": False,
    }


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
    assert (
        classify_failure(
            exit_code=0,
            result_payload={"total_tasks": 1, "overall_accuracy": 1.0},
            stdout="",
            stderr="",
        )[0]
        == "pass"
    )


def test_collects_outcome_metrics_from_common_result_shapes() -> None:
    swe = collect_outcome_metrics(
        {"summary": {"total_instances": 5, "resolved": 3, "unresolved": 2, "resolve_rate": 0.6}}
    )
    terminal = collect_outcome_metrics(
        {"summary": {"total_tasks": 4, "passed_tasks": 4, "failed_tasks": 0, "accuracy": 1.0}}
    )
    browser = collect_outcome_metrics(
        {"total_trials": 10, "overall_task_success_rate": 0.7}
    )
    generic = collect_outcome_metrics({"results": [{"success": True}, {"success": False}]})
    accuracy_only = collect_outcome_metrics({"total_tasks": 2, "overall_accuracy": 0.75})
    reward_only = collect_outcome_metrics({"total_tasks": 2, "average_reward": 0.4})
    metrics_only = collect_outcome_metrics(
        {"metrics": {"overall_score": 0.625, "provider_scores": {"elizaos": 0.625}}}
    )
    detailed_partial = collect_outcome_metrics(
        {"results": [{"task_id": "a", "reward": 0.6}, {"task_id": "b", "score": 0.25}]}
    )
    osworld = collect_outcome_metrics(
        [
            {"task_id": "a", "score": 1.0},
            {"task_id": "b", "score": 0.0},
            {"task_id": "c", "score": 0.5},
        ]
    )

    assert swe == {"right": 3, "wrong": 2, "total": 5, "accuracy": 0.6}
    assert terminal == {"right": 4, "wrong": 0, "total": 4, "accuracy": 1.0}
    assert browser["total"] == 10
    assert browser["accuracy"] == 0.7
    assert generic == {"right": 1, "wrong": 1, "total": 2, "accuracy": 0.5}
    assert accuracy_only == {"right": 1.5, "wrong": 0.5, "total": 2, "accuracy": 0.75}
    assert reward_only == {"right": 0.8, "wrong": 1.2, "total": 2, "accuracy": 0.4}
    assert metrics_only == {"right": None, "wrong": None, "total": None, "accuracy": 0.625}
    assert detailed_partial == {"right": 0.85, "wrong": 1.15, "total": 2, "accuracy": 0.425}
    assert osworld == {"right": 1.5, "wrong": 1.5, "total": 3, "accuracy": 0.5}


def test_finds_osworld_nested_summary_result(tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    nested = output_dir / "computer_13" / "screenshot" / "model" / "summary"
    nested.mkdir(parents=True)
    result_path = nested / "results.json"
    result_path.write_text(json.dumps([{"task_id": "a", "score": 1.0}]), encoding="utf-8")
    (output_dir / "trace.json").write_text(json.dumps({"score": 0.0}), encoding="utf-8")

    assert find_latest_result(output_dir) == result_path


def test_collects_token_metrics_from_trajectory_files(tmp_path: Path) -> None:
    trajectory = tmp_path / "trajectory.jsonl"
    trajectory.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "prompt": "task",
                        "usage": {
                            "promptTokens": 100,
                            "completionTokens": 20,
                            "cachedTokens": 25,
                        },
                    }
                ),
                json.dumps(
                    {
                        "prompt": "task 2",
                        "usage": {
                            "prompt_tokens": 50,
                            "completion_tokens": 10,
                            "cache_creation_input_tokens": 5,
                        },
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    metrics = collect_token_metrics(tmp_path)

    assert metrics["input_tokens"] == 150
    assert metrics["output_tokens"] == 30
    assert metrics["total_tokens"] == 180
    assert metrics["cached_tokens"] == 25
    assert metrics["cache_creation_tokens"] == 5
    assert metrics["cached_token_percent"] == 25 / 150 * 100
    assert metrics["llm_call_count"] == 2


def test_collects_llm_call_count_from_nested_eliza_trajectory(tmp_path: Path) -> None:
    trajectory_dir = tmp_path / "trajectories"
    trajectory_dir.mkdir()
    (trajectory_dir / "trajectory-core.json").write_text(
        json.dumps(
            {
                "steps": [
                    {
                        "llmCalls": [
                            {
                                "promptTokens": 100,
                                "completionTokens": 20,
                                "cacheReadInputTokens": 30,
                            },
                            {
                                "promptTokens": 80,
                                "completionTokens": 10,
                                "cacheReadInputTokens": 0,
                            },
                        ]
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    metrics = collect_token_metrics(trajectory_dir)

    assert metrics["trajectory_turn_count"] == 1
    assert metrics["llm_call_count"] == 2
    assert metrics["input_tokens"] == 180
    assert metrics["output_tokens"] == 30
    assert metrics["cached_tokens"] == 30
    assert metrics["cached_token_percent"] == 30 / 180 * 100


def test_collects_token_metrics_from_opencode_parts(tmp_path: Path) -> None:
    trajectory_dir = tmp_path / "trajectories"
    trajectory_dir.mkdir()
    (trajectory_dir / "opencode-messages.json").write_text(
        json.dumps(
            {
                "messages": [
                    {
                        "role": "assistant",
                        "parts": [
                            {
                                "type": "step-finish",
                                "tokens": {
                                    "input": 120,
                                    "output": 30,
                                    "reasoning": 4,
                                    "cache": {"read": 40, "write": 8},
                                },
                            },
                            {
                                "type": "step-finish",
                                "tokens": {
                                    "input": 60,
                                    "output": 15,
                                    "reasoning": 0,
                                    "cache": {"read": 0, "write": 0},
                                },
                            },
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    metrics = collect_token_metrics(trajectory_dir)

    assert metrics["trajectory_turn_count"] == 1
    assert metrics["llm_call_count"] == 2
    assert metrics["input_tokens"] == 180
    assert metrics["output_tokens"] == 45
    assert metrics["total_tokens"] == 225
    assert metrics["cached_tokens"] == 40
    assert metrics["cache_creation_tokens"] == 8
    assert metrics["cached_token_percent"] == 40 / 180 * 100


def test_token_evidence_flags_missing_and_present_telemetry() -> None:
    present = _cell_result(
        benchmark="swe_bench",
        adapter="elizaos",
        right=1,
        wrong=0,
        input_tokens=100,
        output_tokens=20,
        cached_percent=10.0,
        llm_calls=2,
    )
    missing = CellResult(
        benchmark="swe_bench",
        adapter="opencode",
        status="succeeded",
        exit_code=0,
        duration_seconds=1.0,
        output_dir="/tmp/run/swe_bench/opencode/output",
        stdout_path="/tmp/run/swe_bench/opencode/stdout.log",
        stderr_path="/tmp/run/swe_bench/opencode/stderr.log",
        result_path="/tmp/run/swe_bench/opencode/output/result.json",
        failure_class="pass",
        outcome_metrics={"right": 1, "wrong": 0, "total": 1, "accuracy": 1.0},
        token_metrics={
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "llm_call_count": 0,
            "trajectory_file_count": 0,
        },
    )

    evidence = build_token_evidence([present, missing])
    summary = summarize_results([present, missing])
    markdown = render_markdown(summary)

    assert evidence["ok"] is False
    assert evidence["status_counts"] == {"present": 1, "empty": 0, "missing": 1}
    assert evidence["cells"][0]["status"] == "present"
    assert evidence["cells"][1]["status"] == "missing"
    assert summary["token_evidence"]["status_counts"]["missing"] == 1
    assert "## Token Evidence" in markdown
    assert "| swe_bench | opencode | missing | 0 | 0 | 0 | 0 |" in markdown


def test_run_config_records_mode_scope_and_enforcement_flags(tmp_path: Path) -> None:
    args = parse_args(
        [
            "--benchmarks",
            "swe_bench,webshop",
            "--adapters",
            "elizaos,opencode",
            "--provider",
            "cerebras",
            "--model",
            "gpt-oss-120b",
            "--smoke",
            "--no-docker",
            "--enforce-comparable",
            "--enforce-coverage",
            "--enforce-token-evidence",
            "--enforce-required-stats",
            "--enforce-report",
        ]
    )

    config = build_run_config(
        args,
        run_root=tmp_path / "run",
        cell_pairs=(
            ("webshop", "opencode"),
            ("swe_bench", "elizaos"),
        ),
    )
    markdown = render_markdown({"generated_at": "now", "total": 0, "run_config": config})

    assert config["mode"] == "smoke"
    assert config["benchmarks"] == ["swe_bench", "webshop"]
    assert config["adapters"] == ["elizaos", "opencode"]
    assert config["enforce_comparable"] is True
    assert config["enforce_coverage"] is True
    assert config["enforce_token_evidence"] is True
    assert config["enforce_required_stats"] is True
    assert config["enforce_report"] is True
    assert "## Run Config" in markdown
    assert "Mode: smoke" in markdown
    assert "Provider/model: cerebras/gpt-oss-120b" in markdown
    assert "Enforce coverage: True" in markdown
    assert "Enforce report: True" in markdown


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


def test_enforce_token_evidence_exits_nonzero_for_missing_smoke_telemetry(tmp_path: Path) -> None:
    code = main(
        [
            "--benchmarks",
            "webshop",
            "--smoke",
            "--no-docker",
            "--max-tasks",
            "1",
            "--run-root",
            str(tmp_path / "run"),
            "--force",
            "--timeout-seconds",
            "120",
            "--enforce-token-evidence",
        ]
    )

    summary = json.loads((tmp_path / "run" / "summary.json").read_text(encoding="utf-8"))
    assert code == 4
    assert summary["run_config"]["mode"] == "smoke"
    assert summary["run_config"]["enforce_token_evidence"] is True
    assert summary["benchmark_gate"]["ok"] is True
    assert summary["token_evidence"]["ok"] is False
    assert summary["token_evidence"]["status_counts"]["missing"] == 2


def test_enforce_coverage_exits_nonzero_for_partial_matrix(tmp_path: Path) -> None:
    code = main(
        [
            "--benchmarks",
            "webshop",
            "--smoke",
            "--no-docker",
            "--max-tasks",
            "1",
            "--run-root",
            str(tmp_path / "run"),
            "--force",
            "--timeout-seconds",
            "120",
            "--enforce-coverage",
        ]
    )

    summary = json.loads((tmp_path / "run" / "summary.json").read_text(encoding="utf-8"))
    assert code == 6
    assert summary["run_config"]["enforce_coverage"] is True
    assert summary["coverage_gate"]["ok"] is False
    assert "swe_bench" in summary["coverage_gate"]["blocking_benchmarks"]


def test_enforce_report_exits_nonzero_for_combined_gate_failure(tmp_path: Path) -> None:
    code = main(
        [
            "--benchmarks",
            "webshop",
            "--smoke",
            "--no-docker",
            "--max-tasks",
            "1",
            "--run-root",
            str(tmp_path / "run"),
            "--force",
            "--timeout-seconds",
            "120",
            "--enforce-report",
        ]
    )

    summary = json.loads((tmp_path / "run" / "summary.json").read_text(encoding="utf-8"))
    assert code == 7
    assert summary["run_config"]["enforce_report"] is True
    assert summary["benchmark_gate"]["ok"] is True
    assert summary["required_stats_gate"]["ok"] is True
    assert summary["coverage_gate"]["ok"] is False
    assert summary["report_gate"]["ok"] is False
    assert summary["report_gate"]["blocking_gates"] == ["benchmark coverage"]


def test_enforce_report_takes_precedence_over_individual_gate_codes(tmp_path: Path) -> None:
    code = main(
        [
            "--benchmarks",
            "webshop",
            "--smoke",
            "--no-docker",
            "--max-tasks",
            "1",
            "--run-root",
            str(tmp_path / "run"),
            "--force",
            "--timeout-seconds",
            "120",
            "--enforce-report",
            "--enforce-coverage",
        ]
    )

    summary = json.loads((tmp_path / "run" / "summary.json").read_text(encoding="utf-8"))
    assert code == 7
    assert summary["run_config"]["enforce_report"] is True
    assert summary["run_config"]["enforce_coverage"] is True
    assert summary["coverage_gate"]["ok"] is False
    assert summary["report_gate"]["blocking_gates"] == ["benchmark coverage"]


def test_queue_rerun_template_keeps_required_stats_but_omits_coverage(tmp_path: Path) -> None:
    code = main(
        [
            "--benchmarks",
            "webshop",
            "--smoke",
            "--dry-run",
            "--no-docker",
            "--max-tasks",
            "1",
            "--run-root",
            str(tmp_path / "run"),
            "--force",
            "--enforce-coverage",
            "--enforce-required-stats",
        ]
    )

    summary = json.loads((tmp_path / "run" / "summary.json").read_text(encoding="utf-8"))
    command = summary["improvement_queue"][0]["rerun_command_template"]
    assert code == 6
    assert summary["run_config"]["enforce_coverage"] is True
    assert summary["run_config"]["enforce_required_stats"] is True
    assert "--enforce-required-stats" in command
    assert "--enforce-coverage" not in command


def test_enforce_required_stats_exits_nonzero_for_missing_outcomes(tmp_path: Path) -> None:
    code = main(
        [
            "--benchmarks",
            "webshop",
            "--smoke",
            "--dry-run",
            "--no-docker",
            "--max-tasks",
            "1",
            "--run-root",
            str(tmp_path / "run"),
            "--force",
            "--enforce-required-stats",
        ]
    )

    summary = json.loads((tmp_path / "run" / "summary.json").read_text(encoding="utf-8"))
    assert code == 5
    assert summary["run_config"]["mode"] == "dry_run"
    assert summary["run_config"]["enforce_required_stats"] is True
    assert summary["required_stats_gate"]["ok"] is False
    assert summary["required_stats_gate"]["blocking_requirements"] == [
        "outcome_right_wrong_totals"
    ]


def test_enforce_required_stats_passes_for_no_llm_smoke_with_measured_outcomes(tmp_path: Path) -> None:
    code = main(
        [
            "--benchmarks",
            "webshop",
            "--smoke",
            "--no-docker",
            "--max-tasks",
            "1",
            "--run-root",
            str(tmp_path / "run"),
            "--force",
            "--timeout-seconds",
            "120",
            "--enforce-required-stats",
        ]
    )

    summary = json.loads((tmp_path / "run" / "summary.json").read_text(encoding="utf-8"))
    assert code == 0
    assert summary["run_config"]["mode"] == "smoke"
    assert summary["required_stats_gate"]["ok"] is True
    assert summary["required_stats_gate"]["token_evidence_required"] is False
    assert summary["token_evidence"]["ok"] is False


def test_preflight_reports_missing_provider_key_and_opencode_cli(tmp_path: Path) -> None:
    cell = build_cell(
        root=_root(),
        run_root=tmp_path,
        benchmark="terminal_bench",
        adapter="opencode",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=True,
        no_docker=True,
    )

    report = preflight_matrix(
        root=tmp_path,
        cells=[cell],
        provider="cerebras",
        env={},
    )

    assert report["ok"] is False
    assert report["provider_key"] == "CEREBRAS_API_KEY"
    assert report["provider_key_present"] is False
    assert report["provider_key_required"] is True
    assert {issue["kind"] for issue in report["issues"]} >= {
        "missing_provider_key",
        "missing_opencode_cli",
    }
    assert report["cells"][0]["benchmark"] == "terminal_bench"
    assert report["cells"][0]["executable_ok"] is True


def test_preflight_passes_with_required_provider_key_and_opencode_bin(tmp_path: Path) -> None:
    opencode_bin = tmp_path / "opencode"
    opencode_bin.write_text("#!/bin/sh\n", encoding="utf-8")
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

    report = preflight_matrix(
        root=tmp_path,
        cells=[cell],
        provider="cerebras",
        env={"CEREBRAS_API_KEY": "present", "OPENCODE_BIN": str(opencode_bin)},
    )

    assert report["ok"] is True
    assert report["issues"] == []
    assert report["opencode_bin"] == str(opencode_bin)


def test_preflight_can_skip_provider_key_for_smoke_or_dry_runs(tmp_path: Path) -> None:
    opencode_bin = tmp_path / "opencode"
    opencode_bin.write_text("#!/bin/sh\n", encoding="utf-8")
    cell = build_cell(
        root=_root().parent,
        run_root=tmp_path,
        benchmark="webshop",
        adapter="opencode",
        provider="cerebras",
        model="gpt-oss-120b",
        max_tasks=1,
        smoke=True,
        no_docker=True,
    )

    report = preflight_matrix(
        root=tmp_path,
        cells=[cell],
        provider="cerebras",
        require_provider_key=False,
        env={"OPENCODE_BIN": str(opencode_bin)},
    )

    assert report["ok"] is True
    assert report["provider_key"] == "CEREBRAS_API_KEY"
    assert report["provider_key_present"] is False
    assert report["provider_key_required"] is False
    assert report["issues"] == []


def test_smoke_preflight_cli_does_not_require_provider_key(tmp_path: Path) -> None:
    code = main(
        [
            "--benchmarks",
            "webshop",
            "--smoke",
            "--no-docker",
            "--max-tasks",
            "1",
            "--run-root",
            str(tmp_path / "run"),
            "--preflight",
        ]
    )

    assert code == 0


def test_live_cli_blocks_before_running_without_provider_key(tmp_path: Path) -> None:
    code = main(
        [
            "--benchmarks",
            "webshop",
            "--adapters",
            "elizaos",
            "--no-docker",
            "--max-tasks",
            "1",
            "--run-root",
            str(tmp_path / "run"),
        ]
    )

    assert code == 2
    assert not (tmp_path / "run" / "webshop" / "elizaos" / "cell-result.json").exists()
    assert not (tmp_path / "run" / "summary.json").exists()


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


def test_summarize_preserves_previous_live_mode_for_required_stats_gate(tmp_path: Path) -> None:
    for adapter in ("elizaos", "opencode"):
        cell_dir = tmp_path / "webshop" / adapter
        output_dir = cell_dir / "output"
        output_dir.mkdir(parents=True)
        (cell_dir / "command.json").write_text(
            json.dumps(
                {
                    "benchmark": "webshop",
                    "adapter": adapter,
                    "command": ["python", "-m", "benchmarks.webshop"],
                    "output_dir": str(output_dir),
                }
            ),
            encoding="utf-8",
        )
        (output_dir / "webshop-results.json").write_text(
            json.dumps({"total_tasks": 1, "success_rate": 1.0}),
            encoding="utf-8",
        )
    (tmp_path / "summary.json").write_text(
        json.dumps({"run_config": {"mode": "live"}}),
        encoding="utf-8",
    )

    code = main(
        [
            "--summarize",
            str(tmp_path),
            "--enforce-required-stats",
        ]
    )

    summary = json.loads((tmp_path / "summary.json").read_text(encoding="utf-8"))
    assert code == 5
    assert summary["run_config"]["mode"] == "live"
    assert summary["run_config"]["summarized_existing"] is True
    assert summary["benchmark_gate"]["ok"] is True
    assert summary["required_stats_gate"]["token_evidence_required"] is True
    assert summary["required_stats_gate"]["blocking_requirements"] == [
        "llm_token_telemetry"
    ]


def _cell_result(
    *,
    benchmark: str,
    adapter: str,
    right: int,
    wrong: int,
    input_tokens: int,
    output_tokens: int,
    cached_percent: float,
    llm_calls: int,
    output_dir: str = "/tmp/output",
    failure_class: str = "pass",
    notes: list[str] | None = None,
) -> CellResult:
    total = right + wrong
    return CellResult(
        benchmark=benchmark,
        adapter=adapter,
        status="succeeded",
        exit_code=0,
        duration_seconds=1.0,
        output_dir=output_dir,
        stdout_path="/tmp/stdout.log",
        stderr_path="/tmp/stderr.log",
        result_path="/tmp/result.json",
        failure_class=failure_class,
        notes=notes or [],
        score=right / total,
        outcome_metrics={
            "right": right,
            "wrong": wrong,
            "total": total,
            "accuracy": right / total,
        },
        token_metrics={
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            "cached_tokens": int(input_tokens * cached_percent / 100),
            "cache_creation_tokens": 0,
            "cached_token_percent": cached_percent,
            "llm_call_count": llm_calls,
            "trajectory_turn_count": llm_calls,
            "trajectory_file_count": 1,
        },
    )


def test_head_to_head_reports_inferior_and_token_deltas() -> None:
    results = [
        _cell_result(
            benchmark="terminal_bench",
            adapter="elizaos",
            right=3,
            wrong=1,
            input_tokens=1000,
            output_tokens=200,
            cached_percent=25.0,
            llm_calls=6,
        ),
        _cell_result(
            benchmark="terminal_bench",
            adapter="opencode",
            right=4,
            wrong=0,
            input_tokens=800,
            output_tokens=150,
            cached_percent=10.0,
            llm_calls=4,
        ),
    ]

    head_to_head = build_head_to_head(results)
    row = head_to_head["comparisons"][0]

    assert row["benchmark"] == "terminal_bench"
    assert row["status"] == "inferior"
    assert row["accuracy_delta"] == -0.25
    assert row["right_delta"] == -1
    assert row["total_token_delta"] == 250
    assert row["cached_token_percent_delta"] == 15.0
    assert row["llm_call_delta"] == 2
    assert head_to_head["inferior_benchmarks"] == ["terminal_bench"]


def test_required_stats_gate_requires_token_evidence_only_for_live_runs() -> None:
    results = [
        CellResult(
            benchmark="webshop",
            adapter="elizaos",
            status="succeeded",
            exit_code=0,
            duration_seconds=1.0,
            output_dir="/tmp/run/webshop/elizaos/output",
            stdout_path="/tmp/stdout.log",
            stderr_path="/tmp/stderr.log",
            result_path="/tmp/result.json",
            failure_class="pass",
            outcome_metrics={"right": 1, "wrong": 0, "total": 1, "accuracy": 1.0},
            token_metrics={
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "llm_call_count": 0,
                "trajectory_file_count": 0,
            },
        ),
        CellResult(
            benchmark="webshop",
            adapter="opencode",
            status="succeeded",
            exit_code=0,
            duration_seconds=1.0,
            output_dir="/tmp/run/webshop/opencode/output",
            stdout_path="/tmp/stdout.log",
            stderr_path="/tmp/stderr.log",
            result_path="/tmp/result.json",
            failure_class="pass",
            outcome_metrics={"right": 1, "wrong": 0, "total": 1, "accuracy": 1.0},
            token_metrics={
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "llm_call_count": 0,
                "trajectory_file_count": 0,
            },
        ),
    ]
    summary = summarize_results(results)

    live_gate = build_required_stats_gate(summary, mode="live")
    smoke_gate = build_required_stats_gate(summary, mode="smoke")

    assert summary["benchmark_gate"]["ok"] is True
    assert summary["token_evidence"]["ok"] is False
    assert live_gate["ok"] is False
    assert live_gate["blocking_requirements"] == ["llm_token_telemetry"]
    assert live_gate["token_evidence_required"] is True
    assert live_gate["token_blocking_cells"] == [
        {
            "benchmark": "webshop",
            "adapter": "elizaos",
            "status": "missing",
            "trajectory_dir": "/tmp/run/webshop/elizaos/trajectories",
            "note": "no trajectory artifacts or token usage found",
            "rerun_command_template": (
                "python -m benchmarks.orchestrator.code_agent_matrix "
                "--benchmarks webshop "
                "--adapters elizaos "
                "--force "
                "--enforce-required-stats"
            ),
        },
        {
            "benchmark": "webshop",
            "adapter": "opencode",
            "status": "missing",
            "trajectory_dir": "/tmp/run/webshop/opencode/trajectories",
            "note": "no trajectory artifacts or token usage found",
            "rerun_command_template": (
                "python -m benchmarks.orchestrator.code_agent_matrix "
                "--benchmarks webshop "
                "--adapters opencode "
                "--force "
                "--enforce-required-stats"
            ),
        },
    ]
    assert smoke_gate["ok"] is True
    assert smoke_gate["token_evidence_required"] is False
    assert smoke_gate["token_blocking_cells"] == []


def test_head_to_head_blocks_all_zero_comparable_results() -> None:
    results = [
        _cell_result(
            benchmark="webshop",
            adapter="elizaos",
            right=0,
            wrong=1,
            input_tokens=100,
            output_tokens=20,
            cached_percent=0.0,
            llm_calls=1,
            failure_class="tests_failed",
        ),
        _cell_result(
            benchmark="webshop",
            adapter="opencode",
            right=0,
            wrong=1,
            input_tokens=90,
            output_tokens=18,
            cached_percent=0.0,
            llm_calls=1,
            failure_class="tests_failed",
        ),
    ]

    summary = summarize_results(results)

    row = summary["head_to_head"]["comparisons"][0]
    assert row["status"] == "weak"
    assert summary["head_to_head"]["status_counts"]["weak"] == 1
    assert summary["benchmark_gate"]["ok"] is False
    assert summary["benchmark_gate"]["blocking_benchmarks"] == ["webshop"]
    assert summary["improvement_queue"][0]["priority"] == "p0"
    assert summary["improvement_queue"][0]["next_action"].startswith(
        "review benchmark evidence"
    )


def test_head_to_head_requires_measured_right_wrong_totals() -> None:
    results = [
        CellResult(
            benchmark="swe_bench",
            adapter="elizaos",
            status="succeeded",
            exit_code=0,
            duration_seconds=1.0,
            output_dir="/tmp/run/swe_bench/elizaos/output",
            stdout_path="/tmp/stdout.log",
            stderr_path="/tmp/stderr.log",
            result_path="/tmp/result.json",
            failure_class="pass",
            outcome_metrics={
                "right": None,
                "wrong": None,
                "total": None,
                "accuracy": 1.0,
            },
            token_metrics={
                "input_tokens": 100,
                "output_tokens": 20,
                "total_tokens": 120,
                "llm_call_count": 1,
                "trajectory_file_count": 1,
            },
        ),
        _cell_result(
            benchmark="swe_bench",
            adapter="opencode",
            right=1,
            wrong=0,
            input_tokens=90,
            output_tokens=18,
            cached_percent=0.0,
            llm_calls=1,
        ),
    ]

    summary = summarize_results(results)

    row = summary["head_to_head"]["comparisons"][0]
    assert row["status"] == "missing"
    assert summary["benchmark_gate"]["ok"] is False
    assert summary["benchmark_gate"]["blocking_benchmarks"] == ["swe_bench"]
    assert summary["improvement_queue"][0]["priority"] == "p1"
    gate = build_required_stats_gate(summary, mode="live")
    assert gate["outcome_blocking_benchmarks"] == ["swe_bench"]
    assert gate["outcome_blocking_comparisons"] == [
        {
            "benchmark": "swe_bench",
            "status": "missing",
            "target_accuracy": 1.0,
            "baseline_accuracy": 1.0,
            "target_total": None,
            "baseline_total": 1,
            "rerun_command_template": (
                "python -m benchmarks.orchestrator.code_agent_matrix "
                "--benchmarks swe_bench "
                "--adapters elizaos,opencode "
                "--force "
                "--enforce-required-stats"
            ),
        }
    ]


def test_improvement_queue_points_to_inferior_artifacts(tmp_path: Path) -> None:
    target_output = tmp_path / "run" / "terminal_bench" / "elizaos" / "output"
    target_trajectory = target_output.parent / "trajectories"
    target_trajectory.mkdir(parents=True)
    repeated_prompt = "shared-prefix " * 40
    (target_trajectory / "trajectory.jsonl").write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "prompt": repeated_prompt,
                        "usage": {
                            "promptTokens": 100,
                            "completionTokens": 20,
                            "cachedTokens": 50,
                        },
                    }
                ),
                json.dumps(
                    {
                        "prompt": repeated_prompt,
                        "usage": {
                            "promptTokens": 80,
                            "completionTokens": 10,
                            "cachedTokens": 20,
                        },
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    baseline_output = tmp_path / "run" / "terminal_bench" / "opencode" / "output"
    results = [
        _cell_result(
            benchmark="terminal_bench",
            adapter="elizaos",
            right=3,
            wrong=1,
            input_tokens=1000,
            output_tokens=200,
            cached_percent=25.0,
            llm_calls=6,
            output_dir=str(target_output),
            failure_class="tests_failed",
            notes=["benchmark item failures reported"],
        ),
        _cell_result(
            benchmark="terminal_bench",
            adapter="opencode",
            right=4,
            wrong=0,
            input_tokens=800,
            output_tokens=150,
            cached_percent=10.0,
            llm_calls=4,
            output_dir=str(baseline_output),
        ),
    ]
    head_to_head = build_head_to_head(results)

    queue = build_improvement_queue(results, head_to_head)

    assert len(queue) == 1
    item = queue[0]
    assert item["priority"] == "p0"
    assert item["benchmark"] == "terminal_bench"
    assert item["status"] == "inferior"
    assert item["primary_diagnosis"] == "target accuracy is below baseline"
    assert item["diagnosis"] == [
        "target accuracy is below baseline",
        "target failure class: tests_failed",
        "baseline trajectory telemetry is missing",
        "target repeated prompt prefixes need review",
        "target used more total tokens than baseline",
        "target made more LLM calls than baseline",
    ]
    assert item["rerun_command_template"] == (
        "python -m benchmarks.orchestrator.code_agent_matrix "
        "--rerun-queue {summary_json} "
        "--queue-priorities p0 "
        "--queue-statuses inferior "
        "--compare-summary {summary_json} "
        "--force"
    )
    assert item["target_failure_class"] == "tests_failed"
    assert item["target_notes"] == ["benchmark item failures reported"]
    assert item["target_artifacts"]["trajectory_dir"] == str(target_trajectory)
    assert item["baseline_artifacts"]["trajectory_dir"] == str(
        baseline_output.parent / "trajectories"
    )
    assert item["target_trajectory_review"]["trajectory_files"] == 1
    assert item["target_trajectory_review"]["turns"] == 2
    assert item["target_trajectory_review"]["input_tokens"] == 180
    assert item["target_trajectory_review"]["output_tokens"] == 30
    assert item["target_trajectory_review"]["cached_token_percent"] == 70 / 180 * 100
    assert item["target_trajectory_review"]["repeated_prefix_count"] > 0
    assert item["baseline_trajectory_review"]["review_notes"] == [
        "no trajectory files found",
        "no trajectory turns found",
        "no cached-token telemetry found",
    ]


def test_improvement_queue_rerun_command_preserves_run_config() -> None:
    results = [
        _cell_result(
            benchmark="terminal_bench",
            adapter="elizaos",
            right=0,
            wrong=1,
            input_tokens=100,
            output_tokens=20,
            cached_percent=0.0,
            llm_calls=1,
        ),
        _cell_result(
            benchmark="terminal_bench",
            adapter="opencode",
            right=1,
            wrong=0,
            input_tokens=100,
            output_tokens=20,
            cached_percent=0.0,
            llm_calls=1,
        ),
    ]
    head_to_head = build_head_to_head(results)

    queue = build_improvement_queue(
        results,
        head_to_head,
        run_config={
            "mode": "smoke",
            "provider": "cerebras",
            "model": "gpt-oss-120b",
            "max_tasks": 2,
            "timeout_seconds": 300,
            "no_docker": True,
            "enforce_coverage": True,
            "enforce_required_stats": True,
        },
    )

    assert queue[0]["rerun_command_template"] == (
        "python -m benchmarks.orchestrator.code_agent_matrix "
        "--rerun-queue {summary_json} "
        "--queue-priorities p0 "
        "--queue-statuses inferior "
        "--compare-summary {summary_json} "
        "--provider cerebras "
        "--model gpt-oss-120b "
        "--max-tasks 2 "
        "--timeout-seconds 300 "
        "--smoke "
        "--no-docker "
        "--enforce-required-stats "
        "--force"
    )
    assert "--enforce-coverage" not in queue[0]["rerun_command_template"]


def test_summary_and_markdown_include_outcome_token_and_head_to_head_metrics() -> None:
    results = [
        _cell_result(
            benchmark="swe_bench",
            adapter="elizaos",
            right=2,
            wrong=0,
            input_tokens=100,
            output_tokens=50,
            cached_percent=20.0,
            llm_calls=3,
        ),
        _cell_result(
            benchmark="swe_bench",
            adapter="opencode",
            right=1,
            wrong=1,
            input_tokens=200,
            output_tokens=25,
            cached_percent=5.0,
            llm_calls=4,
        ),
    ]

    summary = summarize_results(results)
    summary["required_stats_gate"] = build_required_stats_gate(summary, mode="live")
    summary["report_gate"] = build_report_gate(summary)
    markdown = render_markdown(summary)

    assert summary["outcome_by_adapter"]["elizaos"]["right"] == 2
    assert summary["token_by_adapter"]["opencode"]["output_tokens"] == 25
    assert summary["head_to_head"]["comparisons"][0]["status"] == "superior"
    assert summary["coverage"]["selection_complete"] is False
    assert "terminal_bench" in summary["coverage"]["unselected_included_benchmarks"]
    assert summary["coverage_gate"]["ok"] is False
    assert summary["benchmark_gate"]["ok"] is True
    assert summary["benchmark_gate"]["blocking_benchmarks"] == []
    assert summary["improvement_queue"] == []
    assert "## Benchmark Coverage" in markdown
    assert "Status: partial" in markdown
    assert "### Deferred Related Benchmarks" in markdown
    assert "## Report Gate" in markdown
    assert "Blocking gates: benchmark coverage" in markdown
    assert "## Coverage Gate" in markdown
    assert "Blocking benchmarks: mind2web, osworld, terminal_bench, visualwebbench, webshop" in markdown
    assert "## Benchmark Gate" in markdown
    assert "Status: ok" in markdown
    assert "## Required Stats Gate" in markdown
    assert "Token evidence required: True" in markdown
    assert "## ElizaOS vs OpenCode" in markdown
    assert "target input | baseline input | target output | baseline output" in markdown
    assert "| swe_bench | superior | 1.0000 | 0.5000 | 0.5000 | 2/0 | 1/1 | 100 | 200 | 50 | 25 | 150 | 225 | -75 | 20.00 | 5.00 | 15.00 | 3 | 4 | -1 |" in markdown
    assert "## Token Totals By Adapter" in markdown


def test_required_stats_markdown_lists_token_blocking_cells() -> None:
    results = [
        CellResult(
            benchmark="webshop",
            adapter="elizaos",
            status="succeeded",
            exit_code=0,
            duration_seconds=1.0,
            output_dir="/tmp/run/webshop/elizaos/output",
            stdout_path="/tmp/stdout.log",
            stderr_path="/tmp/stderr.log",
            result_path="/tmp/result.json",
            failure_class="pass",
            outcome_metrics={"right": 1, "wrong": 0, "total": 1, "accuracy": 1.0},
            token_metrics={
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "llm_call_count": 0,
                "trajectory_file_count": 0,
            },
        ),
        _cell_result(
            benchmark="webshop",
            adapter="opencode",
            right=1,
            wrong=0,
            input_tokens=100,
            output_tokens=25,
            cached_percent=10.0,
            llm_calls=1,
        ),
    ]

    summary = summarize_results(results)
    summary["required_stats_gate"] = build_required_stats_gate(summary, mode="live")
    markdown = render_markdown(summary)

    assert summary["required_stats_gate"]["ok"] is False
    assert summary["required_stats_gate"]["token_blocking_cells"] == [
        {
            "benchmark": "webshop",
            "adapter": "elizaos",
            "status": "missing",
            "trajectory_dir": "/tmp/run/webshop/elizaos/trajectories",
            "note": "no trajectory artifacts or token usage found",
            "rerun_command_template": (
                "python -m benchmarks.orchestrator.code_agent_matrix "
                "--benchmarks webshop "
                "--adapters elizaos "
                "--force "
                "--enforce-required-stats"
            ),
        }
    ]
    assert "| webshop | elizaos | missing | /tmp/run/webshop/elizaos/trajectories | no trajectory artifacts or token usage found | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks webshop --adapters elizaos --force --enforce-required-stats` |" in markdown


def test_required_stats_rerun_commands_preserve_run_config() -> None:
    results = [
        _cell_result(
            benchmark="webshop",
            adapter="elizaos",
            right=1,
            wrong=0,
            input_tokens=0,
            output_tokens=0,
            cached_percent=0.0,
            llm_calls=0,
        ),
        _cell_result(
            benchmark="webshop",
            adapter="opencode",
            right=1,
            wrong=0,
            input_tokens=100,
            output_tokens=25,
            cached_percent=10.0,
            llm_calls=1,
        ),
    ]

    summary = summarize_results(results)
    summary["run_config"] = {
        "mode": "live",
        "provider": "groq",
        "model": "openai/gpt-oss-120b",
        "max_tasks": 3,
        "timeout_seconds": 900,
        "no_docker": True,
        "enforce_comparable": True,
        "enforce_coverage": True,
    }

    gate = build_required_stats_gate(summary, mode="live")

    assert gate["token_blocking_cells"][0]["rerun_command_template"] == (
        "python -m benchmarks.orchestrator.code_agent_matrix "
        "--benchmarks webshop "
        "--adapters elizaos "
        "--provider groq "
        "--model openai/gpt-oss-120b "
        "--max-tasks 3 "
        "--timeout-seconds 900 "
        "--no-docker "
        "--enforce-comparable "
        "--force "
        "--enforce-required-stats"
    )
    assert "--enforce-coverage" not in gate["token_blocking_cells"][0]["rerun_command_template"]


def test_required_stats_markdown_lists_outcome_blocking_comparisons() -> None:
    results = [
        _cell_result(
            benchmark="terminal_bench",
            adapter="elizaos",
            right=1,
            wrong=1,
            input_tokens=100,
            output_tokens=20,
            cached_percent=0.0,
            llm_calls=1,
        ),
        _cell_result(
            benchmark="terminal_bench",
            adapter="opencode",
            right=2,
            wrong=0,
            input_tokens=90,
            output_tokens=18,
            cached_percent=0.0,
            llm_calls=1,
        ),
    ]

    summary = summarize_results(results)
    summary["required_stats_gate"] = build_required_stats_gate(summary, mode="live")
    markdown = render_markdown(summary)

    assert summary["required_stats_gate"]["outcome_blocking_comparisons"] == [
        {
            "benchmark": "terminal_bench",
            "status": "inferior",
            "target_accuracy": 0.5,
            "baseline_accuracy": 1.0,
            "target_total": 2,
            "baseline_total": 2,
            "rerun_command_template": (
                "python -m benchmarks.orchestrator.code_agent_matrix "
                "--benchmarks terminal_bench "
                "--adapters elizaos,opencode "
                "--force "
                "--enforce-required-stats"
            ),
        }
    ]
    assert "| terminal_bench | inferior | 0.5000 | 1.0000 | 2 | 2 | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks terminal_bench --adapters elizaos,opencode --force --enforce-required-stats` |" in markdown


def test_benchmark_gate_blocks_missing_and_inferior_benchmarks() -> None:
    summary = {
        "head_to_head": {
            "status_counts": {
                "superior": 0,
                "comparable": 1,
                "inferior": 1,
                "weak": 1,
                "missing": 1,
            },
            "comparisons": [
                {"benchmark": "swe_bench", "status": "comparable"},
                {"benchmark": "terminal_bench", "status": "inferior"},
                {"benchmark": "visualwebbench", "status": "weak"},
                {"benchmark": "webshop", "status": "missing"},
            ],
        }
    }

    gate = build_benchmark_gate(summary)

    assert gate["ok"] is False
    assert gate["blocking_benchmarks"] == [
        "terminal_bench",
        "visualwebbench",
        "webshop",
    ]
    assert gate["required_statuses"] == ["superior", "comparable"]


def test_previous_summary_comparison_tracks_elizaos_trends() -> None:
    previous = summarize_results(
        [
            _cell_result(
                benchmark="swe_bench",
                adapter="elizaos",
                right=1,
                wrong=1,
                input_tokens=100,
                output_tokens=50,
                cached_percent=5.0,
                llm_calls=4,
            ),
            _cell_result(
                benchmark="swe_bench",
                adapter="opencode",
                right=2,
                wrong=0,
                input_tokens=90,
                output_tokens=40,
                cached_percent=5.0,
                llm_calls=3,
            ),
        ]
    )
    current = summarize_results(
        [
            _cell_result(
                benchmark="swe_bench",
                adapter="elizaos",
                right=2,
                wrong=0,
                input_tokens=80,
                output_tokens=45,
                cached_percent=25.0,
                llm_calls=3,
            ),
            _cell_result(
                benchmark="swe_bench",
                adapter="opencode",
                right=2,
                wrong=0,
                input_tokens=90,
                output_tokens=40,
                cached_percent=5.0,
                llm_calls=3,
            ),
        ]
    )

    comparison = build_previous_summary_comparison(current, previous)
    current["previous_summary_comparison"] = comparison
    markdown = render_markdown(current)
    row = comparison["comparisons"][0]

    assert row["benchmark"] == "swe_bench"
    assert row["trend"] == "improved"
    assert row["previous_status"] == "inferior"
    assert row["current_status"] == "comparable"
    assert row["target_accuracy_delta"] == 0.5
    assert row["accuracy_delta_change"] == 0.5
    assert row["target_total_token_delta"] == -25
    assert row["target_cached_token_percent_delta"] == 20.0
    assert row["target_llm_call_delta"] == -1
    assert comparison["trend_counts"]["improved"] == 1
    assert "## Previous Summary Comparison" in markdown
    assert "| swe_bench | improved | inferior | comparable | 0.5000 | 0.5000 | -25 | 20.00 | -1 |" in markdown


def test_markdown_includes_missing_live_run_queue_items() -> None:
    results = [
        CellResult(
            benchmark="webshop",
            adapter="elizaos",
            status="dry_run",
            exit_code=None,
            duration_seconds=0.0,
            output_dir="/tmp/run/webshop/elizaos/output",
            stdout_path="/tmp/run/webshop/elizaos/stdout.log",
            stderr_path="/tmp/run/webshop/elizaos/stderr.log",
            result_path=None,
            failure_class="stopped_early",
            notes=["dry run only"],
            outcome_metrics={"right": None, "wrong": None, "total": None, "accuracy": None},
            token_metrics={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "llm_call_count": 0},
        ),
        CellResult(
            benchmark="webshop",
            adapter="opencode",
            status="dry_run",
            exit_code=None,
            duration_seconds=0.0,
            output_dir="/tmp/run/webshop/opencode/output",
            stdout_path="/tmp/run/webshop/opencode/stdout.log",
            stderr_path="/tmp/run/webshop/opencode/stderr.log",
            result_path=None,
            failure_class="stopped_early",
            notes=["dry run only"],
            outcome_metrics={"right": None, "wrong": None, "total": None, "accuracy": None},
            token_metrics={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "llm_call_count": 0},
        ),
    ]

    summary = summarize_results(results)
    markdown = render_markdown(summary)

    assert summary["improvement_queue"][0]["priority"] == "p1"
    assert summary["improvement_queue"][0]["next_action"].startswith("run live benchmark")
    assert summary["improvement_queue"][0]["primary_diagnosis"] == "missing comparable outcome evidence"
    assert "target failure class: stopped_early" in summary["improvement_queue"][0]["diagnosis"]
    assert summary["improvement_queue"][0]["rerun_command_template"] == (
        "python -m benchmarks.orchestrator.code_agent_matrix "
        "--rerun-queue {summary_json} "
        "--queue-priorities p1 "
        "--queue-statuses missing "
        "--compare-summary {summary_json} "
        "--force"
    )
    assert "## Improvement Queue" in markdown
    assert "| p1 | webshop | missing | missing comparable outcome evidence | run live benchmark" in markdown
    assert "### Queue Rerun Commands" in markdown
    assert "--queue-statuses missing" in markdown
    assert "### Trajectory Review Briefs" in markdown
    assert "| webshop | target | 0 | 0 | 0 | 0 |" in markdown


def test_queue_cell_pairs_extracts_exact_target_and_baseline_pairs() -> None:
    summary = {
        "improvement_queue": [
            {
                "benchmark": "terminal_bench",
                "priority": "p0",
                "status": "inferior",
                "target_artifacts": {
                    "output_dir": "/tmp/run/terminal_bench/elizaos/output"
                },
                "baseline_artifacts": {
                    "output_dir": "/tmp/run/terminal_bench/opencode/output"
                },
            },
            {
                "benchmark": "webshop",
                "priority": "p1",
                "status": "missing",
                "target_artifacts": {"output_dir": "/tmp/run/webshop/elizaos/output"},
                "baseline_artifacts": {"output_dir": "/tmp/run/webshop/opencode/output"},
            },
        ]
    }

    assert queue_cell_pairs(summary, priorities={"p0"}) == (
        ("terminal_bench", "elizaos"),
        ("terminal_bench", "opencode"),
    )
    assert queue_cell_pairs(summary, statuses={"missing"}) == (
        ("webshop", "elizaos"),
        ("webshop", "opencode"),
    )
    assert queue_cell_pairs(summary) == (
        ("terminal_bench", "elizaos"),
        ("terminal_bench", "opencode"),
        ("webshop", "elizaos"),
        ("webshop", "opencode"),
    )
