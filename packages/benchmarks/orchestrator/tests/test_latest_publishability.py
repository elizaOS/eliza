from __future__ import annotations

import argparse
import json
from pathlib import Path

from benchmarks.orchestrator import cli
from benchmarks.orchestrator.latest_publishability import validate_latest_publishability


def _write_latest(latest_dir: Path, name: str, payload: dict) -> None:
    latest_dir.mkdir(parents=True, exist_ok=True)
    (latest_dir / name).write_text(
        json.dumps(payload, sort_keys=True),
        encoding="utf-8",
    )


def _write_code_agent_artifacts(tmp_path: Path) -> dict[str, str]:
    artifact_dir = tmp_path / "artifacts"
    target_trajectory_dir = artifact_dir / "target-trajectories"
    baseline_trajectory_dir = artifact_dir / "baseline-trajectories"
    target_trajectory_dir.mkdir(parents=True)
    baseline_trajectory_dir.mkdir(parents=True)
    (target_trajectory_dir / "trajectory.jsonl").write_text(
        json.dumps(
            {
                "prompt": "target prompt",
                "usage": {
                    "prompt_tokens": 70,
                    "completion_tokens": 30,
                    "cached_tokens": 7,
                    "llm_call_count": 2,
                },
            }
        ),
        encoding="utf-8",
    )
    (baseline_trajectory_dir / "trajectory.jsonl").write_text(
        json.dumps(
            {
                "prompt": "baseline prompt",
                "usage": {
                    "prompt_tokens": 90,
                    "completion_tokens": 30,
                    "cached_tokens": 9,
                    "llm_call_count": 3,
                },
            }
        ),
        encoding="utf-8",
    )
    paths = {
        "target_result_path": artifact_dir / "target-result.json",
        "baseline_result_path": artifact_dir / "baseline-result.json",
        "target_command_path": artifact_dir / "target-command.json",
        "baseline_command_path": artifact_dir / "baseline-command.json",
    }
    for path in paths.values():
        path.write_text("{}", encoding="utf-8")
    return {
        **{key: str(path) for key, path in paths.items()},
        "target_trajectory_dir": str(target_trajectory_dir),
        "baseline_trajectory_dir": str(baseline_trajectory_dir),
    }


def test_latest_publishability_allows_benign_sample_count_fields(tmp_path: Path) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "voicebench__eliza.json",
        {
            "benchmark_id": "voicebench",
            "agent": "eliza",
            "status": "succeeded",
            "score": 0.7,
            "metrics": {
                "sampleCount": 10,
                "total_samples": 10,
                "sample": False,
                "mock": False,
                "use_sample_tasks": False,
            },
            "publication_warnings": ["insufficient_total_samples"],
        },
    )
    _write_latest(latest_dir, "index.json", {"latest": {}})

    report = validate_latest_publishability(tmp_path)

    assert report.ok
    assert report.checked_files == 1


