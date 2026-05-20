from __future__ import annotations

import json
from pathlib import Path

from benchmarks.orchestrator.latest_publishability import validate_latest_publishability


def _write_latest(latest_dir: Path, name: str, payload: dict) -> None:
    latest_dir.mkdir(parents=True, exist_ok=True)
    (latest_dir / name).write_text(
        json.dumps(payload, sort_keys=True),
        encoding="utf-8",
    )


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
        "bfcl__hermes.json",
        {
            "benchmark_id": "bfcl",
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
