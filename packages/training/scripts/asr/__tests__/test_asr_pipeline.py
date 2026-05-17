"""Tests for the Qwen3-ASR fine-tune scaffold.

Three suites:
1. Synthetic-smoke pipeline shape (no torch, no GPU).
2. Config loading + gate logic.
3. CLI surface.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Add the asr scripts dir to sys.path so we can import the modules directly.
ASR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ASR_DIR))

import finetune_asr  # noqa: E402
import eval_asr  # noqa: E402


# ---------------------------------------------------------------------------
# 1. Synthetic-smoke pipeline shape.
# ---------------------------------------------------------------------------


def test_finetune_synthetic_smoke_writes_manifest(tmp_path: Path) -> None:
    """Smoke: finetune_asr.py --synthetic-smoke emits train_manifest.json."""
    run_dir = tmp_path / "run"
    rc = finetune_asr.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            str(ASR_DIR / "configs" / "asr_same.yaml"),
            "--synthetic-smoke",
        ]
    )
    assert rc == 0, f"finetune_asr exit code {rc}"

    manifest_path = run_dir / "checkpoints" / "train_manifest.json"
    assert manifest_path.exists(), "train_manifest.json not written"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["kind"] == "asr-finetune-manifest"
    assert manifest["synthetic"] is True
    assert "hyperparameters" in manifest
    assert "dataset" in manifest


def test_finetune_synthetic_smoke_writes_eval(tmp_path: Path) -> None:
    """Smoke: finetune_asr.py --synthetic-smoke emits eval.json."""
    run_dir = tmp_path / "run"
    rc = finetune_asr.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            str(ASR_DIR / "configs" / "asr_same.yaml"),
            "--synthetic-smoke",
        ]
    )
    assert rc == 0

    eval_path = run_dir / "eval.json"
    assert eval_path.exists(), "eval.json not written"
    ev = json.loads(eval_path.read_text())
    assert ev["kind"] == "asr-eval-report"
    assert "metrics" in ev
    assert "gateResult" in ev
    assert "wer" in ev["metrics"]
    assert "rtf" in ev["metrics"]


def test_finetune_synthetic_smoke_writes_artifact_receipt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Smoke: artifact receipt lands under artifacts/voice-fine-tune/<id>/."""
    # Redirect REPO_ROOT so artifacts don't go into the real repo.
    fake_root = tmp_path / "repo"
    fake_root.mkdir()
    monkeypatch.setattr(finetune_asr, "REPO_ROOT", fake_root)

    run_dir = tmp_path / "run"
    rc = finetune_asr.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            str(ASR_DIR / "configs" / "asr_same.yaml"),
            "--synthetic-smoke",
        ]
    )
    assert rc == 0

    artifact_base = fake_root / "artifacts" / "voice-fine-tune"
    receipts = list(artifact_base.rglob("receipt.json"))
    assert receipts, "no artifact receipt.json written"
    receipt = json.loads(receipts[0].read_text())
    assert receipt["kind"] == "asr-finetune-receipt"
    assert receipt["synthetic"] is True


def test_eval_synthetic_smoke_writes_eval_json(tmp_path: Path) -> None:
    """Smoke: eval_asr.py --synthetic-smoke emits eval.json."""
    run_dir = tmp_path / "eval_run"
    rc = eval_asr.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            str(ASR_DIR / "configs" / "asr_same.yaml"),
            "--synthetic-smoke",
        ]
    )
    assert rc == 0
    eval_path = run_dir / "eval.json"
    assert eval_path.exists()
    ev = json.loads(eval_path.read_text())
    assert ev["synthetic"] is True
    assert ev["gateResult"]["passed"] is True  # smoke metrics pass gates


# ---------------------------------------------------------------------------
# 2. Config loading + gate logic.
# ---------------------------------------------------------------------------


def test_config_defaults() -> None:
    """Load config with no file — should return default dict."""
    cfg = finetune_asr._load_config("")
    assert cfg["optimizer"] == "apollo_mini"
    assert cfg["sample_rate"] == 16000
    assert cfg["mel_bins"] == 80


