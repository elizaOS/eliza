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
from .random_baseline_runner import (
    CALIBRATION_HARNESSES,
    CALIBRATION_SPEC_VERSION,
    SYNTHETIC_HARNESSES,
    is_synthetic_harness,
    run_synthetic_baseline,
)
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
CANONICAL_REAL_HARNESSES: tuple[str, ...] = ("eliza", "hermes", "openclaw")
LATEST_SNAPSHOT_AGENTS: set[str] = {
    *CANONICAL_REAL_HARNESSES,
    *SYNTHETIC_HARNESSES,
    "compare",
}


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _sanitize_name(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in value.strip().lower())
    cleaned = cleaned.strip("-")
    return cleaned or "item"


def _signature_for(adapter: BenchmarkAdapter, request: RunRequest) -> str:
    extra_config = dict(request.extra_config)
    if request.agent.strip().lower() in CALIBRATION_HARNESSES:
        extra_config["calibration_spec_version"] = CALIBRATION_SPEC_VERSION
    payload = {
        "benchmark_id": adapter.id,
        "benchmark_directory": adapter.directory,
        "agent": request.agent,
        "provider": request.provider,
        "model": request.model,
        "extra_config": extra_config,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")).hexdigest()


def _comparison_signature_for(adapter: BenchmarkAdapter, request: RunRequest) -> str:
    """Hash the benchmark/model/config shape without the harness label.

    ``signature`` intentionally includes ``request.agent`` so resume/idempotency
    stays per-harness. For apples-to-apples reporting we also need a stable
    grouping key that lets the latest index line up Eliza, Hermes, and OpenClaw
    runs using the same benchmark configuration.
    """
    return _comparison_signature_from_parts(
        benchmark_id=adapter.id,
        benchmark_directory=adapter.directory,
        agent=request.agent,
        provider=request.provider,
        model=request.model,
        extra_config=request.extra_config,
    )


def _comparison_signature_from_parts(
    *,
    benchmark_id: str,
    benchmark_directory: str,
    agent: str,
    provider: str,
    model: str,
    extra_config: dict[str, Any] | None,
) -> str:
    normalized_extra = dict(extra_config or {})
    injected_agent = str(normalized_extra.get("agent") or "").strip().lower()
    injected_harness = str(normalized_extra.get("harness") or "").strip().lower()
    comparable_agents = set(LATEST_SNAPSHOT_AGENTS) | set(SYNTHETIC_HARNESSES)
    if injected_agent in comparable_agents:
        normalized_extra.pop("agent", None)
    if injected_harness in comparable_agents:
        normalized_extra.pop("harness", None)
    if agent.strip().lower() in CALIBRATION_HARNESSES:
        normalized_extra["calibration_spec_version"] = CALIBRATION_SPEC_VERSION
    payload = {
        "benchmark_id": benchmark_id,
        "benchmark_directory": benchmark_directory,
        "provider": provider,
        "model": model,
        "extra_config": normalized_extra,
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
    if not harness_label or is_synthetic_harness(harness_label):
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
    env["ELIZA_PROVIDER"] = provider or request.provider
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


def _adapter_version_from_pyproject(adapter_root: Path) -> str | None:
    try:
        pyproject = (adapter_root / "pyproject.toml").read_text(encoding="utf-8")
    except OSError:
        return None
    for line in pyproject.splitlines():
        stripped = line.strip()
        if stripped.startswith("version") and "=" in stripped:
            _, _, raw = stripped.partition("=")
            return raw.strip().strip('"').strip("'")
    return None


def _build_reproducibility_metadata(
    *,
    workspace_root: Path,
    request: RunRequest,
    repo_meta: dict[str, str | None],
) -> dict[str, Any]:
    """Persist enough metadata that an old result can be re-run.

    Fields:
        ``cli_argv``           — process argv at orchestrator start.
        ``extra_config``       — request.extra_config dict (preserved verbatim).
        ``harness_commit_sha`` — ``git rev-parse HEAD`` of the workspace.
        ``dataset_revision``   — adapter-specific (TODO; ``None`` for now).
        ``adapter_versions``   — version strings of each in-repo adapter.
        ``seed`` / ``temperature`` — from extra_config or env.
        ``provider`` / ``model`` — already required.
    """
    benchmarks_root = workspace_root / "benchmarks"
    try:
        harness_commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(workspace_root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        harness_commit = None
    extra_config = dict(request.extra_config) if request.extra_config else {}
    seed = extra_config.get("seed")
    temperature = extra_config.get("temperature")
    if temperature is None:
        try:
            temperature = float(os.environ.get("BENCHMARK_TEMPERATURE", "")) if os.environ.get("BENCHMARK_TEMPERATURE") else None
        except ValueError:
            temperature = None
    return {
        "cli_argv": list(sys.argv),
        "extra_config": extra_config,
        "harness_commit_sha": harness_commit,
        "benchmarks_commit_sha": repo_meta.get("benchmarks_commit"),
        "eliza_commit_sha": repo_meta.get("eliza_commit"),
        # TODO: each adapter should expose its own dataset revision (e.g.
        # SWE-bench dataset version, hermes-tblite checkpoint). For now we
        # record ``None`` rather than fabricate.
        "dataset_revision": None,
        "adapter_versions": {
            "eliza": _adapter_version_from_pyproject(benchmarks_root / "eliza-adapter"),
            "hermes": _adapter_version_from_pyproject(benchmarks_root / "hermes-adapter"),
            "openclaw": _adapter_version_from_pyproject(benchmarks_root / "openclaw-adapter"),
        },
        "seed": seed,
        "temperature": temperature,
        "provider": request.provider,
        "model": request.model,
    }


def _status_after_returncode(returncode: int) -> str:
    return "succeeded" if returncode == 0 else "failed"


def _required_env_for_request(adapter: BenchmarkAdapter, request: RunRequest) -> tuple[str, ...]:
    if adapter.id == "lifeops_bench":
        extra = request.extra_config
        agent = str(
            extra.get("agent")
            or extra.get("harness")
            or request.model
            or ""
        ).strip().lower()
        mode = str(extra.get("mode") or "").strip().lower()
        if agent in {"perfect", "wrong"} and mode != "live":
            return ()
        if mode == "live":
            return ("CEREBRAS_API_KEY", "ANTHROPIC_API_KEY")
        provider_key = PROVIDER_KEY_ENV.get(request.provider.strip().lower())
        if agent in {"eliza", "hermes", "openclaw", "cerebras-direct"}:
            return (provider_key or "CEREBRAS_API_KEY",)
        return ()

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
    # P0b: Never silently substitute prompt_chars/4 for real tokens. If the
    # adapter didn't emit usage we surface ``None`` here and let the
    # publication gate quarantine the result downstream.
    has_real_prompt = summary.prompt_tokens > 0
    has_real_completion = summary.completion_tokens > 0
    has_real_total = summary.total_tokens > 0
    prompt_tokens: int | None = summary.prompt_tokens if has_real_prompt else None
    completion_tokens: int | None = summary.completion_tokens if has_real_completion else None
    if has_real_total:
        total_tokens: int | None = summary.total_tokens
    elif has_real_prompt or has_real_completion:
        total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)
    else:
        total_tokens = None
    llm_call_count: int | None = summary.turns if summary.turns else None
    telemetry_missing = total_tokens in (None, 0) or llm_call_count in (None, 0)
    trajectory_summary = {
        "files": summary.files,
        "turns": summary.turns,
        "prompt_chars": summary.prompt_chars,
        "repeated_prefixes": [
            {"snippet": snippet, "count": count}
            for snippet, count in summary.repeated_prefixes
        ],
    }
    token_metrics: dict[str, Any] = {
        "llm_call_count": llm_call_count,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "avg_prompt_tokens": (prompt_tokens / summary.turns) if (prompt_tokens and summary.turns) else None,
        "avg_completion_tokens": (completion_tokens / summary.turns) if (completion_tokens and summary.turns) else None,
        "telemetry_missing": telemetry_missing,
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


SYNTHETIC_AGENT_SUFFIX = "_v1"
SYNTHETIC_AGENT_SET: set[str] = set(SYNTHETIC_HARNESSES)


def _is_synthetic_agent(agent: str) -> bool:
    agent_lc = agent.strip().lower()
    if agent_lc in SYNTHETIC_AGENT_SET:
        return True
    return agent_lc.endswith(SYNTHETIC_AGENT_SUFFIX)


def _publication_quarantine_reason(
    *,
    status: str,
    agent: str,
    token_metrics: dict[str, Any] | None,
    metrics: dict[str, Any],
) -> str | None:
    """Return ``None`` if the result is publishable; otherwise a reason string.

    ``latest/`` is the source of truth for the most recent real benchmark
    result. Telemetry and sample-size weaknesses are recorded as publication
    warnings, not quarantine reasons, because hiding successful rows makes the
    matrix look missing and breaks idempotent tracking.
    """
    del status, token_metrics, metrics
    if _is_synthetic_agent(agent):
        return None
    return None


def _publication_warnings(
    *,
    status: str,
    token_metrics: dict[str, Any] | None,
    metrics: dict[str, Any],
) -> list[str]:
    if status != "succeeded":
        return []
    warnings: list[str] = []
    tokens = token_metrics or {}
    estimate_source = tokens.get("token_estimate_source")
    if estimate_source is not None or any(str(key).startswith("estimated_") for key in tokens):
        source = str(estimate_source or "unknown")
        warnings.append(f"estimated_token_metrics:{source}")
    total_tokens = tokens.get("total_tokens")
    llm_calls = tokens.get("llm_call_count")
    if total_tokens in (None, 0):
        warnings.append("telemetry_missing_total_tokens")
    if llm_calls in (None, 0):
        warnings.append(f"telemetry_missing_llm_calls:{llm_calls!r}")
    elif llm_calls == 1:
        warnings.append("single_llm_call")
    total_instances = metrics.get("total_instances")
    if isinstance(total_instances, (int, float)) and total_instances <= 1:
        warnings.append(f"insufficient_total_instances:{total_instances!r}")
    n_value = metrics.get("n")
    if isinstance(n_value, (int, float)) and n_value <= 1:
        warnings.append(f"insufficient_n:{n_value!r}")
    if metrics.get("interrupted") is True:
        warnings.append("interrupted_run")
    return warnings


_QUARANTINE_TRACKER: dict[Path, list[tuple[str, str, str]]] = {}


def _record_quarantine(output_root: Path, agent: str, benchmark_id: str, reason: str) -> None:
    _QUARANTINE_TRACKER.setdefault(output_root, []).append((benchmark_id, agent, reason))


def _pop_quarantine_records(output_root: Path) -> list[tuple[str, str, str]]:
    return _QUARANTINE_TRACKER.pop(output_root, [])


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
    reproducibility: dict[str, Any] | None = None,
    signature: str | None = None,
    comparison_signature: str | None = None,
) -> Path:
    """Route a snapshot to ``latest/`` or ``baselines/``.

    Real-agent rows always publish to ``latest/`` so that the newest result is
    visible even when telemetry is incomplete. Synthetic baselines
    (``perfect_v1`` etc.) are always written to ``baselines/`` and never
    intermingle with ``latest/``.
    """
    agent = request.agent
    is_synthetic = _is_synthetic_agent(agent)
    quarantine_reason = (
        None if is_synthetic
        else _publication_quarantine_reason(
            status=status, agent=agent, token_metrics=token_metrics, metrics=metrics,
        )
    )
    if is_synthetic:
        target_dir = output_root / "baselines"
    else:
        target_dir = output_root / "latest"
    publication_warnings = [] if is_synthetic else _publication_warnings(
        status=status,
        token_metrics=token_metrics,
        metrics=metrics,
    )
    target_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path = target_dir / f"{_sanitize_name(adapter.id)}__{_sanitize_name(agent)}.json"
    payload: dict[str, Any] = {
        "updated_at": _utc_now(),
        "benchmark_id": adapter.id,
        "benchmark_directory": adapter.directory,
        "run_group_id": run_group_id,
        "run_id": run_id,
        "signature": signature,
        "comparison_signature": comparison_signature
        or _comparison_signature_for(adapter, request),
        "status": status,
        "agent": agent,
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
        "reproducibility": reproducibility or {},
    }
    if quarantine_reason is not None:
        payload["quarantine_reason"] = quarantine_reason
        _record_quarantine(output_root, agent, adapter.id, quarantine_reason)
    if publication_warnings:
        payload["publication_warnings"] = publication_warnings
    if is_synthetic:
        payload["synthetic"] = True
    snapshot_path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True), encoding="utf-8")

    # Also prune any stale entry for the same (benchmark, agent) from the
    # other directories. A run that previously published to ``latest/`` and
    # this time fails the gate must not leave its stale snapshot behind.
    other_dirs = [
        output_root / "latest",
        output_root / "quarantine",
        output_root / "baselines",
    ]
    for other in other_dirs:
        if other == target_dir:
            continue
        if not other.exists():
            continue
        stale = other / snapshot_path.name
        if stale.exists():
            stale.unlink()

    # Rebuild the index.json for the published-only set (``latest/``).
    latest_dir = output_root / "latest"
    latest_dir.mkdir(parents=True, exist_ok=True)
    index: dict[str, Any] = {
        "updated_at": _utc_now(),
        "latest": {},
        "latest_by_signature": {},
        "latest_by_comparison_signature": {},
    }
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
            "run_group_id": data.get("run_group_id"),
            "signature": data.get("signature"),
            "comparison_signature": data.get("comparison_signature"),
            "score": data.get("score"),
            "status": data.get("status"),
            "updated_at": data.get("updated_at"),
        }
        signature_key = data.get("signature")
        if signature_key:
            index["latest_by_signature"][f"{signature_key}::{key}"] = index["latest"][key]
        comparison_signature_key = data.get("comparison_signature")
        if comparison_signature_key:
            index["latest_by_comparison_signature"][
                f"{comparison_signature_key}::{key}"
            ] = index["latest"][key]
    (latest_dir / "index.json").write_text(json.dumps(index, indent=2, sort_keys=True, ensure_ascii=True), encoding="utf-8")
    return snapshot_path


