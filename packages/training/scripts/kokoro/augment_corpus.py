#!/usr/bin/env python3
"""Acoustic augmentation of the same corpus.

Expands 3.5 min → ~15-20 min via:
  - Time-stretch ×0.9 and ×1.1 (2× clips, same content, different speed)
  - Pitch-shift ±50 cents ≈ ±0.5 semitones (2× clips, same content, small pitch shift)
  - Combined SNR-aware Gaussian noise at 15 dB SNR (1× clips)

Each original clip produces 5 variants total (1 original + 4 augmented).
Augmented clips are labeled with source so eval can split them.

Output directory layout:
  <out_dir>/
    wavs_norm/         24 kHz mono PCM16 WAVs
    train_list.txt     LJSpeech-format lines for real clips + augmented clips
    val_list.txt       LJSpeech-format lines (original only, no augmented)
    augmentation_manifest.jsonl  per-clip metadata
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import soundfile as sf

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.augment_corpus")

SAMPLE_RATE = 24000
TARGET_LUFS = -23.0

# Augmentation variants to apply per clip.
AUGMENT_VARIANTS = [
    {"name": "stretch_slow", "kind": "time_stretch", "rate": 0.9},
    {"name": "stretch_fast", "kind": "time_stretch", "rate": 1.1},
    {"name": "pitch_up", "kind": "pitch_shift", "n_steps": 0.5},
    {"name": "pitch_down", "kind": "pitch_shift", "n_steps": -0.5},
    {"name": "noise_15db", "kind": "noise", "snr_db": 15},
]


def _lufs_normalize(audio: np.ndarray, sr: int, target_lufs: float = TARGET_LUFS) -> np.ndarray:
    """Simple RMS-based loudness normalization (approximation of -23 LUFS)."""
    rms = np.sqrt(np.mean(audio ** 2))
    if rms < 1e-8:
        return audio
    # Convert target LUFS to linear RMS (rough approximation)
    target_rms = 10 ** ((target_lufs + 20) / 20)  # LUFS ≈ dBFS + ~20dB offset
    scale = target_rms / rms
    audio = audio * scale
    # Clip to prevent overflow
    return np.clip(audio, -1.0, 1.0)


def _apply_time_stretch(audio: np.ndarray, rate: float) -> np.ndarray:
    """Rate > 1.0 speeds up, < 1.0 slows down."""
    return librosa.effects.time_stretch(audio, rate=rate)


def _apply_pitch_shift(audio: np.ndarray, sr: int, n_steps: float) -> np.ndarray:
    """n_steps in semitones (0.5 = 50 cents)."""
    return librosa.effects.pitch_shift(audio, sr=sr, n_steps=n_steps)


def _apply_noise(audio: np.ndarray, snr_db: float) -> np.ndarray:
    """Add Gaussian noise at given SNR."""
    signal_rms = np.sqrt(np.mean(audio ** 2))
    if signal_rms < 1e-8:
        return audio
    noise_rms = signal_rms / (10 ** (snr_db / 20))
    noise = np.random.randn(len(audio)) * noise_rms
    return np.clip(audio + noise, -1.0, 1.0)


def _augment_clip(audio: np.ndarray, variant: dict[str, Any]) -> np.ndarray:
    kind = variant["kind"]
    if kind == "time_stretch":
        augmented = _apply_time_stretch(audio, variant["rate"])
    elif kind == "pitch_shift":
        augmented = _apply_pitch_shift(audio, SAMPLE_RATE, variant["n_steps"])
    elif kind == "noise":
        augmented = _apply_noise(audio, variant["snr_db"])
    else:
        raise ValueError(f"unknown augmentation kind: {kind!r}")
    return _lufs_normalize(augmented, SAMPLE_RATE)


def _load_manifest(corpus_dir: Path) -> list[dict[str, Any]]:
    manifest_path = corpus_dir / "manifest.jsonl"
    if not manifest_path.exists():
        raise FileNotFoundError(f"manifest.jsonl not found in {corpus_dir}")
    records = []
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if not rec.get("excluded", False):
            records.append(rec)
    return records


def _normalize_text(text: str) -> str:
    """Lowercase + strip punctuation for LJSpeech format."""
    text = text.lower()
    text = re.sub(r"[^a-z0-9 ''-]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def run_augmentation(
    corpus_dir: Path,
    out_dir: Path,
    val_fraction: float = 0.10,
    seed: int = 1337,
) -> dict[str, Any]:
    random.seed(seed)
    np.random.seed(seed)

    records = _load_manifest(corpus_dir)
    log.info("loaded %d non-excluded clips from manifest", len(records))

    wavs_out = out_dir / "wavs_norm"
    wavs_out.mkdir(parents=True, exist_ok=True)

    aug_manifest: list[dict[str, Any]] = []
    all_lines: list[str] = []

    # Shuffle and split originals for val set
    shuffled = list(records)
    random.shuffle(shuffled)
    n_val = max(1, int(len(shuffled) * val_fraction))
    val_ids = {r["id"] for r in shuffled[:n_val]}
    log.info("val set: %d clips (%s)", n_val, sorted(val_ids))

    total_original_s = 0.0
    total_augmented_s = 0.0

    for rec in records:
        clip_id = rec["id"]
        audio_path = corpus_dir / rec["audio_path"]
        if not audio_path.exists():
            log.warning("missing audio: %s — skipping", audio_path)
            continue

        audio, sr = librosa.load(str(audio_path), sr=SAMPLE_RATE, mono=True)
        audio = _lufs_normalize(audio, SAMPLE_RATE)
        duration_s = len(audio) / SAMPLE_RATE
        total_original_s += duration_s

        transcript = rec.get("transcript", "")
        norm_text = _normalize_text(transcript)

        # Write original clip
        orig_wav = wavs_out / f"{clip_id}.wav"
        sf.write(str(orig_wav), audio, SAMPLE_RATE, subtype="PCM_16")
        line = f"wavs_norm/{clip_id}.wav|{norm_text}|0"
        all_lines.append(line)

        aug_entry: dict[str, Any] = {
            "id": clip_id,
            "source": "original",
            "duration_s": duration_s,
            "transcript": transcript,
            "is_val": clip_id in val_ids,
            "augmented_variants": [],
        }

        # Apply augmentations (only to non-val clips to avoid data leakage)
        if clip_id not in val_ids:
            for variant in AUGMENT_VARIANTS:
                aug_id = f"{clip_id}_{variant['name']}"
                try:
                    aug_audio = _augment_clip(audio, variant)
                except Exception as exc:  # noqa: BLE001
                    log.warning("augmentation %s failed for %s: %s", variant["name"], clip_id, exc)
                    continue

                aug_duration = len(aug_audio) / SAMPLE_RATE
                aug_wav = wavs_out / f"{aug_id}.wav"
                sf.write(str(aug_wav), aug_audio, SAMPLE_RATE, subtype="PCM_16")

                aug_line = f"wavs_norm/{aug_id}.wav|{norm_text}|0"
                all_lines.append(aug_line)

                aug_entry["augmented_variants"].append({
                    "aug_id": aug_id,
                    "kind": variant["kind"],
                    "params": {k: v for k, v in variant.items() if k not in ("name", "kind")},
                    "duration_s": aug_duration,
                })
                total_augmented_s += aug_duration

        aug_manifest.append(aug_entry)

    # Write train/val splits
    val_line_ids = {r["id"] for r in records if r["id"] in val_ids}
    train_lines = [line for line in all_lines if not any(line.startswith(f"wavs_norm/{vid}.wav|") for vid in val_line_ids)]
    val_lines = [line for line in all_lines if any(line.startswith(f"wavs_norm/{vid}.wav|") for vid in val_line_ids)]

    (out_dir / "train_list.txt").write_text("\n".join(train_lines) + "\n", encoding="utf-8")
    (out_dir / "val_list.txt").write_text("\n".join(val_lines) + "\n", encoding="utf-8")

    manifest_path = out_dir / "augmentation_manifest.jsonl"
    with manifest_path.open("w", encoding="utf-8") as fh:
        for entry in aug_manifest:
            fh.write(json.dumps(entry) + "\n")

    total_s = total_original_s + total_augmented_s
    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "originalClips": len(records),
        "originalDurationS": round(total_original_s, 2),
        "augmentedVariants": len(AUGMENT_VARIANTS),
        "totalClips": len(all_lines),
        "totalDurationS": round(total_s, 2),
        "totalDurationMin": round(total_s / 60, 2),
        "trainLines": len(train_lines),
        "valLines": len(val_lines),
        "outDir": str(out_dir),
    }
    (out_dir / "augmentation_summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    log.info(
        "augmentation complete: %d original clips → %d total clips / %.1f min "
        "(original %.1f min + augmented %.1f min)",
        len(records),
        len(all_lines),
        total_s / 60,
        total_original_s / 60,
        total_augmented_s / 60,
    )
    return summary


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--corpus-dir",
        type=Path,
        default=Path("packages/training/data/voice/same"),
        help="Path to same corpus dir with manifest.jsonl + audio/.",
    )
    p.add_argument(
        "--out-dir",
        type=Path,
        required=True,
        help="Output directory for augmented corpus.",
    )
    p.add_argument("--val-fraction", type=float, default=0.10)
    p.add_argument("--seed", type=int, default=1337)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    summary = run_augmentation(
        corpus_dir=args.corpus_dir,
        out_dir=args.out_dir,
        val_fraction=args.val_fraction,
        seed=args.seed,
    )
    log.info("summary: %s", json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
