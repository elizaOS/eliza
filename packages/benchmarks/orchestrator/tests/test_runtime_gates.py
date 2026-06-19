from __future__ import annotations

import json
from pathlib import Path

from benchmarks.orchestrator import adapters
from benchmarks.orchestrator.runtime_gates import build_runtime_gate_report


def test_runtime_gate_report_passes_when_all_runtime_probes_pass(monkeypatch) -> None:
    monkeypatch.setattr(adapters, "_has_hyperliquid_live_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_terminal_bench_docker_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_swe_bench_docker_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_osworld_docker_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_hermes_sandbox_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_vision_language_real_inputs", lambda: True)
    monkeypatch.setattr(adapters, "_has_vision_language_harness_runtime", lambda: True)

    report = build_runtime_gate_report(Path.cwd())

    assert report.ok
    assert len(report.gates) == 7


def test_runtime_gate_report_explains_failed_runtime_probes(monkeypatch) -> None:
    monkeypatch.setattr(adapters, "_has_hyperliquid_live_backend", lambda: False)
    monkeypatch.setattr(adapters, "_has_terminal_bench_docker_backend", lambda: False)
    monkeypatch.setattr(adapters, "_has_swe_bench_docker_backend", lambda: False)
    monkeypatch.setattr(adapters, "_has_osworld_docker_backend", lambda: False)
    monkeypatch.setattr(adapters, "_has_hermes_sandbox_backend", lambda: False)
    monkeypatch.setattr(adapters, "_has_vision_language_real_inputs", lambda: True)
    monkeypatch.setattr(adapters, "_has_vision_language_harness_runtime", lambda: False)

    report = build_runtime_gate_report(Path.cwd())

    assert not report.ok
    failed = {gate.id: gate for gate in report.gates if not gate.ok}
    assert set(failed) == {
        "hyperliquid_live",
        "terminal_bench_docker",
        "swe_bench_docker",
        "osworld_docker",
        "hermes_sandbox",
        "vision_language_harness_runtime",
    }
    assert failed["terminal_bench_docker"].benchmarks == ("terminal_bench",)
    assert failed["swe_bench_docker"].benchmarks == (
        "swe_bench",
        "swe_bench_orchestrated",
    )
    assert failed["hyperliquid_live"].metadata == {
        "required_env": ["HL_PRIVATE_KEY"]
    }
    payload = json.loads(report.to_json())
    hyperliquid_gate = next(
        gate for gate in payload["gates"] if gate["id"] == "hyperliquid_live"
    )
    assert hyperliquid_gate["metadata"] == {"required_env": ["HL_PRIVATE_KEY"]}


def test_hyperliquid_live_probe_tracks_current_environment(monkeypatch) -> None:
    monkeypatch.delenv("HL_PRIVATE_KEY", raising=False)
    assert adapters._has_hyperliquid_live_backend() is False

    monkeypatch.setenv("HL_PRIVATE_KEY", "0xabc")
    assert adapters._has_hyperliquid_live_backend() is True

    monkeypatch.delenv("HL_PRIVATE_KEY", raising=False)
    assert adapters._has_hyperliquid_live_backend() is False
