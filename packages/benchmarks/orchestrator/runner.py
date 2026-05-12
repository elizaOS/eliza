from __future__ import annotations

import hashlib
import json
import os
import shlex
import subprocess
import sys
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .adapters import discover_adapters
from .db import (
    connect_database,
    create_run_group,
    finish_run_group,
    get_latest_run_for_signature,
    get_latest_succeeded_run_for_signature,
    initialize_database,
    insert_run_start,
    list_runs,
    next_attempt_for_signature,
    recover_stale_running_runs,
    repair_nonzero_returncode_statuses,
    replace_run_trajectories,
    update_run_result,
)
from .env_utils import git_head, load_env_file, merged_environment, safe_version_from_package_json
from .leaderboard import delta_to_high_score
from .analyze_trajectory import summarize as summarize_trajectory
from .random_baseline_runner import run_random_baseline
from .trajectory_normalize_hook import normalize_outcome_trajectories
from .types import (
    BenchmarkAdapter,
    BenchmarkRunOutcome,
    ExecutionContext,
    LeaderboardComparison,
    RunRequest,
)

PROVIDER_KEY_ENV: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "groq": "GROQ_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "vllm": "VLLM_API_KEY",
    "cerebras": "CEREBRAS_API_KEY",
}
OPENAI_COMPAT_BASE_URL: dict[str, str] = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "vllm": "http://127.0.0.1:8001/v1",
    "cerebras": "https://api.cerebras.ai/v1",
}
# Providers whose API key has no real secret value (self-hosted endpoints).
PROVIDER_DUMMY_KEY: dict[str, str] = {
    "vllm": "dummy",
}
DEFAULT_STALE_RECOVERY_SECONDS = 300


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _sanitize_name(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in value.strip().lower())
    cleaned = cleaned.strip("-")
    return cleaned or "item"


def _signature_for(adapter: BenchmarkAdapter, request: RunRequest) -> str:
    payload = {
        "benchmark_id": adapter.id,
        "benchmark_directory": adapter.directory,
        "agent": request.agent,
        "provider": request.provider,
        "model": request.model,
        "extra_config": request.extra_config,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")).hexdigest()


def _effective_request(adapter: BenchmarkAdapter, request: RunRequest) -> RunRequest:
    request_extra = dict(request.extra_config)
    per_benchmark = request_extra.pop("per_benchmark", None)
    per_benchmark_extra: dict[str, Any] = {}
    if isinstance(per_benchmark, dict):
        adapter_specific = per_benchmark.get(adapter.id)
        if isinstance(adapter_specific, dict):
            per_benchmark_extra = dict(adapter_specific)

    merged_extra = dict(adapter.default_extra_config)
    merged_extra.update(per_benchmark_extra)
    merged_extra.update(request_extra)
    explicit_agent = "agent" in per_benchmark_extra or "agent" in request_extra
    agent_label = request.agent.strip()
    if agent_label and not explicit_agent and agent_label != "compare":
        merged_extra["agent"] = agent_label
    if (
        adapter.id == "trust"
        and agent_label.lower() in {"eliza", "hermes", "openclaw"}
        and "handler" not in per_benchmark_extra
        and "handler" not in request_extra
    ):
        merged_extra["handler"] = "eliza"
    if agent_label:
        merged_extra.setdefault("harness", agent_label)
    return RunRequest(
        benchmarks=request.benchmarks,
        agent=request.agent,
        provider=request.provider,
        model=request.model,
        extra_config=merged_extra,
        resume=request.resume,
        rerun_failed=request.rerun_failed,
        force=request.force,
    )


def _is_harness_compatible(adapter: BenchmarkAdapter, harness_label: str) -> bool:
    if not harness_label or harness_label == "random_v1":
        return True
    if harness_label == "compare":
        # Model/provider compare is valid for normal multi-harness adapters,
        # but not for adapters that run a single concrete implementation under
        # the hood. CompactBench is currently Eliza-only; compare-mode rows
        # would still exercise Eliza's TypeScript compactor.
        return len(adapter.agent_compatibility) > 1
    return harness_label in adapter.agent_compatibility


def _result_subdir(run_root: Path, adapter: BenchmarkAdapter, run_id: str) -> Path:
    return run_root / f"{_sanitize_name(adapter.directory)}__{_sanitize_name(adapter.id)}" / run_id


def _provider_model_name(provider: str, model: str) -> str:
    provider = provider.strip().lower()
    model = model.strip()
    if provider == "cerebras" and model.startswith("openai/"):
        return model.split("/", 1)[1]
    return model


def _default_env(workspace_root: Path, request: RunRequest) -> dict[str, str]:
    env = dict(os.environ)
    load_env_file(workspace_root / "eliza" / ".env")
    load_env_file(workspace_root / ".env")
    load_env_file(workspace_root.parent / ".env")
    load_env_file(workspace_root.parent.parent / ".env")
    env = dict(os.environ)
    python_bin = str(Path(sys.executable).parent)
    path_entries = [python_bin]
    for candidate in (
        Path.home() / ".bun" / "bin",
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
    ):
        if candidate.exists():
            path_entries.append(str(candidate))
    existing_path = env.get("PATH", "")
    if existing_path:
        path_entries.append(existing_path)
    env["PATH"] = os.pathsep.join(path_entries)
    env["PYTHONUNBUFFERED"] = "1"
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    plugin_python_paths: list[str] = []
    plugins_root = workspace_root / "plugins"
    if plugins_root.exists():
        for candidate in sorted(plugins_root.glob("*/python")):
            if candidate.is_dir():
                plugin_python_paths.append(str(candidate))
    benchmarks_root = workspace_root / "benchmarks"
    adapter_python_paths = [
        str((benchmarks_root / "eliza-adapter").resolve()),
        str((benchmarks_root / "hermes-adapter").resolve()),
        str((benchmarks_root / "openclaw-adapter").resolve()),
    ]
    workspace_python = [
        str(workspace_root),
        str(workspace_root / "eliza" / "packages" / "python"),
        *adapter_python_paths,
        *plugin_python_paths,
    ]
    existing_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        os.pathsep.join(workspace_python + [existing_pythonpath])
        if existing_pythonpath
        else os.pathsep.join(workspace_python)
    )
    provider = request.provider.strip().lower()
    model_name = _provider_model_name(provider, request.model)
    harness = request.agent.strip().lower() or "eliza"
    env["BENCHMARK_MODEL_PROVIDER"] = provider or request.provider
    env["BENCHMARK_MODEL_NAME"] = model_name
    env["BENCHMARK_HARNESS"] = harness
    env["ELIZA_BENCH_HARNESS"] = harness
    env["BENCHMARK_AGENT"] = harness
    env["MILADY_PROVIDER"] = provider or request.provider
    env["MODEL_NAME"] = model_name
    env["OPENAI_MODEL"] = model_name
    env["ANTHROPIC_MODEL"] = model_name
    env["OPENAI_LARGE_MODEL"] = model_name
    env["OPENAI_SMALL_MODEL"] = model_name
    env["GROQ_LARGE_MODEL"] = model_name
    env["GROQ_SMALL_MODEL"] = model_name
    env["OPENROUTER_LARGE_MODEL"] = model_name
    env["OPENROUTER_SMALL_MODEL"] = model_name
    env["CEREBRAS_MODEL"] = model_name
    env["CEREBRAS_LARGE_MODEL"] = model_name
    env["CEREBRAS_SMALL_MODEL"] = model_name
    env.setdefault("ELIZA_ACTION_COMPACTION", "true")
    env.setdefault("ELIZA_CONVERSATION_COMPACTOR", "structured-state")
    env.setdefault("MAX_CONVERSATION_TOKENS", "120000")
    env.setdefault("BENCHMARK_CAPTURE_TRAJECTORIES", "1")
    if provider in PROVIDER_DUMMY_KEY:
        provider_key = PROVIDER_KEY_ENV.get(provider)
        if provider_key and not env.get(provider_key):
            env[provider_key] = PROVIDER_DUMMY_KEY[provider]
    if provider in OPENAI_COMPAT_BASE_URL:
        provider_key = PROVIDER_KEY_ENV.get(provider)
        if provider_key and env.get(provider_key):
            env["OPENAI_API_KEY"] = env[provider_key]
        base_url_override = (
            request.extra_config.get("vllm_base_url")
            if provider == "vllm"
            else None
        )
        if isinstance(base_url_override, str) and base_url_override.strip():
            env["OPENAI_BASE_URL"] = base_url_override.strip()
            env["VLLM_BASE_URL"] = base_url_override.strip()
        elif provider == "vllm" and env.get("VLLM_BASE_URL"):
            env["OPENAI_BASE_URL"] = env["VLLM_BASE_URL"]
        else:
            env["OPENAI_BASE_URL"] = OPENAI_COMPAT_BASE_URL[provider]
        if provider == "cerebras":
            env["CEREBRAS_BASE_URL"] = env["OPENAI_BASE_URL"]
    return env


