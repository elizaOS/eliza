#!/usr/bin/env python3
"""Validate a Samantha-corpus directory before prep_corpus.py runs.

Runs the structural checks documented in collect_audio.md. Refuses to
emit ``OK`` unless every check passes — there are no soft warnings, no
``--allow-degraded`` escape hatch. The training pipeline trusts this
script's output, so a green report has to mean "actually ready".

Usage:

    python3 validate_voice_corpus.py --corpus ~/samantha-corpus
    python3 validate_voice_corpus.py --corpus ~/samantha-corpus --json

Exit codes:
    0  — corpus is valid; safe to run prep_corpus.py.
    1  — at least one validation failed; details on stderr (or JSON).
    2  — invocation error (bad arguments, corpus path missing).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

# Hard floors documented in collect_audio.md. Bumping any of these is a
# product decision — update the doc in the same PR.
MIN_TOTAL_DURATION_SECONDS = 600.0  # 10 min
MIN_SAMPLE_RATE = 24_000
MIN_CLIP_SECONDS = 0.5
MAX_CLIP_SECONDS = 30.0
ID_RE = re.compile(r"^[A-Za-z0-9_]+$")


@dataclass
class CorpusReport:
    corpus_path: str
    total_clips: int = 0
    total_duration_seconds: float = 0.0
    failures: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.failures

    def to_dict(self) -> dict[str, object]:
        return {
            "corpus_path": self.corpus_path,
            "total_clips": self.total_clips,
            "total_duration_seconds": round(self.total_duration_seconds, 2),
            "passed": self.passed,
            "failures": list(self.failures),
        }


def _read_transcripts(csv_path: Path) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    with csv_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh, delimiter="|")
        for line_no, row in enumerate(reader, start=1):
            if not row or all(not cell.strip() for cell in row):
                continue
            if len(row) < 2:
                raise ValueError(
                    f"{csv_path.name}:{line_no}: expected at least 2 pipe-separated columns (id|text), got {len(row)}"
                )
            clip_id = row[0].strip()
            # Legacy staged corpora use metadata.csv as id|raw|normalized.
            # Prefer the normalized transcript when present; otherwise use
            # the regular id|text second column used by transcripts.csv.
            text = (
                row[2].strip()
                if csv_path.name == "metadata.csv" and len(row) >= 3 and row[2].strip()
                else row[1].strip()
            )
            if not clip_id:
                raise ValueError(f"{csv_path.name}:{line_no}: empty id")
            if not ID_RE.match(clip_id):
                raise ValueError(
                    f"{csv_path.name}:{line_no}: id {clip_id!r} not [A-Za-z0-9_]+"
                )
            if not text:
                raise ValueError(f"{csv_path.name}:{line_no}: empty text for id {clip_id}")
            rows.append((clip_id, text))
    return rows


def _u16(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 2], "little")


def _u32(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 4], "little")


def _probe_wav(path: Path) -> tuple[int, float]:
    """Return (sample_rate, duration_seconds). Raises ValueError on bad WAV."""
    data = path.read_bytes()
    if len(data) < 44 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError(f"{path.name}: expected RIFF/WAVE file")

    fmt_offset = -1
    fmt_size = 0
    data_bytes = 0
    offset = 12
    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        chunk_size = _u32(data, offset + 4)
        payload = offset + 8
        if payload + chunk_size > len(data):
            raise ValueError(f"{path.name}: malformed WAV chunk {chunk_id!r}")
        if chunk_id == b"fmt ":
            fmt_offset = payload
            fmt_size = chunk_size
        elif chunk_id == b"data":
            data_bytes = chunk_size
        offset = payload + chunk_size + (chunk_size % 2)

    if fmt_offset < 0 or fmt_size < 16:
        raise ValueError(f"{path.name}: missing fmt chunk")
    if data_bytes <= 0:
        raise ValueError(f"{path.name}: empty or unreadable WAV")

    audio_format = _u16(data, fmt_offset)
    channels = _u16(data, fmt_offset + 2)
    sr = _u32(data, fmt_offset + 4)
    bits_per_sample = _u16(data, fmt_offset + 14)
    is_pcm16 = audio_format == 1 and bits_per_sample == 16
    is_float32 = audio_format == 3 and bits_per_sample == 32
    is_extensible_supported = audio_format == 0xFFFE and bits_per_sample in (16, 32)

    if channels != 1:
        raise ValueError(f"{path.name}: must be mono (got {channels} channels)")
    if sr <= 0:
        raise ValueError(f"{path.name}: empty or unreadable WAV")
    if not (is_pcm16 or is_float32 or is_extensible_supported):
        raise ValueError(
            f"{path.name}: unsupported WAV format={audio_format} bits={bits_per_sample} "
            "(need PCM16 or float32)"
        )
    if sr < MIN_SAMPLE_RATE:
        raise ValueError(
            f"{path.name}: sample rate {sr} below floor {MIN_SAMPLE_RATE}"
        )

    bytes_per_frame = channels * (bits_per_sample // 8)
    frames = data_bytes // bytes_per_frame
    if frames <= 0:
        raise ValueError(f"{path.name}: empty or unreadable WAV")
    return sr, frames / float(sr)


def validate_corpus(corpus_path: Path) -> CorpusReport:
    report = CorpusReport(corpus_path=str(corpus_path))

    if not corpus_path.is_dir():
        report.failures.append(f"corpus path is not a directory: {corpus_path}")
        return report

    csv_path = corpus_path / "transcripts.csv"
    # Accept the legacy `metadata.csv` layout used by the existing
    # packages/training/data/voice/same/ corpus (id|raw|normalized);
    # treat the third column as the canonical text when present.
    metadata_path = corpus_path / "metadata.csv"
    use_metadata = False
    if not csv_path.is_file():
        if metadata_path.is_file():
            csv_path = metadata_path
            use_metadata = True
        else:
            report.failures.append(
                "missing transcripts.csv (or legacy metadata.csv) at corpus root"
            )
            return report

    wavs_dir = corpus_path / "wavs"
    if not wavs_dir.is_dir():
        report.failures.append("missing wavs/ directory at corpus root")
        return report

    try:
        rows = _read_transcripts(csv_path)
    except ValueError as exc:
        report.failures.append(str(exc))
        return report

    if use_metadata:
        # legacy metadata.csv has 3 columns id|raw|normalized; _read_transcripts
        # prefers normalized text when present.
        pass

    if not rows:
        report.failures.append("transcripts.csv has no usable rows")
        return report

    # Check 1:1 file/transcript correspondence.
    referenced_ids = {clip_id for clip_id, _ in rows}
    on_disk = {p.stem for p in wavs_dir.glob("*.wav")}
    missing_audio = sorted(referenced_ids - on_disk)
    orphan_audio = sorted(on_disk - referenced_ids)
    for clip_id in missing_audio:
        report.failures.append(f"transcript references missing wavs/{clip_id}.wav")
    for clip_id in orphan_audio:
        report.failures.append(f"orphan wav has no transcript: wavs/{clip_id}.wav")

    # Probe every wav.
    seen_ids: set[str] = set()
    total_duration = 0.0
    for clip_id, _text in rows:
        if clip_id in seen_ids:
            report.failures.append(f"duplicate transcript id: {clip_id}")
            continue
        seen_ids.add(clip_id)
        wav_path = wavs_dir / f"{clip_id}.wav"
        if not wav_path.is_file():
            continue  # already noted above
        try:
            _sr, duration = _probe_wav(wav_path)
        except ValueError as exc:
            report.failures.append(str(exc))
            continue
        if duration < MIN_CLIP_SECONDS:
            report.failures.append(
                f"{clip_id}: duration {duration:.2f}s below floor {MIN_CLIP_SECONDS}s"
            )
            continue
        if duration > MAX_CLIP_SECONDS:
            report.failures.append(
                f"{clip_id}: duration {duration:.2f}s above ceiling {MAX_CLIP_SECONDS}s"
            )
            continue
        total_duration += duration
        report.total_clips += 1

    report.total_duration_seconds = total_duration

    # Total-duration gate.
    if total_duration < MIN_TOTAL_DURATION_SECONDS:
        report.failures.append(
            f"total duration {total_duration:.1f}s below floor {MIN_TOTAL_DURATION_SECONDS:.0f}s "
            f"({MIN_TOTAL_DURATION_SECONDS / 60:.0f} min). Add more clips or reduce the floor."
        )

    return report


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--corpus",
        type=Path,
        required=True,
        help="Path to the corpus directory (must contain transcripts.csv + wavs/).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a single JSON document instead of human-readable lines.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    report = validate_corpus(args.corpus.resolve())

    if args.json:
        json.dump(report.to_dict(), sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(
            f"corpus: {report.corpus_path}\n"
            f"clips:  {report.total_clips}\n"
            f"total:  {report.total_duration_seconds:.1f}s "
            f"({report.total_duration_seconds / 60:.2f} min)\n"
        )
        if report.failures:
            sys.stdout.write(f"FAIL ({len(report.failures)} issues):\n")
            for failure in report.failures:
                sys.stdout.write(f"  - {failure}\n")
        else:
            sys.stdout.write("OK: corpus is ready for prep_corpus.py\n")

    return 0 if report.passed else 1


if __name__ == "__main__":  # pragma: no cover - CLI dispatch
    raise SystemExit(main())
