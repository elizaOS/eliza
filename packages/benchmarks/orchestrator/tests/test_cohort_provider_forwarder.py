"""Exercises the cohort coordinator's provider-forwarder wiring: a remote
OpenAI-compatible cohort gets per-leg loopback env injection from a real
forwarder, loopback endpoints keep the direct path, extra_config endpoint pins
and forwarder death fail the group, and run signatures are forwarder-blind."""

from __future__ import annotations

import json
from http.client import HTTPConnection
from pathlib import Path

import pytest

from benchmarks.orchestrator import cohort as cohort_module
from benchmarks.orchestrator import runner as runner_module
from benchmarks.orchestrator.db import connect_database, list_run_groups
from benchmarks.orchestrator.provider_forwarder import (
    ForwarderLifecycleError,
    is_loopback_url,
)
from benchmarks.orchestrator.types import (
    AdapterDiscovery,
    BenchmarkAdapter,
    BenchmarkRunOutcome,
    LeaderboardComparison,
    RunRequest,
    ScoreSummary,
)

REMOTE_BASE_URL = "https://elizacloud.ai/api/v1"
REMOTE_KEY = "real-upstream-secret-key"
_AMBIENT_VARS = (
    "OPENAI_BASE_URL",
    "BENCHMARK_BASE_URL",
    "CEREBRAS_BASE_URL",
    "VLLM_BASE_URL",
    "OPENAI_API_KEY",
    "CEREBRAS_API_KEY",
    "VLLM_API_KEY",
)


@pytest.fixture(autouse=True)
def _clean_ambient_provider_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _AMBIENT_VARS:
        monkeypatch.delenv(name, raising=False)


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


def _outcome(benchmark_id: str, harness: str) -> BenchmarkRunOutcome:
    return BenchmarkRunOutcome(
        benchmark_id=benchmark_id,
        run_id=f"run-{benchmark_id}-{harness}",
        status="succeeded",
        attempt=1,
        score=1.0,
        unit="ratio",
        higher_is_better=True,
        metrics={},
        error=None,
        result_json_path=None,
        stdout_path="",
        stderr_path="",
        artifacts=[],
        comparison=LeaderboardComparison(benchmark_id, None, None, None),
        duration_seconds=0.01,
        command=[],
        cwd=".",
    )


def _workspace(tmp_path: Path) -> Path:
    workspace_root = tmp_path / "packages"
    (workspace_root / "benchmarks").mkdir(parents=True)
    return workspace_root


def _wire_alpha_cohort(
    monkeypatch: pytest.MonkeyPatch,
    workspace_root: Path,
    worker_envs: dict[str, dict[str, str] | None],
    captured_requests: dict[str, RunRequest],
) -> dict[str, BenchmarkAdapter]:
    adapters = {"alpha": _adapter("alpha", ("eliza", "hermes", "openclaw"))}
    monkeypatch.setattr(
        cohort_module,
        "discover_adapters",
        lambda _root: AdapterDiscovery(adapters=adapters, all_directories=("alpha",)),
    )
    monkeypatch.setattr(cohort_module, "_repo_meta", lambda _root: {})

    def fake_run_benchmarks(**kwargs):
        request = kwargs["request"]
        worker_envs[request.agent] = kwargs["execution_env_overrides"]
        captured_requests[request.agent] = request
        return (
            kwargs["shared_run_group_id"],
            [_outcome("alpha", request.agent)],
            workspace_root / "benchmarks" / "benchmark_results" / "viewer_data.json",
        )

    monkeypatch.setattr(cohort_module, "run_benchmarks", fake_run_benchmarks)
    return adapters


def _request(provider: str, extra_config: dict[str, object] | None = None) -> RunRequest:
    return RunRequest(
        benchmarks=("alpha",),
        agent="eliza",
        provider=provider,
        model="gemma-4-31b",
        extra_config=dict(extra_config or {}),
        force=True,
    )


def _group_statuses(workspace_root: Path) -> list[str | None]:
    conn = connect_database(
        workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    )
    try:
        return [group.get("cohort_status") for group in list_run_groups(conn)]
    finally:
        conn.close()