def _repo_meta(workspace_root: Path) -> dict[str, str | None]:
    benchmarks_root = workspace_root / "benchmarks"
    eliza_root = workspace_root / "eliza"
    return {
        "benchmarks_commit": git_head(benchmarks_root),
        "eliza_commit": git_head(eliza_root),
        "eliza_version": safe_version_from_package_json(eliza_root / "package.json"),
        "benchmarks_version": safe_version_from_package_json(benchmarks_root / "package.json"),
    }


def _status_after_returncode(returncode: int) -> str:
    return "succeeded" if returncode == 0 else "failed"


def _required_env_for_request(adapter: BenchmarkAdapter, request: RunRequest) -> tuple[str, ...]:
    provider = request.provider.strip().lower()
    required = list(adapter.required_env)
    provider_key = PROVIDER_KEY_ENV.get(provider)
    if provider_key:
        required = [key for key in required if key not in PROVIDER_KEY_ENV.values()]
        required.append(provider_key)
    seen: set[str] = set()
    deduped: list[str] = []
    for key in required:
        if key in seen:
            continue
        seen.add(key)
        deduped.append(key)
    return tuple(deduped)


def _ensure_viewer_snapshot(
    conn,
    *,
    workspace_root: Path,
) -> Path:
    from .viewer_data import build_viewer_dataset

    data = build_viewer_dataset(conn)
    out = workspace_root / "benchmarks" / "benchmark_results" / "viewer_data.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=2, ensure_ascii=True), encoding="utf-8")
    return out


