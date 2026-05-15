"""Tests for OmniVoice fine-tune pipeline scaffold.

Two suites:
1. Synthetic-smoke pipeline shape (no GPU, no FFI).
2. Config loading + eval gate logic.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

OMNIVOICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OMNIVOICE_DIR))

import finetune_omnivoice  # noqa: E402
import eval_omnivoice  # noqa: E402


# ---------------------------------------------------------------------------
# 1. Synthetic-smoke pipeline shape.
# ---------------------------------------------------------------------------


def test_finetune_synthetic_smoke_writes_manifest(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    rc = finetune_omnivoice.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            str(OMNIVOICE_DIR / "configs" / "omnivoice_samantha.yaml"),
            "--synthetic-smoke",
        ]
    )
    assert rc == 0
    manifest_path = run_dir / "checkpoints" / "train_manifest.json"
    assert manifest_path.exists()
    manifest = json.loads(manifest_path.read_text())
    assert manifest["kind"] == "omnivoice-finetune-manifest"
    assert manifest["synthetic"] is True


def test_finetune_synthetic_smoke_writes_eval(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    rc = finetune_omnivoice.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            str(OMNIVOICE_DIR / "configs" / "omnivoice_samantha.yaml"),
            "--synthetic-smoke",
        ]
    )
    assert rc == 0
    eval_path = run_dir / "eval.json"
    assert eval_path.exists()
    ev = json.loads(eval_path.read_text())
    assert ev["kind"] == "omnivoice-eval-report"
    assert "metrics" in ev
    assert "speaker_similarity" in ev["metrics"]


def test_eval_synthetic_smoke(tmp_path: Path) -> None:
    run_dir = tmp_path / "eval_run"
    rc = eval_omnivoice.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            str(OMNIVOICE_DIR / "configs" / "omnivoice_samantha.yaml"),
            "--synthetic-smoke",
        ]
    )
    assert rc == 0
    ev = json.loads((run_dir / "eval.json").read_text())
    assert ev["synthetic"] is True
    assert ev["gateResult"]["passed"] is True


# ---------------------------------------------------------------------------
# 2. Config loading + gate logic.
# ---------------------------------------------------------------------------


def test_config_defaults() -> None:
    cfg = finetune_omnivoice._load_config("")
    assert cfg["optimizer"] == "apollo_mini"
    assert cfg["sample_rate"] == 24000
    assert cfg["mask_fraction"] == 0.5


def test_config_samantha_yaml() -> None:
    cfg = finetune_omnivoice._load_config(
        str(OMNIVOICE_DIR / "configs" / "omnivoice_samantha.yaml")
    )
    assert cfg["voice_name"] == "samantha"
    assert cfg["max_steps"] == 500


def test_gate_pass() -> None:
    gates = {"wer_max": 0.10, "speaker_similarity_min": 0.55, "rtf_min": 3.0}
    result = eval_omnivoice._apply_gates(
        {"wer": 0.07, "rtf": 4.0, "speaker_similarity": 0.65},
        gates,
    )
    assert result["passed"] is True


def test_gate_fail_speaker_sim() -> None:
    gates = {"wer_max": 0.10, "speaker_similarity_min": 0.55, "rtf_min": 3.0}
    result = eval_omnivoice._apply_gates(
        {"wer": 0.07, "rtf": 4.0, "speaker_similarity": 0.40},
        gates,
    )
    assert result["passed"] is False
    assert result["perMetric"]["speaker_similarity"] is False


def test_gate_fail_wer() -> None:
    gates = {"wer_max": 0.10, "speaker_similarity_min": 0.55, "rtf_min": 3.0}
    result = eval_omnivoice._apply_gates(
        {"wer": 0.25, "rtf": 4.0, "speaker_similarity": 0.65},
        gates,
    )
    assert result["passed"] is False
    assert result["perMetric"]["wer"] is False


def test_eval_with_preset_no_ffi() -> None:
    """When FFI is None, eval_with_preset returns placeholder metrics."""
    metrics = eval_omnivoice._eval_with_preset(
        val_records=[{"id": "s001", "wav": "/tmp/fake.wav", "transcript": "hello"}],
        cfg={"sample_rate": 24000},
        ffi=None,
        preset_path=None,
    )
    assert "wer" in metrics
    assert "speaker_similarity" in metrics