def test_remote_cerebras_cohort_injects_loopback_env_per_leg(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace_root = _workspace(tmp_path)
    worker_envs: dict[str, dict[str, str] | None] = {}
    captured: dict[str, RunRequest] = {}
    _wire_alpha_cohort(monkeypatch, workspace_root, worker_envs, captured)
    monkeypatch.setenv("CEREBRAS_BASE_URL", REMOTE_BASE_URL)
    monkeypatch.setenv("CEREBRAS_API_KEY", REMOTE_KEY)

    started = []
    real_start = cohort_module.start_provider_forwarder

    def start_wrapper(**kwargs):
        assert kwargs["upstream_base_url"] == REMOTE_BASE_URL
        assert kwargs["upstream_api_key"] == REMOTE_KEY
        assert kwargs["harnesses"] == ("eliza", "hermes", "openclaw")
        forwarder = real_start(**kwargs)
        started.append(forwarder)
        return forwarder

    monkeypatch.setattr(cohort_module, "start_provider_forwarder", start_wrapper)

    results = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=_request("cerebras"),
        harnesses=("eliza", "hermes", "openclaw"),
    )

    assert len(results) == 1
    assert results[0].status == cohort_module.BenchmarkCohortStatus.SUCCEEDED
    assert len(started) == 1
    forwarder = started[0]
    assert is_loopback_url(forwarder.base_url)
    assert forwarder.base_url.startswith("http://127.0.0.1:")

    tokens: set[str] = set()
    for harness in ("eliza", "hermes", "openclaw"):
        env = worker_envs[harness]
        assert env is not None
        assert env["OPENAI_BASE_URL"] == forwarder.base_url
        assert env["BENCHMARK_BASE_URL"] == forwarder.base_url
        assert env["CEREBRAS_BASE_URL"] == forwarder.base_url
        assert env["OPENAI_API_KEY"] == env["CEREBRAS_API_KEY"]
        # The real upstream key stays confined to the coordinator process.
        assert REMOTE_KEY not in env.values()
        tokens.add(env["OPENAI_API_KEY"])
    assert len(tokens) == 3

    # Per-cohort lifecycle: the coordinator closed the forwarder and the
    # finalized evidence lives under the run group.
    port = int(forwarder.base_url.rsplit(":", 1)[1].split("/", 1)[0])
    probe = HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        with pytest.raises(ConnectionRefusedError):
            probe.request("GET", "/health")
            probe.getresponse()
    finally:
        probe.close()
    evidence = json.loads(forwarder.evidence_file.read_text(encoding="utf-8"))
    assert evidence["upstream_host"] == "elizacloud.ai"
    assert evidence["closed_at"] is not None
    assert forwarder.evidence_file.parent.name == "provider-forwarder"
    assert forwarder.evidence_file.parent.parent.name == results[0].run_group_id
    assert _group_statuses(workspace_root) == ["succeeded"]


def test_loopback_vllm_cohort_keeps_direct_path_without_forwarder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace_root = _workspace(tmp_path)
    worker_envs: dict[str, dict[str, str] | None] = {}
    captured: dict[str, RunRequest] = {}
    _wire_alpha_cohort(monkeypatch, workspace_root, worker_envs, captured)

    def fail_start(**_kwargs):
        raise AssertionError("loopback cohorts must not start a forwarder")

    monkeypatch.setattr(cohort_module, "start_provider_forwarder", fail_start)

    results = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=_request("vllm"),
        harnesses=("eliza", "hermes", "openclaw"),
    )

    assert results[0].status == cohort_module.BenchmarkCohortStatus.SUCCEEDED
    assert worker_envs == {"eliza": None, "hermes": None, "openclaw": None}


def test_non_openai_compat_provider_never_consults_forwarder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace_root = _workspace(tmp_path)
    worker_envs: dict[str, dict[str, str] | None] = {}
    captured: dict[str, RunRequest] = {}
    _wire_alpha_cohort(monkeypatch, workspace_root, worker_envs, captured)
    monkeypatch.setenv("OPENAI_BASE_URL", REMOTE_BASE_URL)

    def fail_start(**_kwargs):
        raise AssertionError("non-OpenAI-compat providers must not start a forwarder")

    monkeypatch.setattr(cohort_module, "start_provider_forwarder", fail_start)

    results = cohort_module.run_benchmark_cohorts(
        workspace_root=workspace_root,
        request=_request("anthropic"),
        harnesses=("eliza",),
    )

    assert results[0].status == cohort_module.BenchmarkCohortStatus.SUCCEEDED
    assert worker_envs == {"eliza": None}


def test_extra_config_endpoint_pin_fails_the_group_before_workers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace_root = _workspace(tmp_path)
    worker_envs: dict[str, dict[str, str] | None] = {}
    captured: dict[str, RunRequest] = {}
    _wire_alpha_cohort(monkeypatch, workspace_root, worker_envs, captured)
    monkeypatch.setenv("CEREBRAS_API_KEY", REMOTE_KEY)

    with pytest.raises(cohort_module.BenchmarkCohortError) as excinfo:
        cohort_module.run_benchmark_cohorts(
            workspace_root=workspace_root,
            request=_request("cerebras", {"base_url": REMOTE_BASE_URL}),
            harnesses=("eliza", "hermes", "openclaw"),
        )

    failure = excinfo.value.failures["coordinator-execution"]
    assert "--base-url" in str(failure)
    assert "CEREBRAS_BASE_URL" in str(failure)
    # No worker ran and the group is durably failed.
    assert worker_envs == {}
    assert _group_statuses(workspace_root) == ["failed"]


