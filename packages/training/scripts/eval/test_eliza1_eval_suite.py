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
    bundle = root / "eliza-1-0_6b.bundle"
    for sub in ("text", "tts", "asr", "vad", "dflash", "cache", "evals"):
        (bundle / sub).mkdir(parents=True, exist_ok=True)
    # Tiny stand-in artifacts (NOT real GGUFs).
    (bundle / "text" / "eliza-1-0_6b-32k.gguf").write_text("standin")
    (bundle / "tts" / "omnivoice-base.gguf").write_text("standin")
    (bundle / "tts" / "omnivoice-tokenizer.gguf").write_text("standin")
    (bundle / "asr" / "asr.gguf").write_text("standin")
    (bundle / "vad" / "silero-vad.onnx").write_text("standin")
    (bundle / "dflash" / "drafter-0_6b.gguf").write_text("standin")
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
        tier="0_6b",
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
    assert agg["tier"] == "0_6b"
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

    rep = apply_gates(agg, "0_6b", mode="full")
    assert rep.tier == "0_6b"
    assert rep.passed is False  # stand-in bundle never passes


def test_real_text_model_override_produces_real_score(tmp_path: Path, monkeypatch) -> None:
    """If a real Qwen3 GGUF is on disk, the text eval produces a real 0..1 score."""
    candidates = [
        Path("/tmp/eliza1-eval-models/Qwen3-0.6B-Q8_0.gguf"),
        Path("/tmp/eliza1-eval-models/Qwen3-1.7B-Q8_0.gguf"),
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
