"""Phase 7 acceptance gate for the tri-agent benchmarking harness.

A single command that runs a fixed sequence of verification steps and
exits ``0`` only if all required steps pass. Calls the real orchestrator
via subprocess so the gate exercises the full integration path, not
just module imports.

When the campaign env points the resolved provider endpoint at a remote
proxy (e.g. ``CEREBRAS_BASE_URL=https://elizacloud.ai/api/v1``), the gate
starts the same loopback provider forwarder cohorts use
(``benchmarks.orchestrator.provider_forwarder``) and routes every harness
lane through it -- the hermes and openclaw native runtimes fail closed on
non-loopback endpoints, and a gate pass must certify the exact campaign
topology, not a diagnostic bypass of it. Loopback endpoints keep the
direct path with the operator env untouched.

Mostly stdlib -- ``urllib`` for the provider smoke call, ``subprocess``
for orchestrator dispatch, ``sqlite3`` for score readback; the forwarder
and its endpoint-resolution helpers are imported from
``benchmarks.orchestrator`` so the gate can never disagree with the
cohort coordinator about when the forwarder is required.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping


_THIS_FILE = Path(__file__).resolve()
PACKAGE_ROOT = _THIS_FILE.parent.parent
# packages/ -- the import root that makes ``benchmarks`` importable as a
# package, both for orchestrator subprocesses (their cwd) and for the gate's
# own in-process imports of the provider forwarder. It is also the
# ``workspace_root`` the orchestrator CLI derives for itself, so ambient-env
# resolution here matches what the spawned runs will resolve.
PACKAGES_ROOT = PACKAGE_ROOT.parent
DB_PATH = PACKAGE_ROOT / "benchmark_results" / "orchestrator.sqlite"

CEREBRAS_DEFAULT_BASE_URL = "https://api.cerebras.ai/v1"
CEREBRAS_DEFAULT_MODEL = "gemma-4-31b"

# Operator env precedence for the OpenAI-compatible endpoint. Campaign runs
# route all traffic through the Eliza Cloud proxy by exporting these vars;
# the hardcoded Cerebras default applies only when nothing is set. Never
# overwrite a pre-set operator env var.
BASE_URL_ENV_CHAIN = ("CEREBRAS_BASE_URL", "BENCHMARK_BASE_URL", "OPENAI_BASE_URL")
API_KEY_ENV_CHAIN = ("CEREBRAS_API_KEY", "OPENAI_API_KEY")


def _resolve_base_url() -> tuple[str, str]:
    """Return ``(base_url, source)`` where ``source`` names the env var that
    supplied the value, or ``"default"`` when none of the chain is set."""
    for var in BASE_URL_ENV_CHAIN:
        value = os.environ.get(var, "").strip()
        if value:
            return value, var
    return CEREBRAS_DEFAULT_BASE_URL, "default"


def _resolve_api_key() -> tuple[str, str | None]:
    """Return ``(api_key, source)``; ``("", None)`` when no key is set."""
    for var in API_KEY_ENV_CHAIN:
        value = os.environ.get(var, "").strip()
        if value:
            return value, var
    return "", None

DEFAULT_BENCHMARK_FALLBACK = "bfcl"
DEFAULT_BENCHMARK_PRIMARY = "hermes_tblite"
DEFAULT_SCORE_FLOOR = 0.1
# The hermes env harnesses (hermes-adapter/run_env_cli.py) enforce
# full-dataset-or-single-task semantics: any max_tasks other than 1 is
# rejected outright ("no generic max-tasks control"), so the gate's sanity
# run must size itself to the largest smoke slice each harness supports —
# otherwise the default gate invocation can never pass on its own default
# benchmark. The cap applies to the sanity/random steps only; full-dataset
# campaign runs go through full_campaign.py, not this gate.
SANITY_MAX_TASKS_CAP = {
    "hermes_tblite": 1,
    "hermes_terminalbench_2": 1,
    "hermes_yc_bench": 1,
    "hermes_swe_env": 1,
}
AGENTS = ("eliza", "openclaw", "hermes")
# The provider label every gate-dispatched orchestrator run uses; the
# forwarder decision must resolve the same provider's endpoint.
GATE_PROVIDER = "cerebras"

# Per-step timeouts. Each step asserts its own deadline and surfaces
# the timeout in the report rather than hanging the whole gate.
TIMEOUT_PRECHECK_S = 30
TIMEOUT_CEREBRAS_SMOKE_S = 30
TIMEOUT_AGENT_SMOKE_S = 120
# A real single-task hermes_tblite leg measures ~316s end to end (hermes venv
# boot + pinned dataset load + docker terminal sandbox + live agent loop), so
# the old 240s budget killed healthy runs. 900s bounds a wedged lane while
# leaving honest headroom for slower agent loops.
TIMEOUT_BENCHMARK_RUN_S = 900
TIMEOUT_RANDOM_RUN_S = 120


# ---------------------------------------------------------------------------
# Report shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GateStepResult:
    """One step in the gate. ``passed=False`` with ``error="skipped"`` means
    a prior step failed and the gate stopped running new work."""

    step_id: str
    passed: bool
    duration_ms: float
    details: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass(frozen=True)
class GateReport:
    overall_passed: bool
    steps: list[GateStepResult]
    started_at: str
    finished_at: str
    config: dict[str, Any]


# ---------------------------------------------------------------------------
# ANSI colors (tty-only)
# ---------------------------------------------------------------------------


def _supports_color() -> bool:
    return sys.stdout.isatty() and os.environ.get("NO_COLOR", "") == ""


_COLORS = {
    "green": "\033[32m",
    "red": "\033[31m",
    "yellow": "\033[33m",
    "cyan": "\033[36m",
    "bold": "\033[1m",
    "reset": "\033[0m",
}


def _color(text: str, color: str) -> str:
    if not _supports_color():
        return text
    return f"{_COLORS[color]}{text}{_COLORS['reset']}"


# ---------------------------------------------------------------------------
# Cerebras smoke (Step 1)
# ---------------------------------------------------------------------------


def _cerebras_chat(
    *,
    api_key: str,
    base_url: str,
    model: str,
    prompt: str,
    timeout_s: int,
) -> tuple[int, dict[str, Any] | None, str]:
    """POST to /v1/chat/completions. Returns ``(http_status, parsed_body, raw_text)``.

    On non-200 the body is the decoded error text; ``parsed_body`` is
    ``None``. We never raise from here -- callers decide whether a
    non-200 is fatal.
    """
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "max_tokens": 512,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Accept-Encoding": "identity",
            "User-Agent": "eliza-acceptance-gate/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:  # nosec B310
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw), raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        return exc.code, None, raw
    except urllib.error.URLError as exc:
        return 0, None, f"URLError: {exc.reason}"
    except (TimeoutError, OSError) as exc:
        return 0, None, f"{type(exc).__name__}: {exc}"


def _extract_cerebras_text(payload: dict[str, Any]) -> str:
    """Return ``content`` if present, else concatenate ``reasoning`` /
    ``reasoning_content`` -- gpt-oss-120b is a reasoning model and may
    emit the visible answer under a different key when the response is
    short."""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    msg = first.get("message")
    if not isinstance(msg, dict):
        return ""
    parts: list[str] = []
    for key in ("content", "reasoning", "reasoning_content"):
        value = msg.get(key)
        if isinstance(value, str) and value:
            parts.append(value)
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Provider forwarder (remote-proxy campaigns)
# ---------------------------------------------------------------------------


_PROVIDER_FORWARDER: Any | None = None
_TEARDOWN_ERRORS: list[str] = []


def _resolve_forwarder_upstream() -> tuple[str, str] | None:
    """Decide whether the gate needs the loopback provider forwarder.

    Returns ``(upstream_base_url, upstream_api_key)`` when the resolved
    provider endpoint is non-loopback, ``None`` when it is loopback (direct
    path, env untouched). Uses the same resolution helpers and ambient
    dotenv cascade as ``cohort._forwarder_upstream`` so the gate's decision
    can never disagree with the campaign coordinator's.
    """

    sys.path.insert(0, str(PACKAGES_ROOT))
    from benchmarks.orchestrator.provider_forwarder import is_loopback_url
    from benchmarks.orchestrator.runner import (
        PROVIDER_DUMMY_KEY,
        PROVIDER_KEY_ENV,
        _ambient_env,
        _resolve_openai_compat_base_url,
    )
    from benchmarks.orchestrator.types import RunRequest

    # The gate never pins endpoints through extra_config, so an empty
    # request carries only the provider the dispatched runs will use.
    request = RunRequest(
        benchmarks=(),
        agent="",
        provider=GATE_PROVIDER,
        model=CEREBRAS_DEFAULT_MODEL,
        extra_config={},
    )
    ambient_env = _ambient_env(PACKAGES_ROOT)
    resolved_base_url = _resolve_openai_compat_base_url(
        GATE_PROVIDER, request, ambient_env
    )
    if is_loopback_url(resolved_base_url):
        return None
    upstream_api_key = (
        ambient_env.get(PROVIDER_KEY_ENV[GATE_PROVIDER], "").strip()
        or ambient_env.get("OPENAI_API_KEY", "").strip()
        or PROVIDER_DUMMY_KEY.get(GATE_PROVIDER, "")
    )
    if not upstream_api_key:
        raise RuntimeError(
            f"Provider {GATE_PROVIDER} resolves to non-loopback "
            f"{resolved_base_url} but neither {PROVIDER_KEY_ENV[GATE_PROVIDER]} "
            "nor OPENAI_API_KEY is set; the loopback provider forwarder "
            "cannot authenticate upstream"
        )
    return resolved_base_url, upstream_api_key


def _step_provider_forwarder() -> GateStepResult:
    """Start one forwarder for the gate's lifetime when the endpoint is remote.

    The forwarder is the same component cohort runs use, so every
    downstream step (agent smoke, sanity benchmark) exercises the exact
    campaign topology: harness lanes hold only worthless bearer tokens and
    reach the model over genuine loopback.
    """

    global _PROVIDER_FORWARDER
    start = _now_ms()
    details: dict[str, Any] = {}
    try:
        target = _resolve_forwarder_upstream()
        if target is None:
            details["mode"] = "direct"
            details["reason"] = "resolved provider endpoint is loopback"
            return GateStepResult(
                step_id="PROVIDER_FORWARDER",
                passed=True,
                duration_ms=_now_ms() - start,
                details=details,
                error=None,
            )
        from benchmarks.orchestrator.provider_forwarder import (
            start_provider_forwarder,
        )

        run_group_id = (
            f"acceptance_gate_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
        )
        forwarder = start_provider_forwarder(
            run_group_id=run_group_id,
            provider=GATE_PROVIDER,
            harnesses=AGENTS,
            upstream_base_url=target[0],
            upstream_api_key=target[1],
            evidence_dir=(
                PACKAGE_ROOT
                / "benchmark_results"
                / run_group_id
                / "provider-forwarder"
            ),
        )
        _PROVIDER_FORWARDER = forwarder
        details = {
            "mode": "forwarder",
            "listen_base_url": forwarder.base_url,
            "upstream_host": forwarder.upstream_host,
            "harness_lanes": list(AGENTS),
            "evidence_file": str(forwarder.evidence_file),
        }
        return GateStepResult(
            step_id="PROVIDER_FORWARDER",
            passed=True,
            duration_ms=_now_ms() - start,
            details=details,
            error=None,
        )
    except Exception as exc:
        # error-policy:J1 the gate is the process boundary: a forwarder
        # startup failure becomes a failed, skip-cascading step in the report.
        return GateStepResult(
            step_id="PROVIDER_FORWARDER",
            passed=False,
            duration_ms=_now_ms() - start,
            details=details,
            error=f"{type(exc).__name__}: {exc}",
        )


def _agent_env_overrides(agent: str) -> dict[str, str]:
    """Per-harness forwarder lane env; empty when the direct path is active."""

    if _PROVIDER_FORWARDER is None:
        return {}
    return dict(_PROVIDER_FORWARDER.env_for_harness(agent))


@contextmanager
def _applied_env(overrides: Mapping[str, str]) -> Iterator[None]:
    """Temporarily apply env overrides for in-process adapter construction.

    The adapters resolve their endpoint and key from ``os.environ`` (hermes
    at construction, openclaw at send, the eliza server at spawn), so the
    lane env must be live for the whole construct-and-send window.
    """

    if not overrides:
        yield
        return
    saved = {name: os.environ.get(name) for name in overrides}
    os.environ.update(overrides)
    try:
        yield
    finally:
        for name, previous in saved.items():
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous


# ---------------------------------------------------------------------------
# Orchestrator dispatch (Steps 3 + 4)
# ---------------------------------------------------------------------------


def _orchestrator_run(
    *,
    benchmark_id: str,
    agent: str,
    provider: str,
    model: str,
    extra: dict[str, Any],
    timeout_s: int,
    verbose: bool,
    env_overrides: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    """Spawn ``python -m benchmarks.orchestrator run ...`` and return
    ``(returncode, stdout, stderr)``. The subprocess inherits the parent
    env so ``CEREBRAS_API_KEY`` and friends are visible; ``env_overrides``
    layers a forwarder harness lane on top so remote-proxy campaigns route
    the run through loopback exactly like a cohort worker."""
    cmd = [
        sys.executable,
        "-m",
        "benchmarks.orchestrator",
        "run",
        "--benchmarks",
        benchmark_id,
        "--agent",
        agent,
        "--provider",
        provider,
        "--model",
        model,
        "--force",
        "--extra",
        json.dumps(extra),
    ]
    if verbose:
        print(f"  $ {' '.join(cmd)}", flush=True)
    try:
        result = subprocess.run(
            cmd,
            cwd=str(PACKAGES_ROOT),  # so ``benchmarks`` is importable as pkg
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env={**os.environ, **env_overrides} if env_overrides else None,
        )
    except subprocess.TimeoutExpired as exc:
        return -1, (exc.stdout or ""), (
            f"orchestrator timed out after {timeout_s}s\n"
            f"stdout so far:\n{(exc.stdout or '')[-2000:]}\n"
            f"stderr so far:\n{(exc.stderr or '')[-2000:]}"
        )
    return result.returncode, (result.stdout or ""), (result.stderr or "")


def _latest_run_for(
    *,
    benchmark_id: str,
    agent: str,
) -> dict[str, Any] | None:
    """Read the most recent run row for (``benchmark_id``, ``agent``)
    from the orchestrator SQLite store. Returns ``None`` if missing."""
    if not DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT run_id, run_group_id, benchmark_id, agent, status, score,
                   unit, higher_is_better, started_at, ended_at, duration_seconds,
                   stdout_path, stderr_path, error
            FROM benchmark_runs
            WHERE benchmark_id = ? AND agent = ?
            ORDER BY started_at DESC
            LIMIT 1
            """,
            (benchmark_id, agent),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return dict(row)