def test_missing_upstream_key_fails_closed_before_workers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace_root = _workspace(tmp_path)
    worker_envs: dict[str, dict[str, str] | None] = {}
    captured: dict[str, RunRequest] = {}
    _wire_alpha_cohort(monkeypatch, workspace_root, worker_envs, captured)
    monkeypatch.setenv("CEREBRAS_BASE_URL", REMOTE_BASE_URL)

    with pytest.raises(cohort_module.BenchmarkCohortError) as excinfo:
        cohort_module.run_benchmark_cohorts(
            workspace_root=workspace_root,
            request=_request("cerebras"),
            harnesses=("eliza", "hermes", "openclaw"),
        )

    failure = excinfo.value.failures["coordinator-execution"]
    assert "OPENAI_API_KEY" in str(failure)
    assert worker_envs == {}
    assert _group_statuses(workspace_root) == ["failed"]


def test_forwarder_death_fails_the_group_even_after_worker_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace_root = _workspace(tmp_path)
    worker_envs: dict[str, dict[str, str] | None] = {}
    captured: dict[str, RunRequest] = {}
    _wire_alpha_cohort(monkeypatch, workspace_root, worker_envs, captured)
    monkeypatch.setenv("CEREBRAS_BASE_URL", REMOTE_BASE_URL)
    monkeypatch.setenv("CEREBRAS_API_KEY", REMOTE_KEY)

    class DeadForwarder:
        base_url = "http://127.0.0.1:59999/v1"

        def env_for_harness(self, harness: str) -> dict[str, str]:
            return {"OPENAI_BASE_URL": self.base_url}

        def close(self) -> Path:
            raise ForwarderLifecycleError(
                "Provider forwarder serving thread exited before close"
            )

    monkeypatch.setattr(
        cohort_module,
        "start_provider_forwarder",
        lambda **_kwargs: DeadForwarder(),
    )

    with pytest.raises(cohort_module.BenchmarkCohortError) as excinfo:
        cohort_module.run_benchmark_cohorts(
            workspace_root=workspace_root,
            request=_request("cerebras"),
            harnesses=("eliza", "hermes", "openclaw"),
        )

    assert isinstance(
        excinfo.value.failures["provider-forwarder"], ForwarderLifecycleError
    )
    # Workers all succeeded, yet the dead boundary durably fails the group.
    assert set(worker_envs) == {"eliza", "hermes", "openclaw"}
    assert _group_statuses(workspace_root) == ["failed"]


def test_run_signatures_are_identical_with_and_without_forwarder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    adapter = _adapter("alpha", ("eliza", "hermes", "openclaw"))

    def run_and_capture(remote: bool, subdir: str) -> dict[str, str]:
        workspace_root = _workspace(tmp_path / subdir)
        worker_envs: dict[str, dict[str, str] | None] = {}
        captured: dict[str, RunRequest] = {}
        _wire_alpha_cohort(monkeypatch, workspace_root, worker_envs, captured)
        if remote:
            monkeypatch.setenv("CEREBRAS_BASE_URL", REMOTE_BASE_URL)
            monkeypatch.setenv("CEREBRAS_API_KEY", REMOTE_KEY)
        else:
            monkeypatch.delenv("CEREBRAS_BASE_URL", raising=False)
            monkeypatch.delenv("CEREBRAS_API_KEY", raising=False)
            monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:8001/v1")
        cohort_module.run_benchmark_cohorts(
            workspace_root=workspace_root,
            request=_request("cerebras", {"seed": 7}),
            harnesses=("eliza", "hermes", "openclaw"),
        )
        expected_overrides = remote
        for harness, env in worker_envs.items():
            assert (env is not None) is expected_overrides, harness
        return {
            harness: runner_module._signature_for(
                adapter,
                runner_module._effective_request(adapter, request),
            )
            for harness, request in captured.items()
        }

    forwarded = run_and_capture(remote=True, subdir="remote")
    direct = run_and_capture(remote=False, subdir="loopback")

    assert set(forwarded) == {"eliza", "hermes", "openclaw"}
    # The forwarder rides env injection only: the persisted request — and
    # therefore the idempotency signature — is byte-identical either way.
    assert forwarded == direct
