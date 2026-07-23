"""Tests for ``scripts/acceptance_gate.py``.

The acceptance gate spawns the orchestrator and calls the provider over
HTTP. These tests mock both so we never spend real quota or launch a
real benchmark process; the provider-forwarder tests instead run the
REAL forwarder against a local upstream stub that stands in for the
remote cloud proxy, so the loopback relay, per-lane bearer swap, and
teardown are exercised over genuine sockets. The module is loaded by
path so the tests don't depend on ``scripts/`` being a package.
"""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest


_MODULE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "acceptance_gate.py"


def _load_module():
    name = "acceptance_gate_under_test"
    spec = importlib.util.spec_from_file_location(name, _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


gate = _load_module()


# ---------------------------------------------------------------------------
# Step 0: PRECHECK
# ---------------------------------------------------------------------------


def _clear_credential_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in (*gate.API_KEY_ENV_CHAIN, *gate.BASE_URL_ENV_CHAIN):
        monkeypatch.delenv(var, raising=False)


def test_precheck_fails_when_key_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_credential_env(monkeypatch)
    result = gate._step_precheck(skip_install_check=True)
    assert result.passed is False
    assert result.step_id == "PRECHECK"
    assert "CEREBRAS_API_KEY" in (result.error or "")
    assert "OPENAI_API_KEY" in (result.error or "")
    assert result.details["api_key_set"] is False
    assert result.details["api_key_source"] is None


def test_precheck_passes_with_key_and_install_skipped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_credential_env(monkeypatch)
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test-123")
    result = gate._step_precheck(skip_install_check=True)
    assert result.passed is True
    assert result.error is None
    assert result.details["api_key_set"] is True
    assert result.details["api_key_source"] == "CEREBRAS_API_KEY"


def test_precheck_accepts_openai_key_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_credential_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-cloud-key")
    result = gate._step_precheck(skip_install_check=True)
    assert result.passed is True
    assert result.details["api_key_source"] == "OPENAI_API_KEY"


# ---------------------------------------------------------------------------
# Env resolution chains
# ---------------------------------------------------------------------------


def test_resolve_base_url_defaults_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_credential_env(monkeypatch)
    assert gate._resolve_base_url() == (gate.CEREBRAS_DEFAULT_BASE_URL, "default")


def test_resolve_base_url_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_credential_env(monkeypatch)
    monkeypatch.setenv("OPENAI_BASE_URL", "https://elizacloud.ai/api/v1")
    assert gate._resolve_base_url() == (
        "https://elizacloud.ai/api/v1",
        "OPENAI_BASE_URL",
    )
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://bench.example/v1")
    assert gate._resolve_base_url() == (
        "https://bench.example/v1",
        "BENCHMARK_BASE_URL",
    )
    monkeypatch.setenv("CEREBRAS_BASE_URL", "https://cerebras.example/v1")
    assert gate._resolve_base_url() == (
        "https://cerebras.example/v1",
        "CEREBRAS_BASE_URL",
    )


def test_resolve_base_url_skips_blank_values(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_credential_env(monkeypatch)
    monkeypatch.setenv("CEREBRAS_BASE_URL", "   ")
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
    assert gate._resolve_base_url() == (
        "https://elizacloud.ai/api/v1",
        "BENCHMARK_BASE_URL",
    )


def test_resolve_api_key_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_credential_env(monkeypatch)
    assert gate._resolve_api_key() == ("", None)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-cloud-key")
    assert gate._resolve_api_key() == ("sk-cloud-key", "OPENAI_API_KEY")
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-native")
    assert gate._resolve_api_key() == ("csk-native", "CEREBRAS_API_KEY")


# ---------------------------------------------------------------------------
# Step 1: CEREBRAS_SMOKE
# ---------------------------------------------------------------------------


def test_cerebras_smoke_classifies_pong(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test-123")

    def _fake_chat(**kwargs: Any) -> tuple[int, dict[str, Any], str]:
        return (
            200,
            {"choices": [{"message": {"content": "PONG"}}]},
            '{"choices":[{"message":{"content":"PONG"}}]}',
        )

    monkeypatch.setattr(gate, "_cerebras_chat", _fake_chat)
    result = gate._step_cerebras_smoke()
    assert result.passed is True
    assert result.error is None
    assert result.details["response_text"] == "PONG"


def test_cerebras_smoke_routes_through_operator_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pre-set operator env (cloud proxy base URL + OpenAI-style key) must be
    honored by the smoke call instead of the hardcoded Cerebras default."""
    _clear_credential_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-cloud-key")
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
    seen: dict[str, Any] = {}

    def _fake_chat(**kwargs: Any) -> tuple[int, dict[str, Any], str]:
        seen.update(kwargs)
        return 200, {"choices": [{"message": {"content": "PONG"}}]}, "{}"

    monkeypatch.setattr(gate, "_cerebras_chat", _fake_chat)
    result = gate._step_cerebras_smoke()
    assert result.passed is True
    assert seen["base_url"] == "https://elizacloud.ai/api/v1"
    assert seen["api_key"] == "sk-cloud-key"
    assert result.details["base_url_source"] == "BENCHMARK_BASE_URL"
    assert result.details["api_key_source"] == "OPENAI_API_KEY"


def test_cerebras_smoke_fails_on_missing_pong(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test-123")

    def _fake_chat(**kwargs: Any) -> tuple[int, dict[str, Any], str]:
        return (
            200,
            {"choices": [{"message": {"content": "ping?"}}]},
            "{}",
        )

    monkeypatch.setattr(gate, "_cerebras_chat", _fake_chat)
    result = gate._step_cerebras_smoke()
    assert result.passed is False
    assert "pong" in (result.error or "").lower()


def test_cerebras_smoke_fails_on_non_200(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test-123")
    monkeypatch.setattr(
        gate,
        "_cerebras_chat",
        lambda **k: (401, None, '{"error":"unauthorized"}'),
    )
    result = gate._step_cerebras_smoke()
    assert result.passed is False
    assert "non-200" in (result.error or "")


def test_cerebras_smoke_does_not_retry_untyped_warming_prose(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test-123")
    calls = 0

    def _fake_chat(**_kwargs: Any) -> tuple[int, None, str]:
        nonlocal calls
        calls += 1
        return 503, None, '{"error":"authorization warming. Retry shortly."}'

    monkeypatch.setattr(gate, "_cerebras_chat", _fake_chat)

    result = gate._step_cerebras_smoke()

    assert result.passed is False
    assert calls == 1
    assert "status=503" in (result.error or "")


# ---------------------------------------------------------------------------
# Orchestrator process ownership
# ---------------------------------------------------------------------------


def test_orchestrator_timeout_interrupts_before_returning_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen_kwargs: dict[str, Any] = {}

    class _FakeProcess:
        returncode = -2

        def __init__(self) -> None:
            self.communicate_calls = 0
            self.signals: list[int] = []
            self.killed = False

        def communicate(self, timeout: float | None = None) -> tuple[str, str]:
            self.communicate_calls += 1
            if self.communicate_calls == 1:
                raise subprocess.TimeoutExpired(
                    cmd=["orchestrator"],
                    timeout=timeout,
                    output="partial stdout",
                    stderr="partial stderr",
                )
            return "final stdout", "final stderr"

        def send_signal(self, value: int) -> None:
            self.signals.append(value)

        def kill(self) -> None:
            self.killed = True

    process = _FakeProcess()

    def _fake_popen(*_args: Any, **kwargs: Any) -> _FakeProcess:
        popen_kwargs.update(kwargs)
        return process

    monkeypatch.setattr(gate.subprocess, "Popen", _fake_popen)

    returncode, stdout, stderr = gate._orchestrator_run(
        benchmark_id="bfcl",
        agent="eliza",
        provider="cerebras",
        model="test-model",
        extra={},
        timeout_s=1,
        verbose=False,
    )

    expected_interrupt = (
        getattr(signal, "CTRL_BREAK_EVENT", signal.SIGTERM)
        if os.name == "nt"
        else signal.SIGINT
    )
    assert returncode == -1
    assert stdout == "final stdout"
    assert "owned interrupt" in stderr
    assert process.signals == [expected_interrupt]
    assert process.killed is False
    assert popen_kwargs["env"][gate.ACCEPTANCE_PARENT_BOUNDARY_ENV] == "1"


def test_orchestrator_timeout_force_kills_after_interrupt_grace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _FakeProcess:
        returncode = -9

        def __init__(self) -> None:
            self.communicate_calls = 0
            self.killed = False

        def communicate(self, timeout: float | None = None) -> tuple[str, str]:
            self.communicate_calls += 1
            if self.communicate_calls <= 2:
                raise subprocess.TimeoutExpired(
                    cmd=["orchestrator"],
                    timeout=timeout,
                    output="partial stdout",
                    stderr="partial stderr",
                )
            return "forced stdout", "forced stderr"

        def send_signal(self, _value: int) -> None:
            return None

        def kill(self) -> None:
            self.killed = True

    process = _FakeProcess()
    monkeypatch.setattr(
        gate.subprocess,
        "Popen",
        lambda *_args, **_kwargs: process,
    )

    returncode, _stdout, stderr = gate._orchestrator_run(
        benchmark_id="bfcl",
        agent="eliza",
        provider="cerebras",
        model="test-model",
        extra={},
        timeout_s=1,
        verbose=False,
    )

    assert returncode == -1
    assert process.killed is True
    assert "forced kill after interrupt grace" in stderr


# ---------------------------------------------------------------------------
# Step 5: LIFT_OVER_RANDOM
# ---------------------------------------------------------------------------


def _make_sanity_step(scores: dict[str, float | None]) -> Any:
    agents_detail = {
        agent: {"score": score, "passed": True, "run_id": f"rid_{agent}"}
        for agent, score in scores.items()
    }
    return gate.GateStepResult(
        step_id="SANITY_BENCHMARK",
        passed=True,
        duration_ms=1.0,
        details={"agents": agents_detail},
        error=None,
    )


def _make_random_step(score: float | None) -> Any:
    return gate.GateStepResult(
        step_id="RANDOM_BASELINE",
        passed=True,
        duration_ms=1.0,
        details={"score": score},
        error=None,
    )


def test_lift_over_random_passes_when_above_threshold() -> None:
    sanity = _make_sanity_step({"eliza": 0.8, "openclaw": 0.8, "hermes": 0.8})
    random_step = _make_random_step(0.4)
    result = gate._step_lift_over_random(
        benchmark_id="bfcl",
        min_lift=1.5,
        score_floor=0.1,
        sanity_step=sanity,
        random_step=random_step,
    )
    assert result.passed is True
    assert result.error is None
    for agent in ("eliza", "openclaw", "hermes"):
        assert result.details["agents"][agent]["passed"] is True
        assert result.details["agents"][agent]["mode"] == "lift"


def test_lift_over_random_fails_when_below_threshold() -> None:
    sanity = _make_sanity_step({"eliza": 0.5, "openclaw": 0.5, "hermes": 0.5})
    random_step = _make_random_step(0.4)
    result = gate._step_lift_over_random(
        benchmark_id="bfcl",
        min_lift=1.5,
        score_floor=0.1,
        sanity_step=sanity,
        random_step=random_step,
    )
    assert result.passed is False
    assert "did not beat" in (result.error or "")


def test_lift_over_random_uses_floor_for_uninterpretable_benchmark() -> None:
    # 'solana' is registered as is_meaningful=False -> use absolute floor
    sanity = _make_sanity_step({"eliza": 0.2, "openclaw": 0.05, "hermes": 0.5})
    random_step = _make_random_step(0.4)
    result = gate._step_lift_over_random(
        benchmark_id="solana",
        min_lift=1.5,
        score_floor=0.1,
        sanity_step=sanity,
        random_step=random_step,
    )
    assert result.passed is False
    assert result.details["is_meaningful"] is False
    agents = result.details["agents"]
    assert agents["eliza"]["passed"] is True
    assert agents["openclaw"]["passed"] is False
    assert agents["hermes"]["passed"] is True


# ---------------------------------------------------------------------------
# Step 6: TRAJECTORY_NORMALIZATION
# ---------------------------------------------------------------------------


def test_trajectory_normalization_warns_when_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(gate, "PACKAGE_ROOT", tmp_path)
    (tmp_path / "benchmark_results").mkdir(parents=True)
    sanity = _make_sanity_step({"eliza": 0.5, "openclaw": 0.5, "hermes": 0.5})
    result = gate._step_trajectory_normalization(
        benchmark_id="bfcl",
        sanity_step=sanity,
        strict=False,
    )
    # warn-only: passes overall, but every agent records a warning.
    assert result.passed is True
    assert len(result.details["warnings"]) == 3


def test_trajectory_normalization_fails_strict(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(gate, "PACKAGE_ROOT", tmp_path)
    (tmp_path / "benchmark_results").mkdir(parents=True)
    sanity = _make_sanity_step({"eliza": 0.5, "openclaw": 0.5, "hermes": 0.5})
    result = gate._step_trajectory_normalization(
        benchmark_id="bfcl",
        sanity_step=sanity,
        strict=True,
    )
    assert result.passed is False
    assert (result.error or "").startswith("eliza:") or "missing" in (
        result.error or ""
    )


def test_trajectory_normalization_succeeds_when_files_present(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(gate, "PACKAGE_ROOT", tmp_path)
    bench_root = tmp_path / "benchmark_results"
    for agent in ("eliza", "openclaw", "hermes"):
        run_dir = bench_root / "rg_test" / "x__y" / f"rid_{agent}"
        run_dir.mkdir(parents=True)
        (run_dir / "trajectory.canonical.jsonl").write_text(
            json.dumps({"step": 1}) + "\n", encoding="utf-8"
        )
    sanity = _make_sanity_step({"eliza": 0.5, "openclaw": 0.5, "hermes": 0.5})
    result = gate._step_trajectory_normalization(
        benchmark_id="bfcl",
        sanity_step=sanity,
        strict=True,
    )
    assert result.passed is True
    for agent in ("eliza", "openclaw", "hermes"):
        assert result.details["agents"][agent]["entry_count"] == 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def test_cli_exits_one_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_credential_env(monkeypatch)
    rc = gate.cli(["--skip-install-check", "--benchmark", "no_such_bench"])
    assert rc == 1


def test_cli_exits_one_when_cerebras_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test")
    monkeypatch.setattr(
        gate,
        "_cerebras_chat",
        lambda **k: (500, None, '{"error":"upstream"}'),
    )
    # Ensure we don't run real subprocesses if the gate gets past cerebras.
    monkeypatch.setattr(
        gate,
        "_orchestrator_run",
        lambda **k: (1, "", "should not run"),
    )
    monkeypatch.setattr(gate, "_benchmark_registered", lambda b: True)
    rc = gate.cli(["--skip-install-check", "--benchmark", "bfcl"])
    assert rc == 1


def test_resolve_benchmark_falls_back_to_bfcl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gate, "_benchmark_registered", lambda b: b == "bfcl")
    assert gate._resolve_benchmark("hermes_tblite") == "bfcl"
    assert gate._resolve_benchmark("bfcl") == "bfcl"
    # unknown non-default keeps the id (so the failure surfaces with full output)
    assert gate._resolve_benchmark("no_such_bench") == "no_such_bench"


def test_sanity_max_tasks_clamped_to_harness_smoke_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The hermes env harnesses reject any max_tasks other than 1, so the
    gate's default sanity size (2) must clamp to 1 for them — otherwise the
    default invocation can never pass on its own default benchmark."""
    monkeypatch.setenv("CEREBRAS_API_KEY", "csk-test")
    monkeypatch.setenv("CEREBRAS_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setattr(gate, "_benchmark_registered", lambda b: True)
    monkeypatch.setattr(
        gate,
        "_cerebras_chat",
        lambda **k: (200, {"choices": [{"message": {"content": "PONG"}}]}, ""),
    )

    class _FakeClient:
        def reset(self, **kwargs: object) -> dict[str, object]:
            return {"status": "ready"}

        def send_message(self, text: str) -> Any:
            class _Response:
                text = "PONG"
                params: dict[str, object] = {}

            return _Response()

    monkeypatch.setattr(gate, "_make_adapter_client", lambda agent: _FakeClient())
    calls: list[dict[str, Any]] = []

    def _fake_orchestrator_run(**kwargs: Any) -> tuple[int, str, str]:
        calls.append(kwargs)
        return 0, "", ""

    monkeypatch.setattr(gate, "_orchestrator_run", _fake_orchestrator_run)
    monkeypatch.setattr(
        gate,
        "_latest_run_for",
        lambda **k: {
            "run_id": f"rid_{k['agent']}",
            "status": "succeeded",
            "score": 1.0,
        },
    )
    report = gate.run_acceptance_gate(
        benchmark_id="hermes_tblite",
        skip_install_check=True,
        skip_random=True,
    )
    assert report.config["max_tasks_requested"] == 2
    assert report.config["max_tasks"] == 1
    assert calls, "sanity benchmark step never dispatched"
    assert all(c["extra"] == {"max_tasks": 1} for c in calls)


def test_random_baseline_accepts_designed_incompatible_outcome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """random_v1 reports status="incompatible" (score None, rc 0) for
    benchmarks whose chance behavior is uninterpretable (freeform strategy,
    e.g. hermes_tblite). That designed outcome passes the step; the absolute
    score floor in LIFT_OVER_RANDOM is the compensating check."""
    monkeypatch.setattr(gate, "_orchestrator_run", lambda **k: (0, "", ""))
    monkeypatch.setattr(
        gate,
        "_latest_run_for",
        lambda **k: {
            "run_id": "rid_random",
            "status": "incompatible",
            "score": None,
            "error": "random baseline uninterpretable for this benchmark",
        },
    )
    step = gate._step_random_baseline(
        benchmark_id="hermes_tblite", max_tasks=1, verbose=False
    )
    assert step.passed
    assert step.details["incompatible"] is True
    assert step.details["score"] is None
    # A genuinely scoreless (non-incompatible) run still fails the step.
    monkeypatch.setattr(
        gate,
        "_latest_run_for",
        lambda **k: {"run_id": "rid_random", "status": "succeeded", "score": None},
    )
    step = gate._step_random_baseline(
        benchmark_id="hermes_tblite", max_tasks=1, verbose=False
    )
    assert not step.passed
    assert step.error == "random_v1 produced no score"


def test_extract_cerebras_text_handles_malformed_payloads() -> None:
    assert gate._extract_cerebras_text({}) == ""
    assert gate._extract_cerebras_text({"choices": []}) == ""
    assert gate._extract_cerebras_text({"choices": [{"message": {}}]}) == ""
    assert (
        gate._extract_cerebras_text({"choices": [{"message": {"content": "hi"}}]})
        == "hi"
    )


# ---------------------------------------------------------------------------
# Step 1.5: PROVIDER_FORWARDER (remote-proxy campaign topology)
# ---------------------------------------------------------------------------


REAL_UPSTREAM_KEY = "csk-real-upstream-key"


class _UpstreamStub:
    """Local OpenAI-compatible upstream standing in for the remote cloud proxy.

    Advertised as ``http://0.0.0.0:<port>/v1``: syntactically NON-loopback for
    every loopback predicate in play (``ipaddress.ip_address("0.0.0.0")`` is
    not loopback), yet routable to this local socket on Linux -- so the gate's
    real forwarder decision, relay, and credential swap run over genuine
    sockets without any network egress.
    """

    def __init__(self) -> None:
        self.requests: list[dict[str, str]] = []
        stub = self

        class _Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                stub.requests.append(
                    {
                        "path": self.path,
                        "authorization": self.headers.get("Authorization", ""),
                    }
                )
                body = json.dumps(
                    {"choices": [{"message": {"content": "PONG"}}]}
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.port = int(self._server.server_address[1])
        self.remote_base_url = f"http://0.0.0.0:{self.port}/v1"
        self.loopback_base_url = f"http://127.0.0.1:{self.port}/v1"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=10)


@pytest.fixture()
def upstream_stub() -> Any:
    stub = _UpstreamStub()
    yield stub
    stub.close()


@pytest.fixture(autouse=True)
def _reset_gate_state() -> Any:
    yield
    gate._teardown()
    gate._TEARDOWN_ERRORS.clear()


def _post_chat(base_url: str, token: str) -> tuple[int, dict[str, Any] | None]:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps({"model": "m", "messages": []}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def _remote_campaign_env(
    monkeypatch: pytest.MonkeyPatch, upstream_stub: _UpstreamStub
) -> None:
    _clear_credential_env(monkeypatch)
    monkeypatch.setenv("CEREBRAS_API_KEY", REAL_UPSTREAM_KEY)
    monkeypatch.setenv("CEREBRAS_BASE_URL", upstream_stub.remote_base_url)


class _EnvDrivenFakeClient:
    """Adapter stand-in that resolves env exactly like the real harnesses.

    Reads ``CEREBRAS_BASE_URL`` / ``CEREBRAS_API_KEY`` from ``os.environ`` at
    send time and performs a REAL HTTP completion against them, so the smoke
    traffic genuinely traverses whatever route the gate injected.
    """

    def __init__(self, seen: list[dict[str, str]]) -> None:
        self._seen = seen

    def reset(self, **kwargs: object) -> dict[str, object]:
        return {"status": "ready"}

    def send_message(self, text: str) -> Any:
        import os

        base_url = os.environ.get("CEREBRAS_BASE_URL", "")
        token = os.environ.get("CEREBRAS_API_KEY", "")
        self._seen.append({"base_url": base_url, "token": token})
        status, payload = _post_chat(base_url, token)
        assert status == 200, f"smoke completion failed with {status}: {payload}"
        content = payload["choices"][0]["message"]["content"]

        class _Response:
            pass

        response = _Response()
        response.text = content
        response.params = {}
        return response


def test_forwarder_started_for_remote_env_and_closed_on_teardown(
    monkeypatch: pytest.MonkeyPatch, upstream_stub: _UpstreamStub
) -> None:
    _remote_campaign_env(monkeypatch, upstream_stub)
    step = gate._step_provider_forwarder()
    assert step.passed is True
    assert step.details["mode"] == "forwarder"
    assert step.details["upstream_host"] == "0.0.0.0"
    assert gate._PROVIDER_FORWARDER is not None
    listen_base_url = step.details["listen_base_url"]
    assert listen_base_url.startswith("http://127.0.0.1:")

    # Every harness gets its own lane: loopback base URLs on all env names the
    # adapters resolve, and distinct worthless tokens instead of the real key.
    lanes = {agent: gate._agent_env_overrides(agent) for agent in gate.AGENTS}
    tokens = {lane["CEREBRAS_API_KEY"] for lane in lanes.values()}
    assert len(tokens) == len(gate.AGENTS)
    for lane in lanes.values():
        for env_name in ("CEREBRAS_BASE_URL", "OPENAI_BASE_URL", "BENCHMARK_BASE_URL"):
            assert lane[env_name] == listen_base_url
        assert lane["CEREBRAS_API_KEY"] == lane["OPENAI_API_KEY"]
        assert lane["CEREBRAS_API_KEY"] != REAL_UPSTREAM_KEY

    # A real request with a lane token relays through to the upstream stub,
    # which must see ONLY the real upstream key.
    status, payload = _post_chat(listen_base_url, lanes["openclaw"]["CEREBRAS_API_KEY"])
    assert status == 200
    assert payload["choices"][0]["message"]["content"] == "PONG"
    assert upstream_stub.requests[-1]["path"] == "/v1/chat/completions"
    assert upstream_stub.requests[-1]["authorization"] == f"Bearer {REAL_UPSTREAM_KEY}"

    # An unknown bearer is rejected at the forwarder, never reaching upstream.
    upstream_before = len(upstream_stub.requests)
    status, payload = _post_chat(listen_base_url, "not-a-lane-token")
    assert status == 401
    assert len(upstream_stub.requests) == upstream_before

    gate._teardown()
    assert gate._PROVIDER_FORWARDER is None
    assert gate._TEARDOWN_ERRORS == []
    with pytest.raises(urllib.error.URLError):
        _post_chat(listen_base_url, "any")


def test_forwarder_not_started_for_loopback_env(
    monkeypatch: pytest.MonkeyPatch, upstream_stub: _UpstreamStub
) -> None:
    _clear_credential_env(monkeypatch)
    monkeypatch.setenv("CEREBRAS_API_KEY", REAL_UPSTREAM_KEY)
    monkeypatch.setenv("CEREBRAS_BASE_URL", upstream_stub.loopback_base_url)
    step = gate._step_provider_forwarder()
    assert step.passed is True
    assert step.details["mode"] == "direct"
    assert gate._PROVIDER_FORWARDER is None
    for agent in gate.AGENTS:
        assert gate._agent_env_overrides(agent) == {}


def test_forwarder_step_fails_without_upstream_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_credential_env(monkeypatch)
    monkeypatch.setenv("CEREBRAS_BASE_URL", "http://0.0.0.0:9/v1")
    # Pin ambient resolution to the process env so a developer machine's
    # dotenv files cannot smuggle a key into this negative case.
    import benchmarks.orchestrator.runner as runner_module
    import os

    monkeypatch.setattr(runner_module, "_ambient_env", lambda root: dict(os.environ))
    step = gate._step_provider_forwarder()
    assert step.passed is False
    assert gate._PROVIDER_FORWARDER is None
    assert "CEREBRAS_API_KEY" in (step.error or "")


def test_agent_smoke_routes_every_harness_through_forwarder(
    monkeypatch: pytest.MonkeyPatch, upstream_stub: _UpstreamStub
) -> None:
    _remote_campaign_env(monkeypatch, upstream_stub)
    step = gate._step_provider_forwarder()
    assert step.passed is True
    listen_base_url = step.details["listen_base_url"]

    seen: list[dict[str, str]] = []
    monkeypatch.setattr(
        gate, "_make_adapter_client", lambda agent: _EnvDrivenFakeClient(seen)
    )
    result = gate._step_agent_smoke()
    assert result.passed is True, result.error
    for agent in gate.AGENTS:
        assert result.details["agents"][agent]["provider_route"] == "forwarder"

    # Each harness resolved the forwarder's loopback URL and its own token.
    assert [entry["base_url"] for entry in seen] == [listen_base_url] * 3
    assert len({entry["token"] for entry in seen}) == 3
    assert all(entry["token"] != REAL_UPSTREAM_KEY for entry in seen)
    # All three completions really traversed the relay into the upstream stub,
    # which only ever saw the real credential.
    chat_hits = [
        r for r in upstream_stub.requests if r["path"] == "/v1/chat/completions"
    ]
    assert len(chat_hits) == 3
    assert all(r["authorization"] == f"Bearer {REAL_UPSTREAM_KEY}" for r in chat_hits)
    # The gate's own env is restored after each lane -- no leakage.
    import os

    assert os.environ["CEREBRAS_BASE_URL"] == upstream_stub.remote_base_url
    assert os.environ["CEREBRAS_API_KEY"] == REAL_UPSTREAM_KEY


def test_agent_smoke_keeps_direct_path_for_loopback_env(
    monkeypatch: pytest.MonkeyPatch, upstream_stub: _UpstreamStub
) -> None:
    _clear_credential_env(monkeypatch)
    monkeypatch.setenv("CEREBRAS_API_KEY", REAL_UPSTREAM_KEY)
    monkeypatch.setenv("CEREBRAS_BASE_URL", upstream_stub.loopback_base_url)
    step = gate._step_provider_forwarder()
    assert step.passed is True and gate._PROVIDER_FORWARDER is None

    seen: list[dict[str, str]] = []
    monkeypatch.setattr(
        gate, "_make_adapter_client", lambda agent: _EnvDrivenFakeClient(seen)
    )
    result = gate._step_agent_smoke()
    assert result.passed is True, result.error
    for agent in gate.AGENTS:
        assert result.details["agents"][agent]["provider_route"] == "direct"
    # Direct path: operator env untouched, harnesses hit the endpoint as-is.
    assert [entry["base_url"] for entry in seen] == [
        upstream_stub.loopback_base_url
    ] * 3
    assert [entry["token"] for entry in seen] == [REAL_UPSTREAM_KEY] * 3


def test_sanity_benchmark_injects_lane_env_into_orchestrator_runs(
    monkeypatch: pytest.MonkeyPatch, upstream_stub: _UpstreamStub
) -> None:
    _remote_campaign_env(monkeypatch, upstream_stub)
    step = gate._step_provider_forwarder()
    assert step.passed is True
    listen_base_url = step.details["listen_base_url"]
    lanes = {agent: gate._agent_env_overrides(agent) for agent in gate.AGENTS}

    dispatched: list[dict[str, Any]] = []

    def _fake_orchestrator_run(**kwargs: Any) -> tuple[int, str, str]:
        dispatched.append(kwargs)
        return 0, "", ""

    monkeypatch.setattr(gate, "_orchestrator_run", _fake_orchestrator_run)
    monkeypatch.setattr(
        gate,
        "_latest_run_for",
        lambda **k: {
            "run_id": f"rid_{k['agent']}",
            "status": "succeeded",
            "score": 1.0,
        },
    )
    result = gate._step_sanity_benchmark(
        benchmark_id="bfcl", max_tasks=1, verbose=False
    )
    assert result.passed is True, result.error
    assert [d["agent"] for d in dispatched] == list(gate.AGENTS)
    for call in dispatched:
        overrides = call["env_overrides"]
        assert overrides == lanes[call["agent"]]
        assert overrides["OPENAI_BASE_URL"] == listen_base_url

    # random_v1 is synthetic (no model traffic): no lane, untouched parent env.
    dispatched.clear()
    random_result = gate._step_random_baseline(
        benchmark_id="bfcl", max_tasks=1, verbose=False
    )
    assert random_result.passed is True, random_result.error
    assert dispatched[0]["agent"] == "random_v1"
    assert "env_overrides" not in dispatched[0]


def test_full_gate_passes_through_forwarder_and_closes_it(
    monkeypatch: pytest.MonkeyPatch, upstream_stub: _UpstreamStub
) -> None:
    """End-to-end CLI run against the remote-looking stub: the provider smoke
    hits the proxy directly with the real key, every agent smoke rides the
    forwarder with a lane token, and the forwarder is closed by the gate's
    own teardown before the CLI returns."""

    _remote_campaign_env(monkeypatch, upstream_stub)
    seen: list[dict[str, str]] = []
    monkeypatch.setattr(
        gate, "_make_adapter_client", lambda agent: _EnvDrivenFakeClient(seen)
    )
    monkeypatch.setattr(gate, "_benchmark_registered", lambda b: True)
    monkeypatch.setattr(gate, "_orchestrator_run", lambda **k: (0, "", ""))
    monkeypatch.setattr(
        gate,
        "_latest_run_for",
        lambda **k: {
            "run_id": f"rid_{k['agent']}",
            "status": "succeeded",
            "score": 1.0,
        },
    )
    rc = gate.cli(["--skip-install-check", "--skip-random", "--benchmark", "bfcl"])
    assert rc == 0

    # The gate closed its forwarder; its port no longer accepts connections.
    assert gate._PROVIDER_FORWARDER is None
    assert len(seen) == 3
    forwarder_base_url = seen[0]["base_url"]
    assert forwarder_base_url.startswith("http://127.0.0.1:")
    assert forwarder_base_url != upstream_stub.loopback_base_url
    with pytest.raises(urllib.error.URLError):
        _post_chat(forwarder_base_url, "any")
    # Upstream only ever saw the real key: the direct provider smoke plus
    # three relayed harness smokes.
    assert all(
        r["authorization"] == f"Bearer {REAL_UPSTREAM_KEY}"
        for r in upstream_stub.requests
    )
    assert len(upstream_stub.requests) == 4