def test_latest_publishability_flags_structured_non_real_markers(tmp_path: Path) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "gaia__hermes.json",
        {
            "benchmark_id": "gaia",
            "agent": "hermes",
            "status": "succeeded",
            "score": 1.0,
            "metrics": {"dataset_source": "sample"},
            "extra_config": {"demo_mode": True},
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    reasons = {finding.reason for finding in report.findings}
    assert "sample_dataset_source" in reasons
    assert "truthy_non_real_flag" in reasons


def test_latest_publishability_flags_non_real_warnings_and_text(tmp_path: Path) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "tau_bench__openclaw.json",
        {
            "benchmark_id": "tau_bench",
            "agent": "openclaw",
            "status": "succeeded",
            "score": 1.0,
            "publication_warnings": ["sample_task_set"],
            "trajectory": [{"content": "Fallback used a bundled smoke task."}],
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    reasons = {finding.reason for finding in report.findings}
    assert "non_real_publication_warning" in reasons
    assert "non_real_text_marker:bundled smoke" in reasons


def test_latest_publishability_flags_unscored_latest_rows(tmp_path: Path) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "terminal_bench__hermes.json",
        {
            "benchmark_id": "terminal_bench",
            "agent": "hermes",
            "status": "failed",
            "score": None,
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    reasons = {finding.reason for finding in report.findings}
    assert "latest_row_not_succeeded" in reasons
    assert "latest_row_missing_numeric_score" in reasons


def test_latest_publishability_requires_code_agent_provenance_fields(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "swe_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "swe_bench",
            "agent": "elizaos",
            "status": "succeeded",
            "score": 1.0,
            "comparison_status": "comparable",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_accuracy": 1.0,
            "baseline_accuracy": 1.0,
            "accuracy_delta": 0.0,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 90,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 120,
            "baseline_cached_token_percent": 10.0,
            "baseline_llm_call_count": 3,
            "input_token_delta": -20,
            "output_token_delta": 0,
            "total_token_delta": -20,
            "llm_call_delta": -1,
            "cached_token_percent_delta": 0.0,
            "target_result_path": "/tmp/result.json",
            "baseline_result_path": "/tmp/baseline-result.json",
            "target_command_path": "/tmp/command.json",
            "baseline_command_path": "",
            "target_trajectory_dir": "/tmp/trajectories",
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    missing = {
        finding.path
        for finding in report.findings
        if finding.reason == "missing_code_agent_provenance_field"
    }
    assert missing == {
        "$.baseline_command_path",
        "$.baseline_trajectory_dir",
    }


def test_latest_publishability_detects_malformed_code_agent_row_by_filename(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "swe_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "swe_bench",
            "agent": "not-code-agent",
            "status": "succeeded",
            "score": 1.0,
            "mode": "live",
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    reasons = {finding.reason for finding in report.findings}
    assert "missing_code_agent_provenance_field" in reasons
    assert "missing_code_agent_numeric_stat" in reasons
    assert "code_agent_not_comparable_or_better" in reasons


def test_latest_publishability_detects_malformed_code_agent_row_by_agent(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "swe_bench__custom.json",
        {
            "benchmark_id": "swe_bench",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": 1.0,
            "mode": "live",
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    reasons = {finding.reason for finding in report.findings}
    assert "missing_code_agent_provenance_field" in reasons
    assert "missing_code_agent_numeric_stat" in reasons
    assert "code_agent_not_comparable_or_better" in reasons


def test_latest_publishability_accepts_complete_code_agent_provenance_fields(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    artifacts = _write_code_agent_artifacts(tmp_path)
    _write_latest(
        latest_dir,
        "swe_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "swe_bench",
            "agent": "elizaos",
            "status": "succeeded",
            "score": 1.0,
            "mode": "live",
            "comparison_status": "comparable",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_accuracy": 1.0,
            "baseline_accuracy": 1.0,
            "accuracy_delta": 0.0,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 90,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 120,
            "baseline_cached_token_percent": 10.0,
            "baseline_llm_call_count": 3,
            "input_token_delta": -20,
            "output_token_delta": 0,
            "total_token_delta": -20,
            "llm_call_delta": -1,
            "cached_token_percent_delta": 0.0,
            **artifacts,
            "coverage_gate_ok": True,
            "benchmark_gate_ok": True,
            "required_stats_gate_ok": True,
            "efficiency_gate_ok": True,
            "quality_guardrail_gate_ok": True,
            "trajectory_review_gate_ok": True,
            "live_report_gate_ok": True,
            "report_gate_ok": True,
            "release_readiness_ok": True,
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert report.ok


def test_latest_publishability_rejects_mislabeled_code_agent_comparison_status(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    artifacts = _write_code_agent_artifacts(tmp_path)
    _write_latest(
        latest_dir,
        "swe_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "swe_bench",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": 1.0,
            "mode": "live",
            "comparison_status": "superior",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_accuracy": 1.0,
            "baseline_accuracy": 1.0,
            "accuracy_delta": 0.0,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 90,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 120,
            "baseline_cached_token_percent": 10.0,
            "baseline_llm_call_count": 3,
            "input_token_delta": -20,
            "output_token_delta": 0,
            "total_token_delta": -20,
            "llm_call_delta": -1,
            "cached_token_percent_delta": 0.0,
            **artifacts,
            "coverage_gate_ok": True,
            "benchmark_gate_ok": True,
            "required_stats_gate_ok": True,
            "efficiency_gate_ok": True,
            "quality_guardrail_gate_ok": True,
            "trajectory_review_gate_ok": True,
            "live_report_gate_ok": True,
            "report_gate_ok": True,
            "release_readiness_ok": True,
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    assert any(
        finding.reason == "code_agent_comparison_status_mismatch"
        and finding.path == "$.comparison_status"
        and '"expected_status": "comparable"' in finding.value
        for finding in report.findings
    )


def test_latest_publishability_requires_existing_code_agent_provenance_artifacts(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    missing_result = tmp_path / "artifacts" / "missing-result.json"
    wrong_type_trajectory = tmp_path / "artifacts" / "trajectory-file"
    wrong_type_trajectory.parent.mkdir(parents=True)
    wrong_type_trajectory.write_text("not a directory", encoding="utf-8")
    _write_latest(
        latest_dir,
        "swe_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "swe_bench",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": 1.0,
            "mode": "live",
            "comparison_status": "superior",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 60,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 90,
            "baseline_cached_token_percent": 15.0,
            "baseline_llm_call_count": 1,
            "total_token_delta": 0,
            "llm_call_delta": 0,
            "cached_token_percent_delta": 0.0,
            "target_result_path": str(missing_result),
            "baseline_result_path": str(wrong_type_trajectory),
            "target_command_path": str(wrong_type_trajectory),
            "baseline_command_path": str(wrong_type_trajectory),
            "target_trajectory_dir": str(wrong_type_trajectory),
            "baseline_trajectory_dir": str(tmp_path / "missing-trajectories"),
            "coverage_gate_ok": True,
            "benchmark_gate_ok": True,
            "required_stats_gate_ok": True,
            "efficiency_gate_ok": True,
            "quality_guardrail_gate_ok": True,
            "trajectory_review_gate_ok": True,
            "live_report_gate_ok": True,
            "report_gate_ok": True,
            "release_readiness_ok": True,
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    missing = {
        finding.path
        for finding in report.findings
        if finding.reason == "missing_code_agent_provenance_artifact"
    }
    wrong_type = {
        finding.path
        for finding in report.findings
        if finding.reason == "wrong_type_code_agent_provenance_artifact"
    }
    assert missing == {"$.target_result_path", "$.baseline_trajectory_dir"}
    assert wrong_type == {"$.target_trajectory_dir"}


def test_latest_publishability_rejects_empty_code_agent_trajectory_dirs(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    artifacts = _write_code_agent_artifacts(tmp_path)
    empty_trajectory_dir = tmp_path / "artifacts" / "empty-trajectories"
    empty_trajectory_dir.mkdir()
    artifacts["target_trajectory_dir"] = str(empty_trajectory_dir)
    _write_latest(
        latest_dir,
        "webshop__elizaos_vs_opencode.json",
        {
            "benchmark_id": "webshop",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": 1.0,
            "mode": "live",
            "comparison_status": "superior",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 90,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 120,
            "baseline_cached_token_percent": 10.0,
            "baseline_llm_call_count": 3,
            "total_token_delta": -20,
            "llm_call_delta": -1,
            "cached_token_percent_delta": 0.0,
            **artifacts,
            "coverage_gate_ok": True,
            "benchmark_gate_ok": True,
            "required_stats_gate_ok": True,
            "efficiency_gate_ok": True,
            "quality_guardrail_gate_ok": True,
            "trajectory_review_gate_ok": True,
            "live_report_gate_ok": True,
            "report_gate_ok": True,
            "release_readiness_ok": True,
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    assert any(
        finding.reason == "empty_code_agent_trajectory_dir"
        and finding.path == "$.target_trajectory_dir"
        for finding in report.findings
    )


def test_latest_publishability_requires_parseable_code_agent_trajectory_telemetry(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    artifacts = _write_code_agent_artifacts(tmp_path)
    invalid_trajectory_dir = tmp_path / "artifacts" / "invalid-trajectories"
    invalid_trajectory_dir.mkdir()
    (invalid_trajectory_dir / "trajectory.jsonl").write_text(
        json.dumps({"turn": 1, "role": "assistant"}),
        encoding="utf-8",
    )
    artifacts["target_trajectory_dir"] = str(invalid_trajectory_dir)
    _write_latest(
        latest_dir,
        "terminal_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "terminal_bench",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": 1.0,
            "mode": "live",
            "comparison_status": "superior",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 90,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 120,
            "baseline_cached_token_percent": 10.0,
            "baseline_llm_call_count": 3,
            "total_token_delta": -20,
            "llm_call_delta": -1,
            "cached_token_percent_delta": 0.0,
            **artifacts,
            "coverage_gate_ok": True,
            "benchmark_gate_ok": True,
            "required_stats_gate_ok": True,
            "efficiency_gate_ok": True,
            "quality_guardrail_gate_ok": True,
            "trajectory_review_gate_ok": True,
            "live_report_gate_ok": True,
            "report_gate_ok": True,
            "release_readiness_ok": True,
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    reasons = {
        finding.reason
        for finding in report.findings
        if finding.path == "$.target_trajectory_dir"
    }
    assert {
        "unparseable_code_agent_trajectory_dir",
        "missing_code_agent_trajectory_input_tokens",
        "missing_code_agent_trajectory_output_tokens",
        "missing_code_agent_trajectory_llm_calls",
        "missing_code_agent_trajectory_cached_tokens",
    }.issubset(reasons)


def test_latest_publishability_rejects_trajectory_metric_mismatches(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    artifacts = _write_code_agent_artifacts(tmp_path)
    _write_latest(
        latest_dir,
        "mind2web__elizaos_vs_opencode.json",
        {
            "benchmark_id": "mind2web",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": 1.0,
            "mode": "live",
            "comparison_status": "superior",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_input_tokens": 999,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 90,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 120,
            "baseline_cached_token_percent": 10.0,
            "baseline_llm_call_count": 99,
            "total_token_delta": -20,
            "llm_call_delta": -1,
            "cached_token_percent_delta": 0.0,
            **artifacts,
            "coverage_gate_ok": True,
            "benchmark_gate_ok": True,
            "required_stats_gate_ok": True,
            "efficiency_gate_ok": True,
            "quality_guardrail_gate_ok": True,
            "trajectory_review_gate_ok": True,
            "live_report_gate_ok": True,
            "report_gate_ok": True,
            "release_readiness_ok": True,
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    mismatches = {
        finding.path
        for finding in report.findings
        if finding.reason == "code_agent_trajectory_metric_mismatch"
    }
    assert mismatches == {"$.target_input_tokens", "$.baseline_llm_call_count"}


def test_latest_publishability_rejects_code_agent_delta_mismatches(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    artifacts = _write_code_agent_artifacts(tmp_path)
    _write_latest(
        latest_dir,
        "visualwebbench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "visualwebbench",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": 1.0,
            "mode": "live",
            "comparison_status": "superior",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_accuracy": 1.0,
            "baseline_accuracy": 1.0,
            "accuracy_delta": 999.0,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 90,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 120,
            "baseline_cached_token_percent": 10.0,
            "baseline_llm_call_count": 3,
            "input_token_delta": 999,
            "output_token_delta": 999,
            "total_token_delta": -999,
            "llm_call_delta": -999,
            "cached_token_percent_delta": 999.0,
            **artifacts,
            "coverage_gate_ok": True,
            "benchmark_gate_ok": True,
            "required_stats_gate_ok": True,
            "efficiency_gate_ok": True,
            "quality_guardrail_gate_ok": True,
            "trajectory_review_gate_ok": True,
            "live_report_gate_ok": True,
            "report_gate_ok": True,
            "release_readiness_ok": True,
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    mismatches = {
        finding.path
        for finding in report.findings
        if finding.reason == "code_agent_delta_mismatch"
    }
    assert mismatches == {
        "$.accuracy_delta",
        "$.input_token_delta",
        "$.output_token_delta",
        "$.total_token_delta",
        "$.llm_call_delta",
        "$.cached_token_percent_delta",
    }


def test_latest_publishability_rejects_code_agent_outcome_mismatches(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    artifacts = _write_code_agent_artifacts(tmp_path)
    _write_latest(
        latest_dir,
        "osworld__elizaos_vs_opencode.json",
        {
            "benchmark_id": "osworld",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": 0.75,
            "mode": "live",
            "comparison_status": "superior",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 1,
            "target_total": 3,
            "target_accuracy": 0.9,
            "baseline_right": 1,
            "baseline_wrong": 1,
            "baseline_total": 1,
            "baseline_accuracy": 0.25,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 90,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 120,
            "baseline_cached_token_percent": 10.0,
            "baseline_llm_call_count": 3,
            "total_token_delta": -20,
            "llm_call_delta": -1,
            "cached_token_percent_delta": 0.0,
            **artifacts,
            "coverage_gate_ok": True,
            "benchmark_gate_ok": True,
            "required_stats_gate_ok": True,
            "efficiency_gate_ok": True,
            "quality_guardrail_gate_ok": True,
            "trajectory_review_gate_ok": True,
            "live_report_gate_ok": True,
            "report_gate_ok": True,
            "release_readiness_ok": True,
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    findings = {(finding.path, finding.reason) for finding in report.findings}
    assert ("$.target_total", "code_agent_outcome_total_mismatch") in findings
    assert ("$.baseline_total", "code_agent_outcome_total_mismatch") in findings
    assert ("$.target_accuracy", "code_agent_accuracy_mismatch") in findings
    assert ("$.baseline_accuracy", "code_agent_accuracy_mismatch") in findings
    assert ("$.score", "code_agent_score_mismatch") in findings


def test_latest_publishability_requires_code_agent_release_gates(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "swe_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "swe_bench",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": 1.0,
            "mode": "live",
            "comparison_status": "superior",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 60,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 90,
            "baseline_cached_token_percent": 15.0,
            "baseline_llm_call_count": 1,
            "total_token_delta": 0,
            "llm_call_delta": 0,
            "cached_token_percent_delta": 0.0,
            "target_result_path": "/tmp/result.json",
            "baseline_result_path": "/tmp/baseline-result.json",
            "target_command_path": "/tmp/command.json",
            "baseline_command_path": "/tmp/baseline-command.json",
            "target_trajectory_dir": "/tmp/trajectories",
            "baseline_trajectory_dir": "/tmp/baseline-trajectories",
            "coverage_gate_ok": True,
            "benchmark_gate_ok": True,
            "required_stats_gate_ok": True,
            "efficiency_gate_ok": True,
            "quality_guardrail_gate_ok": True,
            "trajectory_review_gate_ok": False,
            "live_report_gate_ok": True,
            "report_gate_ok": True,
            "release_readiness_ok": False,
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    failed_gates = {
        finding.path
        for finding in report.findings
        if finding.reason == "code_agent_required_gate_not_true"
    }
    assert failed_gates == {
        "$.trajectory_review_gate_ok",
        "$.release_readiness_ok",
    }


def test_latest_publishability_rejects_non_live_code_agent_rows(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "swe_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "swe_bench",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": 1.0,
            "mode": "smoke",
            "comparison_status": "comparable",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 90,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 120,
            "baseline_cached_token_percent": 10.0,
            "baseline_llm_call_count": 3,
            "total_token_delta": -20,
            "llm_call_delta": -1,
            "cached_token_percent_delta": 0.0,
            "target_result_path": "/tmp/result.json",
            "baseline_result_path": "/tmp/baseline-result.json",
            "target_command_path": "/tmp/command.json",
            "baseline_command_path": "/tmp/baseline-command.json",
            "target_trajectory_dir": "/tmp/trajectories",
            "baseline_trajectory_dir": "/tmp/baseline-trajectories",
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    assert any(
        finding.reason == "code_agent_not_live"
        and finding.path == "$.mode"
        and finding.value == '"smoke"'
        for finding in report.findings
    )


def test_latest_publishability_requires_code_agent_numeric_stats(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "terminal_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "terminal_bench",
            "agent": "elizaos",
            "status": "succeeded",
            "score": 1.0,
            "comparison_status": "comparable",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_input_tokens": 70,
            "target_output_tokens": None,
            "target_total_tokens": 100,
            "target_cached_token_percent": None,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 60,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 90,
            "baseline_cached_token_percent": 15.0,
            "baseline_llm_call_count": None,
            "total_token_delta": -5,
            "llm_call_delta": 0,
            "cached_token_percent_delta": 5.0,
            "target_result_path": "/tmp/result.json",
            "baseline_result_path": "/tmp/baseline-result.json",
            "target_command_path": "/tmp/command.json",
            "baseline_command_path": "/tmp/baseline-command.json",
            "target_trajectory_dir": "/tmp/trajectories",
            "baseline_trajectory_dir": "/tmp/baseline-trajectories",
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    missing_stats = {
        finding.path
        for finding in report.findings
        if finding.reason == "missing_code_agent_numeric_stat"
    }
    assert missing_stats == {
        "$.accuracy_delta",
        "$.input_token_delta",
        "$.output_token_delta",
        "$.target_output_tokens",
        "$.target_cached_token_percent",
        "$.baseline_llm_call_count",
    }


def test_latest_publishability_rejects_non_finite_score_and_stats(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "terminal_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "terminal_bench",
            "agent": "elizaos_vs_opencode",
            "status": "succeeded",
            "score": float("nan"),
            "comparison_status": "comparable",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": True,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": float("inf"),
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 60,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 90,
            "baseline_cached_token_percent": 15.0,
            "baseline_llm_call_count": 1,
            "total_token_delta": 0,
            "llm_call_delta": 0,
            "cached_token_percent_delta": 0.0,
            "target_result_path": "/tmp/result.json",
            "baseline_result_path": "/tmp/baseline-result.json",
            "target_command_path": "/tmp/command.json",
            "baseline_command_path": "/tmp/baseline-command.json",
            "target_trajectory_dir": "/tmp/trajectories",
            "baseline_trajectory_dir": "/tmp/baseline-trajectories",
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    assert any(
        finding.reason == "latest_row_missing_numeric_score"
        and finding.path == "$.score"
        for finding in report.findings
    )
    missing_stats = {
        finding.path
        for finding in report.findings
        if finding.reason == "missing_code_agent_numeric_stat"
    }
    assert {"$.target_right", "$.target_total_tokens"}.issubset(missing_stats)


def test_latest_publishability_rejects_inferior_code_agent_comparison(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "terminal_bench__elizaos_vs_opencode.json",
        {
            "benchmark_id": "terminal_bench",
            "agent": "elizaos",
            "status": "succeeded",
            "score": 0.5,
            "comparison_status": "inferior",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 1,
            "target_total": 2,
            "baseline_right": 2,
            "baseline_wrong": 0,
            "baseline_total": 2,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 60,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 90,
            "baseline_cached_token_percent": 15.0,
            "baseline_llm_call_count": 1,
            "total_token_delta": 10,
            "llm_call_delta": 1,
            "cached_token_percent_delta": -5.0,
            "target_result_path": "/tmp/result.json",
            "baseline_result_path": "/tmp/baseline-result.json",
            "target_command_path": "/tmp/command.json",
            "baseline_command_path": "/tmp/baseline-command.json",
            "target_trajectory_dir": "/tmp/trajectories",
            "baseline_trajectory_dir": "/tmp/baseline-trajectories",
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    assert any(
        finding.reason == "code_agent_not_comparable_or_better"
        and finding.path == "$.comparison_status"
        and finding.value == '"inferior"'
        for finding in report.findings
    )


def test_latest_publishability_rejects_code_agent_efficiency_regressions(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "webshop__elizaos_vs_opencode.json",
        {
            "benchmark_id": "webshop",
            "agent": "elizaos",
            "status": "succeeded",
            "score": 1.0,
            "comparison_status": "comparable",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_input_tokens": 120,
            "target_output_tokens": 40,
            "target_total_tokens": 160,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 3,
            "baseline_input_tokens": 80,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 110,
            "baseline_cached_token_percent": 25.0,
            "baseline_llm_call_count": 1,
            "total_token_delta": 50,
            "llm_call_delta": 2,
            "cached_token_percent_delta": -15.0,
            "target_result_path": "/tmp/result.json",
            "baseline_result_path": "/tmp/baseline-result.json",
            "target_command_path": "/tmp/command.json",
            "baseline_command_path": "/tmp/baseline-command.json",
            "target_trajectory_dir": "/tmp/trajectories",
            "baseline_trajectory_dir": "/tmp/baseline-trajectories",
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    reasons = {finding.reason for finding in report.findings}
    assert {
        "code_agent_total_tokens_worse",
        "code_agent_llm_calls_worse",
        "code_agent_cached_token_percent_worse",
    }.issubset(reasons)


def test_latest_publishability_requires_code_agent_efficiency_deltas(
    tmp_path: Path,
) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "mind2web__elizaos_vs_opencode.json",
        {
            "benchmark_id": "mind2web",
            "agent": "elizaos",
            "status": "succeeded",
            "score": 1.0,
            "comparison_status": "comparable",
            "target_adapter": "elizaos",
            "baseline_adapter": "opencode",
            "target_right": 1,
            "target_wrong": 0,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_wrong": 0,
            "baseline_total": 1,
            "target_input_tokens": 70,
            "target_output_tokens": 30,
            "target_total_tokens": 100,
            "target_cached_token_percent": 10.0,
            "target_llm_call_count": 2,
            "baseline_input_tokens": 60,
            "baseline_output_tokens": 30,
            "baseline_total_tokens": 90,
            "baseline_cached_token_percent": 15.0,
            "baseline_llm_call_count": 1,
            "target_result_path": "/tmp/result.json",
            "baseline_result_path": "/tmp/baseline-result.json",
            "target_command_path": "/tmp/command.json",
            "baseline_command_path": "/tmp/baseline-command.json",
            "target_trajectory_dir": "/tmp/trajectories",
            "baseline_trajectory_dir": "/tmp/baseline-trajectories",
        },
    )

    report = validate_latest_publishability(tmp_path)

    assert not report.ok
    missing_stats = {
        finding.path
        for finding in report.findings
        if finding.reason == "missing_code_agent_numeric_stat"
    }
    assert {
        "$.total_token_delta",
        "$.llm_call_delta",
        "$.cached_token_percent_delta",
    }.issubset(missing_stats)


def test_latest_publishability_filters_excluded_benchmarks(tmp_path: Path) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "terminal_bench__eliza.json",
        {
            "benchmark_id": "terminal_bench",
            "agent": "eliza",
            "status": "failed",
            "score": None,
            "metrics": {"mock": True},
        },
    )
    _write_latest(
        latest_dir,
        "voicebench__eliza.json",
        {
            "benchmark_id": "voicebench",
            "agent": "eliza",
            "status": "succeeded",
            "score": 0.7,
        },
    )

    report = validate_latest_publishability(
        tmp_path,
        exclude_benchmarks={"terminal_bench"},
    )

    assert report.ok
    assert report.checked_files == 2


def test_latest_publishability_filtered_scope_requires_selected_row(tmp_path: Path) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "terminal_bench__eliza.json",
        {
            "benchmark_id": "terminal_bench",
            "agent": "eliza",
            "status": "succeeded",
            "score": 1.0,
        },
    )

    report = validate_latest_publishability(
        tmp_path,
        exclude_benchmarks={"terminal_bench"},
    )

    assert not report.ok
    assert any(
        finding.reason == "no_selected_latest_rows"
        for finding in report.findings
    )


def test_latest_publishability_include_filter_requires_matching_row(tmp_path: Path) -> None:
    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(
        latest_dir,
        "voicebench__eliza.json",
        {
            "benchmark_id": "voicebench",
            "agent": "eliza",
            "status": "succeeded",
            "score": 1.0,
        },
    )

    report = validate_latest_publishability(
        tmp_path,
        include_benchmarks={"terminal_bench"},
    )

    assert not report.ok
    assert any(
        finding.reason == "no_selected_latest_rows"
        for finding in report.findings
    )


def test_latest_publishability_cli_accepts_latest_dir_and_filters(
    tmp_path: Path,
    capsys,
) -> None:
    latest_dir = tmp_path / "custom-latest"
    _write_latest(
        latest_dir,
        "terminal_bench__eliza.json",
        {
            "benchmark_id": "terminal_bench",
            "agent": "eliza",
            "status": "failed",
            "score": None,
            "metrics": {"mock": True},
        },
    )
    _write_latest(
        latest_dir,
        "voicebench__eliza.json",
        {
            "benchmark_id": "voicebench",
            "agent": "eliza",
            "status": "succeeded",
            "score": 0.7,
        },
    )

    code = cli._cmd_validate_latest_publishability(
        argparse.Namespace(
            latest_dir=str(latest_dir),
            include_benchmarks="voicebench",
            exclude_benchmarks="",
            json=True,
        )
    )

    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert payload["ok"] is True
    assert payload["latest_dir"] == str(latest_dir)
    assert payload["checked_files"] == 2
