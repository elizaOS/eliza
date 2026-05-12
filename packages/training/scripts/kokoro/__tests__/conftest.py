"""Shared pytest fixtures for the Kokoro fine-tune pipeline tests.

These tests intentionally avoid every heavy dependency (torch, transformers,
peft, librosa, onnx). They rely on:

  - the stdlib `wave` module to materialize a tiny LJSpeech-format dataset,
  - `pyyaml` for config loading (already a top-level dep of eliza-training),
  - `numpy` for the voice-bin shape check.

Each test runs the script's `main()` function directly with argv, asserting
file outputs. This matches the convention in
`packages/training/scripts/test_distill_dflash_drafter.py` — drive a CLI by
its own main() so coverage tracks the real entry point.
"""

from __future__ import annotations

import sys
import wave
from pathlib import Path

import pytest

# Make sibling scripts importable as top-level modules (their internal
# `from _config import load_config` only works when scripts/kokoro/ is on
# sys.path).
SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def _write_silence_wav(path: Path, *, sample_rate: int, duration_s: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    n_frames = int(round(sample_rate * duration_s))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * n_frames)


@pytest.fixture
def tiny_ljspeech(tmp_path: Path) -> Path:
    """Materialize a 12-clip LJSpeech-format directory under tmp_path.

    Returns the dataset root (containing `metadata.csv` and `wavs/`).
    Each clip is 6s of silence at 24 kHz so the prep gate's >=60s
    cumulative-duration floor is satisfied (12 * 6 = 72s).
    """
    root = tmp_path / "tiny-ljspeech"
    wavs = root / "wavs"
    wavs.mkdir(parents=True, exist_ok=True)
    metadata = root / "metadata.csv"
    lines: list[str] = []
    for i in range(12):
        clip_id = f"FIX-{i:04d}"
        _write_silence_wav(wavs / f"{clip_id}.wav", sample_rate=24000, duration_s=6.0)
        lines.append(f"{clip_id}|hello world {i}|hello world {i}")
    metadata.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return root