def _collect_run_trajectory_metrics(run_root: Path, *, duration_seconds: float) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    summary, records = summarize_trajectory(run_root)
    trajectory_summary = {
        "files": summary.files,
        "turns": summary.turns,
        "prompt_chars": summary.prompt_chars,
        "repeated_prefixes": [
            {"snippet": snippet, "count": count}
            for snippet, count in summary.repeated_prefixes
        ],
    }
    token_metrics = {
        "llm_call_count": summary.turns,
        "prompt_tokens": summary.prompt_tokens,
        "completion_tokens": summary.completion_tokens,
        "total_tokens": summary.total_tokens,
        "avg_prompt_tokens": (summary.prompt_tokens / summary.turns) if summary.turns else 0.0,
        "avg_completion_tokens": (summary.completion_tokens / summary.turns) if summary.turns else 0.0,
    }
    cache_metrics = {
        "cache_read_input_tokens": summary.cached_tokens,
        "cache_creation_input_tokens": summary.cache_creation_tokens,
        "turns_with_cached_field": summary.turns_with_cached_field,
        "cache_hit_ratio": summary.cache_hit_ratio,
    }
    throughput = (summary.turns / duration_seconds) if duration_seconds > 0 else None
    performance_metrics = {
        "duration_seconds": duration_seconds,
        "mean_latency_ms": summary.mean_latency_ms,
        "p95_latency_ms": summary.p95_latency_ms,
        "throughput_per_second": throughput,
    }
    trajectory_rows = [
        {
            "trajectory_file": record.file,
            "turn_index": record.index,
            "prompt_tokens": record.tokens.prompt,
            "completion_tokens": record.tokens.completion,
            "total_tokens": record.tokens.total or (record.tokens.prompt + record.tokens.completion),
            "cached_tokens": record.tokens.cached,
            "cache_creation_tokens": record.tokens.cache_creation,
            "latency_ms": record.latency_ms,
            "prompt_chars": len(record.prompt_text),
        }
        for record in records
    ]
    return trajectory_summary, token_metrics, cache_metrics, performance_metrics, trajectory_rows


def _write_latest_result_snapshot(
    output_root: Path,
    *,
    adapter: BenchmarkAdapter,
    request: RunRequest,
    run_group_id: str,
    run_id: str,
    status: str,
    score: float | None,
    unit: str | None,
    higher_is_better: bool | None,
    metrics: dict[str, Any],
    trajectory_summary: dict[str, Any] | None = None,
    token_metrics: dict[str, Any] | None = None,
    cache_metrics: dict[str, Any] | None = None,
    performance_metrics: dict[str, Any] | None = None,
    result_json_path: str | None = None,
    artifacts: list[str] | None = None,
    error: str | None = None,
) -> Path:
    latest_dir = output_root / "latest"
    latest_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path = latest_dir / f"{_sanitize_name(adapter.id)}__{_sanitize_name(request.agent)}.json"
    payload = {
        "updated_at": _utc_now(),
        "benchmark_id": adapter.id,
        "benchmark_directory": adapter.directory,
        "run_group_id": run_group_id,
        "run_id": run_id,
        "status": status,
        "agent": request.agent,
        "provider": request.provider,
        "model": request.model,
        "score": score,
        "unit": unit,
        "higher_is_better": higher_is_better,
        "metrics": metrics,
        "trajectory_summary": trajectory_summary or {},
        "token_metrics": token_metrics or {},
        "cache_metrics": cache_metrics or {},
        "performance_metrics": performance_metrics or {},
        "result_json_path": result_json_path,
        "artifacts": artifacts or [],
        "error": error,
    }
    snapshot_path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True), encoding="utf-8")

    index: dict[str, Any] = {"updated_at": _utc_now(), "latest": {}}
    for path in sorted(latest_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        key = f"{data.get('benchmark_id')}::{data.get('agent')}"
        index["latest"][key] = {
            "path": str(path),
            "run_id": data.get("run_id"),
            "status": data.get("status"),
            "updated_at": data.get("updated_at"),
        }
    (latest_dir / "index.json").write_text(json.dumps(index, indent=2, sort_keys=True, ensure_ascii=True), encoding="utf-8")
    return snapshot_path


def _rebuild_latest_result_snapshots(conn, output_root: Path) -> None:
    """Rebuild latest snapshots from SQLite.

    This keeps ``benchmark_results/latest`` idempotent even when a single
    benchmark is rerun, a stale snapshot was manually removed, or a compatibility
    rule changes. The latest row per ``(benchmark_id, agent)`` is the source of
    truth; files not represented by SQLite are pruned.
    """

    latest_dir = output_root / "latest"
    latest_dir.mkdir(parents=True, exist_ok=True)

    latest_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for row in list_runs(conn, limit=100000):
        benchmark_id = str(row.get("benchmark_id") or "")
        agent = str(row.get("agent") or "")
        if not benchmark_id or not agent:
            continue
        key = (benchmark_id, agent)
        if key not in latest_by_key:
            latest_by_key[key] = row

    expected_paths: set[Path] = set()
    index: dict[str, Any] = {"updated_at": _utc_now(), "latest": {}}
    for (benchmark_id, agent), row in sorted(latest_by_key.items()):
        snapshot_path = latest_dir / f"{_sanitize_name(benchmark_id)}__{_sanitize_name(agent)}.json"
        expected_paths.add(snapshot_path)
        payload = {
            "updated_at": row.get("ended_at") or row.get("started_at") or _utc_now(),
            "benchmark_id": benchmark_id,
            "benchmark_directory": row.get("benchmark_directory"),
            "run_group_id": row.get("run_group_id"),
            "run_id": row.get("run_id"),
            "status": row.get("status"),
            "agent": agent,
            "provider": row.get("provider"),
            "model": row.get("model"),
            "score": row.get("score"),
            "unit": row.get("unit"),
            "higher_is_better": row.get("higher_is_better"),
            "metrics": row.get("metrics") or {},
            "trajectory_summary": row.get("trajectory_summary") or {},
            "token_metrics": row.get("token_metrics") or {},
            "cache_metrics": row.get("cache_metrics") or {},
            "performance_metrics": row.get("performance_metrics") or {},
            "result_json_path": row.get("result_json_path"),
            "artifacts": row.get("artifacts") or [],
            "error": row.get("error"),
        }
        snapshot_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True),
            encoding="utf-8",
        )
        index["latest"][f"{benchmark_id}::{agent}"] = {
            "path": str(snapshot_path),
            "run_id": row.get("run_id"),
            "status": row.get("status"),
            "updated_at": payload["updated_at"],
        }

    index_path = latest_dir / "index.json"
    expected_paths.add(index_path)
    for path in latest_dir.glob("*.json"):
        if path not in expected_paths:
            path.unlink()
    index_path.write_text(
        json.dumps(index, indent=2, sort_keys=True, ensure_ascii=True),
        encoding="utf-8",
    )


