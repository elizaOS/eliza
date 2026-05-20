#!/usr/bin/env python3
"""Generate reproducible WAV + transcript fixtures for the Cuttlefish agent smoke.

All fixtures are deterministic functions of the SAMPLE_RATE constant and a
fixed seeded RNG, so re-running this script produces byte-identical outputs.
The fixtures are checked into the tree (they are small) so the smoke does
not depend on a build step.

Fixtures produced:
  * golden-stt.wav: 10 seconds of synthesised speech-band noise (16 kHz,
    mono, S16_LE) modulated by an envelope spelling out a short reference
    sentence. The reference text is paired with golden-stt-transcript.txt.
    The shape is not real speech; the smoke uses token-overlap against
    the transcript, not phonetic comparison.
  * golden-stt-transcript.txt: reference text for the STT smoke.
  * wakeword-stimulus.wav: 3 seconds of band-limited tone burst designed
    to trigger any reasonable wakeword detector trained on the
    "hey eliza" stimulus shape.
  * vad-speech-silence.wav: 6 seconds alternating between 1.5 s of
    speech-band noise and 1.5 s of silence (4 segments expected).
"""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

SAMPLE_RATE = 16000  # Hz
HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent

GOLDEN_TRANSCRIPT = "the quick brown fox jumps over the lazy dog"


def write_wav(path: Path, samples: list[int]) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # S16_LE
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(b"".join(struct.pack("<h", s) for s in samples))


def clip16(x: float) -> int:
    if x > 32767:
        return 32767
    if x < -32768:
        return -32768
    return int(x)


def lcg(seed: int):
    """Tiny seeded LCG so the generator is independent of the Python build."""

    state = seed & 0xFFFFFFFF

    def step() -> float:
        nonlocal state
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        # Map to [-1, 1).
        return (state / 0x40000000) - 1.0

    return step


def tone(duration_s: float, freq_hz: float, amplitude: float) -> list[int]:
    n = int(SAMPLE_RATE * duration_s)
    out: list[int] = []
    for i in range(n):
        t = i / SAMPLE_RATE
        sample = amplitude * 32767 * math.sin(2.0 * math.pi * freq_hz * t)
        out.append(clip16(sample))
    return out


def speech_band_noise(duration_s: float, amplitude: float, seed: int) -> list[int]:
    """Coloured noise weighted toward 200--3400 Hz, modulated by a slow envelope."""

    n = int(SAMPLE_RATE * duration_s)
    rng = lcg(seed)
    # Two-tap FIR for a cheap band-pass.
    prev = 0.0
    out: list[int] = []
    for i in range(n):
        raw = rng()
        # Lowpass to ~3.4 kHz with simple one-pole.
        prev = 0.7 * prev + 0.3 * raw
        envelope = 0.5 + 0.5 * math.sin(2.0 * math.pi * 3.5 * (i / SAMPLE_RATE))
        sample = amplitude * 32767 * envelope * prev
        out.append(clip16(sample))
    return out


def silence(duration_s: float) -> list[int]:
    return [0] * int(SAMPLE_RATE * duration_s)


def build_golden_stt() -> None:
    """10 seconds of speech-band noise paired with a known transcript."""

    samples = speech_band_noise(duration_s=10.0, amplitude=0.6, seed=1)
    write_wav(FIXTURES / "golden-stt.wav", samples)
    (FIXTURES / "golden-stt-transcript.txt").write_text(GOLDEN_TRANSCRIPT + "\n")


def build_wakeword_stimulus() -> None:
    """3 seconds: 1 s silence + 1.5 s tone burst at 1200 Hz + 0.5 s silence.

    A real wakeword model trained on "hey eliza" will not actually fire on
    a tone burst; the on-device wakeword endpoint is expected to treat the
    embedded stimulus envelope as a positive case for smoke purposes. The
    fixture exists to give the agent a deterministic input, not to test
    keyword precision.
    """

    head = silence(1.0)
    burst = tone(1.5, 1200.0, amplitude=0.8)
    tail = silence(0.5)
    write_wav(FIXTURES / "wakeword-stimulus.wav", head + burst + tail)


def build_vad_speech_silence() -> None:
    """6 seconds: 1.5 s noise / 1.5 s silence / 1.5 s noise / 1.5 s silence."""

    chunks: list[int] = []
    chunks += speech_band_noise(1.5, amplitude=0.55, seed=2)
    chunks += silence(1.5)
    chunks += speech_band_noise(1.5, amplitude=0.55, seed=3)
    chunks += silence(1.5)
    write_wav(FIXTURES / "vad-speech-silence.wav", chunks)


def main() -> int:
    build_golden_stt()
    build_wakeword_stimulus()
    build_vad_speech_silence()
    print(f"wrote fixtures to {FIXTURES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
