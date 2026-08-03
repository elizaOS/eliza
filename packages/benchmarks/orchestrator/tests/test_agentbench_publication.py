"""Exercises AgentBench scoring separately from unsupported publication."""

from __future__ import annotations

import json
from pathlib import Path

from benchmarks.orchestrator.latest_publishability import validate_latest_publishability
from benchmarks.orchestrator.runner import (
    _publication_quarantine_reason,
    _write_latest_result_snapshot,
)
from benchmarks.orchestrator.types import (
    BenchmarkAdapter,
    ExecutionContext,
    RunRequest,
    ScoreSummary,
)
from benchmarks.publication_contracts import (
    AGENTBENCH_UNSUPPORTED_PROTOCOL_REASON,
    agentbench_publication_contract_reason,
)
from benchmarks.registry import _score_from_agentbench_json


_ENVIRONMENT_COUNTS = {
    "operating_system": 144,
    "database": 300,
    "knowledge_graph": 150,
    "card_game": 5,
    "lateral_thinking": 50,
    "householding": 109,
    "web_shopping": 500,
    "web_browsing": 6,
}


def _exact_shaped_report() -> dict:
    source_manifest = (
        Path(__file__).resolve().parents[2] / "agentbench" / "upstream" / "SOURCE.json"
    )
    environment_reports = {}
    for environment, total in _ENVIRONMENT_COUNTS.items():
        passed = total // 2
        environment_reports[environment] = {
            "total_tasks": total,
            "passed_tasks": passed,
            "failed_tasks": total - passed,
            "success_rate": passed / total,
        }
    passed_tasks = sum(
        report["passed_tasks"] for report in environment_reports.values()
    )
    total_tasks = sum(_ENVIRONMENT_COUNTS.values())
    return {
        "dataset_provenance": json.loads(source_manifest.read_text(encoding="utf-8")),
        "dataset_selection": {
            "split": "test",
            "data_mode": "full",
            "expanded_scenarios": False,
        },
        # A report-provided aggregate claim is not evidence that each task
        # traversed the required environment protocol stages.
        "execution_protocol_attestation": {
            "schema_version": 1,
            "complete": True,
            "environments": {
                environment: {"task_count": count, "protocol": ["claimed"]}
                for environment, count in _ENVIRONMENT_COUNTS.items()
            },
        },
        "environment_reports": environment_reports,
        "total_tasks": total_tasks,
        "passed_tasks": passed_tasks,
        "failed_tasks": total_tasks - passed_tasks,
        "overall_success_rate": passed_tasks / total_tasks,
    }


def _write_latest(latest_dir: Path, metrics: dict) -> None:
    latest_dir.mkdir(parents=True, exist_ok=True)
    (latest_dir / "agentbench__eliza.json").write_text(
        json.dumps(
            {
                "benchmark_id": "agentbench",
                "agent": "eliza",
                "provider": "cerebras",
                "model": "gemma-4-31b",
                "status": "succeeded",
                "score": metrics["overall_success_rate"],
                "metrics": metrics,
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )


def _adapter() -> BenchmarkAdapter:
    def command_builder(
        _context: ExecutionContext, _adapter: BenchmarkAdapter
    ) -> list[str]:
        return []

    def result_locator(
        _context: ExecutionContext,
        _adapter: BenchmarkAdapter,
        _output_root: Path,
    ) -> Path | None:
        return None

    def score_extractor(_path: Path) -> ScoreSummary:
        return ScoreSummary(score=None, unit=None, higher_is_better=True)

    return BenchmarkAdapter(
        id="agentbench",
        directory="agentbench",
        description="AgentBench test adapter",
        cwd=".",
        command_builder=command_builder,
        result_locator=result_locator,
        score_extractor=score_extractor,
    )


def test_even_exact_shaped_report_is_quarantined_by_both_publication_gates(
    tmp_path: Path,
) -> None:
    raw_report = _exact_shaped_report()
    extraction = _score_from_agentbench_json(raw_report)

    assert "execution_protocol_attestation" not in extraction.metrics
    assert (
        agentbench_publication_contract_reason(raw_report)
        == AGENTBENCH_UNSUPPORTED_PROTOCOL_REASON
    )
    assert (
        _publication_quarantine_reason(
            benchmark_id="agentbench",
            status="succeeded",
            agent="eliza",
            score=extraction.score,
            token_metrics=None,
            metrics=extraction.metrics,
            provider="cerebras",
            model="gemma-4-31b",
        )
        == AGENTBENCH_UNSUPPORTED_PROTOCOL_REASON
    )

    latest_dir = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_latest(latest_dir, extraction.metrics)
    report = validate_latest_publishability(tmp_path, include_benchmarks={"agentbench"})
    assert not report.ok
    assert any(
        finding.reason == AGENTBENCH_UNSUPPORTED_PROTOCOL_REASON
        for finding in report.findings
    )


def test_partial_diagnostic_scores_and_routes_away_from_latest(tmp_path: Path) -> None:
    metrics = _score_from_agentbench_json(
        {
            "total_tasks": 2,
            "passed_tasks": 1,
            "failed_tasks": 1,
            "overall_success_rate": 0.5,
        }
    ).metrics
    adapter = _adapter()
    common = {
        "adapter": adapter,
        "run_group_id": "run-group",
        "status": "succeeded",
        "score": 0.5,
        "unit": "ratio",
        "higher_is_better": True,
        "metrics": metrics,
    }

    _write_latest_result_snapshot(
        tmp_path,
        request=RunRequest(
            benchmarks=("agentbench",),
            agent="eliza",
            provider="cerebras",
            model="gemma-4-31b",
            extra_config={},
        ),
        run_id="real-diagnostic",
        **common,
    )
    _write_latest_result_snapshot(
        tmp_path,
        request=RunRequest(
            benchmarks=("agentbench",),
            agent="half_v1",
            provider="synthetic",
            model="synthetic",
            extra_config={},
        ),
        run_id="synthetic-calibration",
        **common,
    )

    quarantine = json.loads(
        (tmp_path / "quarantine" / "agentbench__eliza.json").read_text(encoding="utf-8")
    )
    assert quarantine["quarantine_reason"] == AGENTBENCH_UNSUPPORTED_PROTOCOL_REASON
    assert (tmp_path / "baselines" / "agentbench__half_v1.json").exists()
    assert not (tmp_path / "latest" / "agentbench__eliza.json").exists()
    assert not (tmp_path / "latest" / "agentbench__half_v1.json").exists()