def _run_random_v1_outcome(
    conn,
    *,
    adapter: BenchmarkAdapter,
    effective_request: RunRequest,
    signature: str,
    run_group_id: str,
    output_root: Path,
    run_root: Path,
    repo_meta: dict[str, str | None],
) -> BenchmarkRunOutcome:
    """Synthesize a ``random_v1`` outcome for one benchmark.

    Inserts a new ``benchmark_runs`` row (no subprocess), runs the
    benchmark's own ``score_extractor`` over a generated result file
    when the strategy is meaningful, or records an ``incompatible``
    row otherwise. The function reuses ``replace_run_trajectories``
    only to clear any stale entries — random_v1 does not produce
    real trajectory rows.
    """
    attempt = next_attempt_for_signature(conn, signature)
    now_compact = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_id = f"random_{adapter.id}_{now_compact}_{attempt}_{uuid4().hex[:8]}"
    bench_run_root = _result_subdir(run_root, adapter, run_id)
    bench_run_root.mkdir(parents=True, exist_ok=True)
    bench_output_root = bench_run_root / "output"
    bench_output_root.mkdir(parents=True, exist_ok=True)

    started_at = _utc_now()
    insert_run_start(
        conn,
        run_id=run_id,
        run_group_id=run_group_id,
        benchmark_id=adapter.id,
        benchmark_directory=adapter.directory,
        signature=signature,
        attempt=attempt,
        agent="random_v1",
        provider=effective_request.provider,
        model=effective_request.model,
        extra_config=effective_request.extra_config,
        started_at=started_at,
        command=["<random_v1-synthetic>"],
        cwd=adapter.cwd,
        stdout_path="",
        stderr_path="",
        benchmark_version=repo_meta.get("benchmarks_version"),
        benchmarks_commit=repo_meta.get("benchmarks_commit"),
        eliza_commit=repo_meta.get("eliza_commit"),
        eliza_version=repo_meta.get("eliza_version"),
    )

    baseline = run_random_baseline(
        benchmark_id=adapter.id,
        output_dir=bench_output_root,
        score=0.0,
    )

    metrics: dict[str, Any] = {
        "random_baseline_strategy": baseline.strategy_name,
        "random_baseline_is_meaningful": baseline.is_meaningful,
        "return_code": 0,
    }
    if baseline.note:
        metrics["random_baseline_note"] = baseline.note

    score: float | None = None
    unit: str | None = None
    higher_is_better: bool | None = None
    error: str | None = None
    result_path: Path | None = baseline.result_path
    status = baseline.status

    if baseline.status == "incompatible":
        error = baseline.note
    elif baseline.status == "succeeded":
        if result_path is not None and result_path.exists():
            try:
                summary = adapter.score_extractor(result_path)
                score = summary.score
                unit = summary.unit
                higher_is_better = summary.higher_is_better
                metrics.update(summary.metrics)
            except Exception as exc:  # noqa: BLE001 — extractor failure must surface
                status = "failed"
                error = f"random_v1 score extraction failed: {exc}"
                metrics["score_extraction_error"] = str(exc)
        else:
            score = baseline.score
            unit = "ratio"
            higher_is_better = True

    high_label, high_value, delta = delta_to_high_score(adapter.id, score)

    update_run_result(
        conn,
        run_id=run_id,
        status=status,
        ended_at=_utc_now(),
        duration_seconds=0.0,
        score=score,
        unit=unit,
        higher_is_better=higher_is_better,
        metrics=metrics,
        result_json_path=str(result_path) if result_path else None,
        artifacts=[str(bench_output_root)],
        error=error,
        high_score_label=high_label,
        high_score_value=high_value,
        delta_to_high_score=delta,
    )
    replace_run_trajectories(conn, run_id=run_id, trajectories=[])

    outcome = BenchmarkRunOutcome(
        benchmark_id=adapter.id,
        run_id=run_id,
        status=status,  # type: ignore[arg-type]
        attempt=attempt,
        score=score,
        unit=unit,
        higher_is_better=higher_is_better,
        metrics=metrics,
        error=error,
        result_json_path=str(result_path) if result_path else None,
        stdout_path="",
        stderr_path="",
        artifacts=[str(bench_output_root)],
        comparison=LeaderboardComparison(
            benchmark_id=adapter.id,
            high_score_label=high_label,
            high_score_value=high_value,
            delta_to_high_score=delta,
        ),
        duration_seconds=0.0,
        command=["<random_v1-synthetic>"],
        cwd=adapter.cwd,
    )
    _write_latest_result_snapshot(
        output_root,
        adapter=adapter,
        request=effective_request,
        run_group_id=run_group_id,
        run_id=run_id,
        status=status,
        score=score,
        unit=unit,
        higher_is_better=higher_is_better,
        metrics=metrics,
        result_json_path=str(result_path) if result_path else None,
        artifacts=[str(bench_output_root)],
        error=error,
    )
    return outcome


