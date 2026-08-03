from __future__ import annotations

import hashlib
import json
import math
import os
import shlex
import signal
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from benchmarks.campaign_profile import is_full_campaign_profile

from .adapters import (
    HERMES_SANDBOX_UNAVAILABLE_REASON,
    HYPERLIQUID_LIVE_UNAVAILABLE_REASON,
    OSWORLD_DOCKER_UNAVAILABLE_REASON,
    SWE_BENCH_DOCKER_UNAVAILABLE_REASON,
    TERMINAL_BENCH_DOCKER_UNAVAILABLE_REASON,
    VISION_LANGUAGE_FIXED_RUNTIME_REASON,
    VISION_LANGUAGE_HARNESS_RUNTIME_UNAVAILABLE_REASON,
    VISION_LANGUAGE_OPENCLAW_NATIVE_MULTIMODAL_UNAVAILABLE_REASON,
    VISION_LANGUAGE_REAL_INPUTS_UNAVAILABLE_REASON,
    discover_adapters,
)
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
    repair_nonpublishable_success_statuses,
    replace_run_trajectories,
    update_run_result,
)
from .env_utils import (
    git_head,
    load_env_file,
    merged_environment,
    safe_version_from_package_json,
)
from .leaderboard import delta_to_high_score
from .locking import latest_publication_lock, serialize_on_output_root
from benchmarks.publication_contracts import (
    agentbench_publication_contract_reason,
    webshop_workload_quarantine_reason,
)
from .analyze_trajectory import summarize as summarize_trajectory
from .random_baseline_runner import (
    CALIBRATION_HARNESSES,
    CALIBRATION_SPEC_VERSION,
    SYNTHETIC_HARNESSES,
    is_synthetic_harness,
    run_synthetic_baseline,
)
from .runtime_provenance import (
    native_runtime_quarantine_reason,
    summarize_runtime_provenance,
)
from .subscription_provenance import subscription_gateway_quarantine_reason
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
    "claude-subscription": "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN",
}
OPENAI_COMPAT_BASE_URL: dict[str, str] = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "vllm": "http://127.0.0.1:8001/v1",
    "cerebras": "https://api.cerebras.ai/v1",
}
# Provider-native base-URL env var mirrored alongside OPENAI_BASE_URL so both
# OpenAI-compat clients and provider-native SDKs in the subprocess hit the same
# endpoint.
PROVIDER_BASE_URL_ENV: dict[str, str] = {
    "groq": "GROQ_BASE_URL",
    "openrouter": "OPENROUTER_BASE_URL",
    "vllm": "VLLM_BASE_URL",
    "cerebras": "CEREBRAS_BASE_URL",
}
# Providers whose API key has no real secret value (self-hosted endpoints).
PROVIDER_DUMMY_KEY: dict[str, str] = {
    "vllm": "dummy",
}
DEFAULT_STALE_RECOVERY_SECONDS = 6 * 60 * 60
DEFAULT_FULL_CAMPAIGN_SILENT_TIMEOUT_SECONDS = 60 * 60
DEFAULT_PROCESS_PROGRESS_POLL_SECONDS = 1.0
PROCESS_TERMINATION_GRACE_SECONDS = 10.0
CANONICAL_REAL_HARNESSES: tuple[str, ...] = ("eliza", "hermes", "openclaw")
LATEST_SNAPSHOT_AGENTS: set[str] = {
    *CANONICAL_REAL_HARNESSES,
    *SYNTHETIC_HARNESSES,
    "compare",
    # smithers publishes to latest/ but is intentionally NOT in
    # CANONICAL_REAL_HARNESSES: it has partial benchmark coverage, so it must
    # not be a required agent for cross-harness comparability.
    "smithers",
}


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _sanitize_name(value: str) -> str:
    cleaned = "".join(
        ch if ch.isalnum() or ch in {"-", "_", "."} else "-"
        for ch in value.strip().lower()
    )
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
    return hashlib.sha256(
        json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode("utf-8")
    ).hexdigest()


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
    normalized_extra = _comparison_extra_config(extra_config, agent=agent)
    payload = {
        "benchmark_id": benchmark_id,
        "benchmark_directory": benchmark_directory,
        "provider": provider,
        "model": model,
        "extra_config": normalized_extra,
    }
    return hashlib.sha256(
        json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode("utf-8")
    ).hexdigest()


def _comparison_extra_config(
    extra_config: dict[str, Any] | None,
    *,
    agent: str,
) -> dict[str, Any]:
    normalized_extra = dict(extra_config or {})
    injected_agent = str(normalized_extra.get("agent") or "").strip().lower()
    injected_harness = str(normalized_extra.get("harness") or "").strip().lower()
    comparable_agents = set(LATEST_SNAPSHOT_AGENTS) | set(SYNTHETIC_HARNESSES)
    if injected_agent in comparable_agents:
        normalized_extra.pop("agent", None)
    if injected_harness in comparable_agents:
        normalized_extra.pop("harness", None)
    for runtime_key in (
        "eliza_bench_http_timeout_s",
        "openclaw_timeout_s",
        "timeout_s",
    ):
        normalized_extra.pop(runtime_key, None)
    if str(normalized_extra.get("reasoning_effort") or "").strip().lower() == "low":
        normalized_extra.pop("reasoning_effort", None)
    dataset = str(normalized_extra.get("dataset") or "").strip()
    suite = str(normalized_extra.get("suite") or "").strip()
    if dataset and suite and dataset == suite:
        normalized_extra.pop("dataset", None)
    if agent.strip().lower() in CALIBRATION_HARNESSES:
        normalized_extra["calibration_spec_version"] = CALIBRATION_SPEC_VERSION
    return normalized_extra


def _comparison_signature_for_row(
    row: dict[str, Any],
    *,
    benchmark_id: str,
    agent: str,
) -> str:
    existing = row.get("comparison_signature")
    if isinstance(existing, str) and existing.strip():
        return existing.strip()
    return _comparison_signature_from_parts(
        benchmark_id=benchmark_id,
        benchmark_directory=str(row.get("benchmark_directory") or benchmark_id),
        agent=agent,
        provider=str(row.get("provider") or ""),
        model=str(row.get("model") or ""),
        extra_config=row.get("extra_config")
        if isinstance(row.get("extra_config"), dict)
        else {},
    )


