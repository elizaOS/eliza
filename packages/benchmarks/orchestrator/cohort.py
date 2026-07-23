"""Coordinates fair cross-harness benchmark cohorts.

The campaign advances one benchmark at a time while its compatible harnesses
run concurrently under one shared run-group identity. Worker threads only
write their isolated run artifacts and SQLite rows; a single coordinator
finalizes the group and rebuilds generated publications after every worker has
stopped.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from pathlib import Path
from uuid import uuid4

from .adapters import discover_adapters
from .db import (
    connect_database,
    create_run_group,
    fail_running_runs_in_group,
    fail_succeeded_runs_for_publication,
    find_resumable_run_group,
    finish_run_group,
    initialize_database,
    list_run_groups,
    list_runs,
    pause_run_group,
    pause_running_runs_in_group,
    record_run_group_storage_preflight,
    recover_stale_running_runs,
    repair_nonpublishable_success_statuses,
    repair_nonzero_returncode_statuses,
    resume_run_group,
)
from .locking import campaign_execution_lock
from .provider_forwarder import (
    ProviderForwarderProcess,
    is_loopback_url,
    start_provider_forwarder,
)
from .runner import (
    DEFAULT_STALE_RECOVERY_SECONDS,
    OPENAI_COMPAT_BASE_URL,
    PROVIDER_BASE_URL_ENV,
    PROVIDER_DUMMY_KEY,
    PROVIDER_KEY_ENV,
    _ambient_env,
    _ensure_viewer_snapshot,
    _effective_request,
    _is_harness_compatible,
    _publication_quarantine_reason,
    _rebuild_latest_result_snapshots,
    _repair_current_compatibility_statuses,
    _repo_meta,
    _resolve_openai_compat_base_url,
    _signature_for,
    run_benchmarks,
)
from .subscription_gateway import (
    ClaudeSubscriptionGatewayProcess,
    GatewayPauseState,
    GatewayPauseStatus,
    read_gateway_pause_state,
    start_claude_subscription_gateway,
)
from .subscription_provenance import (
    attach_subscription_gateway_provenance,
    build_lifecycle_gateway_content_contract,
    validate_subscription_gateway_audit_artifact,
)
from .types import (
    BenchmarkAdapter,
    BenchmarkRunOutcome,
    LeaderboardComparison,
    RunRequest,
)


DEFAULT_STORAGE_MIN_FREE_BYTES = 8 * 1024**3
DEFAULT_STORAGE_EXPECTED_HEADROOM_BYTES = 4 * 1024**3
DEFAULT_STORAGE_CHECK_INTERVAL_SECONDS = 30.0
_STORAGE_CONTROL_KEYS = frozenset(
    {
        "campaign_storage_min_free_bytes",
        "campaign_storage_expected_headroom_bytes",
        "campaign_storage_check_interval_s",
    }
)
_NAMESPACE_RUNTIME_KEYS = _STORAGE_CONTROL_KEYS | frozenset(
    {
        "_replace_adapter_defaults",
        "campaign_silent_timeout_s",
        "claude_subscription_gateway_url",
        "eliza_bench_http_timeout_s",
        "hermes_timeout_s",
        "hl_bench_command_timeout_s",
        "openclaw_timeout_s",
        "timeout_s",
    }
)
_FINGERPRINT_EXCLUDED_PARTS = frozenset(
    {
        ".cache",
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".turbo",
        ".venv",
        "__pycache__",
        "artifacts",
        "benchmark_results",
        "build",
        "coverage",
        "dist",
        "node_modules",
        "outputs",
        "results",
        "runs",
        "venv",
    }
)


class BenchmarkCohortStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    PAUSED = "paused"
    PAUSED_UNKNOWN = "paused_unknown"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class PhaseExecutionIdentity:
    namespace: str
    contract: Mapping[str, object]
    checkpoint_relpath: str


@dataclass(frozen=True)
class StoragePreflight:
    checked_at: str
    path: str
    free_bytes: int
    min_free_bytes: int
    expected_headroom_bytes: int
    required_bytes: int
    check_interval_seconds: float


class CampaignStoragePreflightError(RuntimeError):
    """Blocks a live cohort before quota is spent on an unsafe filesystem."""

    def __init__(self, preflight: StoragePreflight) -> None:
        self.preflight = preflight
        super().__init__(
            "Benchmark storage preflight failed: "
            f"free_bytes={preflight.free_bytes}, "
            f"required_bytes={preflight.required_bytes}"
        )


@dataclass(frozen=True)
class BenchmarkCohortResult:
    benchmark_id: str
    run_group_id: str | None
    harnesses: tuple[str, ...]
    unsupported_harnesses: tuple[str, ...]
    outcomes: tuple[BenchmarkRunOutcome, ...]
    viewer_snapshot: Path | None
    reused: bool = False
    status: BenchmarkCohortStatus = BenchmarkCohortStatus.SUCCEEDED
    pause_retry_at: str | None = None
    pause_reason: str | None = None


class BenchmarkCohortError(RuntimeError):
    """Reports worker crashes after sibling workers and publication settle."""

    def __init__(
        self,
        *,
        benchmark_id: str,
        run_group_id: str,
        failures: dict[str, Exception],
    ) -> None:
        self.benchmark_id = benchmark_id
        self.run_group_id = run_group_id
        self.failures = dict(failures)
        details = "; ".join(
            f"{harness}={type(error).__name__}: {error}"
            for harness, error in sorted(failures.items())
        )
        super().__init__(
            f"Benchmark cohort {run_group_id} failed for {benchmark_id}: {details}"
        )


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def build_phase_execution_identity(
    *,
    workspace_root: Path,
    adapter: BenchmarkAdapter,
    request: RunRequest,
    harnesses: tuple[str, ...],
    repo_meta: Mapping[str, str | None],
) -> PhaseExecutionIdentity:
    """Build the PID/run-group-independent replay identity for one phase."""

    extra = dict(request.extra_config)
    dataset_config = {
        key: value
        for key, value in extra.items()
        if key not in _NAMESPACE_RUNTIME_KEYS
        and key
        not in {
            "campaign_corpus_sha256",
            "campaign_phase",
            "campaign_profile",
            "reasoning_effort",
        }
    }
    source_fingerprint = _relevant_source_fingerprint(
        workspace_root=workspace_root,
        adapter=adapter,
    )
    explicit_corpus = extra.get("campaign_corpus_sha256")
    if explicit_corpus is not None and (
        not isinstance(explicit_corpus, str) or not explicit_corpus.strip()
    ):
        raise ValueError("campaign_corpus_sha256 must be a non-empty string")
    corpus_sha256 = (
        explicit_corpus.strip()
        if isinstance(explicit_corpus, str)
        else hashlib.sha256(
            _canonical_json(
                {
                    "adapter_directory": adapter.directory,
                    "benchmarks_commit": repo_meta.get("benchmarks_commit"),
                    "dataset_config": dataset_config,
                    "source_fingerprint_sha256": source_fingerprint,
                }
            ).encode("utf-8")
        ).hexdigest()
    )
    contract: dict[str, object] = {
        "schema_version": 1,
        "campaign_profile": str(extra.get("campaign_profile") or "ad-hoc"),
        "benchmark_id": adapter.id,
        "benchmark_directory": adapter.directory,
        "phase": str(extra.get("campaign_phase") or "single"),
        "dataset_config": dataset_config,
        "corpus_sha256": corpus_sha256,
        "source_fingerprint_sha256": source_fingerprint,
        "model": request.model.strip(),
        "provider": request.provider.strip().lower(),
        "reasoning_effort": str(extra.get("reasoning_effort") or "").strip().lower(),
        "harnesses": list(harnesses),
    }
    digest = hashlib.sha256(_canonical_json(contract).encode("utf-8")).hexdigest()
    namespace = f"benchmark-phase-v1-{digest}"
    return PhaseExecutionIdentity(
        namespace=namespace,
        contract=contract,
        checkpoint_relpath=(
            f".subscription-checkpoints/{namespace}/responses.jsonl"
        ),
    )


def _relevant_source_fingerprint(
    *,
    workspace_root: Path,
    adapter: BenchmarkAdapter,
) -> str:
    """Hash dirty source/corpus inputs that a Git HEAD cannot represent."""

    benchmarks_root = workspace_root / "benchmarks"
    candidate_roots = (
        benchmarks_root / adapter.directory,
        benchmarks_root / "orchestrator",
        benchmarks_root / "claude-subscription-gateway",
        benchmarks_root / "eliza-adapter",
        benchmarks_root / "hermes-adapter",
        benchmarks_root / "openclaw-adapter",
        workspace_root.parent / "package.json",
        workspace_root.parent / "bun.lock",
        workspace_root.parent / "bun.lockb",
    )
    files: set[Path] = set()
    for root in candidate_roots:
        if root.is_file():
            files.add(root)
            continue
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            try:
                relative_parts = path.relative_to(root).parts
            except ValueError:
                continue
            if any(part in _FINGERPRINT_EXCLUDED_PARTS for part in relative_parts):
                continue
            if path.is_file() and not path.is_symlink():
                files.add(path)
    digest = hashlib.sha256()
    fingerprint_base = workspace_root.parent
    for path in sorted(files, key=lambda value: value.as_posix()):
        relative = path.relative_to(fingerprint_base).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    return digest.hexdigest()


def _storage_integer(extra: Mapping[str, object], key: str, default: int) -> int:
    value = extra.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer byte count")
    return value


def check_campaign_storage(
    *,
    workspace_root: Path,
    request: RunRequest,
) -> StoragePreflight:
    """Measure conservative reserve plus artifact/journal headroom."""

    min_free_bytes = _storage_integer(
        request.extra_config,
        "campaign_storage_min_free_bytes",
        DEFAULT_STORAGE_MIN_FREE_BYTES,
    )
    expected_headroom_bytes = _storage_integer(
        request.extra_config,
        "campaign_storage_expected_headroom_bytes",
        DEFAULT_STORAGE_EXPECTED_HEADROOM_BYTES,
    )
    interval_value = request.extra_config.get(
        "campaign_storage_check_interval_s",
        DEFAULT_STORAGE_CHECK_INTERVAL_SECONDS,
    )
    if (
        isinstance(interval_value, bool)
        or not isinstance(interval_value, (int, float))
        or float(interval_value) <= 0
    ):
        raise ValueError("campaign_storage_check_interval_s must be positive")
    probe_path = workspace_root
    while not probe_path.exists() and probe_path != probe_path.parent:
        probe_path = probe_path.parent
    free_bytes = int(shutil.disk_usage(probe_path).free)
    required_bytes = min_free_bytes + expected_headroom_bytes
    result = StoragePreflight(
        checked_at=_utc_now(),
        path=str(probe_path.resolve()),
        free_bytes=free_bytes,
        min_free_bytes=min_free_bytes,
        expected_headroom_bytes=expected_headroom_bytes,
        required_bytes=required_bytes,
        check_interval_seconds=float(interval_value),
    )
    if free_bytes < required_bytes:
        raise CampaignStoragePreflightError(result)
    return result


def _checkpoint_paths(
    output_root: Path,
    identity: PhaseExecutionIdentity,
) -> tuple[Path, Path]:
    replay_file = output_root / identity.checkpoint_relpath
    hmac_key_file = Path(f"{replay_file}.hmac-key")
    return replay_file, hmac_key_file


def _storage_payload(preflight: StoragePreflight) -> dict[str, object]:
    return asdict(preflight)


def _cohort_id(benchmark_id: str) -> str:
    safe_benchmark = (
        "".join(
            character if character.isalnum() or character in {"-", "_"} else "-"
            for character in benchmark_id.strip().lower()
        ).strip("-")
        or "benchmark"
    )
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"rgc_{safe_benchmark}_{timestamp}_{uuid4().hex[:8]}"


def _prepare_cohort(
    *,
    workspace_root: Path,
    request: RunRequest,
    benchmark_id: str,
    run_group_id: str,
    harnesses: tuple[str, ...],
    requested_harnesses: tuple[str, ...],
    unsupported_harnesses: tuple[str, ...],
    repo_meta: dict[str, str | None],
    execution_identity: PhaseExecutionIdentity | None,
    storage_preflight: StoragePreflight | None,
) -> None:
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    conn = connect_database(output_root / "orchestrator.sqlite")
    try:
        initialize_database(conn)
        # Standalone runs recover interrupted rows at startup (run_benchmarks);
        # without the same sweep here, a killed non-subscription cohort keeps
        # its rows 'running' and its group open until an operator runs
        # recover-stale-runs by hand. Namespaced (subscription) groups are
        # excluded: their zombie rows are retired by the durable pause/resume
        # path, never by a timeout.
        recover_stale_running_runs(
            conn,
            stale_before=(
                datetime.now(UTC) - timedelta(seconds=DEFAULT_STALE_RECOVERY_SECONDS)
            ).isoformat(),
            ended_at=_utc_now(),
            include_namespaced_groups=False,
        )
        repair_nonzero_returncode_statuses(conn)
        repair_nonpublishable_success_statuses(conn)
        request_payload = asdict(replace(request, benchmarks=(benchmark_id,)))
        request_payload["cohort"] = {
            "run_group_id": run_group_id,
            "benchmark_id": benchmark_id,
            "harnesses": list(harnesses),
            "requested_harnesses": list(requested_harnesses),
            "unsupported_harnesses": list(unsupported_harnesses),
            "execution_mode": "supported_harnesses_concurrent",
        }
        if execution_identity is not None:
            request_payload["cohort"].update(
                {
                    "execution_namespace": execution_identity.namespace,
                    "execution_contract": dict(execution_identity.contract),
                    "checkpoint": {
                        "kind": "private_gateway_replay",
                        "relative_path": execution_identity.checkpoint_relpath,
                    },
                }
            )
        create_run_group(
            conn,
            run_group_id=run_group_id,
            created_at=_utc_now(),
            request=request_payload,
            benchmarks=[benchmark_id],
            repo_meta=repo_meta,
            execution_namespace=(
                execution_identity.namespace if execution_identity is not None else None
            ),
            execution_contract=(
                dict(execution_identity.contract)
                if execution_identity is not None
                else None
            ),
            checkpoint_relpath=(
                execution_identity.checkpoint_relpath
                if execution_identity is not None
                else None
            ),
            storage_preflight=(
                _storage_payload(storage_preflight)
                if storage_preflight is not None
                else None
            ),
        )
    finally:
        conn.close()


def _finalize_cohort(
    *,
    workspace_root: Path,
    run_group_id: str,
    adapters: dict[str, BenchmarkAdapter],
    failures: dict[str, Exception],
    success_cleanup: Callable[[], None] | None = None,
) -> Path:
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    conn = connect_database(output_root / "orchestrator.sqlite")
    try:
        if failures:
            summary = "; ".join(
                f"{harness}={type(error).__name__}: {error}"
                for harness, error in sorted(failures.items())
            )
            fail_running_runs_in_group(
                conn,
                run_group_id=run_group_id,
                ended_at=_utc_now(),
                error=f"Cohort worker crashed: {summary}",
            )
        repair_nonzero_returncode_statuses(conn)
        publication_rejections = _subscription_publication_rejections(
            row
            for row in list_runs(conn, limit=None)
            if str(row.get("run_group_id") or "") == run_group_id
        )
        fail_succeeded_runs_for_publication(
            conn,
            reasons=publication_rejections,
        )
        repair_nonpublishable_success_statuses(conn)
        _repair_current_compatibility_statuses(conn, adapters)
        if publication_rejections:
            details = "; ".join(
                f"{run_id}={reason}"
                for run_id, reason in sorted(publication_rejections.items())
            )
            raise RuntimeError(
                "Claude subscription cohort failed publication integrity: " + details
            )
        if success_cleanup is not None and not failures:
            success_cleanup()
        _rebuild_latest_result_snapshots(conn, output_root, adapters)
        viewer_snapshot = _ensure_viewer_snapshot(
            conn,
            workspace_root=workspace_root,
            benchmark_ids=set(adapters),
        )
        group_rows = [
            row
            for row in list_runs(conn, limit=None)
            if str(row.get("run_group_id") or "") == run_group_id
        ]
        finish_run_group(
            conn,
            run_group_id=run_group_id,
            finished_at=_utc_now(),
            status=(
                "failed"
                if failures
                or any(str(row.get("status") or "") == "failed" for row in group_rows)
                else "succeeded"
            ),
        )
        return viewer_snapshot
    except Exception:
        # error-policy:J1 final publication validation is the cohort boundary;
        # a rejected cohort is durably failed, never left as a success.
        finish_run_group(
            conn,
            run_group_id=run_group_id,
            finished_at=_utc_now(),
            status="failed",
        )
        raise
    finally:
        conn.close()


def _subscription_publication_rejections(
    rows: Iterable[dict[str, object]],
) -> dict[str, str]:
    """Reject scored subscription rows before the campaign advances."""

    rejections: dict[str, str] = {}
    for row in rows:
        if str(row.get("provider") or "").strip().lower() != "claude-subscription":
            continue
        if str(row.get("status") or "") != "succeeded":
            continue
        metrics = row.get("metrics")
        metrics_dict = metrics if isinstance(metrics, dict) else {}
        token_metrics = row.get("token_metrics")
        token_metrics_dict = token_metrics if isinstance(token_metrics, dict) else {}
        reason = _publication_quarantine_reason(
            benchmark_id=str(row.get("benchmark_id") or ""),
            status="succeeded",
            agent=str(row.get("agent") or ""),
            score=row.get("score"),
            token_metrics=token_metrics_dict,
            metrics=metrics_dict,
            provider="claude-subscription",
            model=str(row.get("model") or ""),
        )
        if reason is None:
            gateway_provenance = metrics_dict.get("subscription_gateway_provenance")
            reason = validate_subscription_gateway_audit_artifact(
                gateway_provenance if isinstance(gateway_provenance, dict) else None
            )
        if reason is not None:
            rejections[str(row.get("run_id") or "unknown-run")] = reason
    return rejections


def _run_worker(
    *,
    start_barrier: threading.Barrier,
    workspace_root: Path,
    request: RunRequest,
    harness: str,
    run_group_id: str,
    repo_meta: dict[str, str | None],
    execution_env_overrides: dict[str, str] | None = None,
    execution_cancel_event: threading.Event | None = None,
) -> tuple[str, list[BenchmarkRunOutcome], Path]:
    # A barrier makes the intended fairness contract explicit: no harness gets
    # a head start while the executor is still creating sibling worker threads.
    start_barrier.wait(timeout=30)
    return run_benchmarks(
        workspace_root=workspace_root,
        request=replace(request, agent=harness),
        shared_run_group_id=run_group_id,
        defer_publication=True,
        execution_repo_meta=repo_meta,
        execution_env_overrides=execution_env_overrides,
        execution_cancel_event=execution_cancel_event,
    )


def _forwarder_upstream(
    *,
    workspace_root: Path,
    request: RunRequest,
) -> tuple[str, str] | None:
    """Resolve the remote upstream a non-subscription cohort must reach.

    Returns ``(upstream_base_url, upstream_api_key)`` when the provider's
    resolved OpenAI-compatible endpoint is non-loopback and therefore needs
    the loopback provider forwarder for the hermes/openclaw legs to stay
    publishable. Non-OpenAI-compat providers and already-loopback endpoints
    (e.g. local vllm) return ``None`` and keep the direct path.

    The base URL is resolved with the same precedence and dotenv-loaded
    ambient env the worker's ``_default_env`` uses, so the coordinator's
    decision and the workers' resolution can never disagree. extra_config
    endpoint pins fail closed: registry command builders forward those values
    to benchmark CLIs as literal ``--base-url`` flags, which would bypass the
    per-leg env injection and hand a harness the remote URL directly.
    """

    provider = request.provider.strip().lower()
    if provider not in OPENAI_COMPAT_BASE_URL:
        return None
    ambient_env = _ambient_env(workspace_root)
    resolved_base_url = _resolve_openai_compat_base_url(
        provider, request, ambient_env
    )
    if is_loopback_url(resolved_base_url):
        return None
    for extra_key in (f"{provider}_base_url", "base_url", "model_endpoint"):
        candidate = request.extra_config.get(extra_key)
        if isinstance(candidate, str) and candidate.strip():
            raise ValueError(
                f"extra_config {extra_key!r} pins a non-loopback endpoint; "
                "registry commands forward it to benchmark CLIs as a literal "
                "endpoint flag (--base-url / --model-endpoint) that bypasses "
                "the loopback provider forwarder. Export the URL via "
                f"{PROVIDER_BASE_URL_ENV[provider]} or OPENAI_BASE_URL instead"
            )
    upstream_api_key = (
        ambient_env.get(PROVIDER_KEY_ENV[provider], "").strip()
        or ambient_env.get("OPENAI_API_KEY", "").strip()
        or PROVIDER_DUMMY_KEY.get(provider, "")
    )
    if not upstream_api_key:
        raise RuntimeError(
            f"Provider {provider} resolves to a non-loopback endpoint but "
            f"neither {PROVIDER_KEY_ENV[provider]} nor OPENAI_API_KEY is set; "
            "the loopback provider forwarder cannot authenticate upstream"
        )
    return resolved_base_url, upstream_api_key


def _attach_gateway_audit(
    *,
    workspace_root: Path,
    run_group_id: str,
    audit_path: Path,
) -> dict[str, str]:
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    conn = connect_database(output_root / "orchestrator.sqlite")
    try:
        return attach_subscription_gateway_provenance(
            conn,
            run_group_id=run_group_id,
            audit_path=audit_path,
        )
    finally:
        conn.close()


def _outcome_from_stored_row(row: dict[str, object]) -> BenchmarkRunOutcome:
    return BenchmarkRunOutcome(
        benchmark_id=str(row.get("benchmark_id") or ""),
        run_id=str(row.get("run_id") or ""),
        status="succeeded",
        attempt=int(row.get("attempt") or 0),
        score=float(row["score"]),
        unit=str(row["unit"]) if row.get("unit") is not None else None,
        higher_is_better=(
            bool(row["higher_is_better"])
            if row.get("higher_is_better") is not None
            else None
        ),
        metrics=dict(row.get("metrics") or {}),
        error=None,
        result_json_path=str(row.get("result_json_path") or ""),
        stdout_path=str(row.get("stdout_path") or ""),
        stderr_path=str(row.get("stderr_path") or ""),
        artifacts=[str(value) for value in (row.get("artifacts") or [])],
        comparison=LeaderboardComparison(
            benchmark_id=str(row.get("benchmark_id") or ""),
            high_score_label=(
                str(row["high_score_label"])
                if row.get("high_score_label") is not None
                else None
            ),
            high_score_value=(
                float(row["high_score_value"])
                if row.get("high_score_value") is not None
                else None
            ),
            delta_to_high_score=(
                float(row["delta_to_high_score"])
                if row.get("delta_to_high_score") is not None
                else None
            ),
        ),
        duration_seconds=(
            float(row["duration_seconds"])
            if row.get("duration_seconds") is not None
            else None
        ),
        command=[str(value) for value in (row.get("command") or [])],
        cwd=str(row.get("cwd") or ""),
    )


def _find_reusable_subscription_cohort(
    *,
    workspace_root: Path,
    adapter: BenchmarkAdapter,
    request: RunRequest,
    harnesses: tuple[str, ...],
    execution_identity: PhaseExecutionIdentity,
) -> tuple[str, tuple[BenchmarkRunOutcome, ...]] | None:
    """Find a complete, still-verifiable cohort for an idempotent resume."""

    if request.provider.strip().lower() != "claude-subscription":
        return None
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    db_path = output_root / "orchestrator.sqlite"
    if not db_path.is_file():
        return None
    conn = connect_database(db_path)
    try:
        initialize_database(conn)
        repair_nonzero_returncode_statuses(conn)
        repair_nonpublishable_success_statuses(conn)
        expected_signatures = {
            harness: _signature_for(
                adapter,
                _effective_request(adapter, replace(request, agent=harness)),
            )
            for harness in harnesses
        }
        runs_by_group: dict[str, list[dict[str, object]]] = {}
        for row in list_runs(conn, limit=None):
            runs_by_group.setdefault(str(row.get("run_group_id") or ""), []).append(row)
        for group in list_run_groups(conn, limit=3000):
            request_payload = group.get("request")
            cohort_payload = (
                request_payload.get("cohort")
                if isinstance(request_payload, dict)
                else None
            )
            if not isinstance(cohort_payload, dict):
                continue
            if group.get("execution_namespace") != execution_identity.namespace:
                continue
            if cohort_payload.get("benchmark_id") != adapter.id:
                continue
            if tuple(cohort_payload.get("harnesses") or ()) != harnesses:
                continue
            run_group_id = str(group.get("run_group_id") or "")
            rows = runs_by_group.get(run_group_id, [])
            selected: dict[str, dict[str, object]] = {}
            for row in rows:
                harness = str(row.get("agent") or "").strip().lower()
                if (
                    harness in expected_signatures
                    and row.get("benchmark_id") == adapter.id
                    and row.get("signature") == expected_signatures[harness]
                    and harness not in selected
                ):
                    selected[harness] = row
            valid = (
                group.get("finished_at") is not None
                and group.get("cohort_status") in {None, "succeeded"}
                and all(
                harness in selected for harness in harnesses
                )
            )
            if valid:
                for harness in harnesses:
                    row = selected[harness]
                    metrics = row.get("metrics")
                    metrics_dict = metrics if isinstance(metrics, dict) else {}
                    token_metrics = row.get("token_metrics")
                    token_metrics_dict = (
                        token_metrics if isinstance(token_metrics, dict) else {}
                    )
                    result_json_path = str(row.get("result_json_path") or "")
                    reason = _publication_quarantine_reason(
                        benchmark_id=adapter.id,
                        status=str(row.get("status") or ""),
                        agent=harness,
                        score=row.get("score"),
                        token_metrics=token_metrics_dict,
                        metrics=metrics_dict,
                        provider=str(row.get("provider") or ""),
                        model=str(row.get("model") or ""),
                    )
                    gateway_provenance = metrics_dict.get(
                        "subscription_gateway_provenance"
                    )
                    artifact_reason = validate_subscription_gateway_audit_artifact(
                        gateway_provenance
                        if isinstance(gateway_provenance, dict)
                        else None
                    )
                    if (
                        reason is not None
                        or artifact_reason is not None
                        or not result_json_path
                        or not Path(result_json_path).is_file()
                    ):
                        valid = False
                        break
            if valid:
                return (
                    run_group_id,
                    tuple(_outcome_from_stored_row(selected[h]) for h in harnesses),
                )
            # ``--rerun-failed`` targets the newest matching cohort. Do not
            # hide it behind an older success; the whole three-agent cohort is
            # rerun so timing and inputs remain aligned.
            if request.rerun_failed:
                return None
    finally:
        conn.close()
    return None


def _load_resumable_execution(
    *,
    workspace_root: Path,
    identity: PhaseExecutionIdentity,
) -> dict[str, object] | None:
    db_path = (
        workspace_root
        / "benchmarks"
        / "benchmark_results"
        / "orchestrator.sqlite"
    )
    if not db_path.is_file():
        return None
    conn = connect_database(db_path)
    try:
        initialize_database(conn)
        stored = find_resumable_run_group(
            conn,
            execution_namespace=identity.namespace,
        )
        if stored is None:
            return None
        if _canonical_json(stored.get("execution_contract")) != _canonical_json(
            dict(identity.contract)
        ) or str(stored.get("checkpoint_relpath") or "") != identity.checkpoint_relpath:
            raise RuntimeError(
                "Stored checkpoint identity does not exactly match this phase execution"
            )
        return stored
    finally:
        conn.close()


def _stored_pause_state(stored: Mapping[str, object]) -> GatewayPauseState:
    raw_status = str(stored.get("cohort_status") or "")
    if raw_status not in {"running", "paused", "paused_unknown"}:
        raise RuntimeError(
            "Unfinished replay cohort has an invalid durable status"
        )
    retry_at = stored.get("pause_retry_at")
    pause_reason = str(stored.get("pause_reason") or "orchestrator_interrupted")
    metadata = stored.get("pause_metadata")
    metadata_dict = metadata if isinstance(metadata, dict) else {}
    harnesses_raw = metadata_dict.get("affected_harnesses")
    harnesses = (
        tuple(str(value) for value in harnesses_raw)
        if isinstance(harnesses_raw, list)
        else ()
    )
    active_records = metadata_dict.get("active_records")
    active_count = (
        int(active_records)
        if isinstance(active_records, int) and not isinstance(active_records, bool)
        else 0
    )
    if raw_status == "paused" and isinstance(retry_at, str) and retry_at:
        return GatewayPauseState(
            status=GatewayPauseStatus.PAUSED,
            retry_at=retry_at,
            pause_reason=pause_reason,
            affected_harnesses=harnesses,
            active_records=active_count,
        )
    return GatewayPauseState(
        status=GatewayPauseStatus.PAUSED_UNKNOWN,
        retry_at=None,
        pause_reason=pause_reason,
        affected_harnesses=harnesses,
        active_records=active_count,
    )


def _known_retry_is_future(pause: GatewayPauseState) -> bool:
    if pause.status != GatewayPauseStatus.PAUSED or pause.retry_at is None:
        return False
    try:
        retry_at = datetime.fromisoformat(pause.retry_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError("Stored pause retry_at is not valid ISO-8601") from error
    if retry_at.tzinfo is None:
        raise RuntimeError("Stored pause retry_at is missing a timezone")
    return retry_at.astimezone(UTC) > datetime.now(UTC)


def _resume_cohort(
    *,
    workspace_root: Path,
    run_group_id: str,
    identity: PhaseExecutionIdentity,
    storage_preflight: StoragePreflight,
) -> None:
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    conn = connect_database(output_root / "orchestrator.sqlite")
    try:
        initialize_database(conn)
        resume_run_group(
            conn,
            run_group_id=run_group_id,
            execution_namespace=identity.namespace,
            execution_contract=identity.contract,
            checkpoint_relpath=identity.checkpoint_relpath,
            resumed_at=_utc_now(),
            storage_preflight=_storage_payload(storage_preflight),
        )
        # A killed attempt leaves worker rows behind in 'running', 'failed',
        # or 'succeeded'. Retire all of them before new workers start: the
        # resumed attempt reruns every harness with force=True, so every prior
        # row is superseded. Leaving a 'running' row would let a
        # recover-stale-runs pass flip the group's state hours after it
        # finishes, and leaving a 'failed' row would make _finalize_cohort's
        # any-row-failed check finish an all-green resumed cohort as 'failed'.
        pause_running_runs_in_group(
            conn,
            run_group_id=run_group_id,
            ended_at=_utc_now(),
            error="Superseded by a resumed cohort attempt",
        )
    finally:
        conn.close()


def _persist_gateway_pause(
    *,
    workspace_root: Path,
    run_group_id: str,
    pause: GatewayPauseState,
    extra_metadata: Mapping[str, object] | None = None,
) -> None:
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    conn = connect_database(output_root / "orchestrator.sqlite")
    try:
        initialize_database(conn)
        metadata = {
            "affected_harnesses": list(pause.affected_harnesses),
            "active_records": pause.active_records,
            "reset_category": pause.pause_reason,
            "operator_action": (
                "free_storage_then_resume_same_phase"
                if pause.pause_reason == "storage_reserve"
                else (
                    "wait_then_resume_same_phase"
                    if pause.status == GatewayPauseStatus.PAUSED
                    else "await_operator_or_account_change"
                )
            ),
        }
        metadata.update(dict(extra_metadata or {}))
        pause_run_group(
            conn,
            run_group_id=run_group_id,
            status=pause.status.value,
            paused_at=_utc_now(),
            retry_at=pause.retry_at,
            reason=pause.pause_reason,
            metadata=metadata,
        )
    finally:
        conn.close()


def _record_storage_preflight(
    *,
    workspace_root: Path,
    run_group_id: str,
    preflight: StoragePreflight,
) -> None:
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    conn = connect_database(output_root / "orchestrator.sqlite")
    try:
        record_run_group_storage_preflight(
            conn,
            run_group_id=run_group_id,
            storage_preflight=_storage_payload(preflight),
            checked_at=preflight.checked_at,
        )
    finally:
        conn.close()


def _paused_cohort_result(
    *,
    benchmark_id: str,
    run_group_id: str,
    harnesses: tuple[str, ...],
    unsupported_harnesses: tuple[str, ...],
    pause: GatewayPauseState,
) -> BenchmarkCohortResult:
    return BenchmarkCohortResult(
        benchmark_id=benchmark_id,
        run_group_id=run_group_id,
        harnesses=harnesses,
        unsupported_harnesses=unsupported_harnesses,
        outcomes=(),
        viewer_snapshot=None,
        status=(
            BenchmarkCohortStatus.PAUSED
            if pause.status == GatewayPauseStatus.PAUSED
            else BenchmarkCohortStatus.PAUSED_UNKNOWN
        ),
        pause_retry_at=pause.retry_at,
        pause_reason=pause.pause_reason,
    )


def _refresh_publication(
    *,
    workspace_root: Path,
    adapters: dict[str, BenchmarkAdapter],
) -> Path:
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    conn = connect_database(output_root / "orchestrator.sqlite")
    try:
        initialize_database(conn)
        repair_nonzero_returncode_statuses(conn)
        repair_nonpublishable_success_statuses(conn)
        _repair_current_compatibility_statuses(conn, adapters)
        _rebuild_latest_result_snapshots(conn, output_root, adapters)
        return _ensure_viewer_snapshot(
            conn,
            workspace_root=workspace_root,
            benchmark_ids=set(adapters),
        )
    finally:
        conn.close()


def run_benchmark_cohorts(
    *,
    workspace_root: Path,
    request: RunRequest,
    harnesses: tuple[str, ...],
    stop_after_failed_cohort: bool = True,
    assume_quota_reset: bool = False,
) -> list[BenchmarkCohortResult]:
    """Run compatible harnesses together and benchmarks serially.

    Failed subprocess outcomes stop a multi-benchmark campaign after the
    current cohort, leaving the next benchmark untouched for the operator to
    debug and rerun. Worker crashes raise only after sibling workers have
    stopped and the shared run group has been finalized.

    ``assume_quota_reset`` is the operator's assertion that the subscription
    account behind a stored quota pause was swapped: a known-future
    ``retry_at`` then no longer blocks a ``resume``. The override is
    fail-closed — a still-latched gateway immediately re-pauses the cohort
    with a fresh ``retry_at``.
    """

    normalized_harnesses = tuple(
        dict.fromkeys(value.strip().lower() for value in harnesses if value.strip())
    )
    if not normalized_harnesses:
        raise ValueError("At least one harness is required for a benchmark cohort")

    discovery = discover_adapters(workspace_root)
    benchmark_ids = list(request.benchmarks) or sorted(discovery.adapters)
    missing = sorted(set(benchmark_ids) - set(discovery.adapters))
    if missing:
        raise ValueError(f"Unknown benchmark IDs: {', '.join(missing)}")

    if request.provider.strip().lower() == "claude-subscription":
        # Fail without even allocating the results directory or campaign lock.
        check_campaign_storage(workspace_root=workspace_root, request=request)
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    output_root.mkdir(parents=True, exist_ok=True)
    campaign_repo_meta = _repo_meta(workspace_root)
    results: list[BenchmarkCohortResult] = []

    with campaign_execution_lock(output_root):
        for benchmark_id in benchmark_ids:
            adapter = discovery.adapters[benchmark_id]
            supported = tuple(
                harness
                for harness in normalized_harnesses
                if _is_harness_compatible(adapter, harness)
            )
            unsupported = tuple(
                harness for harness in normalized_harnesses if harness not in supported
            )
            if not supported:
                results.append(
                    BenchmarkCohortResult(
                        benchmark_id=benchmark_id,
                        run_group_id=None,
                        harnesses=(),
                        unsupported_harnesses=unsupported,
                        outcomes=(),
                        viewer_snapshot=None,
                        status=BenchmarkCohortStatus.UNSUPPORTED,
                    )
                )
                continue

            cohort_request = replace(request, benchmarks=(benchmark_id,))
            is_subscription = (
                cohort_request.provider.strip().lower() == "claude-subscription"
            )
            execution_identity = (
                build_phase_execution_identity(
                    workspace_root=workspace_root,
                    adapter=adapter,
                    request=cohort_request,
                    harnesses=supported,
                    repo_meta=campaign_repo_meta,
                )
                if is_subscription
                else None
            )
            if not cohort_request.force:
                reusable = (
                    _find_reusable_subscription_cohort(
                        workspace_root=workspace_root,
                        adapter=adapter,
                        request=cohort_request,
                        harnesses=supported,
                        execution_identity=execution_identity,
                    )
                    if execution_identity is not None
                    else None
                )
                if reusable is not None:
                    reused_run_group_id, reused_outcomes = reusable
                    viewer_snapshot = _refresh_publication(
                        workspace_root=workspace_root,
                        adapters=discovery.adapters,
                    )
                    results.append(
                        BenchmarkCohortResult(
                            benchmark_id=benchmark_id,
                            run_group_id=reused_run_group_id,
                            harnesses=supported,
                            unsupported_harnesses=unsupported,
                            outcomes=reused_outcomes,
                            viewer_snapshot=viewer_snapshot,
                            reused=True,
                        )
                    )
                    continue

            stored_execution: dict[str, object] | None = None
            storage_preflight: StoragePreflight | None = None
            if is_subscription:
                if execution_identity is None:
                    raise RuntimeError("Subscription cohort lost execution identity")
                stored_execution = _load_resumable_execution(
                    workspace_root=workspace_root,
                    identity=execution_identity,
                )
                if stored_execution is not None:
                    pause = _stored_pause_state(stored_execution)
                    should_remain_paused = not cohort_request.resume or (
                        not assume_quota_reset and _known_retry_is_future(pause)
                    )
                    if (
                        should_remain_paused
                        and str(stored_execution.get("cohort_status") or "") == "running"
                    ):
                        _persist_gateway_pause(
                            workspace_root=workspace_root,
                            run_group_id=str(stored_execution["run_group_id"]),
                            pause=pause,
                        )
                    if should_remain_paused:
                        results.append(
                            _paused_cohort_result(
                                benchmark_id=benchmark_id,
                                run_group_id=str(stored_execution["run_group_id"]),
                                harnesses=supported,
                                unsupported_harnesses=unsupported,
                                pause=pause,
                            )
                        )
                        break
                # This is the final check before auth status, gateway process
                # allocation, or any harness/model process can start.
                storage_preflight = check_campaign_storage(
                    workspace_root=workspace_root,
                    request=cohort_request,
                )

            if stored_execution is not None:
                if execution_identity is None or storage_preflight is None:
                    raise RuntimeError("Resumable subscription execution lost identity")
                run_group_id = str(stored_execution["run_group_id"])
                _resume_cohort(
                    workspace_root=workspace_root,
                    run_group_id=run_group_id,
                    identity=execution_identity,
                    storage_preflight=storage_preflight,
                )
            else:
                run_group_id = _cohort_id(benchmark_id)
                _prepare_cohort(
                    workspace_root=workspace_root,
                    request=cohort_request,
                    benchmark_id=benchmark_id,
                    run_group_id=run_group_id,
                    harnesses=supported,
                    requested_harnesses=normalized_harnesses,
                    unsupported_harnesses=unsupported,
                    repo_meta=campaign_repo_meta,
                    execution_identity=execution_identity,
                    storage_preflight=storage_preflight,
                )
            worker_request = (
                replace(
                    cohort_request,
                    force=True,
                    resume=False,
                    rerun_failed=False,
                )
                if cohort_request.provider.strip().lower() == "claude-subscription"
                else cohort_request
            )

            start_barrier = threading.Barrier(len(supported))
            futures: dict[str, Future[tuple[str, list[BenchmarkRunOutcome], Path]]] = {}
            worker_outcomes: dict[str, tuple[BenchmarkRunOutcome, ...]] = {}
            failures: dict[str, Exception] = {}
            viewer_snapshot: Path | None = None
            gateway: ClaudeSubscriptionGatewayProcess | None = None
            forwarder: ProviderForwarderProcess | None = None
            gateway_pause: GatewayPauseState | None = None
            storage_pause_preflight: StoragePreflight | None = None
            execution_cancel_event = threading.Event()
            try:
                if is_subscription:
                    if execution_identity is None or storage_preflight is None:
                        raise RuntimeError("Subscription cohort lost execution identity")
                    replay_file, hmac_key_file = _checkpoint_paths(
                        output_root,
                        execution_identity,
                    )
                    gateway = start_claude_subscription_gateway(
                        workspace_root=workspace_root,
                        run_group_id=run_group_id,
                        harnesses=supported,
                        benchmark_namespace=execution_identity.namespace,
                        replay_file=replay_file,
                        hmac_key_file=hmac_key_file,
                        storage_root=workspace_root,
                        minimum_free_bytes=storage_preflight.required_bytes,
                        content_attestation_contract=(
                            build_lifecycle_gateway_content_contract(workspace_root)
                            if benchmark_id == "orchestrator_lifecycle"
                            else None
                        ),
                    )
                else:
                    forwarder_target = _forwarder_upstream(
                        workspace_root=workspace_root,
                        request=cohort_request,
                    )
                    if forwarder_target is not None:
                        forwarder = start_provider_forwarder(
                            run_group_id=run_group_id,
                            provider=cohort_request.provider.strip().lower(),
                            harnesses=supported,
                            upstream_base_url=forwarder_target[0],
                            upstream_api_key=forwarder_target[1],
                            evidence_dir=(
                                output_root / run_group_id / "provider-forwarder"
                            ),
                        )
                with ThreadPoolExecutor(
                    max_workers=len(supported),
                    thread_name_prefix=f"benchmark-{benchmark_id}",
                ) as executor:
                    for harness in supported:
                        futures[harness] = executor.submit(
                            _run_worker,
                            start_barrier=start_barrier,
                            workspace_root=workspace_root,
                            request=worker_request,
                            harness=harness,
                            run_group_id=run_group_id,
                            repo_meta=campaign_repo_meta,
                            execution_env_overrides=(
                                gateway.env_for_harness(harness)
                                if gateway is not None
                                else (
                                    forwarder.env_for_harness(harness)
                                    if forwarder is not None
                                    else None
                                )
                            ),
                            execution_cancel_event=execution_cancel_event,
                        )
                    pending = set(futures.values())
                    harness_by_future = {
                        future: harness for harness, future in futures.items()
                    }
                    next_storage_check: float | None = (
                        time.monotonic() + storage_preflight.check_interval_seconds
                        if storage_preflight is not None
                        else None
                    )
                    while pending:
                        timeout = (
                            max(0.0, next_storage_check - time.monotonic())
                            if next_storage_check is not None
                            else None
                        )
                        completed, pending = wait(
                            pending,
                            timeout=timeout,
                            return_when=FIRST_COMPLETED,
                        )
                        if not completed:
                            if storage_preflight is not None:
                                try:
                                    storage_preflight = check_campaign_storage(
                                        workspace_root=workspace_root,
                                        request=cohort_request,
                                    )
                                except CampaignStoragePreflightError as error:
                                    storage_pause_preflight = error.preflight
                                    gateway_pause = GatewayPauseState(
                                        status=GatewayPauseStatus.PAUSED_UNKNOWN,
                                        retry_at=None,
                                        pause_reason="storage_reserve",
                                        affected_harnesses=supported,
                                        active_records=0,
                                    )
                                    _persist_gateway_pause(
                                        workspace_root=workspace_root,
                                        run_group_id=run_group_id,
                                        pause=gateway_pause,
                                        extra_metadata={
                                            "storage_preflight": _storage_payload(
                                                error.preflight
                                            )
                                        },
                                    )
                                    execution_cancel_event.set()
                                    if gateway is not None:
                                        gateway.close()
                                    storage_preflight = None
                                    next_storage_check = None
                                    continue
                                _record_storage_preflight(
                                    workspace_root=workspace_root,
                                    run_group_id=run_group_id,
                                    preflight=storage_preflight,
                                )
                                next_storage_check = (
                                    time.monotonic()
                                    + storage_preflight.check_interval_seconds
                                )
                            continue
                        for future in completed:
                            harness = harness_by_future[future]
                            try:
                                worker_group_id, outcomes, _viewer = future.result()
                                if worker_group_id != run_group_id:
                                    raise RuntimeError(
                                        "Cohort worker returned a different run-group identity: "
                                        f"expected {run_group_id}, got {worker_group_id}"
                                    )
                                worker_outcomes[harness] = tuple(outcomes)
                            except Exception as error:
                                # error-policy:J1 settle every sibling before
                                # surfacing worker crashes.
                                failures[harness] = error
                    for harness in supported:
                        if harness in worker_outcomes or harness in failures:
                            continue
                        try:
                            futures[harness].result()
                        except Exception as error:
                            failures[harness] = error
            except Exception as error:
                # error-policy:J1 the coordinator owns gateway startup and
                # executor creation, and always finalizes the shared group.
                failures["coordinator-execution"] = error
            finally:
                if forwarder is not None:
                    try:
                        forwarder.close()
                    except Exception as error:
                        # error-policy:J1 forwarder shutdown is a required
                        # cohort boundary: a loopback boundary that died
                        # mid-cohort durably fails the group even when every
                        # worker already finished.
                        failures["provider-forwarder"] = error
                if gateway is not None:
                    try:
                        audit_path = gateway.close()
                        audit_pause = read_gateway_pause_state(audit_path)
                        if gateway_pause is None:
                            gateway_pause = audit_pause
                        if gateway_pause is None:
                            audit_reasons = _attach_gateway_audit(
                                workspace_root=workspace_root,
                                run_group_id=run_group_id,
                                audit_path=audit_path,
                            )
                            if audit_reasons:
                                details = "; ".join(
                                    f"{run_id}={reason}"
                                    for run_id, reason in sorted(audit_reasons.items())
                                )
                                raise RuntimeError(
                                    "Claude subscription gateway evidence rejected: "
                                    f"{details}"
                                )
                    except Exception as error:
                        # error-policy:J1 gateway shutdown/audit is a required
                        # cohort boundary, not best-effort telemetry.
                        failures["subscription-gateway-audit"] = error
                if gateway_pause is not None:
                    try:
                        _persist_gateway_pause(
                            workspace_root=workspace_root,
                            run_group_id=run_group_id,
                            pause=gateway_pause,
                            extra_metadata=(
                                {
                                    "storage_preflight": _storage_payload(
                                        storage_pause_preflight
                                    )
                                }
                                if storage_pause_preflight is not None
                                else None
                            ),
                        )
                    except Exception as error:
                        # error-policy:J1 a pause is not durable until all late
                        # worker rows are transitioned after sibling settlement.
                        failures["coordinator-pause-persistence"] = error
                if gateway_pause is None:
                    try:
                        viewer_snapshot = _finalize_cohort(
                            workspace_root=workspace_root,
                            run_group_id=run_group_id,
                            adapters=discovery.adapters,
                            failures=failures,
                            success_cleanup=(
                                gateway.cleanup_private_checkpoint
                                if gateway is not None and not failures
                                else None
                            ),
                        )
                    except Exception as error:
                        # error-policy:J1 preserve worker and publication failures together.
                        failures["coordinator-publication"] = error

            if gateway_pause is not None:
                if "coordinator-pause-persistence" in failures:
                    raise BenchmarkCohortError(
                        benchmark_id=benchmark_id,
                        run_group_id=run_group_id,
                        failures=failures,
                    ) from failures["coordinator-pause-persistence"]
                cohort_result = _paused_cohort_result(
                    benchmark_id=benchmark_id,
                    run_group_id=run_group_id,
                    harnesses=supported,
                    unsupported_harnesses=unsupported,
                    pause=gateway_pause,
                )
                results.append(cohort_result)
                break

            if failures:
                raise BenchmarkCohortError(
                    benchmark_id=benchmark_id,
                    run_group_id=run_group_id,
                    failures=failures,
                ) from next(iter(failures.values()))

            ordered_outcomes = tuple(
                outcome for harness in supported for outcome in worker_outcomes[harness]
            )
            if viewer_snapshot is None:
                raise RuntimeError(
                    f"Benchmark cohort {run_group_id} did not publish viewer data"
                )
            cohort_result = BenchmarkCohortResult(
                benchmark_id=benchmark_id,
                run_group_id=run_group_id,
                harnesses=supported,
                unsupported_harnesses=unsupported,
                outcomes=ordered_outcomes,
                viewer_snapshot=viewer_snapshot,
                status=(
                    BenchmarkCohortStatus.FAILED
                    if any(outcome.status == "failed" for outcome in ordered_outcomes)
                    else BenchmarkCohortStatus.SUCCEEDED
                ),
            )
            results.append(cohort_result)
            if stop_after_failed_cohort and any(
                outcome.status == "failed" for outcome in ordered_outcomes
            ):
                break

    return results
