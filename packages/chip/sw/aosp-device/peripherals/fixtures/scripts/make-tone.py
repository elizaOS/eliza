#!/usr/bin/env python3
"""Deterministically generate a 1-second 440 Hz sine WAV fixture for the
speaker-loopback probe. Output: fixtures/tone-440hz.wav (16-bit PCM, mono,
16000 Hz, full-scale amplitude 0.5).

Run from this directory or pass --out. The byte output is reproducible so the
fixture can be regenerated and compared against the committed file.
"""

from __future__ import annotations

import argparse
import math
import struct
import wave
from pathlib import Path

SAMPLE_RATE = 16000
DURATION_S = 1.0
FREQ_HZ = 440.0
AMPLITUDE = 0.5  # half-scale; safe headroom for any loopback gain stage
CHANNELS = 1
SAMPWIDTH = 2  # 16-bit


def render(samples: int) -> bytes:
    out = bytearray(samples * SAMPWIDTH)
    two_pi = 2.0 * math.pi
    for i in range(samples):
        phase = two_pi * FREQ_HZ * (i / SAMPLE_RATE)
        value = int(round(math.sin(phase) * AMPLITUDE * 32767.0))
        if value > 32767:
            value = 32767
        elif value < -32768:
            value = -32768
        struct.pack_into("<h", out, i * SAMPWIDTH, value)
    return bytes(out)


def write_wav(path: Path) -> None:
    samples = int(SAMPLE_RATE * DURATION_S)
    pcm = render(samples)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(CHANNELS)
        wav.setsampwidth(SAMPWIDTH)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)


def main() -> int:
    here = Path(__file__).resolve()
    default_out = here.parents[1] / "tone-440hz.wav"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=default_out,
        help=f"output WAV path (default: {default_out})",
    )
    args = parser.parse_args()
    write_wav(args.out)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
