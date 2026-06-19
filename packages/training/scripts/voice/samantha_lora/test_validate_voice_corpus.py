from __future__ import annotations

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import validate_voice_corpus as validator


def _write_wav(
    path: Path,
    *,
    audio_format: int,
    bits_per_sample: int,
    sample_rate: int = 24_000,
    duration_s: float = 1.0,
) -> None:
    frames = int(sample_rate * duration_s)
    bytes_per_sample = bits_per_sample // 8
    data = bytearray(frames * bytes_per_sample)
    for i in range(frames):
        if audio_format == 1:
            struct.pack_into("<h", data, i * bytes_per_sample, 8000)
        elif audio_format == 3:
            struct.pack_into("<f", data, i * bytes_per_sample, 0.25)
    riff_size = 36 + len(data)
    header = (
        b"RIFF"
        + struct.pack("<I", riff_size)
        + b"WAVE"
        + b"fmt "
        + struct.pack(
            "<IHHIIHH",
            16,
            audio_format,
            1,
            sample_rate,
            sample_rate * bytes_per_sample,
            bytes_per_sample,
            bits_per_sample,
        )
        + b"data"
        + struct.pack("<I", len(data))
    )
    path.write_bytes(header + data)


def test_metadata_csv_prefers_normalized_transcript(tmp_path: Path) -> None:
    metadata = tmp_path / "metadata.csv"
    metadata.write_text("clip_001|RAW TEXT|normalized text\n", encoding="utf-8")

    assert validator._read_transcripts(metadata) == [("clip_001", "normalized text")]


def test_probe_wav_accepts_documented_float32_wav(tmp_path: Path) -> None:
    wav = tmp_path / "clip_001.wav"
    _write_wav(wav, audio_format=3, bits_per_sample=32)

    sample_rate, duration = validator._probe_wav(wav)

    assert sample_rate == 24_000
    assert duration == 1.0


def test_validate_corpus_accepts_float32_layout(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(validator, "MIN_TOTAL_DURATION_SECONDS", 0.5)
    corpus = tmp_path / "corpus"
    wavs = corpus / "wavs"
    wavs.mkdir(parents=True)
    (corpus / "transcripts.csv").write_text("clip_001|hello there\n", encoding="utf-8")
    _write_wav(wavs / "clip_001.wav", audio_format=3, bits_per_sample=32)

    report = validator.validate_corpus(corpus)

    assert report.passed, report.failures
    assert report.total_clips == 1
