"""Drive `prep_ljspeech.py` end-to-end against a tiny fixture LJSpeech tree.

Assertions cover:

  - manifest emission with the expected shape (schema fields, voice fields,
    stats fields),
  - train/val list emission with the right line shape,
  - phonemes.jsonl shape,
  - the no-audio-libs + no-phonemize escape hatches (the tests cannot pull
    librosa / pyloudnorm / misaki into the CI graph).

Real audio + phonemizer paths are exercised by an integration run with
`scripts/kokoro/jobs/finetune_default_voice.sh` on a real LJSpeech tree —
that is intentionally not unit-testable in this repo.
"""

from __future__ import annotations

import json
from pathlib import Path

import prep_ljspeech  # type: ignore  # noqa: E402


def test_prep_emits_manifest_and_splits(tiny_ljspeech: Path, tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    rc = prep_ljspeech.main(
        [
            "--data-dir",
            str(tiny_ljspeech),
            "--run-dir",
            str(run_dir),
            "--config",
            "kokoro_lora_ljspeech.yaml",
            "--no-audio-libs",
            "--no-phonemize",
            "--speaker-id",
            "test",
        ]
    )
    assert rc == 0, f"prep exit code {rc}"

    manifest_path = run_dir / "processed" / "prep_manifest.json"
    assert manifest_path.exists(), "prep_manifest.json missing"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["kind"] == "kokoro-prep-manifest"
    assert manifest["sampleRate"] == 24000
    assert manifest["stats"]["totalClips"] >= 10
    assert manifest["stats"]["trainClips"] + manifest["stats"]["valClips"] == manifest["stats"]["totalClips"]
    assert manifest["stats"]["valClips"] >= 1

    train_list = (run_dir / "processed" / "train_list.txt").read_text().splitlines()
    val_list = (run_dir / "processed" / "val_list.txt").read_text().splitlines()
    assert len(train_list) >= 10
    assert len(val_list) >= 1
    # Train/val lines: "<wav-rel>|<phonemes>|<speaker_id>".
    for line in (*train_list, *val_list):
        parts = line.split("|")
        assert len(parts) == 3, f"bad split: {line!r}"
        assert parts[0].startswith("wavs_norm/")
        assert parts[2] == "test"

    phonemes = [
        json.loads(line)
        for line in (run_dir / "processed" / "phonemes.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert len(phonemes) == manifest["stats"]["totalClips"]
    for rec in phonemes:
        assert set(rec.keys()) >= {"clip_id", "raw_text", "norm_text", "phonemes"}


def test_prep_synthetic_smoke_runs(tmp_path: Path) -> None:
    """The pure-synthetic path (no --data-dir) must work for CI smoke.

    Pump the synthetic clip count above the 60s hard-duration gate (each
    synthetic clip is 1s of silence).
    """
    run_dir = tmp_path / "synth-run"
    rc = prep_ljspeech.main(
        [
            "--run-dir",
            str(run_dir),
            "--synthetic-smoke",
            "--synthetic-clips",
            "72",
            "--config",
            "kokoro_lora_ljspeech.yaml",
        ]
    )
    assert rc == 0
    assert (run_dir / "processed" / "prep_manifest.json").exists()
    assert (run_dir / "processed" / "train_list.txt").read_text().strip()
    assert (run_dir / "processed" / "val_list.txt").read_text().strip()
