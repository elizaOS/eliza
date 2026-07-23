"""Tests for ``scripts/acceptance_gate.py``.

The acceptance gate spawns the orchestrator and calls Cerebras over
HTTP. These tests mock both so we never make a real network call or
launch a real benchmark process. The module is loaded by path so the
tests don't depend on ``scripts/`` being a package.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest


_MODULE_PATH = (
    Path(__file__).resolve().parent.parent / "scripts" / "acceptance_gate.py"
)


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


def test_precheck_passes_with_key_and_install_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
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


def test_cerebras_smoke_routes_through_operator_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
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


def test_trajectory_normalization_warns_when_missing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
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


def test_trajectory_normalization_fails_strict(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(gate, "PACKAGE_ROOT", tmp_path)
    (tmp_path / "benchmark_results").mkdir(parents=True)
    sanity = _make_sanity_step({"eliza": 0.5, "openclaw": 0.5, "hermes": 0.5})
    result = gate._step_trajectory_normalization(
        benchmark_id="bfcl",
        sanity_step=sanity,
        strict=True,
    )
    assert result.passed is False
    assert (result.error or "").startswith("eliza:") or "missing" in (result.error or "")


def test_trajectory_normalization_succeeds_when_files_present(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(gate, "PACKAGE_ROOT", tmp_path)
    bench_root = tmp_path / "benchmark_results"
    for agent in ("eliza", "openclaw", "hermes"):
        run_dir = bench_root / "rg_test" / f"x__y" / f"rid_{agent}"
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


def test_extract_cerebras_text_handles_malformed_payloads() -> None:
    assert gate._extract_cerebras_text({}) == ""
    assert gate._extract_cerebras_text({"choices": []}) == ""
    assert gate._extract_cerebras_text({"choices": [{"message": {}}]}) == ""
    assert gate._extract_cerebras_text({"choices": [{"message": {"content": "hi"}}]}) == "hi"
