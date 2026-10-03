"""Checks real filesystem inputs and SQLite reuse after runtime/source changes."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from benchmarks.orchestrator.cohort import build_phase_execution_identity
from benchmarks.orchestrator.db import (
    connect_database,
    initialize_database,
    insert_run_start,
    get_latest_succeeded_run_for_signature,
    update_run_result,
)
from benchmarks.orchestrator.runner import (
    _signature_for,
    _comparison_signature_for,
    _repo_meta,
)
from benchmarks.orchestrator.types import BenchmarkAdapter, RunRequest, ScoreSummary


def _inputs(root: Path):
    adapter = BenchmarkAdapter(
        id="context",
        directory="context",
        description="Context integration fixture",
        cwd=".",
        command_builder=lambda *_: [],
        result_locator=lambda *_: None,
        score_extractor=lambda _: ScoreSummary(1.0, "ratio", True),
        agent_compatibility=("eliza",),
    )
    request = RunRequest(
        benchmarks=("context",),
        agent="eliza",
        provider="test",
        model="test",
        extra_config={"campaign_corpus_sha256": "pinned-corpus"},
    )
    return adapter, request


def _signature(root, adapter, request, meta):
    return _signature_for(adapter, request, workspace_root=root, repo_meta=meta)


@pytest.mark.parametrize(
    "relative",
    [
        "packages/core/src/runtime.ts",
        "suites/context/corpus.jsonl",
        "harnesses/eliza/agent.ts",
        "harnesses/codex/runner.py",
        "run.py",
        "registry/commands.py",
        "framework/runner.py",
        "lib/results.py",
        "package.json",
        "bun.lock",
    ],
)
def test_changed_inputs_cannot_reuse_prior_success_or_checkpoint(
    tmp_path: Path, relative: str
):
    source = tmp_path / relative
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("first complete input Ω\n", encoding="utf-8")
    adapter, request = _inputs(tmp_path)
    meta = {"benchmarks_commit": "benchmark-a", "eliza_commit": "runtime-a"}
    signature = _signature(tmp_path, adapter, request, meta)
    identity = build_phase_execution_identity(
        workspace_root=tmp_path,
        adapter=adapter,
        request=request,
        harnesses=("eliza",),
        repo_meta=meta,
    )
    comparison = _comparison_signature_for(adapter, request)
    conn = connect_database(tmp_path / "suites/benchmark_results/orchestrator.sqlite")
    try:
        initialize_database(conn)
        insert_run_start(
            conn,
            run_id="prior",
            run_group_id="group",
            benchmark_id=adapter.id,
            benchmark_directory=adapter.directory,
            signature=signature,
            attempt=1,
            agent=request.agent,
            provider=request.provider,
            model=request.model,
            extra_config=dict(request.extra_config),
            started_at="2026-09-14T00:00:00Z",
            command=[],
            cwd=str(tmp_path),
            stdout_path="",
            stderr_path="",
            benchmark_version=None,
            benchmarks_commit="benchmark-a",
            eliza_commit="runtime-a",
            eliza_version=None,
        )
        update_run_result(
            conn,
            run_id="prior",
            status="succeeded",
            ended_at="2026-09-14T00:00:01Z",
            duration_seconds=1,
            score=None,
            unit=None,
            higher_is_better=None,
            metrics={},
            result_json_path=None,
            artifacts=[],
            error=None,
            high_score_label=None,
            high_score_value=None,
            delta_to_high_score=None,
        )
        unchanged = _signature(tmp_path, adapter, request, meta)
        assert get_latest_succeeded_run_for_signature(conn, unchanged).run_id == "prior"
        assert (
            build_phase_execution_identity(
                workspace_root=tmp_path,
                adapter=adapter,
                request=request,
                harnesses=("eliza",),
                repo_meta=meta,
            ).checkpoint_relpath
            == identity.checkpoint_relpath
        )
        source.write_text("second complete input Ω\n", encoding="utf-8")
        changed = _signature(tmp_path, adapter, request, meta)
        assert get_latest_succeeded_run_for_signature(conn, changed) is None
        assert (
            build_phase_execution_identity(
                workspace_root=tmp_path,
                adapter=adapter,
                request=request,
                harnesses=("eliza",),
                repo_meta=meta,
            ).checkpoint_relpath
            != identity.checkpoint_relpath
        )
        assert _comparison_signature_for(adapter, request) == comparison
    finally:
        conn.close()


def test_revision_changes_invalidate_even_with_explicit_corpus(tmp_path: Path):
    adapter, request = _inputs(tmp_path)
    initial = {"benchmarks_commit": "a", "eliza_commit": "b"}
    previous = _signature(tmp_path, adapter, request, initial)
    for key in initial:
        assert (
            _signature(tmp_path, adapter, request, {**initial, key: "changed"})
            != previous
        )


def test_uninitialized_runtime_is_not_attributed_to_parent(tmp_path: Path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / "package.json").write_text('{"version":"1.2.3"}')
    subprocess.run(["git", "-C", str(tmp_path), "add", "package.json"], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(tmp_path),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "fixture",
        ],
        check=True,
    )
    meta = _repo_meta(tmp_path)
    assert (
        meta["benchmarks_commit"]
        == subprocess.check_output(
            ["git", "-C", str(tmp_path), "rev-parse", "HEAD"], text=True
        ).strip()
    )
    assert meta["eliza_commit"] == meta["benchmarks_commit"]
    assert meta["benchmarks_version"] == "1.2.3"


@pytest.mark.parametrize("relative", ["packages/core/src/runtime.ts", "plugins/provider/src/index.ts", "bun.lock", "patches/runtime.patch"])
def test_monorepo_runtime_changes_invalidate_benchmark_resume(tmp_path: Path, relative: str):
    workspace = tmp_path / "packages" / "benchmarks"
    workspace.mkdir(parents=True)
    source = tmp_path / relative
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("original runtime input\n")
    adapter, request = _inputs(workspace)
    meta = {"benchmarks_commit": "same-head", "eliza_commit": "same-head"}
    before = _signature(workspace, adapter, request, meta)
    source.write_text("changed runtime input\n")
    assert _signature(workspace, adapter, request, meta) != before