def _rebuild_latest_result_snapshots(
    conn,
    output_root: Path,
    adapters: dict[str, BenchmarkAdapter] | None = None,
) -> None:
    """Rebuild latest snapshots from SQLite.

    This keeps ``benchmark_results/latest`` idempotent even when a single
    benchmark is rerun, a stale snapshot was manually removed, or a compatibility
    rule changes. The latest row per ``(benchmark_id, agent)`` is the source of
    truth; files not represented by SQLite are pruned.
    """

    latest_dir = output_root / "latest"
    quarantine_dir = output_root / "quarantine"
    baselines_dir = output_root / "baselines"

    row = conn.execute("SELECT COUNT(*) AS count FROM benchmark_runs").fetchone()
    total_runs = int(row["count"] if row is not None else 0)
    if total_runs == 0:
        existing_snapshots = sum(
            1
            for d in (latest_dir, quarantine_dir, baselines_dir)
            if d.exists()
            for _path in d.glob("*.json")
        )
        suffix = (
            f"; preserved {existing_snapshots} existing snapshot file(s)"
            if existing_snapshots
            else ""
        )
        print(
            "WARNING: orchestrator database has no benchmark_runs rows; "
            "leaving latest/quarantine/baselines snapshots untouched"
            f"{suffix}.",
            file=sys.stderr,
        )
        return

    for d in (latest_dir, quarantine_dir, baselines_dir):
        d.mkdir(parents=True, exist_ok=True)

    latest_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    latest_by_signature: dict[tuple[str, str, str], dict[str, Any]] = {}
    latest_by_comparison_signature: dict[tuple[str, str, str], tuple[dict[str, Any], str]] = {}
    valid_benchmark_ids = set(adapters) if adapters is not None else None
    for row in list_runs(conn, limit=100000):
        benchmark_id = str(row.get("benchmark_id") or "")
        agent = str(row.get("agent") or "")
        if row.get("status") in {"queued", "running", "skipped"}:
            continue
        if valid_benchmark_ids is not None and benchmark_id not in valid_benchmark_ids:
            continue
        if agent not in LATEST_SNAPSHOT_AGENTS:
            continue
        if not benchmark_id or not agent:
            continue
        if _is_stale_compatibility_incompatible_row(row, adapters):
            continue
        key = (benchmark_id, agent)
        if key not in latest_by_key:
            latest_by_key[key] = row
        signature = str(row.get("signature") or "")
        if signature:
            signature_key = (signature, benchmark_id, agent)
            if signature_key not in latest_by_signature:
                latest_by_signature[signature_key] = row
        comparison_signature = _comparison_signature_from_parts(
            benchmark_id=benchmark_id,
            benchmark_directory=str(row.get("benchmark_directory") or benchmark_id),
            agent=agent,
            provider=str(row.get("provider") or ""),
            model=str(row.get("model") or ""),
            extra_config=row.get("extra_config")
            if isinstance(row.get("extra_config"), dict)
            else {},
        )
        comparison_key = (comparison_signature, benchmark_id, agent)
        if comparison_key not in latest_by_comparison_signature:
            latest_by_comparison_signature[comparison_key] = (row, comparison_signature)

    expected_by_dir: dict[Path, set[Path]] = {
        latest_dir: set(),
        quarantine_dir: set(),
        baselines_dir: set(),
    }
    index: dict[str, Any] = {
        "updated_at": _utc_now(),
        "latest": {},
        "latest_by_signature": {},
        "latest_by_comparison_signature": {},
    }
    for (benchmark_id, agent), row in sorted(latest_by_key.items()):
        metrics = row.get("metrics") or {}
        token_metrics = row.get("token_metrics") or {}
        is_synthetic = _is_synthetic_agent(agent)
        if is_synthetic:
            target_dir = baselines_dir
            quarantine_reason = None
        else:
            quarantine_reason = _publication_quarantine_reason(
                status=str(row.get("status") or ""),
                agent=agent,
                token_metrics=token_metrics,
                metrics=metrics,
            )
            target_dir = quarantine_dir if quarantine_reason is not None else latest_dir
        publication_warnings = [] if is_synthetic else _publication_warnings(
            status=str(row.get("status") or ""),
            token_metrics=token_metrics,
            metrics=metrics,
        )
        snapshot_path = target_dir / f"{_sanitize_name(benchmark_id)}__{_sanitize_name(agent)}.json"
        expected_by_dir[target_dir].add(snapshot_path)
        payload: dict[str, Any] = {
            "updated_at": row.get("ended_at") or row.get("started_at") or _utc_now(),
            "benchmark_id": benchmark_id,
            "benchmark_directory": row.get("benchmark_directory"),
            "run_group_id": row.get("run_group_id"),
            "run_id": row.get("run_id"),
            "signature": row.get("signature"),
            "comparison_signature": _comparison_signature_from_parts(
                benchmark_id=benchmark_id,
                benchmark_directory=str(row.get("benchmark_directory") or benchmark_id),
                agent=agent,
                provider=str(row.get("provider") or ""),
                model=str(row.get("model") or ""),
                extra_config=row.get("extra_config")
                if isinstance(row.get("extra_config"), dict)
                else {},
            ),
            "status": row.get("status"),
            "agent": agent,
            "provider": row.get("provider"),
            "model": row.get("model"),
            "score": row.get("score"),
            "unit": row.get("unit"),
            "higher_is_better": row.get("higher_is_better"),
            "metrics": metrics,
            "trajectory_summary": row.get("trajectory_summary") or {},
            "token_metrics": token_metrics,
            "cache_metrics": row.get("cache_metrics") or {},
            "performance_metrics": row.get("performance_metrics") or {},
            "result_json_path": row.get("result_json_path"),
            "artifacts": row.get("artifacts") or [],
            "error": row.get("error"),
        }
        if quarantine_reason is not None:
            payload["quarantine_reason"] = quarantine_reason
        if publication_warnings:
            payload["publication_warnings"] = publication_warnings
        if is_synthetic:
            payload["synthetic"] = True
        snapshot_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True),
            encoding="utf-8",
        )
        if target_dir is latest_dir:
            index["latest"][f"{benchmark_id}::{agent}"] = {
                "path": str(snapshot_path),
                "run_id": row.get("run_id"),
                "run_group_id": row.get("run_group_id"),
                "signature": row.get("signature"),
                "comparison_signature": payload["comparison_signature"],
                "score": row.get("score"),
                "status": row.get("status"),
                "updated_at": payload["updated_at"],
            }

    for (signature, benchmark_id, agent), row in sorted(latest_by_signature.items()):
        index["latest_by_signature"][f"{signature}::{benchmark_id}::{agent}"] = {
            "run_id": row.get("run_id"),
            "run_group_id": row.get("run_group_id"),
            "benchmark_id": benchmark_id,
            "agent": agent,
            "signature": signature,
            "score": row.get("score"),
            "status": row.get("status"),
            "updated_at": row.get("ended_at") or row.get("started_at"),
            "result_json_path": row.get("result_json_path"),
        }

    for (comparison_signature, benchmark_id, agent), (
        row,
        _comparison_signature,
    ) in sorted(latest_by_comparison_signature.items()):
        index["latest_by_comparison_signature"][
            f"{comparison_signature}::{benchmark_id}::{agent}"
        ] = {
            "run_id": row.get("run_id"),
            "run_group_id": row.get("run_group_id"),
            "benchmark_id": benchmark_id,
            "agent": agent,
            "signature": row.get("signature"),
            "comparison_signature": comparison_signature,
            "score": row.get("score"),
            "status": row.get("status"),
            "updated_at": row.get("ended_at") or row.get("started_at"),
            "result_json_path": row.get("result_json_path"),
        }

    # Prune stale files from each managed dir (only files we own).
    for d, expected in expected_by_dir.items():
        index_path_in_d = d / "index.json"
        expected_with_index = expected | {index_path_in_d}
        for path in d.glob("*.json"):
            if path not in expected_with_index:
                path.unlink()
    index_path = latest_dir / "index.json"
    index_path.write_text(
        json.dumps(index, indent=2, sort_keys=True, ensure_ascii=True),
        encoding="utf-8",
    )


