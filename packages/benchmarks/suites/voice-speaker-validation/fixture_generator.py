"""Deterministic synthetic WAV fixture generator for voice-speaker-validation.

The generated files are speech-like mono 16 kHz PCM assets with stable
speaker-specific timbre. They are intentionally synthetic so the benchmark can
be reproduced without licensed voice corpora or platform room captures.
"""

from __future__ import annotations

import argparse
import json
import math
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TARGET_SR = 16_000


@dataclass(frozen=True)
class SpeakerVoice:
    f0_hz: float
    formants_hz: tuple[float, float, float]
    brightness: float
    breath: float
    seed: int


SPEAKER_VOICES: dict[str, SpeakerVoice] = {
    "sam": SpeakerVoice(132.0, (610.0, 1160.0, 2380.0), 0.42, 0.018, 101),
    "speaker_a": SpeakerVoice(132.0, (610.0, 1160.0, 2380.0), 0.42, 0.018, 101),
    "owner": SpeakerVoice(132.0, (610.0, 1160.0, 2380.0), 0.42, 0.018, 101),
    "speaker_b": SpeakerVoice(80.0, (260.0, 620.0, 1450.0), 0.00, 0.180, 201),
    "jill": SpeakerVoice(80.0, (260.0, 620.0, 1450.0), 0.00, 0.180, 201),
    "speaker_c": SpeakerVoice(170.0, (245.4, 2020.3, 3924.9), 1.55, 0.000, 3018),
}


def _speaker_signal(
    voice: SpeakerVoice,
    duration_s: float,
    *,
    phrase_index: int,
    sample_rate: int = TARGET_SR,
) -> np.ndarray:
    """Return one speech-like utterance for a synthetic speaker."""
    n_samples = max(1, int(round(duration_s * sample_rate)))
    t = np.arange(n_samples, dtype=np.float64) / sample_rate
    rng = np.random.default_rng(voice.seed + phrase_index * 7919 + n_samples)

    # Slow intonation plus syllable-rate amplitude modulation.
    vibrato = 1.0 + 0.018 * np.sin(2.0 * np.pi * (2.3 + 0.17 * phrase_index) * t)
    phrase_sweep = 1.0 + 0.025 * np.sin(2.0 * np.pi * (0.23 + 0.03 * phrase_index) * t)
    f0 = voice.f0_hz * vibrato * phrase_sweep
    phase = 2.0 * np.pi * np.cumsum(f0) / sample_rate

    voiced = np.zeros_like(t)
    for harmonic in range(1, 12):
        amp = 1.0 / (harmonic ** (1.08 - 0.18 * voice.brightness))
        jitter = 0.01 * rng.normal()
        voiced += amp * np.sin(harmonic * phase + jitter)

    formant_mix = np.zeros_like(t)
    for formant_i, formant_hz in enumerate(voice.formants_hz):
        wobble = 1.0 + 0.012 * np.sin(
            2.0 * np.pi * (0.37 + formant_i * 0.21) * t + phrase_index
        )
        amp = [0.72, 0.45, 0.25][formant_i]
        formant_mix += amp * np.sin(2.0 * np.pi * formant_hz * wobble * t)

    syllable_rate = 3.7 + (voice.seed % 5) * 0.17
    syllable = 0.58 + 0.42 * np.maximum(
        0.0,
        np.sin(2.0 * np.pi * syllable_rate * t + 0.3 * phrase_index),
    )
    micro_pause = 0.88 + 0.12 * np.sin(2.0 * np.pi * 0.71 * t + voice.seed)

    # Smooth attack/release prevents VAD edge artifacts.
    attack = min(n_samples, int(0.045 * sample_rate))
    release = min(n_samples, int(0.055 * sample_rate))
    envelope = syllable * micro_pause
    if attack:
        envelope[:attack] *= np.linspace(0.0, 1.0, attack)
    if release:
        envelope[-release:] *= np.linspace(1.0, 0.0, release)

    breath = rng.normal(0.0, voice.breath, n_samples)
    signal = (0.72 * voiced + 0.28 * formant_mix + breath) * envelope
    signal -= float(signal.mean())
    peak = max(float(np.max(np.abs(signal))), 1e-9)
    return (0.52 * signal / peak).astype(np.float32)


def _write_wav(path: Path, pcm: np.ndarray, sample_rate: int = TARGET_SR) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(pcm, -0.98, 0.98)
    pcm16 = (clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm16.tobytes())


def build_fixture_audio(info: dict, sample_rate: int = TARGET_SR) -> np.ndarray:
    """Build a complete fixture waveform from a manifest entry."""
    total_ms = max(seg["end_ms"] for seg in info["ground_truth"])
    total_samples = int(math.ceil(total_ms * sample_rate / 1000.0))
    pcm = np.zeros(total_samples, dtype=np.float32)

    for index, segment in enumerate(info["ground_truth"]):
        speaker = segment["speaker"]
        voice = SPEAKER_VOICES[speaker]
        start = int(round(segment["start_ms"] * sample_rate / 1000.0))
        end = int(round(segment["end_ms"] * sample_rate / 1000.0))
        utterance = _speaker_signal(
            voice,
            (segment["end_ms"] - segment["start_ms"]) / 1000.0,
            phrase_index=index,
            sample_rate=sample_rate,
        )
        pcm[start:end] += utterance[: end - start]

    peak = max(float(np.max(np.abs(pcm))), 1e-9)
    return (0.78 * pcm / peak).astype(np.float32)


def ensure_fixture_wavs(fixtures_dir: Path) -> list[Path]:
    """Generate any missing WAV fixture declared in fixtures/manifest.json."""
    manifest_path = fixtures_dir / "manifest.json"
    with open(manifest_path) as handle:
        manifest = json.load(handle)

    generated: list[Path] = []
    for info in manifest.values():
        wav_path = fixtures_dir / info["path"]
        if wav_path.exists():
            continue
        pcm = build_fixture_audio(info)
        _write_wav(wav_path, pcm)
        generated.append(wav_path)
    return generated


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixtures-dir",
        type=Path,
        default=Path(__file__).parent / "fixtures",
        help="Directory containing manifest.json and generated WAV files.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Regenerate WAV files even when they already exist.",
    )
    args = parser.parse_args()

    if args.force:
        manifest = json.loads((args.fixtures_dir / "manifest.json").read_text())
        for info in manifest.values():
            wav_path = args.fixtures_dir / info["path"]
            if wav_path.exists():
                wav_path.unlink()

    generated = ensure_fixture_wavs(args.fixtures_dir)
    for path in generated:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