def _effective_request(adapter: BenchmarkAdapter, request: RunRequest) -> RunRequest:
    request_extra = dict(request.extra_config)
    replace_adapter_defaults = request_extra.pop("_replace_adapter_defaults", False)
    if replace_adapter_defaults is not False and replace_adapter_defaults is not True:
        raise ValueError("_replace_adapter_defaults must be a boolean")
    per_benchmark = request_extra.pop("per_benchmark", None)
    per_benchmark_extra: dict[str, Any] = {}
    if isinstance(per_benchmark, dict):
        adapter_specific = per_benchmark.get(adapter.id)
        if isinstance(adapter_specific, dict):
            per_benchmark_extra = dict(adapter_specific)

    # Full campaigns own their complete dataset shape. Merging the normal
    # smoke defaults here would retain limits for any key the full profile
    # intentionally omits, so that internal profile replaces defaults as a
    # unit. The control flag is removed before the effective request reaches
    # adapters or per-run signatures and reproducibility metadata.
    merged_extra = (
        {} if replace_adapter_defaults else dict(adapter.default_extra_config)
    )
    merged_extra.update(per_benchmark_extra)
    merged_extra.update(request_extra)
    # `--extra '{"sample": N}'` is the common ask for "run N samples", but the
    # standard-suite CLIs only read `limit`, so an integer `sample` used to be
    # silently ignored and the bounded-smoke default (limit=2) ran instead.
    # Treat an explicit integer sample as the caller's limit unless they also
    # passed limit. Boolean `sample: true` keeps its flag meaning elsewhere.
    explicit_sample = request_extra.get("sample", per_benchmark_extra.get("sample"))
    if (
        isinstance(explicit_sample, int)
        and not isinstance(explicit_sample, bool)
        and explicit_sample > 0
        and "limit" not in request_extra
        and "limit" not in per_benchmark_extra
    ):
        merged_extra["limit"] = explicit_sample
    explicit_agent = "agent" in per_benchmark_extra or "agent" in request_extra
    agent_label = request.agent.strip()
    if agent_label and not explicit_agent and agent_label != "compare":
        merged_extra["agent"] = agent_label
    if (
        adapter.id == "trust"
        and (
            agent_label.lower() in {"eliza", "hermes", "openclaw"}
            or request.provider.strip().lower() == "claude-subscription"
        )
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
        # the hood.
        return len(adapter.agent_compatibility) > 1
    return harness_label in adapter.agent_compatibility


def _result_subdir(run_root: Path, adapter: BenchmarkAdapter, run_id: str) -> Path:
    return (
        run_root
        / f"{_sanitize_name(adapter.directory)}__{_sanitize_name(adapter.id)}"
        / run_id
    )


def _provider_model_name(provider: str, model: str) -> str:
    provider = provider.strip().lower()
    model = model.strip()
    if provider == "cerebras" and model.startswith("openai/"):
        return model.split("/", 1)[1]
    if provider == "claude-subscription" and "/" in model:
        return model.split("/", 1)[1]
    return model


def _request_for_command_builder(request: RunRequest) -> RunRequest:
    """Translate transport-only providers into names accepted by bench CLIs.

    The persisted request remains ``claude-subscription`` for signatures and
    provenance. Only command construction sees ``openai``; the subprocess
    still reaches the subscription gateway through ``OPENAI_BASE_URL`` and its
    per-harness bearer token.
    """

    if request.provider.strip().lower() == "claude-subscription":
        return replace(request, provider="openai")
    return request


def _resolve_openai_compat_base_url(
    provider: str, request: RunRequest, env: dict[str, str]
) -> str:
    """Resolve the endpoint an OpenAI-compatible provider lane should hit.

    Precedence: per-run extra_config (``<provider>_base_url``, then the generic
    ``base_url``), then ambient operator env (the provider-native variable,
    then ``BENCHMARK_BASE_URL``, then ``OPENAI_BASE_URL``), and only when
    nothing is set the hardcoded provider default. Campaigns route all traffic
    through a proxy by exporting these variables once; the runner must never
    silently clobber them with the public provider endpoint.
    """
    for extra_key in (f"{provider}_base_url", "base_url"):
        candidate = request.extra_config.get(extra_key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    for env_key in (
        PROVIDER_BASE_URL_ENV[provider],
        "BENCHMARK_BASE_URL",
        "OPENAI_BASE_URL",
    ):
        candidate = env.get(env_key, "")
        if candidate.strip():
            return candidate.strip()
    return OPENAI_COMPAT_BASE_URL[provider]


def _ambient_env(workspace_root: Path) -> dict[str, str]:
    """Process env after the workspace dotenv cascade, as workers see it.

    Shared by the subprocess env builder below and the cohort coordinator's
    provider-forwarder decision so both resolve the same endpoint and key.
    dotenv values never override variables the operator already exported.
    """

    load_env_file(workspace_root / "eliza" / ".env")
    load_env_file(workspace_root / ".env")
    load_env_file(workspace_root.parent / ".env")
    load_env_file(workspace_root.parent.parent / ".env")
    return dict(os.environ)


def _default_env(workspace_root: Path, request: RunRequest) -> dict[str, str]:
    env = _ambient_env(workspace_root)
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
    env.setdefault(
        "HF_HOME",
        str((workspace_root / "benchmark-data" / "huggingface").resolve()),
    )
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
        str((benchmarks_root / "smithers-adapter").resolve()),
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
    if provider == "claude-subscription":
        from .subscription_gateway import FORBIDDEN_UPSTREAM_ENV

        for key in tuple(env):
            if key.upper() in FORBIDDEN_UPSTREAM_ENV:
                del env[key]
        # The subscription campaign only accepts provenance-bearing native
        # harness paths; ambient developer auth or toggles must not replace the
        # per-lane gateway bearer or OpenClaw's native transport.
        env.pop("OPENCLAW_API_KEY", None)
        env.pop("OPENCLAW_DIRECT_OPENAI_COMPAT", None)
        env.pop("OPENCLAW_USE_CLI", None)
        # Both names exist in benchmark packages; setting them together keeps
        # every Hermes lane on the isolated, provenance-bearing AIAgent path.
        env["HERMES_MODE"] = "subprocess"
        env["HERMES_ADAPTER_MODE"] = "subprocess"
        env["ELIZA_BENCH_DISABLE_DOTENV"] = "1"
        if "tau_bench" in request.benchmarks:
            # Full campaign assets are staged and hash-reviewed before any
            # subscription quota is spent; runtime downloads could drift or
            # turn a missing corpus into a mid-run partial cohort.
            env["TAU_BENCH_DATA_DIR"] = str(
                (workspace_root / "benchmark-data" / "tau-bench").resolve()
            )
            env["TAU_BENCH_DISABLE_DATA_DOWNLOAD"] = "1"
        if "mind2web" in request.benchmarks:
            env["MIND2WEB_CACHE_DIR"] = str(
                (workspace_root / "benchmark-data" / "mind2web").resolve()
            )
            env["MIND2WEB_DISABLE_DATA_DOWNLOAD"] = "1"
    model_name = _provider_model_name(provider, request.model)
    harness = request.agent.strip().lower() or "eliza"
    env["BENCHMARK_MODEL_PROVIDER"] = provider or request.provider
    env["BENCHMARK_MODEL_NAME"] = model_name
    env["BENCHMARK_HARNESS"] = harness
    env["ELIZA_BENCH_HARNESS"] = harness
    env["BENCHMARK_AGENT"] = harness
    env["ELIZA_PROVIDER"] = (
        "openai" if provider == "claude-subscription" else provider or request.provider
    )
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
    reasoning_effort = request.extra_config.get("reasoning_effort")
    if isinstance(reasoning_effort, str) and reasoning_effort.strip():
        # Model profiles carry provider-neutral extra config. Mirror the
        # reasoning knob into the shared harness control plus provider/runtime
        # aliases so every native lane receives the same explicit effort.
        normalized_reasoning_effort = reasoning_effort.strip().lower()
        env["BENCHMARK_REASONING_EFFORT"] = normalized_reasoning_effort
        env["OPENAI_REASONING_EFFORT"] = normalized_reasoning_effort
        env["CEREBRAS_REASONING_EFFORT"] = normalized_reasoning_effort
        env["OPENCLAW_THINKING_LEVEL"] = normalized_reasoning_effort
    for extra_key, env_key in (
        ("openclaw_timeout_s", "OPENCLAW_TIMEOUT_S"),
        ("hermes_timeout_s", "HERMES_TIMEOUT_S"),
        ("eliza_bench_http_timeout_s", "ELIZA_BENCH_HTTP_TIMEOUT"),
    ):
        timeout_value = request.extra_config.get(extra_key)
        if (
            isinstance(timeout_value, (int, float))
            and not isinstance(timeout_value, bool)
            and math.isfinite(float(timeout_value))
            and float(timeout_value) > 0
        ):
            env[env_key] = str(float(timeout_value))
    env.setdefault("ELIZA_CONVERSATION_COMPACTOR", "structured-state")
    env.setdefault("MAX_CONVERSATION_TOKENS", "120000")
    env.setdefault("BENCHMARK_CAPTURE_TRAJECTORIES", "1")
    if harness == "eliza" and request.extra_config.get("allow_stub_embedding") is True:
        # Diagnostic-only opt-in. Release-evidence runs use the real embedding
        # handler from plugin-local-inference and must not silently publish
        # zero-vector memory behavior.
        env.setdefault("ELIZA_BENCH_ALLOW_STUB_EMBEDDING", "1")
    if provider in PROVIDER_DUMMY_KEY:
        provider_key = PROVIDER_KEY_ENV.get(provider)
        if provider_key and not env.get(provider_key):
            env[provider_key] = PROVIDER_DUMMY_KEY[provider]
    if provider in OPENAI_COMPAT_BASE_URL:
        provider_key = PROVIDER_KEY_ENV.get(provider)
        if provider_key and env.get(provider_key):
            env["OPENAI_API_KEY"] = env[provider_key]
        # Operator-exported proxy endpoints (e.g. the Eliza Cloud
        # OpenAI-compatible gateway) must survive into every benchmark
        # subprocess; the hardcoded provider endpoint is only the fallback when
        # nothing is configured. Both the OpenAI-compat and provider-native
        # variables are exported so no client library in the subprocess can
        # bypass the resolved endpoint.
        resolved_base_url = _resolve_openai_compat_base_url(provider, request, env)
        env["OPENAI_BASE_URL"] = resolved_base_url
        env[PROVIDER_BASE_URL_ENV[provider]] = resolved_base_url
    if provider == "claude-subscription":
        gateway_url = request.extra_config.get("claude_subscription_gateway_url")
        if not isinstance(gateway_url, str) or not gateway_url.strip():
            gateway_url = env.get("CLAUDE_SUBSCRIPTION_GATEWAY_URL", "")
        if gateway_url.strip():
            normalized_gateway_url = gateway_url.strip().rstrip("/")
            env["CLAUDE_SUBSCRIPTION_GATEWAY_URL"] = normalized_gateway_url
            env["OPENAI_BASE_URL"] = (
                normalized_gateway_url
                if normalized_gateway_url.endswith("/v1")
                else f"{normalized_gateway_url}/v1"
            )
        harness_token_key = (
            "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN_" + harness.upper().replace("-", "_")
        )
        gateway_token = env.get(harness_token_key, "") or env.get(
            "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN", ""
        )
        if gateway_token:
            env["CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN"] = gateway_token
            env["OPENAI_API_KEY"] = gateway_token
        if harness == "eliza":
            if request.extra_config.get("allow_stub_embedding") is True:
                raise ValueError(
                    "Claude-subscription Eliza runs use designed text-only "
                    "memory; allow_stub_embedding is not permitted"
                )
            # The subscription gateway is intentionally chat-only. Remove
            # ambient embedding-provider configuration so this lane cannot
            # spend an unrelated API key or silently compare a two-model Eliza
            # stack with single-model Hermes and OpenClaw stacks.
            for key in (
                "OPENAI_EMBEDDING_API_KEY",
                "OPENAI_EMBEDDING_DIMENSIONS",
                "OPENAI_EMBEDDING_MODEL",
                "OPENAI_EMBEDDING_URL",
            ):
                env.pop(key, None)
            env["ELIZA_BENCH_SUBSCRIPTION_CHAT_ONLY"] = "1"
            env["ELIZA_DISABLE_LOCAL_EMBEDDINGS"] = "1"
            env["ELIZA_BENCH_ALLOW_STUB_EMBEDDING"] = "0"
            env["ELIZA_BENCH_SKIP_EMBEDDING"] = "0"
    return env


def _repo_meta(workspace_root: Path) -> dict[str, str | None]:
    benchmarks_root = workspace_root / "benchmarks"
    eliza_root = workspace_root / "eliza"
    return {
        "benchmarks_commit": git_head(benchmarks_root),
        "eliza_commit": git_head(eliza_root),
        "eliza_version": safe_version_from_package_json(eliza_root / "package.json"),
        "benchmarks_version": safe_version_from_package_json(
            benchmarks_root / "package.json"
        ),
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
        harness_commit = (
            subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(workspace_root),
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            ).stdout.strip()
            or None
        )
    except (OSError, subprocess.SubprocessError):
        harness_commit = None
    extra_config = dict(request.extra_config) if request.extra_config else {}
    seed = extra_config.get("seed")
    temperature = extra_config.get("temperature")
    if temperature is None:
        try:
            temperature = (
                float(os.environ.get("BENCHMARK_TEMPERATURE", ""))
                if os.environ.get("BENCHMARK_TEMPERATURE")
                else None
            )
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
            "hermes": _adapter_version_from_pyproject(
                benchmarks_root / "hermes-adapter"
            ),
            "openclaw": _adapter_version_from_pyproject(
                benchmarks_root / "openclaw-adapter"
            ),
        },
        "seed": seed,
        "temperature": temperature,
        "provider": request.provider,
        "model": request.model,
    }


def _status_after_returncode(returncode: int) -> str:
    return "succeeded" if returncode == 0 else "failed"


@dataclass(frozen=True)
class ProcessDeadlinePolicy:
    """Wall and observed-progress limits for one benchmark subprocess."""

    wall_timeout_seconds: float | None
    silent_timeout_seconds: float | None
    poll_interval_seconds: float = DEFAULT_PROCESS_PROGRESS_POLL_SECONDS


@dataclass(frozen=True)
class ProcessExecutionResult:
    """Observable subprocess outcome before result discovery and scoring."""

    returncode: int
    timeout_error: str | None
    cancellation_error: str | None
    progress_event_count: int


def _positive_finite_seconds(value: object, *, label: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
        or float(value) <= 0
    ):
        raise ValueError(f"{label} must be a finite positive number")
    return float(value)


def _process_deadline_policy(
    adapter: BenchmarkAdapter,
    request: RunRequest,
) -> ProcessDeadlinePolicy:
    """Keep smoke wall caps while exhaustive runs use progress liveness."""

    if is_full_campaign_profile(request.extra_config.get("campaign_profile")):
        silent_timeout = _positive_finite_seconds(
            request.extra_config.get(
                "campaign_silent_timeout_s",
                DEFAULT_FULL_CAMPAIGN_SILENT_TIMEOUT_SECONDS,
            ),
            label="campaign_silent_timeout_s",
        )
        return ProcessDeadlinePolicy(
            wall_timeout_seconds=None,
            silent_timeout_seconds=silent_timeout,
        )
    return ProcessDeadlinePolicy(
        wall_timeout_seconds=_positive_finite_seconds(
            adapter.default_timeout_seconds,
            label="adapter.default_timeout_seconds",
        ),
        silent_timeout_seconds=None,
    )


def _progress_signature(
    *,
    stdout_path: Path,
    stderr_path: Path,
    telemetry_path: Path,
    output_root: Path,
) -> tuple[tuple[int, int], ...]:
    observed: list[tuple[int, int]] = []
    for path in (stdout_path, stderr_path, telemetry_path, output_root):
        try:
            stat = path.stat()
        except FileNotFoundError:
            # error-policy:J7 output files may appear between monitor polls;
            # absence is an explicit zero observation, not benchmark success.
            observed.append((0, 0))
            continue
        observed.append((int(stat.st_size), int(stat.st_mtime_ns)))
    return tuple(observed)


