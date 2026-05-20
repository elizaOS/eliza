from __future__ import annotations

from pathlib import Path

from benchmarks.orchestrator import adapters
from benchmarks.orchestrator.runtime_gates import build_runtime_gate_report


def test_runtime_gate_report_passes_when_all_runtime_probes_pass(monkeypatch) -> None:
    monkeypatch.setattr(adapters, "_has_gaia_official_dataset", lambda: True)
    monkeypatch.setattr(adapters, "_has_hyperliquid_live_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_terminal_bench_docker_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_swe_bench_docker_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_hermes_sandbox_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_textvqa_real_inputs", lambda: True)
    monkeypatch.setattr(adapters, "_has_vision_language_harness_runtime", lambda: True)

    report = build_runtime_gate_report(Path.cwd())

    assert report.ok
    assert len(report.gates) == 7


def test_runtime_gate_report_explains_failed_runtime_probes(monkeypatch) -> None:
    monkeypatch.setattr(adapters, "_has_gaia_official_dataset", lambda: False)
    monkeypatch.setattr(adapters, "_has_hyperliquid_live_backend", lambda: False)
    monkeypatch.setattr(adapters, "_has_terminal_bench_docker_backend", lambda: False)
    monkeypatch.setattr(adapters, "_has_swe_bench_docker_backend", lambda: False)
    monkeypatch.setattr(adapters, "_has_hermes_sandbox_backend", lambda: False)
    monkeypatch.setattr(adapters, "_has_textvqa_real_inputs", lambda: True)
    monkeypatch.setattr(adapters, "_has_vision_language_harness_runtime", lambda: False)

    report = build_runtime_gate_report(Path.cwd())

    assert not report.ok
    failed = {gate.id: gate for gate in report.gates if not gate.ok}
    assert set(failed) == {
        "gaia_official_dataset",
        "hyperliquid_live",
        "terminal_bench_docker",
        "swe_bench_docker",
        "hermes_sandbox",
        "vision_language_harness_runtime",
    }
    assert "GAIA" in str(failed["gaia_official_dataset"].reason)
    assert failed["terminal_bench_docker"].benchmarks == ("terminal_bench",)
    assert failed["swe_bench_docker"].benchmarks == (
        "swe_bench",
        "swe_bench_orchestrated",
    )