def test_config_sam_yaml() -> None:
    """Load asr_same.yaml — overrides should be applied."""
    cfg = finetune_asr._load_config(str(ASR_DIR / "configs" / "asr_same.yaml"))
    assert cfg["voice_name"] == "same"
    assert cfg["learning_rate"] < 2e-5, "same config should lower LR vs base"


def test_gate_pass() -> None:
    """Gates pass when WER ≤ wer_max and RTF ≥ rtf_min."""
    cfg = {"gates": {"wer_max": 0.15, "rtf_min": 2.0}}
    result = eval_asr._apply_gates({"wer": 0.08, "rtf": 3.0}, cfg["gates"])
    assert result["passed"] is True
    assert result["perMetric"]["wer"] is True
    assert result["perMetric"]["rtf"] is True


def test_gate_fail_wer() -> None:
    """Gates fail when WER exceeds wer_max."""
    cfg = {"gates": {"wer_max": 0.15, "rtf_min": 2.0}}
    result = eval_asr._apply_gates({"wer": 0.30, "rtf": 3.0}, cfg["gates"])
    assert result["passed"] is False
    assert result["perMetric"]["wer"] is False


def test_gate_fail_rtf() -> None:
    """Gates fail when RTF is below rtf_min."""
    cfg = {"gates": {"wer_max": 0.15, "rtf_min": 2.0}}
    result = eval_asr._apply_gates({"wer": 0.08, "rtf": 1.0}, cfg["gates"])
    assert result["passed"] is False
    assert result["perMetric"]["rtf"] is False


def test_baseline_comparison_beats(tmp_path: Path) -> None:
    """Comparison: beatsBaseline=True when WER delta ≤ 0."""
    baseline_eval = tmp_path / "baseline_eval.json"
    baseline_eval.write_text(json.dumps({
        "metrics": {"wer": 0.25, "rtf": 2.5},
    }))
    comparison = eval_asr._build_comparison({"wer": 0.10, "rtf": 3.0}, baseline_eval)
    assert comparison["beatsBaseline"] is True
    assert comparison["werDelta"] < 0.0


def test_baseline_comparison_loses(tmp_path: Path) -> None:
    """Comparison: beatsBaseline=False when WER gets worse."""
    baseline_eval = tmp_path / "baseline_eval.json"
    baseline_eval.write_text(json.dumps({
        "metrics": {"wer": 0.10, "rtf": 3.0},
    }))
    comparison = eval_asr._build_comparison({"wer": 0.20, "rtf": 3.0}, baseline_eval)
    assert comparison["beatsBaseline"] is False
    assert comparison["werDelta"] > 0.0


def test_early_stopping_no_improvement() -> None:
    """Early stopping triggers when WER stalls/worsens for patience evals.

    patience=2: look at the last patience+1=3 entries; if all of the last
    `patience` entries have WER >= baseline (the entry just before the window),
    stop. Here: baseline=0.30, recent=[0.30, 0.30] — all >= baseline → stop.
    """
    history = [
        {"step": 100, "wer": 0.3},
        {"step": 200, "wer": 0.30},
        {"step": 300, "wer": 0.30},
    ]
    assert finetune_asr._should_early_stop(history, patience=2) is True


def test_early_stopping_still_improving() -> None:
    """Early stopping does not trigger when WER is still improving."""
    history = [
        {"step": 100, "wer": 0.3},
        {"step": 200, "wer": 0.25},
        {"step": 300, "wer": 0.20},
    ]
    assert finetune_asr._should_early_stop(history, patience=2) is False


# ---------------------------------------------------------------------------
# 3. CLI surface.
# ---------------------------------------------------------------------------


def test_cli_requires_run_dir(capsys: pytest.CaptureFixture) -> None:
    """CLI exits non-zero when --run-dir is missing."""
    with pytest.raises(SystemExit) as exc_info:
        finetune_asr.main([])
    assert exc_info.value.code != 0


def test_cli_smoke_default_no_real_train(tmp_path: Path) -> None:
    """CLI defaults to synthetic-smoke when --real-train not passed."""
    run_dir = tmp_path / "run"
    rc = finetune_asr.main(["--run-dir", str(run_dir)])
    assert rc == 0
    assert (run_dir / "checkpoints" / "train_manifest.json").exists()
