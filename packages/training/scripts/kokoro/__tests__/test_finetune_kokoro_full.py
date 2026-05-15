"""Tests for finetune_kokoro_full.py.

Three test suites:

1. Synthetic-smoke pipeline shape (no torch / no kokoro). Asserts the manifest
   schema is stable across the two finetune scripts and that the checkpoint
   directory layout is what package_voice_for_release.py expects.

2. Eval gate decision logic — _decide_continue + _update_top_k. Mocks the
   eval-history input and asserts pass/fail aligns with the spec thresholds.

3. CLI surface — argparse + config loading via load_config('kokoro_sam_full.yaml').
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import finetune_kokoro_full  # type: ignore  # noqa: E402


# ---------------------------------------------------------------------------
# 1. Synthetic-smoke pipeline shape.
# ---------------------------------------------------------------------------


def test_synthetic_smoke_writes_manifest_and_checkpoints(tmp_path: Path) -> None:
    """End-to-end smoke: argv-driven, no torch imports."""
    run_dir = tmp_path / "run"
    rc = finetune_kokoro_full.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            "kokoro_sam_full.yaml",
            "--synthetic-smoke",
        ]
    )
    assert rc == 0, f"finetune_kokoro_full exit code {rc}"

    ckpt_dir = run_dir / "checkpoints"
    train_manifest_path = ckpt_dir / "train_manifest.json"
    assert train_manifest_path.exists(), "train_manifest.json missing"

    manifest = json.loads(train_manifest_path.read_text())
    assert manifest["kind"] == "kokoro-finetune-manifest"
    assert manifest["synthetic"] is True
    assert manifest["mode"] == "full"
    assert manifest["baseModel"] == "hexgrad/Kokoro-82M"
    assert manifest["voiceName"] == "af_sam"

    # Hyperparameter block reflects the N2 defaults from kokoro_sam_full.yaml.
    hp = manifest["hyperparameters"]
    assert hp["optimizer"] in ("apollo", "apollo_mini")
    assert hp["learningRate"] == pytest.approx(5e-5)
    assert hp["maxSteps"] == 1500
    assert hp["earlyStopPatience"] == 3
    assert hp["keepTopK"] == 3
    assert hp["anchorWeight"] == pytest.approx(0.001)

    # topK block is the new shape introduced by full FT.
    assert isinstance(manifest["topK"], list)
    assert manifest["topK"], "topK should be non-empty after smoke run"
    for entry in manifest["topK"]:
        assert "step" in entry
        assert "path" in entry
        assert "speaker_similarity" in entry

    # Eval history exists and contains numbers (not strings).
    assert manifest["training"]["best_speaker_similarity"] > 0
    assert manifest["training"]["best_speaker_similarity_step"] > 0
    assert manifest["training"]["eval_history"]

    # Checkpoint files emitted.
    step_files = list(ckpt_dir.glob("step_*.json"))
    assert step_files, "no step_*.json checkpoints emitted"
    assert (ckpt_dir / "best.json").exists(), "best.json missing"


def test_synthetic_smoke_creates_processed_lists_when_missing(tmp_path: Path) -> None:
    """Smoke path fabricates train/val lists when prep hasn't been run."""
    run_dir = tmp_path / "run-empty"
    rc = finetune_kokoro_full.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            "kokoro_sam_full.yaml",
            "--synthetic-smoke",
        ]
    )
    assert rc == 0
    assert (run_dir / "processed" / "train_list.txt").exists()
    assert (run_dir / "processed" / "val_list.txt").exists()


# ---------------------------------------------------------------------------
# 2. Eval gate decision logic.
# ---------------------------------------------------------------------------


class TestDecideContinue:
    """Spec: stop training when SpkSim stalls or regresses for `patience` evals."""

    def test_warmup_returns_continue(self) -> None:
        """Not enough history → always continue."""
        cont, reason = finetune_kokoro_full._decide_continue(
            [{"speaker_similarity": 0.4}],
            patience=3,
        )
        assert cont is True
        assert reason == "warmup"

    def test_strictly_improving_continues(self) -> None:
        cont, _ = finetune_kokoro_full._decide_continue(
            [
                {"speaker_similarity": 0.4},
                {"speaker_similarity": 0.45},
                {"speaker_similarity": 0.5},
                {"speaker_similarity": 0.55},
            ],
            patience=3,
        )
        assert cont is True

    def test_stalled_for_patience_stops(self) -> None:
        """Three consecutive evals at or below the baseline → stop."""
        cont, reason = finetune_kokoro_full._decide_continue(
            [
                {"speaker_similarity": 0.50},
                {"speaker_similarity": 0.48},
                {"speaker_similarity": 0.49},
                {"speaker_similarity": 0.47},
            ],
            patience=3,
        )
        assert cont is False
        assert "stalled" in reason or "regressed" in reason

    def test_partial_regression_continues(self) -> None:
        """If even one eval in the patience window beats baseline, continue."""
        cont, _ = finetune_kokoro_full._decide_continue(
            [
                {"speaker_similarity": 0.50},
                {"speaker_similarity": 0.48},
                {"speaker_similarity": 0.55},  # this one beats baseline
                {"speaker_similarity": 0.49},
            ],
            patience=3,
        )
        assert cont is True


