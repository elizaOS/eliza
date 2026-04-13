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
    next_attempt_for_signature,
    recover_stale_running_runs,
    update_run_result,
)
from .env_utils import git_head, load_env_file, merged_environment, safe_version_from_package_json
from .leaderboard import delta_to_high_score
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
}
OPENAI_COMPAT_BASE_URL: dict[str, str] = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
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


def _result_subdir(run_root: Path, adapter: BenchmarkAdapter, run_id: str) -> Path:
    return run_root / f"{_sanitize_name(adapter.directory)}__{_sanitize_name(adapter.id)}" / run_id


def _default_env(workspace_root: Path, request: RunRequest) -> dict[str, str]:
    env = dict(os.environ)
    load_env_file(workspace_root / "eliza" / ".env")
    load_env_file(workspace_root / ".env")
    env = dict(os.environ)
    python_bin = str(Path(sys.executable).parent)
    existing_path = env.get("PATH", "")
    env["PATH"] = f"{python_bin}{os.pathsep}{existing_path}" if existing_path else python_bin
    env["PYTHONUNBUFFERED"] = "1"
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    plugin_python_paths: list[str] = []
    plugins_root = workspace_root / "plugins"
    if plugins_root.exists():
        for candidate in sorted(plugins_root.glob("*/python")):
            if candidate.is_dir():
                plugin_python_paths.append(str(candidate))
    workspace_python = [
        str(workspace_root),
        str(workspace_root / "eliza" / "packages" / "python"),
        *plugin_python_paths,
    ]
    existing_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        os.pathsep.join(workspace_python + [existing_pythonpath])
        if existing_pythonpath
        else os.pathsep.join(workspace_python)
    )
    env["BENCHMARK_MODEL_PROVIDER"] = request.provider
    env["BENCHMARK_MODEL_NAME"] = request.model
    env["MODEL_NAME"] = request.model
    env["ANTHROPIC_MODEL"] = request.model
    env["OPENAI_LARGE_MODEL"] = request.model
    env["OPENAI_SMALL_MODEL"] = request.model
    env["GROQ_LARGE_MODEL"] = request.model
    env["GROQ_SMALL_MODEL"] = request.model
    provider = request.provider.strip().lower()
    if provider in OPENAI_COMPAT_BASE_URL:
        provider_key = PROVIDER_KEY_ENV.get(provider)
        if provider_key and env.get(provider_key):
            env["OPENAI_API_KEY"] = env[provider_key]
        env["OPENAI_BASE_URL"] = OPENAI_COMPAT_BASE_URL[provider]
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
        )

        outcomes.append(
            BenchmarkRunOutcome(
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
                artifacts=[str(bench_output_root)],
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
        )

    finish_run_group(conn, run_group_id=run_group_id, finished_at=_utc_now())
    viewer_snapshot = _ensure_viewer_snapshot(conn, workspace_root=workspace_root)
    conn.close()
    return run_group_id, outcomes, viewer_snapshot