def run_benchmarks(
    *,
    workspace_root: Path,
    request: RunRequest,
) -> tuple[str, list[BenchmarkRunOutcome], Path]:
    benchmarks_root = workspace_root / "benchmarks"
    output_root = benchmarks_root / "benchmark_results"
    output_root.mkdir(parents=True, exist_ok=True)
    run_group_id = f"rg_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}_{uuid4().hex[:8]}"
    run_root = output_root / run_group_id
    run_root.mkdir(parents=True, exist_ok=True)

    discovery = discover_adapters(workspace_root)
    selected_ids = list(request.benchmarks)
    if not selected_ids:
        selected_ids = sorted(discovery.adapters.keys())

    missing = [bid for bid in selected_ids if bid not in discovery.adapters]
    if missing:
        raise ValueError(f"Unknown benchmark IDs: {', '.join(sorted(missing))}")

    conn = connect_database(output_root / "orchestrator.sqlite")
    initialize_database(conn)
    stale_before = datetime.now(UTC).timestamp() - DEFAULT_STALE_RECOVERY_SECONDS
    stale_before_iso = datetime.fromtimestamp(stale_before, tz=UTC).isoformat()
    recover_stale_running_runs(
        conn,
        stale_before=stale_before_iso,
        ended_at=_utc_now(),
    )
    repair_nonzero_returncode_statuses(conn)

    repo_meta = _repo_meta(workspace_root)
    base_env = _default_env(workspace_root, request)

    create_run_group(
        conn,
        run_group_id=run_group_id,
        created_at=_utc_now(),
        request=asdict(request),
        benchmarks=selected_ids,
        repo_meta=repo_meta,
    )

    outcomes: list[BenchmarkRunOutcome] = []

    for benchmark_id in selected_ids:
        adapter = discovery.adapters[benchmark_id]
        effective_request = _effective_request(adapter, request)
        signature = _signature_for(adapter, effective_request)

        if request.agent.strip().lower() == "random_v1":
            outcome = _run_random_v1_outcome(
                conn,
                adapter=adapter,
                effective_request=effective_request,
                signature=signature,
                run_group_id=run_group_id,
                output_root=output_root,
                run_root=run_root,
                repo_meta=repo_meta,
            )
            outcomes.append(outcome)
            continue

        # Harness/agent compatibility — if the harness is not in the adapter's
        # supported list, record an ``incompatible`` outcome and skip without
        # spawning the subprocess. ``random_v1`` is a synthetic baseline and is
        # handled above. ``compare`` is allowed only for multi-harness adapters.
        harness_label = request.agent.strip().lower()
        if not _is_harness_compatible(adapter, harness_label):
            attempt = next_attempt_for_signature(conn, signature)
            run_id = (
                f"incompat_{adapter.id}_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
                f"_{attempt}_{uuid4().hex[:8]}"
            )
            started_at = _utc_now()
            insert_run_start(
                conn,
                run_id=run_id,
                run_group_id=run_group_id,
                benchmark_id=adapter.id,
                benchmark_directory=adapter.directory,
                signature=signature,
                attempt=attempt,
                agent=effective_request.agent,
                provider=effective_request.provider,
                model=effective_request.model,
                extra_config=effective_request.extra_config,
                started_at=started_at,
                command=[],
                cwd=adapter.cwd,
                stdout_path="",
                stderr_path="",
                benchmark_version=repo_meta.get("benchmarks_version"),
                benchmarks_commit=repo_meta.get("benchmarks_commit"),
                eliza_commit=repo_meta.get("eliza_commit"),
                eliza_version=repo_meta.get("eliza_version"),
            )
            incompat_metrics: dict[str, Any] = {
                "reason": "harness_not_in_compatibility",
                "harness": harness_label,
                "supported_harnesses": list(adapter.agent_compatibility),
            }
            incompat_error = (
                f"Benchmark '{adapter.id}' is not compatible with harness "
                f"'{harness_label}' (supported: {', '.join(adapter.agent_compatibility)})"
            )
            update_run_result(
                conn,
                run_id=run_id,
                status="incompatible",
                ended_at=_utc_now(),
                duration_seconds=0.0,
                score=None,
                unit=None,
                higher_is_better=None,
                metrics=incompat_metrics,
                result_json_path=None,
                artifacts=[],
                error=incompat_error,
                high_score_label=None,
                high_score_value=None,
                delta_to_high_score=None,
            )
            outcome = BenchmarkRunOutcome(
                benchmark_id=adapter.id,
                run_id=run_id,
                status="incompatible",
                attempt=attempt,
                score=None,
                unit=None,
                higher_is_better=None,
                metrics=incompat_metrics,
                error=incompat_error,
                result_json_path=None,
                stdout_path="",
                stderr_path="",
                artifacts=[],
                comparison=LeaderboardComparison(
                    benchmark_id=adapter.id,
                    high_score_label=None,
                    high_score_value=None,
                    delta_to_high_score=None,
                ),
                duration_seconds=0.0,
                command=[],
                cwd=adapter.cwd,
            )
            outcomes.append(outcome)
            _write_latest_result_snapshot(
                output_root,
                adapter=adapter,
                request=effective_request,
                run_group_id=run_group_id,
                run_id=run_id,
                status="incompatible",
                score=None,
                unit=None,
                higher_is_better=None,
                metrics=outcome.metrics,
                error=outcome.error,
            )
            continue

        if not request.force and not request.rerun_failed:
            existing_success = get_latest_succeeded_run_for_signature(conn, signature)
            if existing_success is not None:
                attempt = next_attempt_for_signature(conn, signature)
                run_id = (
                    f"skip_{adapter.id}_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
                    f"_{attempt}_{uuid4().hex[:8]}"
                )
                started_at = _utc_now()
                insert_run_start(
                    conn,
                    run_id=run_id,
                    run_group_id=run_group_id,
                    benchmark_id=adapter.id,
                    benchmark_directory=adapter.directory,
                    signature=signature,
                    attempt=attempt,
                    agent=effective_request.agent,
                    provider=effective_request.provider,
                    model=effective_request.model,
                    extra_config=effective_request.extra_config,
                    started_at=started_at,
                    command=[],
                    cwd=adapter.cwd,
                    stdout_path="",
                    stderr_path="",
                    benchmark_version=repo_meta.get("benchmarks_version"),
                    benchmarks_commit=repo_meta.get("benchmarks_commit"),
                    eliza_commit=repo_meta.get("eliza_commit"),
                    eliza_version=repo_meta.get("eliza_version"),
                )
                update_run_result(
                    conn,
                    run_id=run_id,
                    status="skipped",
                    ended_at=_utc_now(),
                    duration_seconds=0.0,
                    score=None,
                    unit=None,
                    higher_is_better=None,
                    metrics={
                        "reason": "already_succeeded",
                        "signature": signature,
                        "existing_succeeded_run_id": existing_success.run_id,
                    },
                    result_json_path=None,
                    artifacts=[],
                    error=None,
                    high_score_label=None,
                    high_score_value=None,
                    delta_to_high_score=None,
                )
                outcome = BenchmarkRunOutcome(
                    benchmark_id=adapter.id,
                    run_id=run_id,
                    status="skipped",
                    attempt=attempt,
                    score=None,
                    unit=None,
                    higher_is_better=None,
                    metrics={
                        "reason": "already_succeeded",
                        "signature": signature,
                        "existing_succeeded_run_id": existing_success.run_id,
                    },
                    error=None,
                    result_json_path=None,
                    stdout_path="",
                    stderr_path="",
                    artifacts=[],
                    comparison=LeaderboardComparison(
                        benchmark_id=adapter.id,
                        high_score_label=None,
                        high_score_value=None,
                        delta_to_high_score=None,
                    ),
                    duration_seconds=0.0,
                    command=[],
                    cwd=adapter.cwd,
                )
                outcomes.append(outcome)
                continue

        if request.rerun_failed and not request.force:
            latest = get_latest_run_for_signature(conn, signature)
            if latest is not None and latest.status == "succeeded":
                attempt = next_attempt_for_signature(conn, signature)
                run_id = (
                    f"skip_{adapter.id}_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
                    f"_{attempt}_{uuid4().hex[:8]}"
                )
                started_at = _utc_now()
                insert_run_start(
                    conn,
                    run_id=run_id,
                    run_group_id=run_group_id,
                    benchmark_id=adapter.id,
                    benchmark_directory=adapter.directory,
                    signature=signature,
                    attempt=attempt,
                    agent=effective_request.agent,
                    provider=effective_request.provider,
                    model=effective_request.model,
                    extra_config=effective_request.extra_config,
                    started_at=started_at,
                    command=[],
                    cwd=adapter.cwd,
                    stdout_path="",
                    stderr_path="",
                    benchmark_version=repo_meta.get("benchmarks_version"),
                    benchmarks_commit=repo_meta.get("benchmarks_commit"),
                    eliza_commit=repo_meta.get("eliza_commit"),
                    eliza_version=repo_meta.get("eliza_version"),
                )
                update_run_result(
                    conn,
                    run_id=run_id,
                    status="skipped",
                    ended_at=_utc_now(),
                    duration_seconds=0.0,
                    score=None,
                    unit=None,
                    higher_is_better=None,
                    metrics={
                        "reason": "latest_status_succeeded",
                        "signature": signature,
                        "latest_run_id": latest.run_id,
                    },
                    result_json_path=None,
                    artifacts=[],
                    error=None,
                    high_score_label=None,
                    high_score_value=None,
                    delta_to_high_score=None,
                )
                outcome = BenchmarkRunOutcome(
                    benchmark_id=adapter.id,
                    run_id=run_id,
                    status="skipped",
                    attempt=attempt,
                    score=None,
                    unit=None,
                    higher_is_better=None,
                    metrics={
                        "reason": "latest_status_succeeded",
                        "signature": signature,
                        "latest_run_id": latest.run_id,
                    },
                    error=None,
                    result_json_path=None,
                    stdout_path="",
                    stderr_path="",
                    artifacts=[],
                    comparison=LeaderboardComparison(
                        benchmark_id=adapter.id,
                        high_score_label=None,
                        high_score_value=None,
                        delta_to_high_score=None,
                    ),
                    duration_seconds=0.0,
                    command=[],
                    cwd=adapter.cwd,
                )
                outcomes.append(outcome)
                continue

        required_env = _required_env_for_request(adapter, effective_request)
        required_missing = [key for key in required_env if not base_env.get(key)]
        if required_missing:
            attempt = next_attempt_for_signature(conn, signature)
            run_id = (
                f"incompat_{adapter.id}_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
                f"_{attempt}_{uuid4().hex[:8]}"
            )
            started_at = _utc_now()
            insert_run_start(
                conn,
                run_id=run_id,
                run_group_id=run_group_id,
                benchmark_id=adapter.id,
                benchmark_directory=adapter.directory,
                signature=signature,
                attempt=attempt,
                agent=effective_request.agent,
                provider=effective_request.provider,
                model=effective_request.model,
                extra_config=effective_request.extra_config,
                started_at=started_at,
                command=[],
                cwd=adapter.cwd,
                stdout_path="",
                stderr_path="",
                benchmark_version=repo_meta.get("benchmarks_version"),
                benchmarks_commit=repo_meta.get("benchmarks_commit"),
                eliza_commit=repo_meta.get("eliza_commit"),
                eliza_version=repo_meta.get("eliza_version"),
            )
            update_run_result(
                conn,
                run_id=run_id,
                status="incompatible",
                ended_at=_utc_now(),
                duration_seconds=0.0,
                score=None,
                unit=None,
                higher_is_better=None,
                metrics={"missing_env": required_missing},
                result_json_path=None,
                artifacts=[],
                error=f"Missing required env vars: {', '.join(required_missing)}",
                high_score_label=None,
                high_score_value=None,
                delta_to_high_score=None,
            )
            outcome = BenchmarkRunOutcome(
                benchmark_id=adapter.id,
                run_id=run_id,
                status="incompatible",
                attempt=attempt,
                score=None,
                unit=None,
                higher_is_better=None,
                metrics={"missing_env": required_missing},
                error=f"Missing required env vars: {', '.join(required_missing)}",
                result_json_path=None,
                stdout_path="",
                stderr_path="",
                artifacts=[],
                comparison=LeaderboardComparison(
                    benchmark_id=adapter.id,
                    high_score_label=None,
                    high_score_value=None,
                    delta_to_high_score=None,
                ),
                duration_seconds=0.0,
                command=[],
                cwd=adapter.cwd,
            )
            outcomes.append(outcome)
            _write_latest_result_snapshot(
                output_root,
                adapter=adapter,
                request=effective_request,
                run_group_id=run_group_id,
                run_id=run_id,
                status="incompatible",
                score=None,
                unit=None,
                higher_is_better=None,
                metrics=outcome.metrics,
                error=outcome.error,
            )
            continue

        attempt = next_attempt_for_signature(conn, signature)
        run_id = f"run_{adapter.id}_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}_{attempt}_{uuid4().hex[:8]}"
        bench_run_root = _result_subdir(run_root, adapter, run_id)
        bench_run_root.mkdir(parents=True, exist_ok=True)
        bench_output_root = bench_run_root / "output"
        bench_output_root.mkdir(parents=True, exist_ok=True)
        stdout_path = bench_run_root / "stdout.log"
        stderr_path = bench_run_root / "stderr.log"

        ctx = ExecutionContext(
            workspace_root=workspace_root,
            benchmarks_root=benchmarks_root,
            output_root=bench_output_root,
            run_root=bench_run_root,
            request=effective_request,
            run_group_id=run_group_id,
            env=base_env,
            repo_meta=repo_meta,
        )

        command = adapter.command_builder(ctx, adapter)
        env_overrides = dict(adapter.env_overrides)
        if adapter.env_builder is not None:
            env_overrides.update({k: str(v) for k, v in adapter.env_builder(ctx, adapter).items()})
        run_env = merged_environment(base_env, env_overrides)
        run_env["BENCHMARK_RUN_ID"] = run_id
        run_env["BENCHMARK_RUN_ROOT"] = str(bench_run_root)
        run_env["BENCHMARK_OUTPUT_ROOT"] = str(bench_output_root)
        run_env["BENCHMARK_TELEMETRY_JSONL"] = str(bench_output_root / "harness-telemetry.jsonl")

        insert_run_start(
            conn,
            run_id=run_id,
            run_group_id=run_group_id,
            benchmark_id=adapter.id,
            benchmark_directory=adapter.directory,
            signature=signature,
            attempt=attempt,
            agent=effective_request.agent,
            provider=effective_request.provider,
            model=effective_request.model,
            extra_config=effective_request.extra_config,
            started_at=_utc_now(),
            command=command,
            cwd=adapter.cwd,
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            benchmark_version=repo_meta.get("benchmarks_version"),
            benchmarks_commit=repo_meta.get("benchmarks_commit"),
            eliza_commit=repo_meta.get("eliza_commit"),
            eliza_version=repo_meta.get("eliza_version"),
        )

        started_wall_epoch = time.time()
        started_ts = time.monotonic()
        returncode: int | None = None
        timeout_error: str | None = None
        with stdout_path.open("w", encoding="utf-8") as out_file, stderr_path.open("w", encoding="utf-8") as err_file:
            err_file.write(f"# command: {' '.join(shlex.quote(part) for part in command)}\n")
            err_file.write(f"# cwd: {adapter.cwd}\n")
            err_file.write(f"# run_id: {run_id}\n")
            err_file.flush()
            try:
                proc = subprocess.run(
                    command,
                    cwd=adapter.cwd,
                    env=run_env,
                    stdout=out_file,
                    stderr=err_file,
                    text=True,
                    check=False,
                    timeout=adapter.default_timeout_seconds,
                )
                returncode = proc.returncode
            except subprocess.TimeoutExpired:
                returncode = 124
                timeout_error = f"Command timed out after {adapter.default_timeout_seconds}s"
                err_file.write(f"\n{timeout_error}\n")
                err_file.flush()
            except Exception as exc:
                returncode = 125
                timeout_error = f"Command execution failed: {exc}"
                err_file.write(f"\n{timeout_error}\n")
                err_file.flush()
        duration = time.monotonic() - started_ts

        effective_returncode = returncode if returncode is not None else 125
        status = _status_after_returncode(effective_returncode)
        result_path = adapter.result_locator(ctx, adapter, bench_output_root)
        stale_result_path: str | None = None
        if result_path is not None and result_path.exists():
            if result_path.stat().st_mtime < (started_wall_epoch - 1.0):
                stale_result_path = str(result_path)
                result_path = None

        score = None
        unit = None
        higher_is_better = None
        metrics: dict[str, Any] = {}
        error: str | None = timeout_error

        if result_path is not None and result_path.exists():
            try:
                summary = adapter.score_extractor(result_path)
                score = summary.score
                unit = summary.unit
                higher_is_better = summary.higher_is_better
                metrics = dict(summary.metrics)
                status = "succeeded"
                if effective_returncode != 0:
                    metrics["nonzero_return_code_with_result"] = effective_returncode
                    status = "failed"
                    error = (
                        "Command produced a result JSON but exited with "
                        f"return code {effective_returncode}"
                    )
            except Exception as exc:
                status = "failed"
                error = f"Score extraction failed: {exc}"
                metrics = {"score_extraction_error": str(exc)}
        else:
            status = "failed"
            if timeout_error:
                error = timeout_error
            elif effective_returncode == 0:
                error = "Command succeeded but no result JSON found"
            else:
                error = f"Command exited with return code {effective_returncode} and no result JSON found"
            metrics = {"result_locator": "not_found"}
            if stale_result_path is not None:
                metrics["stale_result_path"] = stale_result_path
        metrics["return_code"] = effective_returncode

        (
            trajectory_summary,
            token_metrics,
            cache_metrics,
            performance_metrics,
            trajectory_rows,
        ) = _collect_run_trajectory_metrics(bench_run_root, duration_seconds=duration)
        metrics["trajectory_summary"] = trajectory_summary
        metrics["token_metrics"] = token_metrics
        metrics["cache_metrics"] = cache_metrics
        metrics["performance_metrics"] = performance_metrics

        if status == "succeeded":
            harness_label = effective_request.agent.strip().lower() or "eliza"
            try:
                canonical_count, canonical_error, _ = normalize_outcome_trajectories(
                    bench_output_root,
                    harness=harness_label,
                    benchmark_id=adapter.id,
                    task_id=run_id,
                    model=effective_request.model,
                )
            except Exception as exc:  # noqa: BLE001 — never block the outcome
                print(
                    f"trajectory normalization crashed for {run_id}: {exc}",
                    file=sys.stderr,
                )
                canonical_count = 0
                canonical_error = f"{type(exc).__name__}: {exc}"
            metrics["canonical_entries"] = canonical_count
            if canonical_error:
                metrics["canonical_error"] = canonical_error

        high_label, high_value, delta = delta_to_high_score(adapter.id, score)

        update_run_result(
            conn,
            run_id=run_id,
            status=status,
            ended_at=_utc_now(),
            duration_seconds=duration,
            score=score,
            unit=unit,
            higher_is_better=higher_is_better,
            metrics=metrics,
            result_json_path=str(result_path) if result_path else None,
            artifacts=[str(bench_output_root)],
            error=error,
            high_score_label=high_label,
            high_score_value=high_value,
            delta_to_high_score=delta,
            trajectory_summary=trajectory_summary,
            token_metrics=token_metrics,
            cache_metrics=cache_metrics,
            performance_metrics=performance_metrics,
        )
        replace_run_trajectories(conn, run_id=run_id, trajectories=trajectory_rows)

        artifacts = [str(bench_output_root)]
        outcome = BenchmarkRunOutcome(
            benchmark_id=adapter.id,
            run_id=run_id,
            status=status,
            attempt=attempt,
            score=score,
            unit=unit,
            higher_is_better=higher_is_better,
            metrics=metrics,
            error=error,
            result_json_path=str(result_path) if result_path else None,
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            artifacts=artifacts,
            comparison=LeaderboardComparison(
                benchmark_id=adapter.id,
                high_score_label=high_label,
                high_score_value=high_value,
                delta_to_high_score=delta,
            ),
            duration_seconds=duration,
            command=command,
            cwd=adapter.cwd,
        )
        outcomes.append(outcome)
        _write_latest_result_snapshot(
            output_root,
            adapter=adapter,
            request=effective_request,
            run_group_id=run_group_id,
            run_id=run_id,
            status=status,
            score=score,
            unit=unit,
            higher_is_better=higher_is_better,
            metrics=metrics,
            trajectory_summary=trajectory_summary,
            token_metrics=token_metrics,
            cache_metrics=cache_metrics,
            performance_metrics=performance_metrics,
            result_json_path=str(result_path) if result_path else None,
            artifacts=artifacts,
            error=error,
        )

    finish_run_group(conn, run_group_id=run_group_id, finished_at=_utc_now())
    repair_nonzero_returncode_statuses(conn)
    _rebuild_latest_result_snapshots(conn, output_root)
    viewer_snapshot = _ensure_viewer_snapshot(conn, workspace_root=workspace_root)
    conn.close()
    return run_group_id, outcomes, viewer_snapshot
