"""Unit tests for the wake-word corpus synthesizer's pure pieces.

Covers the audio helpers that do not need piper or a network: resample,
center/pad-to-window, augmentation, and the PCM16 WAV writer (the exact
16 kHz mono format the trainer reads). The piper-driven `synthesize()`
orchestrator is exercised by the end-to-end smoke run on the training box,
not here. Skips cleanly when numpy/scipy/soundfile aren't installed.
"""

from __future__ import annotations

import sys
import wave
from pathlib import Path

import pytest

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

np = pytest.importorskip("numpy")
pytest.importorskip("scipy")

from scripts.wakeword import synthesize_wakeword_corpus as sc  # noqa: E402


def test_clip_geometry_is_two_seconds_at_16k() -> None:
    assert sc.SAMPLE_RATE == 16_000
    assert sc.CLIP_SECONDS == 2.0
    assert sc.CLIP_SAMPLES == 32_000


def test_resample_to_16k_mono_changes_rate_and_flattens() -> None:
    # A 22.05 kHz stereo half-second tone → 16 kHz mono of the same duration.
    sr = 22_050
    t = np.linspace(0, 0.5, int(sr * 0.5), endpoint=False, dtype=np.float32)
    tone = np.sin(2 * np.pi * 440 * t).astype(np.float32)
    stereo = np.stack([tone, tone])  # (2, n)
    out = sc._resample_to_16k_mono(stereo, sr)
    assert out.ndim == 1
    # ~0.5 s at 16 kHz (resample_poly length is within a few samples).
    assert abs(out.shape[0] - 8_000) <= 4


def test_center_pad_exact_length_short_and_long() -> None:
    rng = np.random.default_rng(0)
    short = np.ones(5_000, dtype=np.float32)
    padded = sc._center_pad(short, rng)
    assert padded.shape[0] == sc.CLIP_SAMPLES
    # The original signal survives intact somewhere in the window.
    assert float(padded.sum()) == pytest.approx(5_000.0, abs=1e-3)

    long = np.ones(50_000, dtype=np.float32)
    cropped = sc._center_pad(long, rng)
    assert cropped.shape[0] == sc.CLIP_SAMPLES


def test_augment_keeps_length_and_bounds() -> None:
    rng = np.random.default_rng(1)
    sig = 0.5 * np.sin(
        np.linspace(0, 50, sc.CLIP_SAMPLES, dtype=np.float32)
    ).astype(np.float32)
    out = sc._augment(sig, rng, noise_bank=[])
    assert out.shape[0] == sc.CLIP_SAMPLES
    assert out.dtype == np.float32
    assert float(np.max(np.abs(out))) <= 1.0


def test_write_wav_is_16k_mono_pcm16(tmp_path: Path) -> None:
    audio = (0.3 * np.sin(np.linspace(0, 100, sc.CLIP_SAMPLES, dtype=np.float32))).astype(
        np.float32
    )
    p = tmp_path / "clip.wav"
    sc._write_wav(p, audio)
    with wave.open(str(p), "rb") as w:
        assert w.getframerate() == sc.SAMPLE_RATE
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2  # PCM16
        assert w.getnframes() == sc.CLIP_SAMPLES


def _normalize_phrase(text: str) -> str:
    # Drop punctuation, lowercase, collapse runs of whitespace — the same
    # word said with different spelling/punctuation is the same phrase.
    cleaned = "".join(c if c.isalnum() or c.isspace() else " " for c in text.lower())
    return " ".join(cleaned.split())


def test_phrase_banks_are_disjoint_and_nonempty() -> None:
    # Every positive variant is the wake phrase; it never leaks into either
    # negative bank — a corpus with "hey eliza" mislabeled as negative would
    # poison the head.
    pos = {_normalize_phrase(v) for v in sc.POSITIVE_VARIANTS}
    assert pos == {"hey eliza"}
    assert sc.HARD_NEGATIVE_PHRASES and sc.GENERIC_NEGATIVE_PHRASES
    neg = {
        _normalize_phrase(p)
        for p in (*sc.HARD_NEGATIVE_PHRASES, *sc.GENERIC_NEGATIVE_PHRASES)
    }
    assert "hey eliza" not in neg