def _write_process_progress(
    progress_file,
    *,
    event: str,
    elapsed_seconds: float,
    signature: tuple[tuple[int, int], ...],
    detail: str | None = None,
) -> None:
    labels = ("stdout", "stderr", "telemetry", "output_root")
    payload: dict[str, Any] = {
        "schema_version": 1,
        "event": event,
        "observed_at": _utc_now(),
        "elapsed_seconds": round(elapsed_seconds, 3),
        "observed": {
            label: {"size_bytes": values[0], "mtime_ns": values[1]}
            for label, values in zip(labels, signature, strict=True)
        },
    }
    if detail is not None:
        payload["detail"] = detail
    progress_file.write(json.dumps(payload, sort_keys=True) + "\n")
    progress_file.flush()


def _terminate_benchmark_process(process: subprocess.Popen[str]) -> None:
    """Stop a timed-out process group so child servers cannot outlive a run."""

    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
    except ProcessLookupError:
        # error-policy:J6 the process exited during best-effort timeout teardown.
        return
    try:
        process.wait(timeout=PROCESS_TERMINATION_GRACE_SECONDS)
        return
    except subprocess.TimeoutExpired:
        # error-policy:J6 a stuck process group gets one bounded hard-stop.
        pass
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except ProcessLookupError:
        # error-policy:J6 the process exited between TERM and KILL.
        return
    process.wait()


def _run_command_with_deadlines(
    command: list[str],
    *,
    cwd: str,
    env: dict[str, str],
    stdout_file,
    stderr_file,
    stdout_path: Path,
    stderr_path: Path,
    telemetry_path: Path,
    output_root: Path,
    progress_path: Path,
    policy: ProcessDeadlinePolicy,
    execution_cancel_event: threading.Event | None = None,
) -> ProcessExecutionResult:
    """Run one command and persist only observed progress until it exits."""

    poll_interval = _positive_finite_seconds(
        policy.poll_interval_seconds,
        label="poll_interval_seconds",
    )
    if policy.wall_timeout_seconds is None and policy.silent_timeout_seconds is None:
        raise ValueError("at least one subprocess deadline must be configured")
    started = time.monotonic()
    with progress_path.open("w", encoding="utf-8") as progress_file:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=stdout_file,
            stderr=stderr_file,
            text=True,
            start_new_session=os.name == "posix",
        )
        signature = _progress_signature(
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            telemetry_path=telemetry_path,
            output_root=output_root,
        )
        _write_process_progress(
            progress_file,
            event="process_started",
            elapsed_seconds=0.0,
            signature=signature,
        )
        progress_events = 1
        last_progress = started

        while True:
            now = time.monotonic()
            current_signature = _progress_signature(
                stdout_path=stdout_path,
                stderr_path=stderr_path,
                telemetry_path=telemetry_path,
                output_root=output_root,
            )
            if current_signature != signature:
                signature = current_signature
                last_progress = now
                progress_events += 1
                _write_process_progress(
                    progress_file,
                    event="output_observed",
                    elapsed_seconds=now - started,
                    signature=signature,
                )

            returncode = process.poll()
            if returncode is not None:
                progress_events += 1
                _write_process_progress(
                    progress_file,
                    event="process_exited",
                    elapsed_seconds=now - started,
                    signature=signature,
                    detail=f"returncode={returncode}",
                )
                return ProcessExecutionResult(
                    returncode=returncode,
                    timeout_error=None,
                    cancellation_error=None,
                    progress_event_count=progress_events,
                )

            if execution_cancel_event is not None and execution_cancel_event.is_set():
                cancellation_error = (
                    "Command cancelled by the benchmark cohort coordinator"
                )
                _terminate_benchmark_process(process)
                progress_events += 1
                _write_process_progress(
                    progress_file,
                    event="cohort_cancelled",
                    elapsed_seconds=time.monotonic() - started,
                    signature=signature,
                    detail=cancellation_error,
                )
                return ProcessExecutionResult(
                    returncode=130,
                    timeout_error=None,
                    cancellation_error=cancellation_error,
                    progress_event_count=progress_events,
                )

            if (
                policy.wall_timeout_seconds is not None
                and now - started >= policy.wall_timeout_seconds
            ):
                timeout_error = (
                    "Command exceeded wall timeout after "
                    f"{policy.wall_timeout_seconds:g}s"
                )
            elif (
                policy.silent_timeout_seconds is not None
                and now - last_progress >= policy.silent_timeout_seconds
            ):
                timeout_error = (
                    "Command made no observable progress for "
                    f"{policy.silent_timeout_seconds:g}s"
                )
            else:
                time.sleep(poll_interval)
                continue

            _terminate_benchmark_process(process)
            progress_events += 1
            _write_process_progress(
                progress_file,
                event="deadline_exceeded",
                elapsed_seconds=time.monotonic() - started,
                signature=signature,
                detail=timeout_error,
            )
            return ProcessExecutionResult(
                returncode=124,
                timeout_error=timeout_error,
                cancellation_error=None,
                progress_event_count=progress_events,
            )


def _required_env_for_request(
    adapter: BenchmarkAdapter, request: RunRequest
) -> tuple[str, ...]:
    provider = request.provider.strip().lower()
    provider_requirements = (
        ("CLAUDE_SUBSCRIPTION_GATEWAY_URL", "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN")
        if provider == "claude-subscription"
        else ((PROVIDER_KEY_ENV[provider],) if provider in PROVIDER_KEY_ENV else ())
    )
    if adapter.id == "lifeops_bench":
        extra = request.extra_config
        agent = (
            str(extra.get("agent") or extra.get("harness") or request.model or "")
            .strip()
            .lower()
        )
        mode = str(extra.get("mode") or "").strip().lower()
        if agent in {"perfect", "wrong"} and mode != "live":
            return ()
        if mode == "live":
            if provider_requirements:
                return provider_requirements
            return ("CEREBRAS_API_KEY", "ANTHROPIC_API_KEY")
        if agent in {"eliza", "hermes", "openclaw", "cerebras-direct"}:
            return provider_requirements or ("CEREBRAS_API_KEY",)
        return ()

    if adapter.id == "voicebench_quality":
        stt_provider = (
            str(
                request.extra_config.get("stt_provider")
                or os.environ.get("VOICEBENCH_QUALITY_STT_PROVIDER")
                or os.environ.get("VOICEBENCH_STT_PROVIDER")
                or "groq"
            )
            .strip()
            .lower()
        )
        required = list(provider_requirements or ("CEREBRAS_API_KEY",))
        if stt_provider == "groq":
            required.append("GROQ_API_KEY")
        elif stt_provider == "eliza-runtime":
            required.append(
                "ELIZA_BENCH_URL"
                if os.environ.get("ELIZA_BENCH_URL")
                else "ELIZA_API_BASE"
            )
        return tuple(required)

    if adapter.id == "hyperliquid_bench":
        required = list(adapter.required_env)
        if "HL_PRIVATE_KEY" not in required:
            required.append("HL_PRIVATE_KEY")
        provider_key = PROVIDER_KEY_ENV.get(provider)
        if provider_key:
            required = [key for key in required if key not in PROVIDER_KEY_ENV.values()]
            required.append(provider_key)
            if provider == "claude-subscription":
                required.append("CLAUDE_SUBSCRIPTION_GATEWAY_URL")
        seen: set[str] = set()
        deduped: list[str] = []
        for key in required:
            if key in seen:
                continue
            seen.add(key)
            deduped.append(key)
        return tuple(deduped)

    required = list(adapter.required_env)
    provider_key = PROVIDER_KEY_ENV.get(provider)
    if provider_key:
        required = [key for key in required if key not in PROVIDER_KEY_ENV.values()]
        required.append(provider_key)
        if provider == "claude-subscription":
            required.append("CLAUDE_SUBSCRIPTION_GATEWAY_URL")
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
    benchmark_ids: set[str] | None = None,
) -> Path:
    from .viewer_data import build_viewer_dataset

    output_root = workspace_root / "benchmarks" / "benchmark_results"
    out = output_root / "viewer_data.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with latest_publication_lock(output_root):
        data = build_viewer_dataset(
            conn,
            benchmark_ids=benchmark_ids,
            latest_dir=output_root / "latest",
        )
        tmp = out.with_name(f"{out.name}.{os.getpid()}.{uuid4().hex}.tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=True), encoding="utf-8")
        tmp.replace(out)
    return out


def _collect_run_trajectory_metrics(
    run_root: Path, *, duration_seconds: float
) -> tuple[
    dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]]
]:
    summary, records = summarize_trajectory(run_root)
    has_real_prompt = summary.prompt_tokens > 0
    has_real_completion = summary.completion_tokens > 0
    has_real_total = summary.total_tokens > 0
    prompt_tokens: int | None = summary.prompt_tokens if has_real_prompt else None
    completion_tokens: int | None = (
        summary.completion_tokens if has_real_completion else None
    )
    if has_real_total:
        total_tokens: int | None = summary.total_tokens
    elif has_real_prompt or has_real_completion:
        total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)
    else:
        total_tokens = None
    llm_call_count: int | None = (
        summary.llm_call_count if summary.llm_call_count else None
    )
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
        "cached_tokens": summary.cached_tokens,
        "avg_prompt_tokens": (prompt_tokens / summary.llm_call_count)
        if (prompt_tokens and summary.llm_call_count)
        else None,
        "avg_completion_tokens": (completion_tokens / summary.llm_call_count)
        if (completion_tokens and summary.llm_call_count)
        else None,
        "telemetry_missing": telemetry_missing,
    }
    cache_metrics = {
        "cache_read_input_tokens": summary.cached_tokens,
        "cache_creation_input_tokens": summary.cache_creation_tokens,
        "turns_with_cached_field": summary.turns_with_cached_field,
        "cache_hit_ratio": summary.cache_hit_ratio,
    }
    throughput = (
        summary.llm_call_count / duration_seconds
        if duration_seconds > 0 and summary.llm_call_count
        else None
    )
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
            "total_tokens": record.tokens.total
            or (record.tokens.prompt + record.tokens.completion),
            "cached_tokens": record.tokens.cached,
            "cache_creation_tokens": record.tokens.cache_creation,
            "latency_ms": record.latency_ms,
            "prompt_chars": len(record.prompt_text),
        }
        for record in records
    ]
    token_metrics = _complete_token_metrics(
        token_metrics,
        trajectory_summary=trajectory_summary,
        result_json_path=None,
    )
    return (
        trajectory_summary,
        token_metrics,
        cache_metrics,
        performance_metrics,
        trajectory_rows,
    )


def _estimated_tokens_from_chars(chars: Any) -> int:
    if isinstance(chars, bool) or not isinstance(chars, (int, float)) or chars <= 0:
        return 0
    return int(math.ceil(float(chars) / 4.0))