def _benchmark_registered(benchmark_id: str) -> bool:
    """Cheap registry probe -- spawns ``orchestrator list-benchmarks`` and
    looks for the id. Avoids importing the registry directly because the
    benchmarks package is meant to run as a subprocess root."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "benchmarks.orchestrator", "list-benchmarks"],
            cwd=str(PACKAGES_ROOT),
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return False
    if result.returncode != 0:
        return False
    return f" {benchmark_id} " in result.stdout or f" {benchmark_id}\n" in result.stdout


# ---------------------------------------------------------------------------
# Step implementations
# ---------------------------------------------------------------------------


def _now_ms() -> float:
    return time.monotonic() * 1000.0


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _step_precheck(
    *,
    skip_install_check: bool,
) -> GateStepResult:
    start = _now_ms()
    details: dict[str, Any] = {}
    failures: list[str] = []

    api_key, key_source = _resolve_api_key()
    details["api_key_set"] = bool(api_key)
    details["api_key_source"] = key_source
    if not api_key:
        failures.append(
            "no API key set: export one of " + " > ".join(API_KEY_ENV_CHAIN)
        )

    if not skip_install_check:
        try:
            # Imported lazily so the script can still be imported in test
            # environments that don't have benchmarks on sys.path.
            sys.path.insert(0, str(PACKAGE_ROOT))
            from lib.agent_install import manifest_path, read_manifest, verify_install
        except ImportError as exc:
            return GateStepResult(
                step_id="PRECHECK",
                passed=False,
                duration_ms=_now_ms() - start,
                details=details,
                error=f"could not import lib.agent_install: {exc}",
            )
        manifests: dict[str, Any] = {}
        for agent_id in ("openclaw", "hermes"):
            mpath = manifest_path(agent_id)
            manifests[agent_id] = {"manifest_path": str(mpath), "exists": mpath.is_file()}
            if not mpath.is_file():
                failures.append(f"manifest missing for {agent_id} at {mpath}")
                continue
            if read_manifest(agent_id) is None:
                failures.append(f"manifest for {agent_id} at {mpath} is unreadable")
                continue
            ok, detail = verify_install(agent_id)
            manifests[agent_id]["verify_passed"] = ok
            manifests[agent_id]["verify_detail"] = detail
            if not ok:
                failures.append(f"verify_install({agent_id}) failed: {detail.splitlines()[0] if detail else ''}")
        details["manifests"] = manifests
    else:
        details["install_check_skipped"] = True

    return GateStepResult(
        step_id="PRECHECK",
        passed=not failures,
        duration_ms=_now_ms() - start,
        details=details,
        error="; ".join(failures) if failures else None,
    )


def _step_cerebras_smoke() -> GateStepResult:
    start = _now_ms()
    api_key, key_source = _resolve_api_key()
    base_url, base_url_source = _resolve_base_url()
    model = CEREBRAS_DEFAULT_MODEL
    prompt = "Reply with the single word: PONG"

    request_start = _now_ms()
    status, parsed, raw = _cerebras_chat(
        api_key=api_key,
        base_url=base_url,
        model=model,
        prompt=prompt,
        timeout_s=TIMEOUT_CEREBRAS_SMOKE_S,
    )
    request_ms = _now_ms() - request_start

    details: dict[str, Any] = {
        "model": model,
        "base_url": base_url,
        "base_url_source": base_url_source,
        "api_key_source": key_source,
        "http_status": status,
        "request_ms": round(request_ms, 2),
    }
    if status != 200 or parsed is None:
        return GateStepResult(
            step_id="CEREBRAS_SMOKE",
            passed=False,
            duration_ms=_now_ms() - start,
            details=details,
            error=f"non-200 response (status={status}): {raw[-1500:]}",
        )
    text = _extract_cerebras_text(parsed)
    details["response_text"] = text
    if "pong" not in text.lower():
        return GateStepResult(
            step_id="CEREBRAS_SMOKE",
            passed=False,
            duration_ms=_now_ms() - start,
            details=details,
            error=f"response did not contain 'pong': {text!r}",
        )
    return GateStepResult(
        step_id="CEREBRAS_SMOKE",
        passed=True,
        duration_ms=_now_ms() - start,
        details=details,
        error=None,
    )


_ELIZA_SERVER_MANAGER: Any | None = None


def _make_adapter_client(agent: str):
    """Build the per-agent client. Imports are localized so the script
    can still load in environments missing one adapter.

    For Eliza we lazily spawn a single ``ElizaServerManager`` per gate run
    so the smoke (and downstream sanity step) hit a real bench server, not
    a phantom localhost:3939. The manager is torn down in ``_teardown``.
    """
    sys.path.insert(0, str(PACKAGE_ROOT / "eliza-adapter"))
    sys.path.insert(0, str(PACKAGE_ROOT / "openclaw-adapter"))
    sys.path.insert(0, str(PACKAGE_ROOT / "hermes-adapter"))
    if agent == "eliza":
        from eliza_adapter.server_manager import ElizaServerManager
        global _ELIZA_SERVER_MANAGER
        if _ELIZA_SERVER_MANAGER is None:
            _ELIZA_SERVER_MANAGER = ElizaServerManager()
            _ELIZA_SERVER_MANAGER.start()
        return _ELIZA_SERVER_MANAGER.client
    if agent == "openclaw":
        from openclaw_adapter.client import OpenClawClient
        return OpenClawClient()
    if agent == "hermes":
        from hermes_adapter.client import HermesClient
        return HermesClient()
    raise ValueError(f"unknown agent {agent!r}")


def _teardown() -> None:
    """Release resources owned by the gate (Eliza server, provider forwarder).

    A forwarder whose serving loop died mid-gate is a broken-lifecycle
    signal, not a cleanup detail: the error is recorded so ``_finalize``
    can fail the report instead of certifying a run whose model route
    silently collapsed.
    """
    global _ELIZA_SERVER_MANAGER, _PROVIDER_FORWARDER
    if _ELIZA_SERVER_MANAGER is not None:
        try:
            _ELIZA_SERVER_MANAGER.stop()
        except Exception:  # noqa: BLE001 - never raise from teardown
            pass
        _ELIZA_SERVER_MANAGER = None
    if _PROVIDER_FORWARDER is not None:
        forwarder = _PROVIDER_FORWARDER
        _PROVIDER_FORWARDER = None
        try:
            forwarder.close()
        except Exception as exc:
            # error-policy:J1 teardown is the gate's boundary for forwarder
            # lifecycle failures; recorded and surfaced as a failed step in
            # _finalize rather than raised past report generation.
            _TEARDOWN_ERRORS.append(
                f"provider forwarder close failed: {type(exc).__name__}: {exc}"
            )


def _step_agent_smoke() -> GateStepResult:
    start = _now_ms()
    prompt = "Reply with the single word: PONG"
    per_agent: dict[str, Any] = {}
    failures: list[str] = []

    for agent in AGENTS:
        agent_start = _now_ms()
        overrides = _agent_env_overrides(agent)
        entry: dict[str, Any] = {
            "provider_route": "forwarder" if overrides else "direct",
        }
        try:
            # The lane env stays applied across construction AND the send:
            # hermes captures its base URL at construction, openclaw resolves
            # it per send, and the eliza server inherits env at spawn.
            with _applied_env(overrides):
                client = _make_adapter_client(agent)
                client.reset(
                    task_id="acceptance_gate_smoke", benchmark="acceptance_gate"
                )
                response = client.send_message(prompt)
            duration_ms = _now_ms() - agent_start
            text = response.text or ""
            entry["duration_ms"] = round(duration_ms, 2)
            entry["text"] = text[:500]
            params = getattr(response, "params", {}) or {}
            usage = params.get("usage") if isinstance(params, dict) else None
            if isinstance(usage, dict) and usage.get("model"):
                entry["model"] = usage.get("model")
            if "pong" not in text.lower():
                failures.append(f"{agent}: did not pong (got {text[:120]!r})")
                entry["passed"] = False
            else:
                entry["passed"] = True
        except Exception as exc:
            entry["passed"] = False
            entry["duration_ms"] = round(_now_ms() - agent_start, 2)
            entry["error"] = f"{type(exc).__name__}: {exc}"
            failures.append(f"{agent}: {type(exc).__name__}: {exc}")
        per_agent[agent] = entry

    return GateStepResult(
        step_id="AGENT_SMOKE",
        passed=not failures,
        duration_ms=_now_ms() - start,
        details={"agents": per_agent},
        error="; ".join(failures) if failures else None,
    )


def _step_sanity_benchmark(
    *,
    benchmark_id: str,
    max_tasks: int,
    verbose: bool,
) -> GateStepResult:
    start = _now_ms()
    per_agent: dict[str, Any] = {}
    failures: list[str] = []
    for agent in AGENTS:
        rc, stdout, stderr = _orchestrator_run(
            benchmark_id=benchmark_id,
            agent=agent,
            provider=GATE_PROVIDER,
            model=CEREBRAS_DEFAULT_MODEL,
            extra={"max_tasks": max_tasks},
            timeout_s=TIMEOUT_BENCHMARK_RUN_S,
            verbose=verbose,
            env_overrides=_agent_env_overrides(agent) or None,
        )
        run = _latest_run_for(benchmark_id=benchmark_id, agent=agent)
        entry: dict[str, Any] = {
            "returncode": rc,
            "run_id": (run or {}).get("run_id"),
            "status": (run or {}).get("status"),
            "score": (run or {}).get("score"),
            "stdout_tail": stdout[-1500:],
            "stderr_tail": stderr[-1500:],
        }
        if rc != 0:
            failures.append(f"{agent}: orchestrator rc={rc}")
            entry["passed"] = False
        elif run is None or run.get("score") is None:
            failures.append(f"{agent}: null score / no DB row")
            entry["passed"] = False
        else:
            entry["passed"] = True
        per_agent[agent] = entry

    return GateStepResult(
        step_id="SANITY_BENCHMARK",
        passed=not failures,
        duration_ms=_now_ms() - start,
        details={"benchmark_id": benchmark_id, "max_tasks": max_tasks, "agents": per_agent},
        error="; ".join(failures) if failures else None,
    )


def _step_random_baseline(
    *,
    benchmark_id: str,
    max_tasks: int,
    verbose: bool,
) -> GateStepResult:
    start = _now_ms()
    # random_v1 is a synthetic baseline with no model traffic, so it has no
    # forwarder lane and keeps the untouched parent env.
    rc, stdout, stderr = _orchestrator_run(
        benchmark_id=benchmark_id,
        agent="random_v1",
        provider=GATE_PROVIDER,
        model=CEREBRAS_DEFAULT_MODEL,
        extra={"max_tasks": max_tasks},
        timeout_s=TIMEOUT_RANDOM_RUN_S,
        verbose=verbose,
    )
    run = _latest_run_for(benchmark_id=benchmark_id, agent="random_v1")
    details: dict[str, Any] = {
        "benchmark_id": benchmark_id,
        "returncode": rc,
        "run_id": (run or {}).get("run_id"),
        "status": (run or {}).get("status"),
        "score": (run or {}).get("score"),
        "stdout_tail": stdout[-1500:],
        "stderr_tail": stderr[-1500:],
    }
    if rc != 0:
        return GateStepResult(
            step_id="RANDOM_BASELINE",
            passed=False,
            duration_ms=_now_ms() - start,
            details=details,
            error=f"orchestrator rc={rc}",
        )
    if run is not None and run.get("status") == "incompatible":
        # Designed outcome, not a failure: the strategy registry declares
        # chance behavior uninterpretable for this benchmark (freeform /
        # is_meaningful=False), so random_v1 reports "incompatible" with no
        # score. LIFT_OVER_RANDOM then applies the absolute score floor,
        # which is the designed compensating check — the bar stays intact.
        details["incompatible"] = True
        return GateStepResult(
            step_id="RANDOM_BASELINE",
            passed=True,
            duration_ms=_now_ms() - start,
            details=details,
            error=None,
        )
    if run is None or run.get("score") is None:
        return GateStepResult(
            step_id="RANDOM_BASELINE",
            passed=False,
            duration_ms=_now_ms() - start,
            details=details,
            error="random_v1 produced no score",
        )
    return GateStepResult(
        step_id="RANDOM_BASELINE",
        passed=True,
        duration_ms=_now_ms() - start,
        details=details,
        error=None,
    )


def _step_lift_over_random(
    *,
    benchmark_id: str,
    min_lift: float,
    score_floor: float,
    sanity_step: GateStepResult,
    random_step: GateStepResult | None,
) -> GateStepResult:
    start = _now_ms()
    sys.path.insert(0, str(PACKAGE_ROOT))
    from lib.random_baseline import BENCHMARK_STRATEGIES, is_better_than_random

    strategy = BENCHMARK_STRATEGIES.get(benchmark_id)
    is_meaningful = bool(strategy and strategy.is_meaningful)
    random_score = (random_step.details.get("score") if random_step else None)
    agents_detail = sanity_step.details.get("agents", {}) if sanity_step.details else {}

    per_agent: dict[str, Any] = {}
    failures: list[str] = []

    for agent in AGENTS:
        agent_detail = agents_detail.get(agent, {})
        score = agent_detail.get("score")
        entry: dict[str, Any] = {"score": score}
        if not is_meaningful or random_step is None or random_score is None:
            # absolute-score floor check
            entry["mode"] = "floor"
            entry["floor"] = score_floor
            ok = isinstance(score, (int, float)) and float(score) >= score_floor
            entry["passed"] = ok
            if not ok:
                failures.append(f"{agent}: score={score} below floor={score_floor}")
        else:
            entry["mode"] = "lift"
            entry["random_score"] = random_score
            entry["min_lift"] = min_lift
            ok = is_better_than_random(
                score,
                random_score,
                higher_is_better=True,
                min_lift=min_lift,
            )
            entry["passed"] = ok
            if not ok:
                failures.append(
                    f"{agent}: score={score} did not beat random={random_score} by {min_lift}x"
                )
        per_agent[agent] = entry

    return GateStepResult(
        step_id="LIFT_OVER_RANDOM",
        passed=not failures,
        duration_ms=_now_ms() - start,
        details={
            "benchmark_id": benchmark_id,
            "is_meaningful": is_meaningful,
            "agents": per_agent,
        },
        error="; ".join(failures) if failures else None,
    )


def _step_trajectory_normalization(
    *,
    benchmark_id: str,
    sanity_step: GateStepResult,
    strict: bool,
) -> GateStepResult:
    start = _now_ms()
    agents_detail = sanity_step.details.get("agents", {}) if sanity_step.details else {}
    per_agent: dict[str, Any] = {}
    failures: list[str] = []
    warnings: list[str] = []

    for agent in AGENTS:
        agent_detail = agents_detail.get(agent, {})
        run_id = agent_detail.get("run_id")
        entry: dict[str, Any] = {"run_id": run_id}
        if not run_id:
            entry["passed"] = False
            entry["error"] = "no run_id available from sanity step"
            failures.append(f"{agent}: no run_id available")
            per_agent[agent] = entry
            continue
        # Search for trajectory.canonical.jsonl anywhere under the run's
        # output directory tree (the runner places it under
        # ``benchmark_results/<run_group_id>/<bench>__<id>/<run_id>/...``).
        bench_results = PACKAGE_ROOT / "benchmark_results"
        matches = list(bench_results.glob(f"**/{run_id}/**/trajectory.canonical.jsonl"))
        if not matches:
            matches = list(bench_results.glob(f"**/{run_id}/trajectory.canonical.jsonl"))
        entry["candidate_paths"] = [str(p) for p in matches[:5]]
        if not matches:
            entry["passed"] = False
            msg = f"{agent}: trajectory.canonical.jsonl missing for run_id={run_id}"
            if strict:
                failures.append(msg)
                entry["error"] = "missing"
            else:
                warnings.append(msg)
                entry["warning"] = "missing (warn-only without --strict)"
            per_agent[agent] = entry
            continue
        path = matches[0]
        try:
            lines = [
                ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()
            ]
        except OSError as exc:
            entry["passed"] = False
            entry["error"] = f"could not read {path}: {exc}"
            failures.append(f"{agent}: read error {path}")
            per_agent[agent] = entry
            continue
        entry["entry_count"] = len(lines)
        entry["path"] = str(path)
        if len(lines) < 1:
            entry["passed"] = False
            failures.append(f"{agent}: {path} has zero entries")
        else:
            entry["passed"] = True
        per_agent[agent] = entry

    passed = not failures
    error_parts = list(failures)
    if warnings and not strict:
        error_parts.extend(warnings)
    return GateStepResult(
        step_id="TRAJECTORY_NORMALIZATION",
        passed=passed,
        duration_ms=_now_ms() - start,
        details={"benchmark_id": benchmark_id, "agents": per_agent, "warnings": warnings},
        error="; ".join(error_parts) if error_parts else None,
    )


def _skipped(step_id: str, reason: str) -> GateStepResult:
    return GateStepResult(
        step_id=step_id,
        passed=False,
        duration_ms=0.0,
        details={"skipped": True, "reason": reason},
        error=f"skipped: {reason}",
    )


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def _resolve_benchmark(benchmark_id: str) -> str:
    """If ``benchmark_id`` isn't registered, fall back to the BFCL default.

    Returns the resolved id. Never raises; an unknown fallback will be
    surfaced as a step failure with full subprocess output.
    """
    if _benchmark_registered(benchmark_id):
        return benchmark_id
    if benchmark_id == DEFAULT_BENCHMARK_PRIMARY:
        return DEFAULT_BENCHMARK_FALLBACK
    return benchmark_id


def run_acceptance_gate(
    *,
    benchmark_id: str = DEFAULT_BENCHMARK_PRIMARY,
    max_tasks: int = 2,
    min_lift: float = 1.5,
    skip_random: bool = False,
    skip_install_check: bool = False,
    verbose: bool = False,
    output_dir: Path | None = None,
    strict: bool = False,
    score_floor: float = DEFAULT_SCORE_FLOOR,
) -> GateReport:
    """Run the full acceptance gate. Each step records its outcome; once
    a required step fails the remainder are recorded as ``skipped``."""

    started_at = _iso_now()
    resolved_bench = _resolve_benchmark(benchmark_id)
    max_tasks_requested = max_tasks
    max_tasks = min(max_tasks, SANITY_MAX_TASKS_CAP.get(resolved_bench, max_tasks))
    config: dict[str, Any] = {
        "benchmark_id_requested": benchmark_id,
        "benchmark_id_resolved": resolved_bench,
        "max_tasks_requested": max_tasks_requested,
        "max_tasks": max_tasks,
        "min_lift": min_lift,
        "skip_random": skip_random,
        "skip_install_check": skip_install_check,
        "strict": strict,
        "score_floor": score_floor,
    }
    steps: list[GateStepResult] = []

    def _print(step: GateStepResult) -> None:
        flag = _color("PASS", "green") if step.passed else _color("FAIL", "red")
        print(f"  [{flag}] {step.step_id} ({step.duration_ms:.0f}ms)")
        if step.error and verbose:
            print(_color(f"        error: {step.error[:600]}", "yellow"))

    print(_color("=== Phase 7 acceptance gate ===", "bold"))
    print(f"  benchmark={resolved_bench} (requested={benchmark_id})")
    print(f"  max_tasks={max_tasks} min_lift={min_lift} skip_random={skip_random}")
    print("")

    # Step 0
    step = _step_precheck(skip_install_check=skip_install_check)
    steps.append(step)
    _print(step)
    if not step.passed:
        for sid in (
            "CEREBRAS_SMOKE",
            "PROVIDER_FORWARDER",
            "AGENT_SMOKE",
            "SANITY_BENCHMARK",
            "RANDOM_BASELINE",
            "LIFT_OVER_RANDOM",
            "TRAJECTORY_NORMALIZATION",
        ):
            steps.append(_skipped(sid, "PRECHECK failed"))
        return _finalize(steps, started_at, config, output_dir)

    # Step 1
    step = _step_cerebras_smoke()
    steps.append(step)
    _print(step)
    if not step.passed:
        for sid in (
            "PROVIDER_FORWARDER",
            "AGENT_SMOKE",
            "SANITY_BENCHMARK",
            "RANDOM_BASELINE",
            "LIFT_OVER_RANDOM",
            "TRAJECTORY_NORMALIZATION",
        ):
            steps.append(_skipped(sid, "CEREBRAS_SMOKE failed"))
        return _finalize(steps, started_at, config, output_dir)

    # Step 1.5 -- one forwarder for the gate's remaining lifetime when the
    # resolved provider endpoint is remote; closed in _teardown.
    step = _step_provider_forwarder()
    steps.append(step)
    _print(step)
    if not step.passed:
        for sid in (
            "AGENT_SMOKE",
            "SANITY_BENCHMARK",
            "RANDOM_BASELINE",
            "LIFT_OVER_RANDOM",
            "TRAJECTORY_NORMALIZATION",
        ):
            steps.append(_skipped(sid, "PROVIDER_FORWARDER failed"))
        return _finalize(steps, started_at, config, output_dir)

    # Step 2
    step = _step_agent_smoke()
    steps.append(step)
    _print(step)
    if not step.passed:
        for sid in (
            "SANITY_BENCHMARK",
            "RANDOM_BASELINE",
            "LIFT_OVER_RANDOM",
            "TRAJECTORY_NORMALIZATION",
        ):
            steps.append(_skipped(sid, "AGENT_SMOKE failed"))
        return _finalize(steps, started_at, config, output_dir)

    # Step 3
    sanity_step = _step_sanity_benchmark(
        benchmark_id=resolved_bench,
        max_tasks=max_tasks,
        verbose=verbose,
    )
    steps.append(sanity_step)
    _print(sanity_step)
    if not sanity_step.passed:
        for sid in (
            "RANDOM_BASELINE",
            "LIFT_OVER_RANDOM",
            "TRAJECTORY_NORMALIZATION",
        ):
            steps.append(_skipped(sid, "SANITY_BENCHMARK failed"))
        return _finalize(steps, started_at, config, output_dir)

    # Step 4
    random_step: GateStepResult | None = None
    if skip_random:
        random_step = _skipped("RANDOM_BASELINE", "--skip-random")
        # Mark as a non-failing "intentional skip" so the gate can still pass.
        random_step = GateStepResult(
            step_id="RANDOM_BASELINE",
            passed=True,
            duration_ms=0.0,
            details={"skipped": True, "reason": "--skip-random"},
            error=None,
        )
        steps.append(random_step)
        _print(random_step)
    else:
        random_step = _step_random_baseline(
            benchmark_id=resolved_bench,
            max_tasks=max_tasks,
            verbose=verbose,
        )
        steps.append(random_step)
        _print(random_step)
        if not random_step.passed:
            for sid in ("LIFT_OVER_RANDOM", "TRAJECTORY_NORMALIZATION"):
                steps.append(_skipped(sid, "RANDOM_BASELINE failed"))
            return _finalize(steps, started_at, config, output_dir)

    # Step 5
    lift_step = _step_lift_over_random(
        benchmark_id=resolved_bench,
        min_lift=min_lift,
        score_floor=score_floor,
        sanity_step=sanity_step,
        random_step=None if skip_random else random_step,
    )
    steps.append(lift_step)
    _print(lift_step)
    # Lift failures don't gate the trajectory check -- we still want to
    # surface trajectory state for debugging.

    # Step 6
    traj_step = _step_trajectory_normalization(
        benchmark_id=resolved_bench,
        sanity_step=sanity_step,
        strict=strict,
    )
    steps.append(traj_step)
    _print(traj_step)

    return _finalize(steps, started_at, config, output_dir)


def _finalize(
    steps: list[GateStepResult],
    started_at: str,
    config: dict[str, Any],
    output_dir: Path | None,
) -> GateReport:
    # Always release resources owned by the gate (Eliza server, forwarder)
    # before producing the final report. Idempotent and exception-safe.
    _teardown()
    if _TEARDOWN_ERRORS:
        # A broken forwarder lifecycle (serving loop died mid-gate) must fail
        # the report: the smokes may have raced ahead of the collapse.
        steps.append(
            GateStepResult(
                step_id="FORWARDER_TEARDOWN",
                passed=False,
                duration_ms=0.0,
                details={},
                error="; ".join(_TEARDOWN_ERRORS),
            )
        )
        _TEARDOWN_ERRORS.clear()
    overall_passed = all(step.passed for step in steps)
    finished_at = _iso_now()
    report = GateReport(
        overall_passed=overall_passed,
        steps=steps,
        started_at=started_at,
        finished_at=finished_at,
        config=config,
    )
    _print_summary(report)
    if output_dir is not None:
        output_dir.mkdir(parents=True, exist_ok=True)
        out_path = output_dir / f"acceptance_gate_{started_at.replace(':', '-')}.json"
        out_path.write_text(_report_to_json(report), encoding="utf-8")
        print("")
        print(f"  report: {out_path}")
    return report


def _report_to_json(report: GateReport) -> str:
    payload = {
        "overall_passed": report.overall_passed,
        "started_at": report.started_at,
        "finished_at": report.finished_at,
        "config": report.config,
        "steps": [asdict(step) for step in report.steps],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _print_summary(report: GateReport) -> None:
    print("")
    print(_color("--- summary ---", "bold"))
    total = len(report.steps)
    passed = sum(1 for step in report.steps if step.passed)
    failed = sum(
        1
        for step in report.steps
        if not step.passed
        and not (step.details and step.details.get("skipped"))
    )
    skipped = sum(
        1 for step in report.steps if step.details and step.details.get("skipped")
    )
    print(f"  steps={total} passed={passed} failed={failed} skipped={skipped}")
    print(
        f"  overall: "
        f"{_color('PASS', 'green') if report.overall_passed else _color('FAIL', 'red')}"
    )
    for step in report.steps:
        flag = "PASS" if step.passed else "FAIL"
        if step.details and step.details.get("skipped"):
            flag = "SKIP"
        color = "green" if flag == "PASS" else ("yellow" if flag == "SKIP" else "red")
        print(
            f"  {_color(flag, color)} {step.step_id:28s} "
            f"{step.duration_ms:8.0f}ms "
            f"{(step.error or '')[:100]}"
        )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="acceptance_gate",
        description="Phase 7 acceptance gate for the tri-agent harness.",
    )
    parser.add_argument("--benchmark", default=DEFAULT_BENCHMARK_PRIMARY)
    parser.add_argument("--max-tasks", type=int, default=2)
    parser.add_argument("--min-lift", type=float, default=1.5)
    parser.add_argument("--skip-random", action="store_true")
    parser.add_argument("--skip-install-check", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--strict", action="store_true",
                        help="Treat missing trajectory.canonical.jsonl as a hard failure (default: warn-only)")
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--score-floor", type=float, default=DEFAULT_SCORE_FLOOR)
    return parser


def cli(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    report = run_acceptance_gate(
        benchmark_id=args.benchmark,
        max_tasks=args.max_tasks,
        min_lift=args.min_lift,
        skip_random=args.skip_random,
        skip_install_check=args.skip_install_check,
        verbose=args.verbose,
        output_dir=args.output_dir,
        strict=args.strict,
        score_floor=args.score_floor,
    )
    return 0 if report.overall_passed else 1


if __name__ == "__main__":
    sys.exit(cli())
