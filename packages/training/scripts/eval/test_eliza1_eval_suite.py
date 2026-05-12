"""Tests for the Eliza-1 bundle eval suite.

These tests build a tiny synthetic bundle (stand-in artifacts, no real
weights) and confirm the suite:

* writes all per-eval JSON blobs + ``aggregate.json`` into ``<bundle>/evals/``,
* records stand-in / engine-missing gates as ``not-run`` with a ``null``
  metric (so the publish orchestrator's gate engine treats them as a fail —
  publish-blocking), never a fabricated pass,
* produces an ``aggregate.json`` shaped for the publish orchestrator
  (``tier`` / ``mode`` / ``results``) and runs the gate engine on it,
* uses a real text GGUF override when given (the only gate measurable without
  a real bundle on a CPU host).

The dispatch eval (``make -C packages/inference/verify ...``) is skipped here
to keep the test fast — it is covered by ``make kernel-contract reference-test``
in CI and by the live run recorded in ``packages/inference/reports/``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.eval import eliza1_eval_suite as suite


def _make_standin_bundle(root: Path) -> Path:
    bundle = root / "eliza-1-0_8b.bundle"
    for sub in ("text", "tts", "asr", "vad", "dflash", "cache", "evals"):
        (bundle / sub).mkdir(parents=True, exist_ok=True)
    # Tiny stand-in artifacts (NOT real GGUFs).
    (bundle / "text" / "eliza-1-0_8b-32k.gguf").write_text("standin")
    (bundle / "tts" / "omnivoice-base.gguf").write_text("standin")
    (bundle / "tts" / "omnivoice-tokenizer.gguf").write_text("standin")
    (bundle / "asr" / "asr.gguf").write_text("standin")
    (bundle / "vad" / "silero-vad.onnx").write_text("standin")
    (bundle / "dflash" / "drafter-0_8b.gguf").write_text("standin")
    (bundle / "cache" / "voice-preset-default.bin").write_text("standin")
    return bundle


def _run(bundle: Path, monkeypatch, *, text_eval_model: Path | None = None):
    # Skip the make-based dispatch eval (slow) and any engine discovery.
    monkeypatch.setattr(suite, "discover_engine", lambda *a, **k: None)
    monkeypatch.setattr(
        suite,
        "eval_dispatch",
        lambda ctx: {
            "schemaVersion": suite.SCHEMA_VERSION,
            "backend": "cpu",
            "status": "not-run",
            "runtimeReady": False,
            "passed": None,
            "reason": "dispatch eval skipped in unit test",
        },
    )
    args = suite.argparse.Namespace(
        bundle_dir=bundle,
        tier="0_8b",
        backend=None,
        text_eval_model=text_eval_model,
        text_corpus=None,
        threads=2,
        timeout=30,
    )
    ctx = suite.build_context(args)
    return suite.run_suite(ctx)


def test_writes_all_eval_blobs(tmp_path: Path, monkeypatch) -> None:
    bundle = _make_standin_bundle(tmp_path)
    agg = _run(bundle, monkeypatch)
    evals = bundle / "evals"
    for name in (
        "text-eval.json",
        "voice-rtf.json",
        "asr-wer.json",
        "vad.json",
        "e2e-loop.json",
        "endurance.json",
        "dflash-accept.json",
        "dispatch.json",
        "aggregate.json",
    ):
        assert (evals / name).is_file(), f"missing {name}"
    assert agg["tier"] == "0_8b"
    assert agg["mode"] == "full"
    assert "results" in agg
    assert agg["bundleIsLocalStandin"] is True


def test_standin_bundle_records_not_run_not_fake_pass(tmp_path: Path, monkeypatch) -> None:
    bundle = _make_standin_bundle(tmp_path)
    agg = _run(bundle, monkeypatch)
    # Voice / ASR / VAD / e2e / endurance / dflash have stand-in artifacts → not-run.
    for name in (
        "voice-rtf.json",
        "asr-wer.json",
        "vad.json",
        "e2e-loop.json",
        "endurance.json",
        "dflash-accept.json",
    ):
        blob = json.loads((bundle / "evals" / name).read_text())
        assert blob["status"] in ("not-run", "needs-hardware"), name
        # passed must never be a fabricated True for a not-run gate.
        assert blob.get("passed") is not True, name
    # The aggregate's results carry None for the unmeasured metrics.
    res = agg["results"]
    assert res["voice_rtf"] is None
    assert res["asr_wer"] is None
    assert res["e2e_loop_ok"] is None
    assert res["thirty_turn_ok"] is None
    # peak_rss / thermal are device-bound → recorded as None (needs-hardware).
    assert res["peak_rss_mb"] is None
    assert res["thermal_throttle_pct"] is None


def test_gate_verdict_is_publish_blocking_for_standin(tmp_path: Path, monkeypatch) -> None:
    bundle = _make_standin_bundle(tmp_path)
    agg = _run(bundle, monkeypatch)
    assert agg["passed"] is False
    rep = agg["gateReport"]
    failed = {f.split(":")[0] for f in rep["failures"]}
    # The required gates with no measurement must be failing.
    assert "voice_rtf" in failed
    assert "asr_wer" in failed
    assert "e2e_loop_ok" in failed
    assert "thirty_turn_ok" in failed


def test_aggregate_is_consumable_by_gate_engine(tmp_path: Path, monkeypatch) -> None:
    bundle = _make_standin_bundle(tmp_path)
    agg = _run(bundle, monkeypatch)
    from benchmarks.eliza1_gates import apply_gates

    rep = apply_gates(agg, "0_8b", mode="full")
    assert rep.tier == "0_8b"
    assert rep.passed is False  # stand-in bundle never passes


def _make_real_bundle(root: Path) -> Path:
    """A bundle whose artifacts pass ``_is_real_gguf`` (GGUF magic + >min bytes).

    The bytes are not a loadable model — these tests monkeypatch the engine
    discovery + the e2e bench bridge, so no real runtime is invoked. They only
    exercise the not-run-vs-ok branching of the bench-bridge runners.
    """
    bundle = root / "eliza-1-0_8b.bundle"
    for sub in ("text", "tts", "asr", "vad", "dflash", "cache", "evals"):
        (bundle / sub).mkdir(parents=True, exist_ok=True)
    big = b"GGUF" + b"\0" * (2 * 1024 * 1024)
    drafter_big = b"GGUF" + b"\0" * (12 * 1024 * 1024)
    (bundle / "text" / "eliza-1-0_8b-32k.gguf").write_bytes(big)
    (bundle / "tts" / "omnivoice-base-Q4_K_M.gguf").write_bytes(big)
    (bundle / "tts" / "omnivoice-tokenizer-Q4_K_M.gguf").write_bytes(big)
    (bundle / "asr" / "eliza-1-asr.gguf").write_bytes(big)
    (bundle / "vad" / "silero-vad-int8.onnx").write_bytes(b"\0" * (200 * 1024))
    (bundle / "dflash" / "drafter-0_8b.gguf").write_bytes(drafter_big)
    (bundle / "cache" / "voice-preset-default.bin").write_text("standin")
    return bundle


def _fake_engine(bin_dir: Path) -> "suite.Engine":
    bin_dir.mkdir(parents=True, exist_ok=True)
    lib = bin_dir / suite._eliza_lib_name()
    server = bin_dir / "llama-server"
    lib.write_text("x")
    server.write_text("x")
    return suite.Engine(
        backend="cpu",
        bin_dir=bin_dir,
        llama_cli=None,
        speculative=None,
        omnivoice_server=None,
        llama_server=server,
        eliza_lib=lib,
        is_fused=True,
    )


def _run_real(bundle: Path, monkeypatch, *, bench_report: dict | None, bench_report_30: dict | None = None):
    bin_dir = bundle.parent / "bin"
    monkeypatch.setattr(suite, "discover_engine", lambda *a, **k: _fake_engine(bin_dir))
    monkeypatch.setattr(
        suite,
        "eval_dispatch",
        lambda ctx: {"schemaVersion": suite.SCHEMA_VERSION, "backend": "cpu", "status": "not-run", "runtimeReady": False, "passed": None, "reason": "skipped in test"},
    )
    monkeypatch.setattr(suite, "eval_text", lambda ctx: {"schemaVersion": suite.SCHEMA_VERSION, "metric": "text_eval", "op": ">=", "status": "not-run", "score": None, "passed": None, "reason": "skipped in test"})
    monkeypatch.setattr(suite, "eval_dflash_accept", lambda ctx: {"schemaVersion": suite.SCHEMA_VERSION, "metric": "dflash_acceptance", "op": ">=", "status": "not-run", "acceptanceRate": None, "speedup": None, "passed": None, "reason": "skipped in test"})

    def _fake_bench(ctx, turns):
        return (bench_report_30 if (turns >= 8 and bench_report_30 is not None) else bench_report)

    monkeypatch.setattr(suite, "_run_e2e_loop_bench", _fake_bench)
    args = suite.argparse.Namespace(bundle_dir=bundle, tier="0_8b", backend=None, text_eval_model=None, text_corpus=None, threads=2, timeout=30)
    ctx = suite.build_context(args)
    return suite.run_suite(ctx)


_OK_BENCH = {
    "status": "ok",
    "e2eLoopOk": True,
    "thirtyTurnOk": None,
    "summary": {
        "ttsRtfMedian": 6.2, "ttsRtfMean": 6.5,
        "asrWerMean": 1.0, "asrWerByTurn": [1.0], "asrLatencyMsMedian": 4800,
        "firstTokenMsMedian": 300.0, "firstAudioFromMicMsMedian": 19000.0,
        "firstAudioFromTokenMsMedian": 14000.0, "decodeTokPerSecMedian": 12.4,
        "totalTurnMsMedian": 48000.0, "bargeInCancelMs": 5.0, "serverPeakRssMb": 3070,
        "leakSuspected": False, "ramWithinBudget": False, "ramBudgetRecommendedMb": 1800,
    },
}
_OK_BENCH_30 = {
    **{k: v for k, v in _OK_BENCH.items() if k != "thirtyTurnOk"},
    "thirtyTurnOk": False,
}


def test_bench_bridge_runners_record_real_numbers_when_bench_ok(tmp_path: Path, monkeypatch) -> None:
    bundle = _make_real_bundle(tmp_path)
    agg = _run_real(bundle, monkeypatch, bench_report=_OK_BENCH, bench_report_30=_OK_BENCH_30)
    voice = json.loads((bundle / "evals" / "voice-rtf.json").read_text())
    asr = json.loads((bundle / "evals" / "asr-wer.json").read_text())
    e2e = json.loads((bundle / "evals" / "e2e-loop.json").read_text())
    end = json.loads((bundle / "evals" / "endurance.json").read_text())
    assert voice["status"] == "ok" and voice["rtf"] == 6.2
    assert asr["status"] == "ok" and asr["wer"] == 1.0
    assert e2e["status"] == "ok" and e2e["e2eLoopOk"] is True
    assert e2e["firstTokenMsMedian"] == 300.0
    # 30-turn: thirtyTurnOk came back False (RSS over budget) → recorded as such, not a fake pass.
    assert end["status"] == "ok" and end["thirtyTurnOk"] is False
    assert end["turns"] == 30 and end["peakRssMb"] == 3070
    # aggregate results carry the real values.
    assert agg["results"]["voice_rtf"] == 6.2
    assert agg["results"]["asr_wer"] == 1.0
    assert agg["results"]["e2e_loop_ok"] is True
    assert agg["results"]["thirty_turn_ok"] is False


def test_bench_bridge_runners_record_not_run_when_bench_fails(tmp_path: Path, monkeypatch) -> None:
    bundle = _make_real_bundle(tmp_path)
    fail = {"status": "needs-build", "reason": "no fused cuda build"}
    agg = _run_real(bundle, monkeypatch, bench_report=fail)
    for name in ("voice-rtf.json", "asr-wer.json", "e2e-loop.json", "endurance.json"):
        blob = json.loads((bundle / "evals" / name).read_text())
        assert blob["status"] == "not-run", name
        assert blob.get("passed") is not True, name
    assert agg["results"]["voice_rtf"] is None
    assert agg["results"]["e2e_loop_ok"] is None
    assert agg["results"]["thirty_turn_ok"] is None


def test_real_text_model_override_produces_real_score(tmp_path: Path, monkeypatch) -> None:
    """If a real Qwen3 GGUF is on disk, the text eval produces a real 0..1 score."""
    candidates = [
        Path("/tmp/eliza1-eval-models/Qwen3-0.8B-Q8_0.gguf"),
        Path("/tmp/eliza1-eval-models/Qwen3-2B-Q8_0.gguf"),
    ]
    model = next((p for p in candidates if suite._is_real_gguf(p)), None)
    if model is None:
        pytest.skip("no real Qwen3 GGUF on disk; run the suite live to exercise this path")
    try:
        import llama_cpp  # noqa: F401
    except ImportError:
        pytest.skip("llama-cpp-python not installed")
    bundle = _make_standin_bundle(tmp_path)
    agg = _run(bundle, monkeypatch, text_eval_model=model)
    blob = json.loads((bundle / "evals" / "text-eval.json").read_text())
    assert blob["status"] == "ok"
    assert 0.0 <= blob["score"] <= 1.0
    assert blob["perplexity"] > 1.0
    assert blob["modelIsBundleText"] is False
