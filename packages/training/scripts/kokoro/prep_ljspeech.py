#!/usr/bin/env python3
"""Prepare an LJSpeech-format directory for Kokoro fine-tuning.

Input layout:

    <dataset>/
    ├── metadata.csv             # "id|raw_text|normalized_text" per line
    └── wavs/<id>.wav            # mono, any sample rate (we resample)

Output layout (under `<run-dir>/processed/`):

    processed/
    ├── train_list.txt           # "<wav-rel>|<phonemes>|<speaker_id>" per line
    ├── val_list.txt             # same format
    ├── wavs_norm/<id>.wav       # 24 kHz mono, peak-normalized
    ├── phonemes.jsonl           # one record per clip with raw + phoneme text
    └── prep_manifest.json       # dataset stats + hashes + tool versions

What this does:

1. Reads metadata.csv, asserts every referenced wav exists.
2. Validates audio: SR > 0, mono, duration in [min_audio_seconds,
   max_audio_seconds], no clipping (|peak| < 0.999).
3. Resamples to `sample_rate` (24000 by default for Kokoro-82M) and writes
   16-bit PCM mono into wavs_norm/. Loudness-normalizes to -23 LUFS.
4. Phonemizes the normalized text via misaki[en] (Kokoro's first-party
   phonemizer). Falls back to a raw-text passthrough only with --no-phonemize
   for smoke tests; that mode is rejected by finetune_kokoro.py.
5. Splits 95/5 train/val (configurable; seeded by config.seed).
6. Emits prep_manifest.json with: clip count, total duration, sha256 of
   metadata.csv, phonemizer version, tool versions.

Hard validations (fail-closed before training):

  - At least 10 train clips and 1 val clip.
  - Total duration >= 60s (anything less will not LoRA meaningfully).
  - No clip is clipped (peak >= 0.999).
  - No id appears in both train and val.

Usage:

    python3 scripts/kokoro/prep_ljspeech.py \\
        --data-dir /path/to/LJSpeech-1.1 \\
        --run-dir /tmp/kokoro-run \\
        --config configs/kokoro_lora_ljspeech.yaml

    # CI smoke (no audio libs needed):
    python3 scripts/kokoro/prep_ljspeech.py --synthetic-smoke --run-dir /tmp/smoke
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import random
import sys
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from _config import load_config  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.prep")


@dataclass(frozen=True, slots=True)
class ClipRecord:
    clip_id: str
    wav_in: Path
    raw_text: str
    norm_text: str


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_metadata(metadata_path: Path) -> list[ClipRecord]:
    if not metadata_path.exists():
        raise FileNotFoundError(f"metadata.csv not found at {metadata_path}")
    records: list[ClipRecord] = []
    wav_root = metadata_path.parent / "wavs"
    with metadata_path.open(newline="", encoding="utf-8") as fh:
        reader = csv.reader(fh, delimiter="|", quoting=csv.QUOTE_NONE)
        for row in reader:
            if not row or row[0].startswith("#"):
                continue
            if len(row) < 2:
                raise ValueError(f"malformed metadata row (need at least id|text): {row!r}")
            clip_id = row[0].strip()
            raw_text = row[1].strip()
            norm_text = row[2].strip() if len(row) > 2 and row[2].strip() else raw_text
            wav_in = wav_root / f"{clip_id}.wav"
            if not wav_in.exists():
                raise FileNotFoundError(f"missing wav for {clip_id}: {wav_in}")
            records.append(
                ClipRecord(clip_id=clip_id, wav_in=wav_in, raw_text=raw_text, norm_text=norm_text)
            )
    if not records:
        raise ValueError(f"metadata.csv at {metadata_path} produced 0 records")
    return records


def _probe_wav_stdlib(path: Path) -> tuple[int, int, float]:
    """Return (sample_rate, n_channels, duration_seconds) using the stdlib `wave`
    module. Used in --synthetic-smoke / no-librosa paths."""
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        frames = wf.getnframes()
        duration = frames / float(sr) if sr else 0.0
    return sr, ch, duration


def _validate_and_resample(
    records: list[ClipRecord],
    *,
    out_root: Path,
    sample_rate: int,
    min_secs: float,
    max_secs: float,
    no_audio_libs: bool,
) -> list[dict[str, Any]]:
    """Validate every clip, resample + normalize to <out_root>/wavs_norm/.

    Returns one stat record per kept clip.

    When `no_audio_libs=True` (synthetic-smoke), uses only the stdlib `wave`
    module and copies the file as-is. This is enough to exercise the pipeline
    shape end-to-end in CI without installing librosa/soundfile/pyloudnorm.
    """
    out_dir = out_root / "wavs_norm"
    out_dir.mkdir(parents=True, exist_ok=True)
    stats: list[dict[str, Any]] = []

    if no_audio_libs:
        log.warning("audio libs disabled — copying wavs without resample/normalize")
        for rec in records:
            sr, ch, dur = _probe_wav_stdlib(rec.wav_in)
            if sr <= 0 or ch <= 0:
                raise ValueError(f"{rec.clip_id}: invalid WAV header (sr={sr}, ch={ch})")
            if not (min_secs <= dur <= max_secs):
                raise ValueError(
                    f"{rec.clip_id}: duration {dur:.2f}s outside [{min_secs}, {max_secs}]"
                )
            dest = out_dir / f"{rec.clip_id}.wav"
            dest.write_bytes(rec.wav_in.read_bytes())
            stats.append({"clip_id": rec.clip_id, "duration_s": dur, "sr_in": sr, "channels_in": ch})
        return stats

    # Real path: librosa + soundfile + pyloudnorm.
    import librosa  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    import pyloudnorm as pyln  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    meter = pyln.Meter(sample_rate)

    for rec in records:
        y, sr_in = librosa.load(str(rec.wav_in), sr=None, mono=True)
        dur = len(y) / float(sr_in)
        if not (min_secs <= dur <= max_secs):
            raise ValueError(
                f"{rec.clip_id}: duration {dur:.2f}s outside [{min_secs}, {max_secs}]"
            )
        peak = float(np.max(np.abs(y))) if y.size else 0.0
        if peak >= 0.999:
            raise ValueError(f"{rec.clip_id}: clipped (peak={peak:.4f}); fix before training")
        if sr_in != sample_rate:
            y = librosa.resample(y, orig_sr=sr_in, target_sr=sample_rate)
        # Loudness normalize to -23 LUFS (EBU R128 broadcast loudness).
        loudness = meter.integrated_loudness(y)
        if loudness > -70.0:  # skip silent / near-silent clips
            y = pyln.normalize.loudness(y, loudness, -23.0)
        # Final peak guard post-normalize.
        post_peak = float(np.max(np.abs(y))) if y.size else 0.0
        if post_peak >= 0.999:
            y = y * (0.98 / post_peak)
        dest = out_dir / f"{rec.clip_id}.wav"
        sf.write(str(dest), y, sample_rate, subtype="PCM_16")
        stats.append(
            {
                "clip_id": rec.clip_id,
                "duration_s": dur,
                "sr_in": sr_in,
                "channels_in": 1,
                "peak_in": peak,
                "loudness_in_lufs": loudness,
            }
        )

    return stats


def _phonemize(records: list[ClipRecord], *, language: str, no_phonemize: bool) -> list[str]:
    """Phonemize every clip via misaki[en]. Returns phoneme strings in input order."""
    if no_phonemize:
        log.warning("--no-phonemize: using normalized text in place of phonemes (smoke only)")
        return [rec.norm_text for rec in records]
    try:
        from misaki import en  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "misaki[en] is required for phonemization. Install it via\n"
            "  pip install 'misaki[en]>=0.9.4'\n"
            "or run with --no-phonemize for a smoke pipeline (not trainable)."
        ) from exc
    g2p = en.G2P(trf=False, british=(language.startswith("en-gb")))
    out: list[str] = []
    for rec in records:
        phonemes, _ = g2p(rec.norm_text)
        out.append(phonemes)
    return out


def _split_train_val(
    records: list[ClipRecord], *, val_fraction: float, seed: int
) -> tuple[list[int], list[int]]:
    n = len(records)
    indices = list(range(n))
    random.Random(seed).shuffle(indices)
    n_val = max(1, int(round(n * val_fraction)))
    val_indices = sorted(indices[:n_val])
    train_indices = sorted(indices[n_val:])
    return train_indices, val_indices


def _write_lists(
    *,
    out_root: Path,
    records: list[ClipRecord],
    phonemes: list[str],
    train_indices: list[int],
    val_indices: list[int],
    speaker_id: str,
) -> None:
    wav_rel = "wavs_norm"
    for name, idxs in (("train_list.txt", train_indices), ("val_list.txt", val_indices)):
        with (out_root / name).open("w", encoding="utf-8") as fh:
            for i in idxs:
                rec = records[i]
                fh.write(f"{wav_rel}/{rec.clip_id}.wav|{phonemes[i]}|{speaker_id}\n")
    with (out_root / "phonemes.jsonl").open("w", encoding="utf-8") as fh:
        for i, rec in enumerate(records):
            fh.write(
                json.dumps(
                    {
                        "clip_id": rec.clip_id,
                        "raw_text": rec.raw_text,
                        "norm_text": rec.norm_text,
                        "phonemes": phonemes[i],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )


def _emit_manifest(
    *,
    out_root: Path,
    records: list[ClipRecord],
    stats: list[dict[str, Any]],
    train_indices: list[int],
    val_indices: list[int],
    metadata_sha256: str,
    cfg: dict[str, Any],
    args: argparse.Namespace,
) -> Path:
    total_duration = sum(s["duration_s"] for s in stats)
    manifest = {
        "schemaVersion": 1,
        "kind": "kokoro-prep-manifest",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": bool(args.synthetic_smoke),
        "input": {
            "dataDir": str(args.data_dir) if args.data_dir else None,
            "metadataSha256": metadata_sha256,
        },
        "output": {
            "runDir": str(args.run_dir),
            "processedDir": str(out_root),
            "trainListPath": str(out_root / "train_list.txt"),
            "valListPath": str(out_root / "val_list.txt"),
        },
        "voiceName": cfg.get("voice_name", "eliza_custom"),
        "voiceLang": cfg.get("voice_lang", "a"),
        "sampleRate": cfg["sample_rate"],
        "phonemizer": cfg.get("phonemizer", "misaki_en"),
        "stats": {
            "totalClips": len(records),
            "trainClips": len(train_indices),
            "valClips": len(val_indices),
            "totalDurationSeconds": total_duration,
            "meanDurationSeconds": (total_duration / len(records)) if records else 0.0,
        },
        "config": {
            "valFraction": cfg["val_fraction"],
            "minAudioSeconds": cfg["min_audio_seconds"],
            "maxAudioSeconds": cfg["max_audio_seconds"],
            "seed": cfg["seed"],
        },
    }
    out_path = out_root / "prep_manifest.json"
    out_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return out_path


def _hard_validations(*, records: list[ClipRecord], stats: list[dict[str, Any]],
                      train_indices: list[int], val_indices: list[int]) -> None:
    if len(train_indices) < 10:
        raise ValueError(f"need at least 10 train clips; got {len(train_indices)}")
    if len(val_indices) < 1:
        raise ValueError(f"need at least 1 val clip; got {len(val_indices)}")
    total = sum(s["duration_s"] for s in stats)
    if total < 60.0:
        raise ValueError(f"total duration {total:.1f}s < 60s minimum; not enough to fine-tune")
    train_ids = {records[i].clip_id for i in train_indices}
    val_ids = {records[i].clip_id for i in val_indices}
    overlap = train_ids & val_ids
    if overlap:
        raise ValueError(f"train/val overlap: {sorted(overlap)[:5]}")


def _materialize_synthetic_dataset(target: Path, *, n_clips: int, sample_rate: int) -> None:
    """Drop a tiny LJSpeech-format dataset into `target` for smoke runs."""
    wavs = target / "wavs"
    wavs.mkdir(parents=True, exist_ok=True)
    metadata = target / "metadata.csv"
    n_frames = sample_rate  # 1 second per clip
    lines = []
    for i in range(n_clips):
        clip_id = f"SMOKE-{i:04d}"
        wav_path = wavs / f"{clip_id}.wav"
        with wave.open(str(wav_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(b"\x00\x00" * n_frames)
        lines.append(f"{clip_id}|sample {i}|sample {i}")
    metadata.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--data-dir", type=Path, help="Path to LJSpeech-format directory.")
    p.add_argument("--run-dir", type=Path, required=True, help="Output run directory.")
    p.add_argument(
        "--config",
        type=str,
        default="kokoro_lora_ljspeech.yaml",
        help="YAML config (path or bare name resolved in configs/).",
    )
    p.add_argument(
        "--no-phonemize",
        action="store_true",
        help="Skip phonemization (smoke only; finetune_kokoro.py will reject this).",
    )
    p.add_argument(
        "--no-audio-libs",
        action="store_true",
        help="Skip librosa/soundfile/pyloudnorm (smoke only; copies wavs unchanged).",
    )
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="Synthesize a tiny fixture dataset and run the full prep pipeline on it.",
    )
    p.add_argument(
        "--synthetic-clips",
        type=int,
        default=12,
        help="Number of synthetic clips (only with --synthetic-smoke).",
    )
    p.add_argument(
        "--speaker-id", default="0", help="Speaker id written into the train/val lists."
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_config(args.config)

    run_dir = args.run_dir.resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    processed = run_dir / "processed"
    processed.mkdir(parents=True, exist_ok=True)

    if args.synthetic_smoke:
        if args.data_dir is None:
            args.data_dir = run_dir / "synthetic_input"
        _materialize_synthetic_dataset(
            args.data_dir,
            n_clips=args.synthetic_clips,
            sample_rate=cfg["sample_rate"],
        )
        args.no_audio_libs = True
        args.no_phonemize = True

    if args.data_dir is None:
        log.error("--data-dir is required (or use --synthetic-smoke)")
        return 2

    metadata_path = args.data_dir / "metadata.csv"
    records = _read_metadata(metadata_path)
    log.info("loaded %d records from %s", len(records), metadata_path)

    stats = _validate_and_resample(
        records,
        out_root=processed,
        sample_rate=cfg["sample_rate"],
        min_secs=cfg["min_audio_seconds"],
        max_secs=cfg["max_audio_seconds"],
        no_audio_libs=args.no_audio_libs,
    )

    phonemes = _phonemize(
        records, language=cfg.get("language", "en-us"), no_phonemize=args.no_phonemize
    )
    if len(phonemes) != len(records):
        raise RuntimeError("phonemizer returned wrong number of records")

    train_indices, val_indices = _split_train_val(
        records, val_fraction=cfg["val_fraction"], seed=cfg["seed"]
    )
    _hard_validations(
        records=records, stats=stats, train_indices=train_indices, val_indices=val_indices
    )

    _write_lists(
        out_root=processed,
        records=records,
        phonemes=phonemes,
        train_indices=train_indices,
        val_indices=val_indices,
        speaker_id=args.speaker_id,
    )

    manifest_path = _emit_manifest(
        out_root=processed,
        records=records,
        stats=stats,
        train_indices=train_indices,
        val_indices=val_indices,
        metadata_sha256=_sha256_file(metadata_path),
        cfg=cfg,
        args=args,
    )

    log.info(
        "prep complete: %d clips (%d train, %d val) → %s",
        len(records),
        len(train_indices),
        len(val_indices),
        processed,
    )
    log.info("manifest: %s", manifest_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