class TestUpdateTopK:
    """Spec: maintain top-k by SpkSim; older entries dropped from disk."""

    def test_first_entry_keeps_one(self) -> None:
        kept, drop = finetune_kokoro_full._update_top_k(
            [],
            step=200,
            path="/x/step_200.pt",
            bin_path="/x/step_200.bin",
            speaker_similarity=0.55,
            k=3,
        )
        assert len(kept) == 1
        assert kept[0]["step"] == 200
        assert drop == []

    def test_top_k_drops_when_full(self) -> None:
        top_k: list[dict[str, Any]] = [
            {"step": 200, "path": "/x/step_200.pt", "binPath": "/x/step_200.bin", "speaker_similarity": 0.55},
            {"step": 400, "path": "/x/step_400.pt", "binPath": "/x/step_400.bin", "speaker_similarity": 0.50},
            {"step": 600, "path": "/x/step_600.pt", "binPath": "/x/step_600.bin", "speaker_similarity": 0.45},
        ]
        kept, drop = finetune_kokoro_full._update_top_k(
            top_k,
            step=800,
            path="/x/step_800.pt",
            bin_path="/x/step_800.bin",
            speaker_similarity=0.60,
            k=3,
        )
        assert len(kept) == 3
        kept_steps = sorted([e["step"] for e in kept])
        assert 800 in kept_steps
        assert 600 not in kept_steps  # worst-perf was step 600
        # Dropping deletes both .pt and .bin paths.
        assert "/x/step_600.pt" in drop
        assert "/x/step_600.bin" in drop

    def test_top_k_ignores_when_under_threshold(self) -> None:
        top_k: list[dict[str, Any]] = [
            {"step": 200, "path": "/x/step_200.pt", "binPath": "/x/step_200.bin", "speaker_similarity": 0.55},
            {"step": 400, "path": "/x/step_400.pt", "binPath": "/x/step_400.bin", "speaker_similarity": 0.50},
            {"step": 600, "path": "/x/step_600.pt", "binPath": "/x/step_600.bin", "speaker_similarity": 0.45},
        ]
        kept, drop = finetune_kokoro_full._update_top_k(
            top_k,
            step=800,
            path="/x/step_800.pt",
            bin_path="/x/step_800.bin",
            speaker_similarity=0.40,  # worse than every kept entry
            k=3,
        )
        assert len(kept) == 3
        # The new entry should be the one that got dropped.
        assert "/x/step_800.pt" in drop


# ---------------------------------------------------------------------------
# 3. CLI surface + config loading.
# ---------------------------------------------------------------------------


def test_cli_default_config_is_sam_full() -> None:
    parser = finetune_kokoro_full.build_parser()
    # parse a minimal argv that doesn't error.
    ns = parser.parse_args(["--run-dir", "/tmp/x"])
    assert ns.config == "kokoro_sam_full.yaml"
    assert ns.init_from_voice == "af_bella"
    assert ns.synthetic_smoke is False


def test_config_has_full_mode_and_correct_thresholds() -> None:
    """The shipped config must declare mode=full + relaxed SpkSim gate."""
    from _config import load_config  # type: ignore  # noqa: PLC0415

    cfg = load_config("kokoro_sam_full.yaml")
    assert cfg["mode"] == "full"
    assert cfg["max_steps"] == 1500
    assert cfg["learning_rate"] == pytest.approx(5e-5)
    assert cfg["gates"]["speaker_similarity_min"] == pytest.approx(0.55)
    assert cfg["gates"]["utmos_min"] == pytest.approx(3.8)
    assert cfg["gates"]["wer_max"] == pytest.approx(0.08)
    assert cfg["gates"]["rtf_min"] == pytest.approx(5.0)
    # APOLLO-only policy.
    assert cfg["optimizer"] in ("apollo", "apollo_mini")
    # Tags reflect the full-finetune lineage.
    assert "full-finetune" in cfg["voice_tags"]


# ---------------------------------------------------------------------------
# 4. Manifest stability across finetune_kokoro.py and finetune_kokoro_full.py.
# ---------------------------------------------------------------------------


def test_manifest_kind_matches_lora_path(tmp_path: Path) -> None:
    """Both scripts emit kokoro-finetune-manifest so downstream consumers
    (package_voice_for_release.py, push_voice_to_hf.py) don't have to branch."""
    run_dir = tmp_path / "shape"
    rc = finetune_kokoro_full.main(
        ["--run-dir", str(run_dir), "--config", "kokoro_sam_full.yaml", "--synthetic-smoke"]
    )
    assert rc == 0
    manifest = json.loads((run_dir / "checkpoints" / "train_manifest.json").read_text())
    assert manifest["kind"] == "kokoro-finetune-manifest"
    assert manifest["mode"] == "full"
    # Required keys consumers depend on.
    for key in (
        "baseModel",
        "voiceName",
        "hyperparameters",
        "dataset",
        "training",
        "checkpoints",
        "topK",
        "trainingCommit",
    ):
        assert key in manifest, f"manifest missing required key: {key}"