def _sum_result_generated_tokens(value: Any) -> int:
    if isinstance(value, dict):
        total = 0
        for key, item in value.items():
            if (
                key in {"tokens_generated", "generated_tokens"}
                and isinstance(item, (int, float))
                and not isinstance(item, bool)
            ):
                total += int(item)
            else:
                total += _sum_result_generated_tokens(item)
        return total
    if isinstance(value, list):
        return sum(_sum_result_generated_tokens(item) for item in value)
    return 0


def _result_generated_token_estimate(result_json_path: Any) -> int:
    if not result_json_path:
        return 0
    path = Path(str(result_json_path))
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    return _sum_result_generated_tokens(payload)


def _complete_token_metrics(
    token_metrics: dict[str, Any] | None,
    *,
    trajectory_summary: dict[str, Any] | None,
    result_json_path: Any,
) -> dict[str, Any]:
    """Return numeric token metrics, using explicit estimates when telemetry is absent."""

    tokens = dict(token_metrics or {})
    summary = trajectory_summary or {}
    prompt = tokens.get("prompt_tokens")
    completion = tokens.get("completion_tokens")
    total = tokens.get("total_tokens")
    calls = tokens.get("llm_call_count")
    cached = tokens.get("cached_tokens", tokens.get("cache_read_input_tokens"))
    prompt_chars = summary.get("prompt_chars")

    source: str | None = tokens.get("token_estimate_source")
    if (
        not isinstance(calls, (int, float))
        or isinstance(calls, bool)
        or calls <= 0
        or int(calls) != calls
    ):
        calls = None
    else:
        calls = int(calls)

    if not isinstance(prompt, (int, float)) or isinstance(prompt, bool):
        prompt = _estimated_tokens_from_chars(prompt_chars)
        if prompt:
            source = source or "prompt_chars_div_4"
            tokens["estimated_prompt_tokens"] = prompt
        else:
            prompt = 0

    if not isinstance(completion, (int, float)) or isinstance(completion, bool):
        generated = _result_generated_token_estimate(result_json_path)
        if generated:
            completion = generated
            source = source or "result_tokens_generated"
            tokens["estimated_completion_tokens"] = completion
        elif isinstance(total, (int, float)) and not isinstance(total, bool):
            completion = max(0, int(total) - int(prompt))
        else:
            completion = 0

    if (
        not isinstance(total, (int, float))
        or isinstance(total, bool)
        or int(total) < int(prompt) + int(completion)
    ):
        total = int(prompt) + int(completion)
        if source is not None:
            tokens["estimated_total_tokens"] = total

    if not isinstance(cached, (int, float)) or isinstance(cached, bool):
        cached = 0

    tokens["llm_call_count"] = calls
    tokens["call_count"] = calls
    tokens["prompt_tokens"] = int(prompt)
    tokens["input_tokens"] = int(prompt)
    tokens["completion_tokens"] = int(completion)
    tokens["output_tokens"] = int(completion)
    tokens["total_tokens"] = int(total)
    tokens["cached_tokens"] = int(cached)
    tokens["avg_prompt_tokens"] = (int(prompt) / calls) if calls else None
    tokens["avg_completion_tokens"] = (int(completion) / calls) if calls else None
    tokens["telemetry_missing"] = source is not None or int(total) <= 0 or calls is None
    if source is not None:
        tokens["token_estimate_source"] = source
    return tokens


SYNTHETIC_AGENT_SUFFIX = "_v1"
SYNTHETIC_AGENT_SET: set[str] = set(SYNTHETIC_HARNESSES)


def _is_synthetic_agent(agent: str) -> bool:
    agent_lc = agent.strip().lower()
    if agent_lc in SYNTHETIC_AGENT_SET:
        return True
    return agent_lc.endswith(SYNTHETIC_AGENT_SUFFIX)