def _is_stale_compatibility_incompatible_row(
    row: dict[str, Any],
    adapters: dict[str, BenchmarkAdapter] | None,
) -> bool:
    """Ignore old incompatibility rows when current rules now allow the pair."""

    if adapters is None or row.get("status") != "incompatible":
        return False
    benchmark_id = str(row.get("benchmark_id") or "")
    agent = str(row.get("agent") or "").strip().lower()
    adapter = adapters.get(benchmark_id)
    if adapter is None or agent not in adapter.agent_compatibility:
        return False
    metrics = row.get("metrics") or {}
    reason = metrics.get("reason") if isinstance(metrics, dict) else None
    return reason in {
        "harness_not_in_compatibility",
        "latest_row_violates_current_compatibility",
    }


def _repair_current_compatibility_statuses(
    conn,
    adapters: dict[str, BenchmarkAdapter],
) -> int:
    """Mark stale succeeded rows incompatible when rules now exclude a harness."""

    repaired = 0
    for row in list_runs(conn, limit=100000):
        if row.get("status") == "skipped":
            continue
        benchmark_id = str(row.get("benchmark_id") or "")
        agent = str(row.get("agent") or "").strip().lower()
        if agent not in CANONICAL_REAL_HARNESSES:
            continue
        adapter = adapters.get(benchmark_id)
        if adapter is None or agent in adapter.agent_compatibility:
            continue
        metrics = dict(row.get("metrics") or {})
        metrics["reason"] = "latest_row_violates_current_compatibility"
        metrics["harness"] = agent
        metrics["supported_harnesses"] = list(adapter.agent_compatibility)
        conn.execute(
            """
            UPDATE benchmark_runs
            SET status = 'incompatible',
                score = NULL,
                unit = NULL,
                higher_is_better = NULL,
                metrics_json = ?,
                error = ?
            WHERE run_id = ?
            """,
            (
                json.dumps(metrics, sort_keys=True, separators=(",", ":"), ensure_ascii=True),
                (
                    f"Benchmark '{benchmark_id}' is no longer compatible with "
                    f"harness '{agent}' (supported: {', '.join(adapter.agent_compatibility)})"
                ),
                row["run_id"],
            ),
        )
        repaired += 1
    if repaired:
        conn.commit()
    return repaired


