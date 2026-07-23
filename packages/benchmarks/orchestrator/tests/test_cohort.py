"""Exercises cohort scheduling and its shared SQLite/publication boundaries."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from benchmarks.orchestrator import cohort as cohort_module
from benchmarks.orchestrator import runner as runner_module
from benchmarks.orchestrator.db import (
    connect_database,
    create_run_group,
    finish_run_group,
    initialize_database,
    insert_run_start,
    list_run_groups,
    list_runs,
    pause_run_group,
    recover_stale_running_runs,
)
from benchmarks.orchestrator.subscription_gateway import (
    GatewayPauseState,
    GatewayPauseStatus,
)
from benchmarks.orchestrator.locking import serialize_on_output_root
from benchmarks.orchestrator.types import (
    AdapterDiscovery,
    BenchmarkAdapter,
    BenchmarkRunOutcome,
    LeaderboardComparison,
    RunRequest,
    ScoreSummary,
)


def _adapter(benchmark_id: str, harnesses: tuple[str, ...]) -> BenchmarkAdapter:
    return BenchmarkAdapter(
        id=benchmark_id,
        directory=benchmark_id,
        description=f"{benchmark_id} test adapter",
        cwd=".",
        command_builder=lambda _ctx, _adapter: [],
        result_locator=lambda _ctx, _adapter, _output: None,
        score_extractor=lambda _path: ScoreSummary(1.0, "ratio", True),
        agent_compatibility=harnesses,
    )


def _outcome(
    benchmark_id: str, harness: str, status: str = "succeeded"
) -> BenchmarkRunOutcome:
    return BenchmarkRunOutcome(
        benchmark_id=benchmark_id,
        run_id=f"run-{benchmark_id}-{harness}",
        status=status,  # type: ignore[arg-type]
        attempt=1,
        score=1.0 if status == "succeeded" else None,
        unit="ratio" if status == "succeeded" else None,
        higher_is_better=True if status == "succeeded" else None,
        metrics={},
        error=None if status == "succeeded" else "failed",
        result_json_path=None,
        stdout_path="",
        stderr_path="",
        artifacts=[],
        comparison=LeaderboardComparison(benchmark_id, None, None, None),
        duration_seconds=0.01,
        command=[],
        cwd=".",
    )


def _request(*benchmark_ids: str) -> RunRequest:
    return RunRequest(
        benchmarks=tuple(benchmark_ids),
        agent="eliza",
        provider="test-provider",
        model="test-model",
        extra_config={"seed": 7},
        force=True,
    )


def _workspace(tmp_path: Path) -> Path:
    workspace_root = tmp_path / "packages"
    (workspace_root / "benchmarks").mkdir(parents=True)
    return workspace_root


@pytest.fixture(autouse=True)
def _default_gateway_has_no_pause(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        cohort_module,
        "read_gateway_pause_state",
        lambda _audit_path: None,
    )


def test_cohorts_start_supported_harnesses_together_and_benchmarks_serially(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    adapters = {
        "alpha": _adapter("alpha", ("eliza", "hermes", "openclaw")),
        "beta": _adapter("beta", ("eliza", "hermes")),
    }
    monkeypatch.setattr(
        cohort_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(
            adapters=adapters, all_directories=tuple(adapters)
        ),
    )
    repo_meta = {
        "benchmarks_commit": "bench-commit",
        "eliza_commit": "eliza-commit",
        "eliza_version": "1.0.0",
        "benchmarks_version": "1.0.0",
    }
    monkeypatch.setattr(cohort_module, "_repo_meta", lambda _root: repo_meta)

    state_lock = threading.Lock()
    active = {"alpha": 0, "beta": 0}
    maximum = {"alpha": 0, "beta": 0}
    worker_barriers = {
        "alpha": threading.Barrier(3),
        "beta": threading.Barrier(2),
    }
    calls: list[tuple[str, str, str]] = []
    group_benchmark: dict[str, str] = {}
    finalized: list[str] = []

    real_prepare = cohort_module._prepare_cohort
    real_finalize = cohort_module._finalize_cohort

    def prepare(**kwargs) -> None:
        group_benchmark[kwargs["run_group_id"]] = kwargs["benchmark_id"]
        real_prepare(**kwargs)

    def finalize(**kwargs) -> Path:
        benchmark_id = group_benchmark[kwargs["run_group_id"]]
        with state_lock:
            assert sum(active.values()) == 0
        path = real_finalize(**kwargs)
        finalized.append(benchmark_id)
        return path

    monkeypatch.setattr(cohort_module, "_prepare_cohort", prepare)
    monkeypatch.setattr(cohort_module, "_finalize_cohort", finalize)

    def fake_run_benchmarks(
        *,
        workspace_root: Path,
        request: RunRequest,
        shared_run_group_id: str | None = None,
        defer_publication: bool = False,
        execution_repo_meta: dict[str, str | None] | None = None,
        execution_env_overrides: dict[str, str] | None = None,
        execution_cancel_event: threading.Event | None = None,
    ) -> tuple[str, list[BenchmarkRunOutcome], Path]:
        assert shared_run_group_id is not None
        assert defer_publication is True
        assert execution_repo_meta == repo_meta
        assert execution_env_overrides is None
        assert execution_cancel_event is not None
        benchmark_id = request.benchmarks[0]
        if benchmark_id == "beta":
            assert finalized == ["alpha"]
        with state_lock:
            active[benchmark_id] += 1
            maximum[benchmark_id] = max(maximum[benchmark_id], active[benchmark_id])
            calls.append((benchmark_id, request.agent, shared_run_group_id))
        worker_barriers[benchmark_id].wait(timeout=5)
        time.sleep(0.05)
        with state_lock:
            active[benchmark_id] -= 1
        return (
            shared_run_group_id,
            [_outcome(benchmark_id, request.agent)],
            workspace_root / "benchmarks" / "benchmark_results" / "viewer_data.json",
        )

    monkeypatch.setattr(cohort_module, "run_benchmarks", fake_run_benchmarks)

    results = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=_request("alpha", "beta"),
        harnesses=("eliza", "hermes", "openclaw"),
    )

    assert [result.benchmark_id for result in results] == ["alpha", "beta"]
    assert maximum == {"alpha": 3, "beta": 2}
    assert finalized == ["alpha", "beta"]
    assert results[0].unsupported_harnesses == ()
    assert results[1].unsupported_harnesses == ("openclaw",)
    assert {(benchmark, harness) for benchmark, harness, _group in calls} == {
        ("alpha", "eliza"),
        ("alpha", "hermes"),
        ("alpha", "openclaw"),
        ("beta", "eliza"),
        ("beta", "hermes"),
    }
    for benchmark_id in ("alpha", "beta"):
        assert (
            len(
                {
                    group
                    for benchmark, _harness, group in calls
                    if benchmark == benchmark_id
                }
            )
            == 1
        )

    conn = connect_database(
        workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    )
    groups = list_run_groups(conn)
    conn.close()
    assert len(groups) == 2
    by_benchmark = {group["benchmarks"][0]: group for group in groups}
    assert by_benchmark["alpha"]["finished_at"] is not None
    assert by_benchmark["beta"]["finished_at"] is not None
    assert by_benchmark["alpha"]["request"]["cohort"]["harnesses"] == [
        "eliza",
        "hermes",
        "openclaw",
    ]
    assert by_benchmark["beta"]["request"]["cohort"]["requested_harnesses"] == [
        "eliza",
        "hermes",
        "openclaw",
    ]
    assert by_benchmark["beta"]["request"]["cohort"]["unsupported_harnesses"] == [
        "openclaw"
    ]


def test_failed_cohort_stops_before_next_benchmark(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    adapters = {
        benchmark_id: _adapter(benchmark_id, ("eliza", "hermes", "openclaw"))
        for benchmark_id in ("alpha", "beta")
    }
    monkeypatch.setattr(
        cohort_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(
            adapters=adapters, all_directories=tuple(adapters)
        ),
    )
    monkeypatch.setattr(cohort_module, "_repo_meta", lambda _root: {})
    called: list[tuple[str, str]] = []

    def fake_run_benchmarks(**kwargs):
        request = kwargs["request"]
        benchmark_id = request.benchmarks[0]
        called.append((benchmark_id, request.agent))
        status = "failed" if request.agent == "hermes" else "succeeded"
        return (
            kwargs["shared_run_group_id"],
            [_outcome(benchmark_id, request.agent, status)],
            workspace_root / "benchmarks" / "benchmark_results" / "viewer_data.json",
        )

    monkeypatch.setattr(cohort_module, "run_benchmarks", fake_run_benchmarks)

    results = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=_request("alpha", "beta"),
        harnesses=("eliza", "hermes", "openclaw"),
    )

    assert [result.benchmark_id for result in results] == ["alpha"]
    assert {harness for benchmark, harness in called if benchmark == "alpha"} == {
        "eliza",
        "hermes",
        "openclaw",
    }
    assert not any(benchmark == "beta" for benchmark, _harness in called)


def test_subscription_cohort_owns_one_gateway_and_scopes_worker_credentials(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    adapters = {"alpha": _adapter("alpha", ("eliza", "hermes", "openclaw"))}
    monkeypatch.setattr(
        cohort_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(adapters=adapters, all_directories=("alpha",)),
    )
    monkeypatch.setattr(cohort_module, "_repo_meta", lambda _root: {})
    lifecycle: list[str] = []
    worker_envs: dict[str, dict[str, str]] = {}
    audit_path = (
        workspace_root / "benchmarks" / "benchmark_results" / "gateway-audit.jsonl"
    )

    class FakeGateway:
        def env_for_harness(self, harness: str) -> dict[str, str]:
            return {
                "CLAUDE_SUBSCRIPTION_GATEWAY_URL": "http://127.0.0.1:43123",
                "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN": f"token-{harness}",
            }

        def close(self) -> Path:
            lifecycle.append("gateway-closed")
            return audit_path

        def cleanup_private_checkpoint(self) -> None:
            lifecycle.append("checkpoint-cleaned")

    def start_gateway(**kwargs) -> FakeGateway:
        assert kwargs["harnesses"] == ("eliza", "hermes", "openclaw")
        lifecycle.append("gateway-started")
        return FakeGateway()

    def fake_run_benchmarks(**kwargs):
        request = kwargs["request"]
        worker_envs[request.agent] = kwargs["execution_env_overrides"]
        return (
            kwargs["shared_run_group_id"],
            [_outcome("alpha", request.agent)],
            workspace_root / "benchmarks" / "benchmark_results" / "viewer_data.json",
        )

    def attach_gateway(**kwargs) -> dict[str, str]:
        assert lifecycle[-1] == "gateway-closed"
        assert kwargs["audit_path"] == audit_path
        lifecycle.append("audit-attached")
        return {}

    def finalize(**kwargs) -> Path:
        assert lifecycle[-1] == "audit-attached"
        kwargs["success_cleanup"]()
        lifecycle.append("published")
        return workspace_root / "benchmarks" / "benchmark_results" / "viewer_data.json"

    monkeypatch.setattr(
        cohort_module, "start_claude_subscription_gateway", start_gateway
    )
    monkeypatch.setattr(cohort_module, "run_benchmarks", fake_run_benchmarks)
    monkeypatch.setattr(cohort_module, "_attach_gateway_audit", attach_gateway)
    monkeypatch.setattr(cohort_module, "_finalize_cohort", finalize)
    request = RunRequest(
        benchmarks=("alpha",),
        agent="eliza",
        provider="claude-subscription",
        model="claude-opus-4-6",
        extra_config={},
        force=True,
    )

    results = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=request,
        harnesses=("eliza", "hermes", "openclaw"),
    )

    assert len(results) == 1
    assert lifecycle == [
        "gateway-started",
        "gateway-closed",
        "audit-attached",
        "checkpoint-cleaned",
        "published",
    ]
    assert {
        harness: env["CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN"]
        for harness, env in worker_envs.items()
    } == {
        "eliza": "token-eliza",
        "hermes": "token-hermes",
        "openclaw": "token-openclaw",
    }


def test_subscription_resume_reuses_complete_cohort_without_gateway(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    adapters = {"alpha": _adapter("alpha", ("eliza", "hermes", "openclaw"))}
    monkeypatch.setattr(
        cohort_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(adapters=adapters, all_directories=("alpha",)),
    )
    monkeypatch.setattr(cohort_module, "_repo_meta", lambda _root: {})
    outcomes = tuple(
        _outcome("alpha", harness) for harness in ("eliza", "hermes", "openclaw")
    )
    monkeypatch.setattr(
        cohort_module,
        "_find_reusable_subscription_cohort",
        lambda **_kwargs: ("rg-existing", outcomes),
    )
    viewer = workspace_root / "benchmarks" / "benchmark_results" / "viewer.json"
    monkeypatch.setattr(
        cohort_module,
        "_refresh_publication",
        lambda **_kwargs: viewer,
    )
    monkeypatch.setattr(
        cohort_module,
        "start_claude_subscription_gateway",
        lambda **_kwargs: pytest.fail("resume started a new gateway"),
    )
    monkeypatch.setattr(
        cohort_module,
        "_prepare_cohort",
        lambda **_kwargs: pytest.fail("resume created a new run group"),
    )
    request = RunRequest(
        benchmarks=("alpha",),
        agent="eliza",
        provider="claude-subscription",
        model="claude-opus-4-6",
        extra_config={},
        resume=True,
    )

    results = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=request,
        harnesses=("eliza", "hermes", "openclaw"),
    )

    assert len(results) == 1
    assert results[0].reused is True
    assert results[0].run_group_id == "rg-existing"
    assert results[0].outcomes == outcomes
    assert results[0].viewer_snapshot == viewer


def test_subscription_partial_resume_reruns_every_harness(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    adapters = {"alpha": _adapter("alpha", ("eliza", "hermes", "openclaw"))}
    monkeypatch.setattr(
        cohort_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(adapters=adapters, all_directories=("alpha",)),
    )
    monkeypatch.setattr(cohort_module, "_repo_meta", lambda _root: {})
    monkeypatch.setattr(
        cohort_module,
        "_find_reusable_subscription_cohort",
        lambda **_kwargs: None,
    )
    seen: dict[str, RunRequest] = {}

    class FakeGateway:
        def env_for_harness(self, harness: str) -> dict[str, str]:
            return {"TOKEN": harness}

        def close(self) -> Path:
            return workspace_root / "audit.jsonl"

        def cleanup_private_checkpoint(self) -> None:
            return None

    monkeypatch.setattr(
        cohort_module,
        "start_claude_subscription_gateway",
        lambda **_kwargs: FakeGateway(),
    )

    def fake_run_benchmarks(**kwargs):
        worker_request = kwargs["request"]
        seen[worker_request.agent] = worker_request
        return (
            kwargs["shared_run_group_id"],
            [_outcome("alpha", worker_request.agent)],
            workspace_root / "viewer.json",
        )

    monkeypatch.setattr(cohort_module, "run_benchmarks", fake_run_benchmarks)
    monkeypatch.setattr(
        cohort_module,
        "_attach_gateway_audit",
        lambda **_kwargs: {},
    )
    monkeypatch.setattr(
        cohort_module,
        "_finalize_cohort",
        lambda **_kwargs: workspace_root / "viewer.json",
    )
    request = RunRequest(
        benchmarks=("alpha",),
        agent="eliza",
        provider="claude-subscription",
        model="claude-opus-4-6",
        extra_config={},
        resume=True,
    )

    results = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=request,
        harnesses=("eliza", "hermes", "openclaw"),
    )

    assert results[0].reused is False
    assert set(seen) == {"eliza", "hermes", "openclaw"}
    assert all(worker.force for worker in seen.values())
    assert all(not worker.resume for worker in seen.values())
    assert all(not worker.rerun_failed for worker in seen.values())


def test_subscription_audit_rejection_stops_before_publication_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    adapters = {"alpha": _adapter("alpha", ("eliza",))}
    monkeypatch.setattr(
        cohort_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(adapters=adapters, all_directories=("alpha",)),
    )
    monkeypatch.setattr(cohort_module, "_repo_meta", lambda _root: {})

    class FakeGateway:
        def env_for_harness(self, _harness: str) -> dict[str, str]:
            return {"CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN": "token-eliza"}

        def close(self) -> Path:
            return workspace_root / "audit.jsonl"

    monkeypatch.setattr(
        cohort_module,
        "start_claude_subscription_gateway",
        lambda **_kwargs: FakeGateway(),
    )
    monkeypatch.setattr(
        cohort_module,
        "run_benchmarks",
        lambda **kwargs: (
            kwargs["shared_run_group_id"],
            [_outcome("alpha", "eliza")],
            workspace_root / "viewer.json",
        ),
    )
    monkeypatch.setattr(
        cohort_module,
        "_attach_gateway_audit",
        lambda **_kwargs: {"run-alpha-eliza": "subscription_missing_gateway_audit"},
    )
    monkeypatch.setattr(
        cohort_module,
        "_finalize_cohort",
        lambda **_kwargs: workspace_root / "viewer.json",
    )
    request = RunRequest(
        benchmarks=("alpha",),
        agent="eliza",
        provider="claude-subscription",
        model="claude-opus-4-6",
        extra_config={},
        force=True,
    )

    with pytest.raises(cohort_module.BenchmarkCohortError) as raised:
        cohort_module.run_benchmark_cohorts(
            workspace_root=workspace_root,
            request=request,
            harnesses=("eliza",),
        )

    assert set(raised.value.failures) == {"subscription-gateway-audit"}


def test_subscription_publication_rejections_revalidate_rows_and_audit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def quarantine_reason(**kwargs) -> str | None:
        if kwargs["benchmark_id"] == "bad-workload":
            return "webshop_scenario_model_call_manifest_mismatch"
        return None

    def audit_reason(provenance: dict[str, object] | None) -> str | None:
        if provenance == {"audit": "invalid"}:
            return "subscription_gateway_audit_sha256_mismatch"
        return None

    monkeypatch.setattr(
        cohort_module,
        "_publication_quarantine_reason",
        quarantine_reason,
    )
    monkeypatch.setattr(
        cohort_module,
        "validate_subscription_gateway_audit_artifact",
        audit_reason,
    )

    rows = [
        {
            "run_id": "run-workload",
            "benchmark_id": "bad-workload",
            "agent": "eliza",
            "provider": "claude-subscription",
            "model": "claude-opus-4-6",
            "status": "succeeded",
            "score": 1.0,
            "metrics": {},
            "token_metrics": {},
        },
        {
            "run_id": "run-audit",
            "benchmark_id": "valid-workload",
            "agent": "hermes",
            "provider": "claude-subscription",
            "model": "claude-opus-4-6",
            "status": "succeeded",
            "score": 1.0,
            "metrics": {"subscription_gateway_provenance": {"audit": "invalid"}},
            "token_metrics": {},
        },
        {
            "run_id": "run-valid",
            "benchmark_id": "valid-workload",
            "agent": "openclaw",
            "provider": "claude-subscription",
            "model": "claude-opus-4-6",
            "status": "succeeded",
            "score": 1.0,
            "metrics": {"subscription_gateway_provenance": {"audit": "valid"}},
            "token_metrics": {},
        },
        {
            "run_id": "run-other-provider",
            "provider": "test-provider",
            "status": "succeeded",
        },
        {
            "run_id": "run-failed",
            "provider": "claude-subscription",
            "status": "failed",
        },
    ]

    assert cohort_module._subscription_publication_rejections(rows) == {
        "run-audit": "subscription_gateway_audit_sha256_mismatch",
        "run-workload": "webshop_scenario_model_call_manifest_mismatch",
    }


def test_finalize_cohort_raises_after_quarantining_subscription_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    persisted_rejections: dict[str, str] = {}

    class FakeConnection:
        def close(self) -> None:
            return None

    monkeypatch.setattr(
        cohort_module,
        "connect_database",
        lambda _path: FakeConnection(),
    )
    monkeypatch.setattr(
        cohort_module, "finish_run_group", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        cohort_module,
        "repair_nonzero_returncode_statuses",
        lambda _conn: 0,
    )
    monkeypatch.setattr(
        cohort_module,
        "repair_nonpublishable_success_statuses",
        lambda _conn: 1,
    )
    monkeypatch.setattr(
        cohort_module,
        "list_runs",
        lambda _conn, limit: [
            {
                "run_id": "run-invalid",
                "run_group_id": "rg-invalid",
                "provider": "claude-subscription",
                "status": "succeeded",
            }
        ],
    )
    monkeypatch.setattr(
        cohort_module,
        "_subscription_publication_rejections",
        lambda _rows: {"run-invalid": "webshop_scenario_model_call_manifest_mismatch"},
    )
    monkeypatch.setattr(
        cohort_module,
        "fail_succeeded_runs_for_publication",
        lambda _conn, *, reasons: persisted_rejections.update(reasons) or 1,
    )
    monkeypatch.setattr(
        cohort_module,
        "_repair_current_compatibility_statuses",
        lambda _conn, _adapters: None,
    )
    monkeypatch.setattr(
        cohort_module,
        "_rebuild_latest_result_snapshots",
        lambda _conn, _output_root, _adapters: (
            None
            if persisted_rejections
            else pytest.fail("publication rebuilt before rejection was persisted")
        ),
    )
    monkeypatch.setattr(
        cohort_module,
        "_ensure_viewer_snapshot",
        lambda *_args, **_kwargs: workspace_root / "viewer.json",
    )

    with pytest.raises(
        RuntimeError,
        match=(
            "Claude subscription cohort failed publication integrity: "
            "run-invalid=webshop_scenario_model_call_manifest_mismatch"
        ),
    ):
        cohort_module._finalize_cohort(
            workspace_root=workspace_root,
            run_group_id="rg-invalid",
            adapters={},
            failures={},
        )
    assert persisted_rejections == {
        "run-invalid": "webshop_scenario_model_call_manifest_mismatch"
    }


def test_worker_crash_settles_siblings_and_marks_running_rows_failed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    adapters = {"alpha": _adapter("alpha", ("eliza", "hermes", "openclaw"))}
    monkeypatch.setattr(
        cohort_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(adapters=adapters, all_directories=("alpha",)),
    )
    monkeypatch.setattr(cohort_module, "_repo_meta", lambda _root: {})
    settled: set[str] = set()
    settled_lock = threading.Lock()

    def fake_run_benchmarks(**kwargs):
        request = kwargs["request"]
        run_group_id = kwargs["shared_run_group_id"]
        if request.agent == "hermes":
            conn = connect_database(
                workspace_root
                / "benchmarks"
                / "benchmark_results"
                / "orchestrator.sqlite"
            )
            insert_run_start(
                conn,
                run_id="run-crashed-hermes",
                run_group_id=run_group_id,
                benchmark_id="alpha",
                benchmark_directory="alpha",
                signature="sig-hermes",
                attempt=1,
                agent="hermes",
                provider="test-provider",
                model="test-model",
                extra_config={},
                started_at="2026-07-20T00:00:00+00:00",
                command=["fake"],
                cwd=".",
                stdout_path="",
                stderr_path="",
                benchmark_version=None,
                benchmarks_commit=None,
                eliza_commit=None,
                eliza_version=None,
            )
            conn.close()
            raise RuntimeError("worker exploded")
        time.sleep(0.05)
        with settled_lock:
            settled.add(request.agent)
        return (
            run_group_id,
            [],
            workspace_root / "benchmarks" / "benchmark_results" / "viewer_data.json",
        )

    monkeypatch.setattr(cohort_module, "run_benchmarks", fake_run_benchmarks)

    with pytest.raises(cohort_module.BenchmarkCohortError) as raised:
        cohort_module.run_benchmark_cohorts(
            workspace_root=workspace_root,
            request=_request("alpha"),
            harnesses=("eliza", "hermes", "openclaw"),
        )

    assert raised.value.benchmark_id == "alpha"
    assert set(raised.value.failures) == {"hermes"}
    assert settled == {"eliza", "openclaw"}
    conn = connect_database(
        workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    )
    runs = list_runs(conn, limit=None)
    groups = list_run_groups(conn)
    conn.close()
    assert runs[0]["status"] == "failed"
    assert "Cohort worker crashed" in runs[0]["error"]
    assert groups[0]["finished_at"] is not None


def test_shared_runner_mode_defers_group_finish_and_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    conn = connect_database(output_root / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rgc-shared",
        created_at="2026-07-20T00:00:00+00:00",
        request={},
        benchmarks=[],
        repo_meta={},
    )
    conn.close()
    monkeypatch.setattr(
        runner_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(adapters={}, all_directories=()),
    )
    monkeypatch.setattr(
        runner_module,
        "_rebuild_latest_result_snapshots",
        lambda *_args, **_kwargs: pytest.fail("deferred worker rebuilt latest"),
    )
    monkeypatch.setattr(
        runner_module,
        "_ensure_viewer_snapshot",
        lambda *_args, **_kwargs: pytest.fail("deferred worker wrote viewer data"),
    )

    run_group_id, outcomes, viewer = runner_module.run_benchmarks(
        workspace_root=workspace_root,
        request=_request(),
        shared_run_group_id="rgc-shared",
        defer_publication=True,
        execution_repo_meta={"benchmarks_commit": "fixed"},
    )

    assert run_group_id == "rgc-shared"
    assert outcomes == []
    assert viewer == output_root / "viewer_data.json"
    conn = connect_database(output_root / "orchestrator.sqlite")
    groups = list_run_groups(conn)
    conn.close()
    assert groups[0]["finished_at"] is None


@pytest.mark.parametrize(
    ("shared_run_group_id", "defer_publication"),
    (("rgc-shared", False), (None, True)),
)
def test_shared_runner_options_must_be_paired(
    tmp_path: Path,
    shared_run_group_id: str | None,
    defer_publication: bool,
) -> None:
    with pytest.raises(ValueError, match="must be supplied together"):
        runner_module.run_benchmarks(
            workspace_root=_workspace(tmp_path),
            request=_request(),
            shared_run_group_id=shared_run_group_id,
            defer_publication=defer_publication,
        )


def test_sqlite_busy_timeout_allows_contending_cohort_writer(tmp_path: Path) -> None:
    db_path = tmp_path / "orchestrator.sqlite"
    blocker = connect_database(db_path)
    initialize_database(blocker)
    blocker.execute("BEGIN IMMEDIATE")

    def write_group() -> None:
        conn = connect_database(db_path)
        try:
            create_run_group(
                conn,
                run_group_id="rgc-contender",
                created_at="2026-07-20T00:00:00+00:00",
                request={},
                benchmarks=["alpha"],
                repo_meta={},
            )
        finally:
            conn.close()

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(write_group)
        time.sleep(0.05)
        assert not future.done()
        blocker.commit()
        future.result(timeout=5)
    blocker.close()

    conn = connect_database(db_path)
    groups = list_run_groups(conn)
    conn.close()
    assert groups[0]["run_group_id"] == "rgc-contender"


def _stored_identity() -> cohort_module.PhaseExecutionIdentity:
    return cohort_module.PhaseExecutionIdentity(
        namespace="benchmark-phase-v1-stored",
        contract={"schema_version": 1, "benchmark_id": "alpha"},
        checkpoint_relpath=".subscription-checkpoints/stored/responses.jsonl",
    )


def _seed_stored_execution(
    workspace_root: Path,
    identity: cohort_module.PhaseExecutionIdentity,
    *,
    run_group_id: str = "rgc-prior",
    running_run_id: str | None = "run-prior-eliza",
) -> None:
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    output_root.mkdir(parents=True, exist_ok=True)
    conn = connect_database(output_root / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id=run_group_id,
        created_at="2026-07-01T00:00:00+00:00",
        request={},
        benchmarks=["alpha"],
        repo_meta={},
        execution_namespace=identity.namespace,
        execution_contract=dict(identity.contract),
        checkpoint_relpath=identity.checkpoint_relpath,
    )
    if running_run_id is not None:
        insert_run_start(
            conn,
            run_id=running_run_id,
            run_group_id=run_group_id,
            benchmark_id="alpha",
            benchmark_directory="alpha",
            signature="sig-prior-eliza",
            attempt=1,
            agent="eliza",
            provider="claude-subscription",
            model="claude-opus-4-6",
            extra_config={},
            started_at="2026-07-01T00:00:00+00:00",
            command=[],
            cwd=".",
            stdout_path="",
            stderr_path="",
            benchmark_version=None,
            benchmarks_commit=None,
            eliza_commit=None,
            eliza_version=None,
        )
    conn.close()


class _ResumeFakeGateway:
    def __init__(self, workspace_root: Path) -> None:
        self._audit_path = workspace_root / "audit.jsonl"

    def env_for_harness(self, harness: str) -> dict[str, str]:
        return {"CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN": f"token-{harness}"}

    def close(self) -> Path:
        return self._audit_path

    def cleanup_private_checkpoint(self) -> None:
        return None


def test_resumed_cohort_retires_prior_running_rows_before_workers_start(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    adapters = {"alpha": _adapter("alpha", ("eliza",))}
    monkeypatch.setattr(
        cohort_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(adapters=adapters, all_directories=("alpha",)),
    )
    monkeypatch.setattr(cohort_module, "_repo_meta", lambda _root: {})
    identity = _stored_identity()
    monkeypatch.setattr(
        cohort_module,
        "build_phase_execution_identity",
        lambda **_kwargs: identity,
    )
    monkeypatch.setattr(
        cohort_module,
        "_find_reusable_subscription_cohort",
        lambda **_kwargs: None,
    )
    _seed_stored_execution(workspace_root, identity)
    monkeypatch.setattr(
        cohort_module,
        "start_claude_subscription_gateway",
        lambda **_kwargs: _ResumeFakeGateway(workspace_root),
    )
    monkeypatch.setattr(cohort_module, "_attach_gateway_audit", lambda **_kwargs: {})
    prior_status_at_worker_start: list[str] = []

    def fake_run_benchmarks(**kwargs):
        conn = connect_database(
            workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
        )
        row = conn.execute(
            "SELECT status FROM benchmark_runs WHERE run_id = 'run-prior-eliza'"
        ).fetchone()
        conn.close()
        prior_status_at_worker_start.append(str(row["status"]))
        return (
            kwargs["shared_run_group_id"],
            [_outcome("alpha", kwargs["request"].agent)],
            workspace_root / "benchmarks" / "benchmark_results" / "viewer_data.json",
        )

    monkeypatch.setattr(cohort_module, "run_benchmarks", fake_run_benchmarks)
    request = RunRequest(
        benchmarks=("alpha",),
        agent="eliza",
        provider="claude-subscription",
        model="claude-opus-4-6",
        extra_config={},
        resume=True,
    )

    results = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=request,
        harnesses=("eliza",),
    )

    assert results[0].run_group_id == "rgc-prior"
    assert results[0].status == cohort_module.BenchmarkCohortStatus.SUCCEEDED
    assert prior_status_at_worker_start == ["paused_unknown"]
    conn = connect_database(
        workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    )
    rows = {row["run_id"]: row for row in list_runs(conn, limit=None)}
    prior = rows["run-prior-eliza"]
    assert prior["status"] == "paused_unknown"
    assert prior["ended_at"] is not None
    groups = {group["run_group_id"]: group for group in list_run_groups(conn)}
    finished_at = groups["rgc-prior"]["finished_at"]
    assert finished_at is not None
    assert groups["rgc-prior"]["cohort_status"] == "succeeded"

    # The group is now terminal; a later stale sweep must be a strict no-op.
    recovered = recover_stale_running_runs(
        conn,
        stale_before="2100-01-01T00:00:00+00:00",
        ended_at="2100-01-01T00:00:00+00:00",
    )
    groups_after = {
        group["run_group_id"]: group for group in list_run_groups(conn)
    }
    conn.close()
    assert recovered == []
    assert groups_after["rgc-prior"]["finished_at"] == finished_at
    assert groups_after["rgc-prior"]["cohort_status"] == "succeeded"


def test_stored_future_retry_blocks_resume_unless_quota_reset_assumed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = _workspace(tmp_path)
    adapters = {"alpha": _adapter("alpha", ("eliza",))}
    monkeypatch.setattr(
        cohort_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(adapters=adapters, all_directories=("alpha",)),
    )
    monkeypatch.setattr(cohort_module, "_repo_meta", lambda _root: {})
    identity = _stored_identity()
    monkeypatch.setattr(
        cohort_module,
        "build_phase_execution_identity",
        lambda **_kwargs: identity,
    )
    monkeypatch.setattr(
        cohort_module,
        "_find_reusable_subscription_cohort",
        lambda **_kwargs: None,
    )
    _seed_stored_execution(workspace_root, identity)
    retry_at = "2100-01-01T00:00:00+00:00"
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    conn = connect_database(output_root / "orchestrator.sqlite")
    pause_run_group(
        conn,
        run_group_id="rgc-prior",
        status="paused",
        paused_at="2026-07-01T01:00:00+00:00",
        retry_at=retry_at,
        reason="rate_limit",
        metadata={"affected_harnesses": ["eliza"], "active_records": 0},
    )
    conn.close()
    monkeypatch.setattr(
        cohort_module,
        "run_benchmarks",
        lambda **_kwargs: pytest.fail("a future retry_at must not start workers"),
    )
    monkeypatch.setattr(
        cohort_module,
        "start_claude_subscription_gateway",
        lambda **_kwargs: pytest.fail("a future retry_at must not start a gateway"),
    )
    request = RunRequest(
        benchmarks=("alpha",),
        agent="eliza",
        provider="claude-subscription",
        model="claude-opus-4-6",
        extra_config={},
        resume=True,
    )

    blocked = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=request,
        harnesses=("eliza",),
    )

    assert blocked[0].status == cohort_module.BenchmarkCohortStatus.PAUSED
    assert blocked[0].pause_retry_at == retry_at
    assert blocked[0].outcomes == ()

    monkeypatch.setattr(
        cohort_module,
        "start_claude_subscription_gateway",
        lambda **_kwargs: _ResumeFakeGateway(workspace_root),
    )
    monkeypatch.setattr(cohort_module, "_attach_gateway_audit", lambda **_kwargs: {})
    worker_agents: list[str] = []

    def fake_run_benchmarks(**kwargs):
        worker_agents.append(kwargs["request"].agent)
        return (
            kwargs["shared_run_group_id"],
            [_outcome("alpha", kwargs["request"].agent)],
            workspace_root / "benchmarks" / "benchmark_results" / "viewer_data.json",
        )

    monkeypatch.setattr(cohort_module, "run_benchmarks", fake_run_benchmarks)

    resumed = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=request,
        harnesses=("eliza",),
        assume_quota_reset=True,
    )

    assert resumed[0].status == cohort_module.BenchmarkCohortStatus.SUCCEEDED
    assert resumed[0].run_group_id == "rgc-prior"
    assert worker_agents == ["eliza"]
    conn = connect_database(output_root / "orchestrator.sqlite")
    groups = {group["run_group_id"]: group for group in list_run_groups(conn)}
    conn.close()
    assert groups["rgc-prior"]["finished_at"] is not None
    assert groups["rgc-prior"]["cohort_status"] == "succeeded"


def test_prepare_cohort_recovers_stale_namespaceless_groups_only(
    tmp_path: Path,
) -> None:
    workspace_root = _workspace(tmp_path)
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    output_root.mkdir(parents=True, exist_ok=True)
    conn = connect_database(output_root / "orchestrator.sqlite")
    initialize_database(conn)
    for group_id in ("rg-plain-open", "rg-plain-live"):
        create_run_group(
            conn,
            run_group_id=group_id,
            created_at="2026-01-01T00:00:00+00:00",
            request={},
            benchmarks=["alpha"],
            repo_meta={},
        )
    create_run_group(
        conn,
        run_group_id="rg-sub-open",
        created_at="2026-01-01T00:00:00+00:00",
        request={},
        benchmarks=["alpha"],
        repo_meta={},
        execution_namespace="benchmark-phase-v1-open",
        execution_contract={"schema_version": 1},
        checkpoint_relpath=".subscription-checkpoints/open/responses.jsonl",
    )
    fresh_started_at = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    for run_id, group_id, started_at in (
        ("run-plain-stale", "rg-plain-open", "2026-01-01T00:00:00+00:00"),
        ("run-plain-fresh", "rg-plain-live", fresh_started_at),
        ("run-sub-stale", "rg-sub-open", "2026-01-01T00:00:00+00:00"),
    ):
        insert_run_start(
            conn,
            run_id=run_id,
            run_group_id=group_id,
            benchmark_id="alpha",
            benchmark_directory="alpha",
            signature=f"sig-{run_id}",
            attempt=1,
            agent="eliza",
            provider="cerebras",
            model="test-model",
            extra_config={},
            started_at=started_at,
            command=[],
            cwd=".",
            stdout_path="",
            stderr_path="",
            benchmark_version=None,
            benchmarks_commit=None,
            eliza_commit=None,
            eliza_version=None,
        )
    conn.close()

    cohort_module._prepare_cohort(
        workspace_root=workspace_root,
        request=_request("alpha"),
        benchmark_id="alpha",
        run_group_id="rgc-new",
        harnesses=("eliza",),
        requested_harnesses=("eliza",),
        unsupported_harnesses=(),
        repo_meta={},
        execution_identity=None,
        storage_preflight=None,
    )

    conn = connect_database(output_root / "orchestrator.sqlite")
    rows = {row["run_id"]: row for row in list_runs(conn, limit=None)}
    groups = {group["run_group_id"]: group for group in list_run_groups(conn)}
    conn.close()
    assert rows["run-plain-stale"]["status"] == "failed"
    # Younger than the 6h threshold: still considered live, not recovered.
    assert rows["run-plain-fresh"]["status"] == "running"
    assert rows["run-sub-stale"]["status"] == "running"
    assert groups["rg-plain-open"]["cohort_status"] == "failed"
    assert groups["rg-plain-open"]["finished_at"] is not None
    assert groups["rg-plain-live"]["finished_at"] is None
    # The namespaced group keeps its durable pause semantics intact.
    assert groups["rg-sub-open"]["cohort_status"] == "running"
    assert groups["rg-sub-open"]["finished_at"] is None
    assert groups["rgc-new"]["finished_at"] is None


def test_publication_decorator_serializes_thread_writers(tmp_path: Path) -> None:
    active = 0
    maximum = 0
    state_lock = threading.Lock()
    first_entered = threading.Event()
    release_first = threading.Event()

    @serialize_on_output_root(0)
    def write_publication(output_root: Path, worker: str) -> None:
        nonlocal active, maximum
        with state_lock:
            active += 1
            maximum = max(maximum, active)
        if worker == "first":
            first_entered.set()
            assert release_first.wait(timeout=5)
        with state_lock:
            active -= 1

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(write_publication, tmp_path, "first")
        assert first_entered.wait(timeout=5)
        second = executor.submit(write_publication, tmp_path, "second")
        time.sleep(0.05)
        assert not second.done()
        release_first.set()
        first.result(timeout=5)
        second.result(timeout=5)

    assert maximum == 1
