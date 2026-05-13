"""Drive `finetune_kokoro.py --synthetic-smoke` and assert checkpoint emission.

This test does NOT exercise the torch / kokoro / peft code path. The synthetic
smoke explicitly bypasses every heavy import so CI without a GPU (or even
without torch) can catch pipeline-shape regressions.
"""

from __future__ import annotations

import json
from pathlib import Path

import finetune_kokoro  # type: ignore  # noqa: E402


def test_finetune_synthetic_smoke_writes_checkpoint(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    # finetune's synthetic-smoke materializes its own train/val lists if
    # they're missing, so we don't need to run prep first.
    rc = finetune_kokoro.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            "kokoro_lora_ljspeech.yaml",
            "--synthetic-smoke",
        ]
    )
    assert rc == 0, f"finetune exit code {rc}"

    ckpt_dir = run_dir / "checkpoints"
    train_manifest_path = ckpt_dir / "train_manifest.json"
    assert train_manifest_path.exists(), "train_manifest.json missing"
    manifest = json.loads(train_manifest_path.read_text())
    assert manifest["kind"] == "kokoro-finetune-manifest"
    assert manifest["synthetic"] is True
    assert manifest["mode"] == "lora"
    assert manifest["baseModel"] == "hexgrad/Kokoro-82M"
    assert "hyperparameters" in manifest
    assert "loraRank" in manifest["hyperparameters"]
    assert manifest["hyperparameters"]["loraRank"] == 16
    assert manifest["training"]["best_step"] >= 1
    assert manifest["dataset"]["trainClips"] >= 1
    assert manifest["dataset"]["valClips"] >= 1

    # The smoke variant writes JSON-encoded checkpoints instead of torch
    # tensors so the CI path stays import-free.
    step_files = list(ckpt_dir.glob("step_*.json"))
    assert step_files, "no step_*.json checkpoint emitted"
    best_path = ckpt_dir / "best.json"
    assert best_path.exists(), "best.json checkpoint missing"
    best = json.loads(best_path.read_text())
    assert best["kind"] == "kokoro-synthetic-checkpoint"
    assert best["baseModel"] == "hexgrad/Kokoro-82M"


def test_finetune_synthetic_smoke_epoch_override(tmp_path: Path) -> None:
    """The `--epochs N` flag overrides max_steps in synthetic-smoke too."""
    run_dir = tmp_path / "run"
    rc = finetune_kokoro.main(
        [
            "--run-dir",
            str(run_dir),
            "--config",
            "kokoro_lora_ljspeech.yaml",
            "--synthetic-smoke",
            "--epochs",
            "1",
        ]
    )
    assert rc == 0