def _run_synthetic_harness_outcome(
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
    """Synthesize a calibration/baseline outcome for one benchmark.

    Inserts a new ``benchmark_runs`` row (no subprocess), runs the
    benchmark's own ``score_extractor`` over a generated result file
    when a matching template exists, or records the expected score
    directly otherwise. The function reuses ``replace_run_trajectories``
    only to clear any stale entries — synthetic harnesses do not
    produce real trajectory rows.
    """
    harness_label = effective_request.agent.strip().lower()
    attempt = next_attempt_for_signature(conn, signature)
    now_compact = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_id = f"{harness_label}_{adapter.id}_{now_compact}_{attempt}_{uuid4().hex[:8]}"
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
        agent=effective_request.agent,
        provider=effective_request.provider,
        model=effective_request.model,
        extra_config=effective_request.extra_config,
        started_at=started_at,
        command=[f"<{harness_label}-synthetic>"],
        cwd=adapter.cwd,
        stdout_path="",
        stderr_path="",
        benchmark_version=repo_meta.get("benchmarks_version"),
        benchmarks_commit=repo_meta.get("benchmarks_commit"),
        eliza_commit=repo_meta.get("eliza_commit"),
        eliza_version=repo_meta.get("eliza_version"),
    )

    baseline = run_synthetic_baseline(
        benchmark_id=adapter.id,
        output_dir=bench_output_root,
        harness=harness_label,
    )

    metrics: dict[str, Any] = {
        "synthetic_harness": harness_label,
        "synthetic_strategy": baseline.strategy_name,
        "synthetic_is_meaningful": baseline.is_meaningful,
        "calibration_spec_version": CALIBRATION_SPEC_VERSION,
        "calibration_depth": "scorer_payload" if baseline.result_path else "direct_score",
        "return_code": 0,
    }
    if harness_label == "random_v1":
        metrics["random_baseline_strategy"] = baseline.strategy_name
        metrics["random_baseline_is_meaningful"] = baseline.is_meaningful
    if baseline.score is not None:
        metrics["synthetic_expected_score"] = baseline.score
    if baseline.note:
        metrics["synthetic_note"] = baseline.note
        if harness_label == "random_v1":
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
                error = f"{harness_label} score extraction failed: {exc}"
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
        command=[f"<{harness_label}-synthetic>"],
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
    _repair_current_compatibility_statuses(conn, discovery.adapters)

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

        # Harness/agent compatibility — if the harness is not in the adapter's
        # supported list, record an ``incompatible`` outcome and skip without
        # spawning the subprocess. Synthetic harnesses are compatible with all
        # adapters and are handled after the normal idempotent skip checks.
        # ``compare`` is allowed only for multi-harness adapters.
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

        if harness_label in SYNTHETIC_HARNESSES:
            outcome = _run_synthetic_harness_outcome(
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
        # Canonical run dir for adapter clients to write per-turn telemetry to
        # ``<run_dir>/telemetry.jsonl``. Kept alongside the legacy
        # ``BENCHMARK_TELEMETRY_JSONL`` for explicit-override use, and so
        # discover_trajectories() picks it up via the ``**/*.jsonl`` glob.
        run_env["BENCHMARK_RUN_DIR"] = str(bench_output_root)
        run_env["BENCHMARK_TELEMETRY_JSONL"] = str(bench_output_root / "telemetry.jsonl")

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
        reproducibility = _build_reproducibility_metadata(
            workspace_root=workspace_root,
            request=effective_request,
            repo_meta=repo_meta,
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
            trajectory_summary=trajectory_summary,
            token_metrics=token_metrics,
            cache_metrics=cache_metrics,
            performance_metrics=performance_metrics,
            result_json_path=str(result_path) if result_path else None,
            artifacts=artifacts,
            error=error,
            reproducibility=reproducibility,
            signature=signature,
        )

    finish_run_group(conn, run_group_id=run_group_id, finished_at=_utc_now())
    repair_nonzero_returncode_statuses(conn)
    _repair_current_compatibility_statuses(conn, discovery.adapters)
    _rebuild_latest_result_snapshots(conn, output_root, discovery.adapters)
    viewer_snapshot = _ensure_viewer_snapshot(conn, workspace_root=workspace_root)
    conn.close()

    # End-of-run quarantine summary. The publication gate diverts real-agent
    # snapshots with missing telemetry or insufficient sample size to
    # ``benchmark_results/quarantine/`` rather than ``latest/``.
    quarantine_records = _pop_quarantine_records(output_root)
    if quarantine_records:
        print(
            f"\nWARNING: {len(quarantine_records)} benchmark result(s) "
            f"failed the publication gate and were quarantined under "
            f"{output_root / 'quarantine'}/. They will NOT appear in "
            f"benchmark_results/latest/:",
            file=sys.stderr,
        )
        for bench, agent, reason in quarantine_records:
            print(f"  - {bench} :: {agent}  reason={reason}", file=sys.stderr)
    return run_group_id, outcomes, viewer_snapshot