def _is_numeric_score(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _high_score_comparison(
    benchmark_id: str,
    score: float | None,
    request: RunRequest,
) -> tuple[str | None, float | None, float | None]:
    """Compare only workloads that explicitly retain leaderboard comparability."""
    if request.extra_config.get("compare_to_high_score") is False:
        return None, None, None
    return delta_to_high_score(benchmark_id, score)


def _publication_quarantine_reason(
    *,
    benchmark_id: str | None = None,
    status: str,
    agent: str,
    score: Any,
    token_metrics: dict[str, Any] | None,
    metrics: dict[str, Any],
    provider: str | None = None,
    model: str | None = None,
) -> str | None:
    """Return ``None`` if the result is publishable; otherwise a reason string.

    ``latest/`` is the source of truth for the most recent successful real
    benchmark result. Telemetry and sample-size weaknesses are recorded as
    publication warnings, not quarantine reasons, because hiding successful
    rows makes the matrix look missing and breaks idempotent tracking. Explicit
    sample/mock datasets are not publishable real-agent results.
    """
    del token_metrics
    if _is_synthetic_agent(agent):
        return None
    if status == "incompatible":
        return "incompatible_harness"
    if status != "succeeded":
        return "unsucceeded_run"
    if not _is_numeric_score(score):
        return "missing_score"
    runtime_provenance = (
        metrics.get("runtime_provenance")
        if isinstance(metrics.get("runtime_provenance"), dict)
        else None
    )
    native_reason = native_runtime_quarantine_reason(
        agent=agent,
        provider=provider or "",
        model=model or "",
        provenance=runtime_provenance,
        benchmark_id=benchmark_id,
    )
    if native_reason is not None:
        return native_reason
    dataset_source = metrics.get("dataset_source")
    explicit_sample = metrics.get("sample") is True or (
        isinstance(dataset_source, str)
        and dataset_source.strip().lower() in {"sample", "sample-files"}
    )
    explicit_sample = explicit_sample or metrics.get("use_sample_tasks") is True
    if benchmark_id == "agentbench":
        workload_reason = agentbench_publication_contract_reason(metrics)
        if workload_reason is not None:
            return workload_reason
    if benchmark_id == "webshop" and not explicit_sample:
        workload_reason = webshop_workload_quarantine_reason(metrics)
        if workload_reason is not None:
            return workload_reason
    minimum_request_count = (
        runtime_provenance.get("telemetry_records")
        if isinstance(runtime_provenance, dict)
        and isinstance(runtime_provenance.get("telemetry_records"), int)
        else None
    )
    gateway_provenance = metrics.get("subscription_gateway_provenance")
    gateway_reason = subscription_gateway_quarantine_reason(
        agent=agent,
        provider=provider or "",
        model=model or "",
        provenance=(
            gateway_provenance if isinstance(gateway_provenance, dict) else None
        ),
        minimum_request_count=minimum_request_count,
        benchmark_id=benchmark_id,
    )
    if gateway_reason is not None:
        return gateway_reason
    if metrics.get("sample") is True or (
        isinstance(dataset_source, str)
        and dataset_source.strip().lower() in {"sample", "sample-files"}
    ):
        return "sample_task_set"
    if metrics.get("use_sample_tasks") is True:
        return "sample_task_set"
    if metrics.get("demo_mode") is True or metrics.get("demoMode") is True:
        return "demo_mode"
    if metrics.get("publishable_three_harness") is False:
        return "benchmark_not_publishable_three_harness"
    failed_scenarios = metrics.get("failed_scenarios")
    if isinstance(failed_scenarios, (int, float)) and not isinstance(
        failed_scenarios, bool
    ):
        if failed_scenarios > 0:
            return "failed_scenarios"
    successful_runs = metrics.get("successful_runs")
    total_runs = metrics.get("total_runs")
    if (
        isinstance(total_runs, (int, float))
        and not isinstance(total_runs, bool)
        and total_runs > 0
        and isinstance(successful_runs, (int, float))
        and not isinstance(successful_runs, bool)
        and successful_runs <= 0
    ):
        return "zero_successful_runs"
    if (
        score == 0
        and metrics.get("avg_net_worth") == 0
        and metrics.get("avg_items_sold") == 0
        and metrics.get("avg_orders_placed") == 0
        and metrics.get("total_revenue") == 0
    ):
        return "no_activity_zero_score"
    if metrics.get("interrupted") is True:
        return "interrupted_run"
    return None


def _subscription_group_quarantine_reason(
    *,
    provider: str,
    run_group_id: object,
    finished_run_group_ids: set[str],
) -> str | None:
    """Keep subscription rows private until their cohort is durably finished."""

    if provider.strip().lower() != "claude-subscription":
        return None
    group_id = str(run_group_id or "").strip()
    if not group_id or group_id not in finished_run_group_ids:
        return "subscription_unfinished_cohort"
    return None


def _publication_warnings(
    *,
    benchmark_id: str,
    status: str,
    token_metrics: dict[str, Any] | None,
    metrics: dict[str, Any],
) -> list[str]:
    if status != "succeeded":
        return []
    warnings: list[str] = []
    tokens = token_metrics or {}
    token_telemetry_optional = benchmark_id in {
        "configbench",
        "eliza_replay",
        "framework",
        "hermes_yc_bench",
        "personality_bench",
        "solana",
        "vision_language",
        "voiceagentbench",
    }
    estimate_source = tokens.get("token_estimate_source")
    if estimate_source is not None or any(
        str(key).startswith("estimated_") for key in tokens
    ):
        source = str(estimate_source or "unknown")
        warnings.append(f"estimated_token_metrics:{source}")
    total_tokens = tokens.get("total_tokens")
    llm_calls = tokens.get("llm_call_count")
    if not token_telemetry_optional and total_tokens in (None, 0):
        warnings.append("telemetry_missing_total_tokens")
    if not token_telemetry_optional and llm_calls in (None, 0):
        warnings.append(f"telemetry_missing_llm_calls:{llm_calls!r}")
    elif not token_telemetry_optional and llm_calls == 1:
        warnings.append("single_llm_call")
    total_instances = metrics.get("total_instances")
    if isinstance(total_instances, (int, float)) and total_instances <= 1:
        warnings.append(f"insufficient_total_instances:{total_instances!r}")
    total_samples = metrics.get("total_samples")
    if isinstance(total_samples, (int, float)) and total_samples <= 2:
        warnings.append(f"insufficient_total_samples:{total_samples!r}")
    total_tasks = metrics.get("total_tasks")
    if isinstance(total_tasks, (int, float)) and total_tasks <= 1:
        warnings.append(f"insufficient_total_tasks:{total_tasks!r}")
    total_questions = metrics.get("total_questions")
    if isinstance(total_questions, (int, float)) and total_questions <= 2:
        warnings.append(f"insufficient_total_questions:{total_questions!r}")
    total_tests = metrics.get("total_tests")
    if isinstance(total_tests, (int, float)) and total_tests <= 2:
        warnings.append(f"insufficient_total_tests:{total_tests!r}")
    num_tasks = metrics.get("num_tasks")
    if isinstance(num_tasks, (int, float)) and num_tasks <= 1:
        warnings.append(f"insufficient_num_tasks:{num_tasks!r}")
    scenario_count = metrics.get("scenario_count")
    if isinstance(scenario_count, (int, float)) and scenario_count <= 1:
        warnings.append(f"insufficient_scenario_count:{scenario_count!r}")
    n_value = metrics.get("n")
    if isinstance(n_value, (int, float)) and n_value <= 2:
        warnings.append(f"insufficient_n:{n_value!r}")
    dataset_source = metrics.get("dataset_source")
    if metrics.get("sample") is True or (
        isinstance(dataset_source, str) and dataset_source.strip().lower() == "sample"
    ):
        warnings.append("sample_task_set")
    if metrics.get("use_sample_tasks") is True:
        warnings.append("sample_task_set")
    if metrics.get("demo_mode") is True or metrics.get("demoMode") is True:
        warnings.append("demo_mode")
    if metrics.get("interrupted") is True:
        warnings.append("interrupted_run")
    return warnings


_QUARANTINE_TRACKER: dict[Path, list[tuple[str, str, str]]] = {}


def _record_quarantine(
    output_root: Path, agent: str, benchmark_id: str, reason: str
) -> None:
    _QUARANTINE_TRACKER.setdefault(output_root, []).append(
        (benchmark_id, agent, reason)
    )


def _pop_quarantine_records(output_root: Path) -> list[tuple[str, str, str]]:
    return _QUARANTINE_TRACKER.pop(output_root, [])


def _annotate_latest_index_comparability(index: dict[str, Any]) -> None:
    """Add per-benchmark comparability metadata for latest rows."""

    groups: dict[str, dict[str, str | None]] = {}
    latest = index.get("latest")
    if not isinstance(latest, dict):
        index["benchmark_comparability"] = {}
        return
    for key, entry in latest.items():
        if not isinstance(key, str) or "::" not in key or not isinstance(entry, dict):
            continue
        benchmark_id, agent = key.split("::", 1)
        groups.setdefault(benchmark_id, {})[agent] = entry.get("comparison_signature")

    index["benchmark_comparability"] = {
        benchmark_id: {
            "comparable": len({sig for sig in signatures.values() if sig}) <= 1,
            "comparison_signatures": signatures,
            "agents": sorted(signatures),
        }
        for benchmark_id, signatures in sorted(groups.items())
    }


def _stable_latest_index_updated_at(entries: list[dict[str, Any]]) -> str:
    timestamps = [
        str(value)
        for entry in entries
        for value in (
            entry.get("updated_at"),
            entry.get("ended_at"),
            entry.get("started_at"),
        )
        if value
    ]
    return max(timestamps) if timestamps else _utc_now()


@serialize_on_output_root(0)
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
    adapters: dict[str, BenchmarkAdapter] | None = None,
) -> Path:
    """Route a snapshot to ``latest/`` or ``baselines/``.

    Real-agent rows publish to ``latest/`` unless they are structurally
    incompatible with the selected harness. Synthetic baselines
    (``perfect_v1`` etc.) are always written to ``baselines/`` and never
    intermingle with ``latest/``.
    """
    agent = request.agent
    is_synthetic = _is_synthetic_agent(agent)
    quarantine_reason = (
        None
        if is_synthetic
        else _publication_quarantine_reason(
            benchmark_id=adapter.id,
            status=status,
            agent=agent,
            score=score,
            token_metrics=token_metrics,
            metrics=metrics,
            provider=request.provider,
            model=request.model,
        )
    )
    if is_synthetic:
        target_dir = output_root / "baselines"
    elif quarantine_reason is not None:
        target_dir = output_root / "quarantine"
    else:
        target_dir = output_root / "latest"
    publication_warnings = (
        []
        if is_synthetic
        else _publication_warnings(
            benchmark_id=adapter.id,
            status=status,
            token_metrics=token_metrics,
            metrics=metrics,
        )
    )
    target_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path = (
        target_dir / f"{_sanitize_name(adapter.id)}__{_sanitize_name(agent)}.json"
    )
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
    snapshot_tmp = snapshot_path.with_name(
        f"{snapshot_path.name}.{os.getpid()}.{uuid4().hex}.tmp"
    )
    snapshot_tmp.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True),
        encoding="utf-8",
    )
    snapshot_tmp.replace(snapshot_path)

    # Also prune stale entries from alternate directories. Failed/quarantined
    # real attempts must not delete a prior successful latest snapshot; latest
    # is the successful source of truth, while quarantine records the failed
    # attempt.
    other_dirs = [
        output_root / "latest",
        output_root / "quarantine",
        output_root / "baselines",
    ]
    for other in other_dirs:
        if other == target_dir:
            continue
        if (
            target_dir.name == "quarantine"
            and other.name == "latest"
            and not is_synthetic
        ):
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
        "updated_at": "",
        "latest": {},
        "latest_by_signature": {},
        "latest_by_comparison_signature": {},
    }
    latest_payloads_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for path in sorted(latest_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        key = f"{data.get('benchmark_id')}::{data.get('agent')}"
        latest_payloads_by_key[
            (str(data.get("benchmark_id") or ""), str(data.get("agent") or ""))
        ] = data
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
            index["latest_by_signature"][f"{signature_key}::{key}"] = index["latest"][
                key
            ]
        comparison_signature_key = data.get("comparison_signature")
        if comparison_signature_key:
            index["latest_by_comparison_signature"][
                f"{comparison_signature_key}::{key}"
            ] = index["latest"][key]
    if adapters is not None:
        quarantine_payloads_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        quarantine_dir = output_root / "quarantine"
        quarantine_paths = (
            sorted(quarantine_dir.glob("*.json")) if quarantine_dir.exists() else []
        )
        for path in quarantine_paths:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(data, dict):
                continue
            quarantine_payloads_by_key[
                (str(data.get("benchmark_id") or ""), str(data.get("agent") or ""))
            ] = data
        index["matrix_contract"] = _build_latest_matrix_contract(
            latest_by_key=latest_payloads_by_key,
            quarantine_by_key=quarantine_payloads_by_key,
            adapters=adapters,
        )
    else:
        previous_index_path = latest_dir / "index.json"
        try:
            previous = json.loads(previous_index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous = {}
        if isinstance(previous, dict) and isinstance(
            previous.get("matrix_contract"), dict
        ):
            index["matrix_contract"] = previous["matrix_contract"]
    index["updated_at"] = _stable_latest_index_updated_at(
        list(latest_payloads_by_key.values())
    )
    _annotate_latest_index_comparability(index)
    index_path = latest_dir / "index.json"
    index_tmp = index_path.with_suffix(index_path.suffix + ".tmp")
    index_tmp.write_text(
        json.dumps(index, indent=2, sort_keys=True, ensure_ascii=True),
        encoding="utf-8",
    )
    index_tmp.replace(index_path)
    return snapshot_path


def _build_latest_matrix_contract(
    *,
    latest_by_key: dict[tuple[str, str], dict[str, Any]],
    quarantine_by_key: dict[tuple[str, str], dict[str, Any]],
    adapters: dict[str, BenchmarkAdapter] | None,
) -> dict[str, Any]:
    if adapters is None:
        return {
            "status": "unknown",
            "reason": "adapter discovery unavailable",
            "harnesses": list(CANONICAL_REAL_HARNESSES),
            "benchmarks": {},
            "summary": {},
        }

    summary: dict[str, int] = {
        "benchmarks": len(adapters),
        "required_real_cells": 0,
        "succeeded_required_real_cells": 0,
        "missing_required_real_cells": 0,
        "failed_required_real_cells": 0,
        "unsupported_real_cells": 0,
        "complete_benchmarks": 0,
        "incomplete_benchmarks": 0,
        "no_required_real_harness_benchmarks": 0,
        "invalid_subscription_cohort_benchmarks": 0,
    }
    benchmarks: dict[str, Any] = {}
    for benchmark_id, adapter in sorted(adapters.items()):
        allowed_harnesses = tuple(adapter.agent_compatibility)
        supported = set(allowed_harnesses)
        effective_supported = set(supported)
        required_count = 0
        complete = True
        cells: dict[str, dict[str, Any]] = {}
        for harness in CANONICAL_REAL_HARNESSES:
            row = latest_by_key.get((benchmark_id, harness))
            quarantine_row = quarantine_by_key.get((benchmark_id, harness))
            transient_success = (
                harness not in supported
                and _is_transient_runtime_gate_incompatibility(
                    benchmark_id,
                    allowed_harnesses,
                )
                and row is not None
                and row.get("status") == "succeeded"
                and isinstance(row.get("score"), (int, float))
            )
            if harness not in supported:
                if transient_success:
                    effective_supported.add(harness)
                    required_count += 1
                    summary["required_real_cells"] += 1
                    summary["succeeded_required_real_cells"] += 1
                    cells[harness] = {
                        "required": True,
                        "state": "succeeded",
                        "status": row.get("status"),
                        "score": row.get("score"),
                        "run_id": row.get("run_id"),
                        "run_group_id": row.get("run_group_id"),
                        "transient_runtime_gate_preserved": True,
                    }
                    continue
                summary["unsupported_real_cells"] += 1
                cell = {
                    "required": False,
                    "state": "unsupported",
                    "status": "unsupported",
                    "score": None,
                    "run_id": None,
                    "reason": _latest_matrix_unsupported_reason(
                        benchmark_id,
                        harness,
                        allowed_harnesses,
                    ),
                }
                required_env = _latest_matrix_unsupported_required_env(
                    benchmark_id,
                    allowed_harnesses,
                )
                if required_env:
                    cell["required_env"] = required_env
                cells[harness] = cell
                continue

            required_count += 1
            summary["required_real_cells"] += 1
            source = row or quarantine_row
            if (
                row
                and row.get("status") == "succeeded"
                and isinstance(row.get("score"), (int, float))
            ):
                state = "succeeded"
                summary["succeeded_required_real_cells"] += 1
            elif source is None:
                state = "missing"
                complete = False
                summary["missing_required_real_cells"] += 1
            else:
                state = str(source.get("status") or "failed")
                complete = False
                summary["failed_required_real_cells"] += 1
            cells[harness] = {
                "required": True,
                "state": state,
                "status": source.get("status") if source else "missing",
                "score": source.get("score") if source else None,
                "run_id": source.get("run_id") if source else None,
                "run_group_id": source.get("run_group_id") if source else None,
            }

        if required_count == 0:
            summary["no_required_real_harness_benchmarks"] += 1
            complete = False
        required_rows = [
            latest_by_key.get((benchmark_id, harness))
            for harness in CANONICAL_REAL_HARNESSES
            if harness in effective_supported
        ]
        subscription_rows = [
            row
            for row in required_rows
            if isinstance(row, dict)
            and str(row.get("provider") or "").strip().lower() == "claude-subscription"
        ]
        cohort_run_group_id: str | None = None
        cohort_reason: str | None = None
        if required_count > 1 and len(subscription_rows) == required_count:
            run_group_ids = {
                str(row.get("run_group_id") or "").strip() for row in subscription_rows
            }
            if "" in run_group_ids or len(run_group_ids) != 1:
                complete = False
                cohort_reason = "subscription_rows_not_single_cohort"
                summary["invalid_subscription_cohort_benchmarks"] += 1
            else:
                cohort_run_group_id = next(iter(run_group_ids))
        if complete:
            summary["complete_benchmarks"] += 1
        else:
            summary["incomplete_benchmarks"] += 1
        benchmarks[benchmark_id] = {
            "compatible_harnesses": [
                harness
                for harness in CANONICAL_REAL_HARNESSES
                if harness in effective_supported
            ],
            "complete": complete,
            "cohort_run_group_id": cohort_run_group_id,
            "cohort_reason": cohort_reason,
            "cells": cells,
        }

    status = "complete" if summary["incomplete_benchmarks"] == 0 else "incomplete"
    return {
        "status": status,
        "harnesses": list(CANONICAL_REAL_HARNESSES),
        "summary": summary,
        "benchmarks": benchmarks,
    }


def _latest_matrix_unsupported_reason(
    benchmark_id: str,
    harness: str,
    allowed_harnesses: tuple[str, ...],
) -> str:
    if benchmark_id == "hyperliquid_bench" and not allowed_harnesses:
        return HYPERLIQUID_LIVE_UNAVAILABLE_REASON
    if benchmark_id == "terminal_bench" and not allowed_harnesses:
        return TERMINAL_BENCH_DOCKER_UNAVAILABLE_REASON
    if (
        benchmark_id in {"swe_bench", "swe_bench_orchestrated"}
        and not allowed_harnesses
    ):
        return SWE_BENCH_DOCKER_UNAVAILABLE_REASON
    if benchmark_id == "osworld" and not allowed_harnesses:
        return OSWORLD_DOCKER_UNAVAILABLE_REASON
    if (
        benchmark_id
        in {
            "hermes_tblite",
            "hermes_terminalbench_2",
            "hermes_yc_bench",
            "hermes_swe_env",
        }
        and not allowed_harnesses
    ):
        return HERMES_SANDBOX_UNAVAILABLE_REASON
    if benchmark_id == "vision_language":
        if not allowed_harnesses:
            return VISION_LANGUAGE_REAL_INPUTS_UNAVAILABLE_REASON
        if harness == "openclaw":
            return VISION_LANGUAGE_OPENCLAW_NATIVE_MULTIMODAL_UNAVAILABLE_REASON
        if harness == "hermes":
            return VISION_LANGUAGE_HARNESS_RUNTIME_UNAVAILABLE_REASON
        return VISION_LANGUAGE_FIXED_RUNTIME_REASON
    allowed = ", ".join(allowed_harnesses) or "none"
    return f"harness '{harness}' not in adapter compatibility ({allowed})"


def _latest_matrix_unsupported_required_env(
    benchmark_id: str,
    allowed_harnesses: tuple[str, ...],
) -> list[str]:
    if benchmark_id == "hyperliquid_bench" and not allowed_harnesses:
        return ["HL_PRIVATE_KEY", "CEREBRAS_API_KEY"]
    return []


@serialize_on_output_root(1)
def _rebuild_latest_result_snapshots(
    conn,
    output_root: Path,
    adapters: dict[str, BenchmarkAdapter] | None = None,
) -> None:
    """Rebuild latest snapshots from SQLite.

    This keeps ``benchmark_results/latest`` idempotent even when a single
    benchmark is rerun, a stale snapshot was manually removed, or a compatibility
    rule changes. The latest successful scored row per ``(benchmark_id, agent)``
    is the source of truth; failed/interrupted attempts do not replace a
    known-good latest snapshot.
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
    repair_nonzero_returncode_statuses(conn)
    repair_nonpublishable_success_statuses(conn)
    if adapters is not None:
        _repair_current_compatibility_statuses(conn, adapters)

    for d in (latest_dir, quarantine_dir, baselines_dir):
        d.mkdir(parents=True, exist_ok=True)

    latest_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    latest_by_signature: dict[tuple[str, str, str], dict[str, Any]] = {}
    latest_by_comparison_signature: dict[
        tuple[str, str, str], tuple[dict[str, Any], str]
    ] = {}
    rows_by_comparison_signature: dict[
        str, dict[str, dict[str, list[dict[str, Any]]]]
    ] = {}
    quarantine_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    finished_run_group_ids = {
        str(group["run_group_id"])
        for group in conn.execute(
            "SELECT run_group_id FROM run_groups WHERE finished_at IS NOT NULL"
        ).fetchall()
    }
    valid_benchmark_ids = set(adapters) if adapters is not None else None
    for row in list_runs(conn, limit=None):
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
        is_synthetic = _is_synthetic_agent(agent)
        if not is_synthetic:
            provider = str(row.get("provider") or "")
            quarantine_reason = _subscription_group_quarantine_reason(
                provider=provider,
                run_group_id=row.get("run_group_id"),
                finished_run_group_ids=finished_run_group_ids,
            ) or _publication_quarantine_reason(
                benchmark_id=benchmark_id,
                status=str(row.get("status") or ""),
                agent=agent,
                score=row.get("score"),
                token_metrics=row.get("token_metrics") or {},
                metrics=row.get("metrics") or {},
                provider=provider,
                model=str(row.get("model") or ""),
            )
            if quarantine_reason is not None:
                key = (benchmark_id, agent)
                if key not in quarantine_by_key:
                    quarantine_by_key[key] = row
                continue
        key = (benchmark_id, agent)
        if key not in latest_by_key:
            latest_by_key[key] = row
        if is_synthetic:
            continue
        signature = str(row.get("signature") or "")
        if signature:
            signature_key = (signature, benchmark_id, agent)
            if signature_key not in latest_by_signature:
                latest_by_signature[signature_key] = row
        comparison_signature = _comparison_signature_for_row(
            row,
            benchmark_id=benchmark_id,
            agent=agent,
        )
        comparison_key = (comparison_signature, benchmark_id, agent)
        if comparison_key not in latest_by_comparison_signature:
            latest_by_comparison_signature[comparison_key] = (row, comparison_signature)
        if (
            agent in CANONICAL_REAL_HARNESSES
            and str(row.get("status") or "") == "succeeded"
            and _is_numeric_score(row.get("score"))
        ):
            rows_by_comparison_signature.setdefault(benchmark_id, {}).setdefault(
                comparison_signature, {}
            ).setdefault(agent, []).append(row)

    _promote_latest_comparable_real_cohorts(
        latest_by_key=latest_by_key,
        rows_by_comparison_signature=rows_by_comparison_signature,
        adapters=adapters,
    )

    preserved_latest: dict[tuple[str, str], tuple[dict[str, Any], Path]] = {}
    for path in sorted(latest_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        benchmark_id = str(payload.get("benchmark_id") or "")
        agent = str(payload.get("agent") or "").strip().lower()
        if not benchmark_id or not agent:
            continue
        if valid_benchmark_ids is not None and benchmark_id not in valid_benchmark_ids:
            continue
        if agent not in LATEST_SNAPSHOT_AGENTS or _is_synthetic_agent(agent):
            continue
        if adapters is not None:
            adapter = adapters.get(benchmark_id)
            if (
                adapter is not None
                and agent in CANONICAL_REAL_HARNESSES
                and agent not in adapter.agent_compatibility
                and not _is_transient_runtime_gate_incompatibility(
                    benchmark_id,
                    tuple(adapter.agent_compatibility),
                )
            ):
                continue
        if str(payload.get("status") or "") != "succeeded" or not _is_numeric_score(
            payload.get("score")
        ):
            continue
        metrics = payload.get("metrics") or {}
        if not isinstance(metrics, dict):
            metrics = {}
        token_metrics = payload.get("token_metrics") or {}
        if not isinstance(token_metrics, dict):
            token_metrics = {}
        if (
            _subscription_group_quarantine_reason(
                provider=str(payload.get("provider") or ""),
                run_group_id=payload.get("run_group_id"),
                finished_run_group_ids=finished_run_group_ids,
            )
            or _publication_quarantine_reason(
                benchmark_id=benchmark_id,
                status=str(payload.get("status") or ""),
                agent=agent,
                score=payload.get("score"),
                token_metrics=token_metrics,
                metrics=metrics,
                provider=str(payload.get("provider") or ""),
                model=str(payload.get("model") or ""),
            )
            is not None
        ):
            continue
        key = (benchmark_id, agent)
        if key in latest_by_key:
            continue
        preserved_latest[key] = (payload, path)

    expected_by_dir: dict[Path, set[Path]] = {
        latest_dir: set(),
        quarantine_dir: set(),
        baselines_dir: set(),
    }
    latest_for_contract = dict(latest_by_key)
    latest_for_contract.update(
        {key: payload for key, (payload, _path) in preserved_latest.items()}
    )
    matrix_contract = _build_latest_matrix_contract(
        latest_by_key=latest_for_contract,
        quarantine_by_key=quarantine_by_key,
        adapters=adapters,
    )
    index: dict[str, Any] = {
        "updated_at": "",
        "latest": {},
        "latest_by_signature": {},
        "latest_by_comparison_signature": {},
        "matrix_contract": matrix_contract,
    }
    for (benchmark_id, agent), row in sorted(latest_by_key.items()):
        metrics = row.get("metrics") or {}
        token_metrics = _complete_token_metrics(
            row.get("token_metrics") or {},
            trajectory_summary=row.get("trajectory_summary") or {},
            result_json_path=row.get("result_json_path"),
        )
        metrics["token_metrics"] = token_metrics
        is_synthetic = _is_synthetic_agent(agent)
        if is_synthetic:
            target_dir = baselines_dir
            quarantine_reason = None
        elif str(row.get("status") or "") == "incompatible":
            target_dir = quarantine_dir
            quarantine_reason = "incompatible_harness"
        else:
            quarantine_reason = _subscription_group_quarantine_reason(
                provider=str(row.get("provider") or ""),
                run_group_id=row.get("run_group_id"),
                finished_run_group_ids=finished_run_group_ids,
            ) or _publication_quarantine_reason(
                benchmark_id=benchmark_id,
                status=str(row.get("status") or ""),
                agent=agent,
                score=row.get("score"),
                token_metrics=token_metrics,
                metrics=metrics,
                provider=str(row.get("provider") or ""),
                model=str(row.get("model") or ""),
            )
            target_dir = quarantine_dir if quarantine_reason is not None else latest_dir
        publication_warnings = (
            []
            if is_synthetic
            else _publication_warnings(
                benchmark_id=benchmark_id,
                status=str(row.get("status") or ""),
                token_metrics=token_metrics,
                metrics=metrics,
            )
        )
        snapshot_path = (
            target_dir / f"{_sanitize_name(benchmark_id)}__{_sanitize_name(agent)}.json"
        )
        expected_by_dir[target_dir].add(snapshot_path)
        payload: dict[str, Any] = {
            "updated_at": row.get("ended_at") or row.get("started_at") or _utc_now(),
            "benchmark_id": benchmark_id,
            "benchmark_directory": row.get("benchmark_directory"),
            "run_group_id": row.get("run_group_id"),
            "run_id": row.get("run_id"),
            "signature": row.get("signature"),
            "comparison_signature": _comparison_signature_for_row(
                row,
                benchmark_id=benchmark_id,
                agent=agent,
            ),
            "status": row.get("status"),
            "agent": agent,
            "provider": row.get("provider"),
            "model": row.get("model"),
            "extra_config": row.get("extra_config") or {},
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

    for (benchmark_id, agent), (payload, snapshot_path) in sorted(
        preserved_latest.items()
    ):
        expected_by_dir[latest_dir].add(snapshot_path)
        metrics = payload.get("metrics") or {}
        if not isinstance(metrics, dict):
            metrics = {}
        token_metrics = _complete_token_metrics(
            payload.get("token_metrics")
            if isinstance(payload.get("token_metrics"), dict)
            else {},
            trajectory_summary=payload.get("trajectory_summary") or {},
            result_json_path=payload.get("result_json_path"),
        )
        metrics["token_metrics"] = token_metrics
        publication_warnings = _publication_warnings(
            benchmark_id=benchmark_id,
            status=str(payload.get("status") or ""),
            token_metrics=token_metrics,
            metrics=metrics,
        )
        payload["token_metrics"] = token_metrics
        payload["metrics"] = metrics
        payload.pop("publication_warnings", None)
        if publication_warnings:
            payload["publication_warnings"] = publication_warnings
        snapshot_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True),
            encoding="utf-8",
        )
        comparison_signature = str(payload.get("comparison_signature") or "")
        if not comparison_signature:
            comparison_signature = _comparison_signature_from_parts(
                benchmark_id=benchmark_id,
                benchmark_directory=str(
                    payload.get("benchmark_directory") or benchmark_id
                ),
                agent=agent,
                provider=str(payload.get("provider") or ""),
                model=str(payload.get("model") or ""),
                extra_config=payload.get("extra_config")
                if isinstance(payload.get("extra_config"), dict)
                else {},
            )
        index["latest"][f"{benchmark_id}::{agent}"] = {
            "path": str(snapshot_path),
            "run_id": payload.get("run_id"),
            "run_group_id": payload.get("run_group_id"),
            "signature": payload.get("signature"),
            "comparison_signature": comparison_signature,
            "score": payload.get("score"),
            "status": payload.get("status"),
            "updated_at": payload.get("updated_at"),
        }
        signature = str(payload.get("signature") or "")
        if signature:
            index["latest_by_signature"][f"{signature}::{benchmark_id}::{agent}"] = {
                "run_id": payload.get("run_id"),
                "run_group_id": payload.get("run_group_id"),
                "benchmark_id": benchmark_id,
                "agent": agent,
                "signature": signature,
                "score": payload.get("score"),
                "status": payload.get("status"),
                "updated_at": payload.get("updated_at"),
                "result_json_path": payload.get("result_json_path"),
            }
        if comparison_signature:
            index["latest_by_comparison_signature"][
                f"{comparison_signature}::{benchmark_id}::{agent}"
            ] = {
                "run_id": payload.get("run_id"),
                "run_group_id": payload.get("run_group_id"),
                "benchmark_id": benchmark_id,
                "agent": agent,
                "signature": payload.get("signature"),
                "comparison_signature": comparison_signature,
                "score": payload.get("score"),
                "status": payload.get("status"),
                "updated_at": payload.get("updated_at"),
                "result_json_path": payload.get("result_json_path"),
            }

    for (benchmark_id, agent), row in sorted(quarantine_by_key.items()):
        metrics = row.get("metrics") or {}
        token_metrics = _complete_token_metrics(
            row.get("token_metrics") or {},
            trajectory_summary=row.get("trajectory_summary") or {},
            result_json_path=row.get("result_json_path"),
        )
        metrics["token_metrics"] = token_metrics
        quarantine_reason = (
            _subscription_group_quarantine_reason(
                provider=str(row.get("provider") or ""),
                run_group_id=row.get("run_group_id"),
                finished_run_group_ids=finished_run_group_ids,
            )
            or _publication_quarantine_reason(
                benchmark_id=benchmark_id,
                status=str(row.get("status") or ""),
                agent=agent,
                score=row.get("score"),
                token_metrics=token_metrics,
                metrics=metrics,
                provider=str(row.get("provider") or ""),
                model=str(row.get("model") or ""),
            )
            or "unsucceeded_run"
        )
        publication_warnings = _publication_warnings(
            benchmark_id=benchmark_id,
            status=str(row.get("status") or ""),
            token_metrics=token_metrics,
            metrics=metrics,
        )
        snapshot_path = (
            quarantine_dir
            / f"{_sanitize_name(benchmark_id)}__{_sanitize_name(agent)}.json"
        )
        expected_by_dir[quarantine_dir].add(snapshot_path)
        payload = {
            "updated_at": row.get("ended_at") or row.get("started_at") or _utc_now(),
            "benchmark_id": benchmark_id,
            "benchmark_directory": row.get("benchmark_directory"),
            "run_group_id": row.get("run_group_id"),
            "run_id": row.get("run_id"),
            "signature": row.get("signature"),
            "comparison_signature": _comparison_signature_for_row(
                row,
                benchmark_id=benchmark_id,
                agent=agent,
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
            "quarantine_reason": quarantine_reason,
        }
        if publication_warnings:
            payload["publication_warnings"] = publication_warnings
        snapshot_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True),
            encoding="utf-8",
        )

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

    _annotate_latest_index_comparability(index)
    index["updated_at"] = _stable_latest_index_updated_at(
        [
            *latest_by_key.values(),
            *quarantine_by_key.values(),
            *(payload for payload, _path in preserved_latest.values()),
        ]
    )

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


def _promote_latest_comparable_real_cohorts(
    *,
    latest_by_key: dict[tuple[str, str], dict[str, Any]],
    rows_by_comparison_signature: dict[str, dict[str, dict[str, list[dict[str, Any]]]]],
    adapters: dict[str, BenchmarkAdapter] | None,
) -> None:
    """Prefer a complete apples-to-apples real-harness cohort for latest rows.

    Rerunning a single harness with a narrower scenario should not silently
    replace one cell and make ``benchmark_results/latest`` compare different
    task sets. If a newer per-harness row creates a mixed latest set but a
    complete common comparison signature exists, publish that coherent cohort.
    """

    for benchmark_id, rows_by_signature in rows_by_comparison_signature.items():
        required_agents = _required_real_latest_agents(benchmark_id, adapters)
        if len(required_agents) < 2:
            continue
        current_signatures: set[str] = set()
        current_rows: list[dict[str, Any]] = []
        for agent in required_agents:
            row = latest_by_key.get((benchmark_id, agent))
            if row is None:
                break
            current_rows.append(row)
            current_signatures.add(
                _comparison_signature_for_row(
                    row, benchmark_id=benchmark_id, agent=agent
                )
            )
        else:
            subscription_current = all(
                str(row.get("provider") or "").strip().lower() == "claude-subscription"
                for row in current_rows
            )
            current_run_groups = {
                str(row.get("run_group_id") or "").strip() for row in current_rows
            }
            if len(current_signatures) <= 1 and (
                not subscription_current
                or ("" not in current_run_groups and len(current_run_groups) == 1)
            ):
                continue

        candidates: list[dict[str, dict[str, Any]]] = []
        for rows_by_agent in rows_by_signature.values():
            if not all(agent in rows_by_agent for agent in required_agents):
                continue
            newest_rows = {agent: rows_by_agent[agent][0] for agent in required_agents}
            if all(
                str(row.get("provider") or "").strip().lower() == "claude-subscription"
                for row in newest_rows.values()
            ):
                rows_by_group: dict[str, dict[str, dict[str, Any]]] = {}
                for agent in required_agents:
                    for row in rows_by_agent[agent]:
                        run_group_id = str(row.get("run_group_id") or "").strip()
                        if not run_group_id:
                            continue
                        rows_by_group.setdefault(run_group_id, {}).setdefault(
                            agent, row
                        )
                candidates.extend(
                    rows
                    for rows in rows_by_group.values()
                    if all(agent in rows for agent in required_agents)
                )
            else:
                candidates.append(newest_rows)
        if not candidates:
            continue
        best = max(candidates, key=_cohort_recency_key)
        for agent in required_agents:
            latest_by_key[(benchmark_id, agent)] = best[agent]


def _required_real_latest_agents(
    benchmark_id: str,
    adapters: dict[str, BenchmarkAdapter] | None,
) -> tuple[str, ...]:
    if adapters is None:
        return CANONICAL_REAL_HARNESSES
    adapter = adapters.get(benchmark_id)
    if adapter is None:
        return CANONICAL_REAL_HARNESSES
    compatible = set(adapter.agent_compatibility)
    return tuple(agent for agent in CANONICAL_REAL_HARNESSES if agent in compatible)


def _cohort_recency_key(rows_by_agent: dict[str, dict[str, Any]]) -> tuple[str, str]:
    rows: list[dict[str, Any]] = []
    for value in rows_by_agent.values():
        if isinstance(value, dict):
            rows.append(value)
        elif isinstance(value, list):
            rows.extend(item for item in value if isinstance(item, dict))
    timestamps = [
        str(row.get("ended_at") or row.get("started_at") or "") for row in rows
    ]
    return (
        min(timestamps) if timestamps else "",
        max(timestamps) if timestamps else "",
    )


def _repair_current_compatibility_statuses(
    conn,
    adapters: dict[str, BenchmarkAdapter],
) -> int:
    """Keep stored compatibility status aligned with current adapter rules.

    Compatibility can depend on local runtime probes such as Docker. If a probe
    was unavailable, older successful rows may have been marked incompatible.
    Restore only those rows when the current rules allow the harness again and
    the saved result artifact still contains a numeric score.
    """

    repaired = 0
    for row in list_runs(conn, limit=None):
        if row.get("status") == "skipped":
            continue
        benchmark_id = str(row.get("benchmark_id") or "")
        agent = str(row.get("agent") or "").strip().lower()
        if agent not in CANONICAL_REAL_HARNESSES:
            continue
        adapter = adapters.get(benchmark_id)
        if adapter is not None and agent in adapter.agent_compatibility:
            restored = _restore_stale_compatibility_row(conn, row)
            repaired += int(restored)
            continue
        if adapter is None:
            continue
        if _is_transient_runtime_gate_incompatibility(
            benchmark_id,
            tuple(adapter.agent_compatibility),
        ):
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
                json.dumps(
                    metrics, sort_keys=True, separators=(",", ":"), ensure_ascii=True
                ),
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


def _is_transient_runtime_gate_incompatibility(
    benchmark_id: str,
    allowed_harnesses: tuple[str, ...],
) -> bool:
    if allowed_harnesses:
        return False
    return benchmark_id in {
        "hyperliquid_bench",
        "terminal_bench",
        "swe_bench",
        "swe_bench_orchestrated",
        "osworld",
        "hermes_tblite",
        "hermes_terminalbench_2",
        "hermes_yc_bench",
        "hermes_swe_env",
        "vision_language",
    }


def _restore_stale_compatibility_row(conn, row: dict[str, Any]) -> bool:
    if row.get("status") != "incompatible":
        return False
    metrics = dict(row.get("metrics") or {})
    if metrics.get("reason") != "latest_row_violates_current_compatibility":
        return False
    result_path = row.get("result_json_path")
    if not result_path:
        return False
    score = _score_from_saved_result(Path(str(result_path)), metrics)
    if score is None:
        return False
    metrics.pop("reason", None)
    metrics.pop("supported_harnesses", None)
    metrics["harness"] = str(row.get("agent") or "").strip().lower()
    conn.execute(
        """
        UPDATE benchmark_runs
        SET status = 'succeeded',
            score = ?,
            unit = 'score',
            higher_is_better = 1,
            metrics_json = ?,
            error = NULL
        WHERE run_id = ?
        """,
        (
            score,
            json.dumps(
                metrics, sort_keys=True, separators=(",", ":"), ensure_ascii=True
            ),
            row["run_id"],
        ),
    )
    return True


def _score_from_saved_result(
    result_path: Path, metrics: dict[str, Any]
) -> float | None:
    try:
        payload = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = {}
    candidates: list[Any] = []
    if isinstance(payload, dict):
        candidates.extend(
            [
                payload.get("score"),
                payload.get("accuracy"),
                payload.get("overall_score"),
                payload.get("resolve_rate"),
                payload.get("pass_at_1"),
                payload.get("transcriptionNormalizedAccuracy"),
                (payload.get("summary") or {}).get("accuracy")
                if isinstance(payload.get("summary"), dict)
                else None,
            ]
        )
        summary = payload.get("summary")
        if isinstance(summary, dict):
            for mode_summary in summary.values():
                if not isinstance(mode_summary, dict):
                    continue
                candidates.append(mode_summary.get("transcriptionNormalizedAccuracy"))
        payload_metrics = payload.get("metrics")
        if isinstance(payload_metrics, dict):
            candidates.extend(
                [
                    payload_metrics.get("score"),
                    payload_metrics.get("accuracy"),
                    payload_metrics.get("overall_score"),
                    payload_metrics.get("resolve_rate"),
                    payload_metrics.get("pass_rate"),
                    payload_metrics.get("eval/pass_rate"),
                    payload_metrics.get("pass_at_1"),
                    payload_metrics.get("transcriptionNormalizedAccuracy"),
                ]
            )
    candidates.extend(
        [
            metrics.get("score"),
            metrics.get("accuracy"),
            metrics.get("overall_score"),
            metrics.get("resolve_rate"),
            metrics.get("pass_rate"),
            metrics.get("eval/pass_rate"),
            metrics.get("pass_at_1"),
            metrics.get("transcriptionNormalizedAccuracy"),
        ]
    )
    for candidate in candidates:
        if isinstance(candidate, bool):
            continue
        if isinstance(candidate, (int, float)) and math.isfinite(float(candidate)):
            return float(candidate)
    return None


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
    publish_snapshot: bool,
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
        "calibration_depth": "scorer_payload"
        if baseline.result_path
        else "direct_score",
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

    high_label, high_value, delta = _high_score_comparison(
        adapter.id, score, effective_request
    )

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
    if publish_snapshot:
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
    shared_run_group_id: str | None = None,
    defer_publication: bool = False,
    execution_repo_meta: dict[str, str | None] | None = None,
    execution_env_overrides: dict[str, str] | None = None,
    execution_cancel_event: threading.Event | None = None,
) -> tuple[str, list[BenchmarkRunOutcome], Path]:
    """Execute benchmark subprocesses in standalone or shared-cohort mode.

    A cohort worker supplies ``shared_run_group_id`` and defers publication;
    the coordinator owns that group's lifecycle and performs one publication
    rebuild after every supported harness has stopped. The two options are
    paired so a caller cannot accidentally leave a standalone group unfinished
    or publish a partially completed cohort.
    """

    if (shared_run_group_id is None and defer_publication) or (
        shared_run_group_id is not None and not defer_publication
    ):
        raise ValueError(
            "shared_run_group_id and defer_publication must be supplied together"
        )
    benchmarks_root = workspace_root / "benchmarks"
    output_root = benchmarks_root / "benchmark_results"
    output_root.mkdir(parents=True, exist_ok=True)
    run_group_id = shared_run_group_id or (
        f"rg_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}_{uuid4().hex[:8]}"
    )
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
    if not defer_publication:
        initialize_database(conn)
        stale_before = datetime.now(UTC).timestamp() - DEFAULT_STALE_RECOVERY_SECONDS
        stale_before_iso = datetime.fromtimestamp(stale_before, tz=UTC).isoformat()
        recover_stale_running_runs(
            conn,
            stale_before=stale_before_iso,
            ended_at=_utc_now(),
        )
        repair_nonzero_returncode_statuses(conn)
        repair_nonpublishable_success_statuses(conn)

    repo_meta = execution_repo_meta or _repo_meta(workspace_root)
    base_env = _default_env(workspace_root, request)
    if execution_env_overrides is not None:
        base_env.update(execution_env_overrides)
    if not defer_publication:
        _repair_current_compatibility_statuses(conn, discovery.adapters)

    if not defer_publication:
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
            if not defer_publication:
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
                    adapters=discovery.adapters,
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
                publish_snapshot=not defer_publication,
            )
            outcomes.append(outcome)
            continue

        required_env = _required_env_for_request(adapter, effective_request)
        required_missing = [key for key in required_env if not base_env.get(key)]
        if required_missing:
            attempt = next_attempt_for_signature(conn, signature)
            run_id = (
                f"missing_env_{adapter.id}_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
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
                status="failed",
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
                status="failed",
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
            if not defer_publication:
                _write_latest_result_snapshot(
                    output_root,
                    adapter=adapter,
                    request=effective_request,
                    run_group_id=run_group_id,
                    run_id=run_id,
                    status="failed",
                    score=None,
                    unit=None,
                    higher_is_better=None,
                    metrics=outcome.metrics,
                    error=outcome.error,
                    adapters=discovery.adapters,
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
        # NDJSON keeps the liveness stream machine-readable without matching
        # trajectory discovery's broad ``*.json``/``*.jsonl`` fallbacks.
        progress_path = bench_run_root / "process-progress.ndjson"

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

        command_ctx = replace(
            ctx, request=_request_for_command_builder(effective_request)
        )
        command = adapter.command_builder(command_ctx, adapter)
        env_overrides = dict(adapter.env_overrides)
        if adapter.env_builder is not None:
            env_overrides.update(
                {k: str(v) for k, v in adapter.env_builder(ctx, adapter).items()}
            )
        run_env = merged_environment(base_env, env_overrides)
        run_env["BENCHMARK_RUN_ID"] = run_id
        run_env["BENCHMARK_RUN_ROOT"] = str(bench_run_root)
        run_env["BENCHMARK_OUTPUT_ROOT"] = str(bench_output_root)
        # Canonical run dir for adapter clients to write per-turn telemetry to
        # ``<run_dir>/telemetry.jsonl``. Kept alongside the legacy
        # ``BENCHMARK_TELEMETRY_JSONL`` for explicit-override use, and so
        # discover_trajectories() picks it up via the ``**/*.jsonl`` glob.
        run_env["BENCHMARK_RUN_DIR"] = str(bench_output_root)
        telemetry_path = bench_output_root / "telemetry.jsonl"
        run_env["BENCHMARK_TELEMETRY_JSONL"] = str(telemetry_path)
        deadline_policy = _process_deadline_policy(adapter, effective_request)

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
        cancellation_error: str | None = None
        progress_event_count = 0
        with (
            stdout_path.open("w", encoding="utf-8") as out_file,
            stderr_path.open("w", encoding="utf-8") as err_file,
        ):
            err_file.write(
                f"# command: {' '.join(shlex.quote(part) for part in command)}\n"
            )
            err_file.write(f"# cwd: {adapter.cwd}\n")
            err_file.write(f"# run_id: {run_id}\n")
            err_file.write(
                "# deadline_policy: "
                + json.dumps(
                    {
                        "wall_timeout_seconds": deadline_policy.wall_timeout_seconds,
                        "silent_timeout_seconds": deadline_policy.silent_timeout_seconds,
                    },
                    sort_keys=True,
                )
                + "\n"
            )
            err_file.flush()
            try:
                process_result = _run_command_with_deadlines(
                    command,
                    cwd=adapter.cwd,
                    env=run_env,
                    stdout_file=out_file,
                    stderr_file=err_file,
                    stdout_path=stdout_path,
                    stderr_path=stderr_path,
                    telemetry_path=telemetry_path,
                    output_root=bench_output_root,
                    progress_path=progress_path,
                    policy=deadline_policy,
                    execution_cancel_event=execution_cancel_event,
                )
                returncode = process_result.returncode
                timeout_error = process_result.timeout_error
                cancellation_error = process_result.cancellation_error
                progress_event_count = process_result.progress_event_count
                if timeout_error is not None:
                    err_file.write(f"\n{timeout_error}\n")
                    err_file.flush()
            except Exception as exc:
                # error-policy:J1 subprocess launch/monitoring is translated at
                # the benchmark process boundary into an explicit failed run.
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
        error: str | None = cancellation_error or timeout_error

        if result_path is not None and result_path.exists():
            try:
                summary = adapter.score_extractor(result_path)
                score = summary.score
                unit = summary.unit
                higher_is_better = summary.higher_is_better
                metrics = dict(summary.metrics)
                status = "succeeded"
                if cancellation_error is not None:
                    status = "failed"
                    error = cancellation_error
                elif effective_returncode != 0:
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
            if cancellation_error:
                error = cancellation_error
            elif timeout_error:
                error = timeout_error
            elif effective_returncode == 0:
                error = "Command succeeded but no result JSON found"
            else:
                error = f"Command exited with return code {effective_returncode} and no result JSON found"
            metrics = {"result_locator": "not_found"}
            if stale_result_path is not None:
                metrics["stale_result_path"] = stale_result_path
        metrics["return_code"] = effective_returncode
        metrics["execution_cancelled"] = cancellation_error is not None
        metrics["execution_deadline"] = {
            "wall_timeout_seconds": deadline_policy.wall_timeout_seconds,
            "silent_timeout_seconds": deadline_policy.silent_timeout_seconds,
            "progress_event_count": progress_event_count,
            "progress_path": str(progress_path),
        }

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
        runtime_provenance = summarize_runtime_provenance(
            bench_output_root / "telemetry.jsonl"
        )
        runtime_provenance["stub_embedding_enabled"] = (
            run_env.get("ELIZA_BENCH_ALLOW_STUB_EMBEDDING") == "1"
        )
        metrics["runtime_provenance"] = runtime_provenance

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

        high_label, high_value, delta = _high_score_comparison(
            adapter.id, score, effective_request
        )

        artifacts = [str(bench_output_root), str(progress_path)]
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
            artifacts=artifacts,
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
        if not defer_publication:
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
                adapters=discovery.adapters,
            )

    if defer_publication:
        conn.close()
        return run_group_id, outcomes, output_root / "viewer_data.json"

    repair_nonzero_returncode_statuses(conn)
    finish_run_group(
        conn,
        run_group_id=run_group_id,
        finished_at=_utc_now(),
        status=(
            "failed"
            if any(outcome.status == "failed" for outcome in outcomes)
            else "succeeded"
        ),
    )
    _repair_current_compatibility_statuses(conn, discovery.adapters)
    _rebuild_latest_result_snapshots(conn, output_root, discovery.adapters)
    viewer_snapshot = _ensure_viewer_snapshot(
        conn,
        workspace_root=workspace_root,
        benchmark_ids=set(discovery.adapters),
    )
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
