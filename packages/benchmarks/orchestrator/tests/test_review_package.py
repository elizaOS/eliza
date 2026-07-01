from __future__ import annotations

import argparse
import json
from pathlib import Path

from benchmarks.orchestrator import cli, review_package
from benchmarks.orchestrator.artifact_guard import ArtifactGuardReport
from benchmarks.orchestrator.inventory import BenchmarkInventoryReport
from benchmarks.orchestrator.latest_readiness import ReadinessFinding, ReadinessReport
from benchmarks.orchestrator.review_package import (
    ReviewPackage,
    build_review_package,
    write_review_package,
)


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _inventory(
    *,
    registry_gaps: tuple[str, ...] = (),
    directory_gaps: tuple[str, ...] = (),
) -> BenchmarkInventoryReport:
    return BenchmarkInventoryReport(
        adapter_count=3,
        registry_entry_count=3,
        benchmark_directory_count=3,
        checklist_count=3,
        registry_entries_without_adapters=registry_gaps,
        adapters_without_registry_entries=(),
        benchmark_directories_without_adapters=directory_gaps,
        rows=[],
    )


def _patch_reports(
    monkeypatch,
    *,
    inventory: BenchmarkInventoryReport | None = None,
    readiness: ReadinessReport | None = None,
    artifact_guard: ArtifactGuardReport | None = None,
) -> None:
    monkeypatch.setattr(
        review_package,
        "build_inventory_report",
        lambda _repo_root: inventory or _inventory(),
    )
    monkeypatch.setattr(
        review_package,
        "validate_latest_readiness",
        lambda *_args, **_kwargs: readiness
        or ReadinessReport(latest_dir="latest", tolerance=0.08, findings=()),
    )
    monkeypatch.setattr(
        review_package,
        "build_artifact_guard_report",
        lambda _workspace_root: artifact_guard or ArtifactGuardReport(True, 10, ()),
    )


def test_review_package_writes_complete_manifest_and_scorecard(
    tmp_path: Path,
    monkeypatch,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", {"matrix_contract": {"status": "complete"}})
    _write_json(
        latest / "bfcl__eliza.json",
        {
            "benchmark_id": "bfcl",
            "agent": "eliza",
            "provider": "cerebras",
            "model": "gpt-oss-120b",
            "status": "succeeded",
            "score": 1.0,
            "run_id": "run_bfcl",
            "trajectory_dir": "/tmp/trajectories",
        },
    )
    _patch_reports(monkeypatch)

    package = build_review_package(
        tmp_path / "packages",
        latest_dir=latest,
        reviewed_by="reviewer",
        reviewer_note="Opened trajectory files and spot-reviewed the replay.",
        check_runtime_gates=False,
        generated_at="2026-07-01T00:00:00Z",
        git_sha="abc123",
    )
    manifest_path, scorecard_path = write_review_package(package, tmp_path / "review")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert package.ok is True
    assert manifest["summary"]["ok"] is True
    assert manifest["summary"]["latest_rows"] == 1
    assert manifest["latest_rows"][0]["benchmark_id"] == "bfcl"
    assert manifest["latest_rows"][0]["provider"] == "cerebras"
    scorecard = scorecard_path.read_text(encoding="utf-8")
    assert "# Benchmark Review Scorecard" in scorecard
    assert "Opened trajectory files" in scorecard
    assert "| bfcl | eliza | succeeded | 1.0 | cerebras | gpt-oss-120b | run_bfcl |" in scorecard


def test_review_package_blocks_on_readiness_artifacts_inventory_and_note(
    tmp_path: Path,
    monkeypatch,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", {})
    readiness = ReadinessReport(
        latest_dir=str(latest),
        tolerance=0.08,
        findings=(
            ReadinessFinding(
                scope="bfcl::hermes",
                reason="missing",
                value="no latest row",
            ),
        ),
    )
    _patch_reports(
        monkeypatch,
        inventory=_inventory(registry_gaps=("missing_adapter",)),
        readiness=readiness,
        artifact_guard=ArtifactGuardReport(
            ok=False,
            checked_count=11,
            offending=("packages/benchmarks/benchmark_results/orchestrator.sqlite",),
        ),
    )

    package = build_review_package(
        tmp_path / "packages",
        latest_dir=latest,
        reviewed_by="",
        reviewer_note="",
        check_runtime_gates=False,
        generated_at="2026-07-01T00:00:00Z",
        git_sha="abc123",
    )

    reasons = {finding["reason"] for finding in package.manifest["blocking_findings"]}
    assert package.ok is False
    assert {
        "registry entries have no orchestrator adapter",
        "missing",
        "generated_artifact_committed",
        "no_latest_rows",
        "missing_reviewer_note",
    }.issubset(reasons)
    assert "bfcl::hermes" in package.markdown


def test_review_package_cli_writes_blocked_package(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setattr(cli, "_workspace_root_from_here", lambda: tmp_path / "packages")
    monkeypatch.setattr(
        cli,
        "build_review_package",
        lambda *_args, **_kwargs: ReviewPackage(
            ok=False,
            manifest={"summary": {"ok": False}, "blocking_findings": [{"reason": "blocked"}]},
            markdown="# blocked\n",
        ),
    )

    code = cli._cmd_review_package(
        argparse.Namespace(
            latest_dir=None,
            out_dir=str(tmp_path / "out"),
            reviewed_by="reviewer",
            reviewer_note="reviewed",
            tolerance=0.08,
            skip_runtime_gates=True,
            include_benchmarks=None,
            exclude_benchmarks=None,
        )
    )

    assert code == 1
    assert (tmp_path / "out" / "manifest.json").is_file()
    assert (tmp_path / "out" / "scorecard.md").is_file()
    assert "blocked" in capsys.readouterr().out
