"""Tests for the Eliza-1 publish-blocking eval gate engine.

The engine (`eliza1_gates.py`) turns a measured eval blob into a
publish-blocking verdict; the publish orchestrator refuses to upload unless
``GateReport.passed`` is True and ``defaultEligible`` requires every required
gate to pass. These tests pin the v2-schema behaviour the orchestrator relies
on.
"""

from __future__ import annotations

import pytest

from benchmarks.eliza1_gates import (
    GateReport,
    apply_gates,
    load_gates,
    normalize_tier,
)


def _full_results(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "format_ok": 0.92,
        "text_eval": 0.72,
        "voice_rtf": 0.30,
        "asr_wer": 0.05,
        "vad_latency_ms": 12.0,
        "vad_boundary_mae_ms": 20.0,
        "vad_endpoint_p95_ms": 400.0,
        "vad_false_bargein_per_hour": 0.0,
        "first_token_latency_ms": 90.0,
        "first_audio_latency_ms": 180.0,
        "barge_in_cancel_ms": 40.0,
        "thirty_turn_ok": True,
        "e2e_loop_ok": True,
        "dflash_acceptance": 0.70,
        "dflash_speedup": 2.1,
        "expressive_tag_faithfulness": 0.90,
        "expressive_mos": 4.1,
        "expressive_tag_leakage": 0.01,
        # device-bound gates: omitted (no mobile hardware) → needs-hardware.
    }
    base.update(overrides)
    return base


def test_v2_yaml_loads() -> None:
    doc = load_gates()
    assert "gates" in doc and "tiers" in doc
    assert "0_6b" in doc["tiers"] and "1_7b" in doc["tiers"]
    # The v2 gate metadata carries the op vocabulary.
    assert doc["gates"]["text_eval"]["op"] == ">="
    assert doc["gates"]["thirty_turn_ok"]["op"] == "bool"
    assert doc["tiers"]["0_6b"]["text_eval"]["threshold"] == 0.55
    assert doc["tiers"]["1_7b"]["text_eval"]["required"] is True


def test_normalize_tier() -> None:
    assert normalize_tier("0_6b") == "0_6b"
    assert normalize_tier("eliza-1-0_6b") == "0_6b"
    assert normalize_tier("eliza-1-27b-256k") == "27b-256k"
    with pytest.raises(ValueError):
        normalize_tier("not-a-tier")


def test_all_passing_blob_passes_and_skips_hardware_gates() -> None:
    rep: GateReport = apply_gates(
        {"tier": "0_6b", "mode": "full", "results": _full_results()}
    )
    assert rep.passed is True
    assert rep.failures == []
    # peak_rss / thermal are needs_hardware and were not measured → skipped.
    skipped = {g.name for g in rep.gates if g.skipped}
    assert "peak_rss_mb" in skipped
    assert "thermal_throttle_pct" in skipped


def test_missing_required_measurement_is_publish_blocking() -> None:
    results = _full_results()
    results.pop("text_eval")
    rep = apply_gates({"tier": "0_6b", "mode": "full", "results": results})
    assert rep.passed is False
    assert any(g.name == "text_eval" and not g.passed for g in rep.gates)
    assert any("text_eval" in f for f in rep.failures)


def test_none_measurement_counts_as_missing() -> None:
    results = _full_results(voice_rtf=None)
    rep = apply_gates({"tier": "0_6b", "mode": "full", "results": results})
    assert rep.passed is False
    assert any(g.name == "voice_rtf" and not g.passed for g in rep.gates)


def test_failing_numeric_gate_blocks() -> None:
    # 0_6b text_eval threshold is 0.55; 0.40 fails (>=).
    rep = apply_gates({"tier": "0_6b", "mode": "full", "results": _full_results(text_eval=0.40)})
    assert rep.passed is False
    row = next(g for g in rep.gates if g.name == "text_eval")
    assert row.passed is False
    assert row.threshold == pytest.approx(0.55)


def test_voice_rtf_uses_le_comparison() -> None:
    # voice_rtf is "<=": 0.30 passes the 0.5 0_6b threshold, 0.80 fails.
    ok = apply_gates({"tier": "0_6b", "mode": "full", "results": _full_results(voice_rtf=0.30)})
    bad = apply_gates({"tier": "0_6b", "mode": "full", "results": _full_results(voice_rtf=0.80)})
    assert ok.passed is True
    assert bad.passed is False


def test_bool_gate_requires_true() -> None:
    bad = apply_gates({"tier": "0_6b", "mode": "full", "results": _full_results(thirty_turn_ok=False)})
    assert bad.passed is False
    row = next(g for g in bad.gates if g.name == "thirty_turn_ok")
    assert row.passed is False


def test_non_required_gate_failure_does_not_block() -> None:
    # first_token_latency_ms is required:false for 0_6b → failing it must not
    # flip the verdict.
    rep = apply_gates({"tier": "0_6b", "mode": "full", "results": _full_results(first_token_latency_ms=99999.0)})
    assert rep.passed is True
    row = next(g for g in rep.gates if g.name == "first_token_latency_ms")
    assert row.passed is False
    assert row.required is False


def test_bare_results_with_explicit_tier() -> None:
    rep = apply_gates(_full_results(), "eliza-1-0_6b")
    assert rep.passed is True


def test_smoke_mode_runs_only_structural_gates() -> None:
    rep = apply_gates(
        {"tier": "0_6b", "mode": "smoke", "results": {"format_ok": 0.7, "format_ok_base": 0.5}}
    )
    assert rep.mode == "smoke"
    assert rep.passed is True
    names = {g.name for g in rep.gates}
    assert names == {"pipeline_ran", "format_ok_floor", "format_ok_not_regressed"}


def test_report_to_dict_shape() -> None:
    rep = apply_gates({"tier": "0_6b", "mode": "full", "results": _full_results()})
    d = rep.to_dict()
    assert set(d) >= {"tier", "mode", "passed", "gates", "failures"}
    g0 = d["gates"][0]
    assert set(g0) >= {"name", "passed", "skipped", "required", "metric", "op", "threshold", "reason"}


def test_different_tiers_have_different_thresholds() -> None:
    # 1_7b text_eval threshold (0.60) is tighter than 0_6b (0.55); 0.57
    # passes 0_6b but fails 1_7b.
    res = _full_results(text_eval=0.57)
    assert apply_gates({"tier": "0_6b", "mode": "full", "results": res}).passed is True
    assert apply_gates({"tier": "1_7b", "mode": "full", "results": res}).passed is False
