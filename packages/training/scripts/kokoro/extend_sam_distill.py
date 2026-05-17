#!/usr/bin/env python3
"""L-kokoro-distill — extend the sam-distill OmniVoice teacher corpus.

G3 already synthesized 60 min / 826 clips via OmniVoice "sam" mel-fit
ref_s teacher at packages/training/data/voice/sam-distill/. This script
appends new clips (drawn from a public English-text dataset, currently
`agentlans/high-quality-english-sentences`) so the corpus crosses the
≥1.5 h floor that Kokoro voice adaptation needs (F-kokoro post-mortem,
F2 §"What would actually work").

The script:
  1. Loads existing synthesis_manifest.jsonl + train_list.txt / val_list.txt.
  2. Pulls N additional sentences from the configured HF text dataset
     (cached locally; no audio download).
  3. Synthesizes each via Kokoro KPipeline conditioned on the sam ref_s
     `--voice-bin` (same teacher G3 used) — NOT af_bella.
  4. Appends new clips to wavs_norm/, manifest, train/val lists, summary.

Indexing continues from the highest existing `synth_NNNN.wav`. Existing
clips are never re-rendered.

Usage::

    python3 extend_sam_distill.py \\
        --voice-bin /tmp/kokoro-f2/melfit-5/af_samantha.bin \\
        --out-dir packages/training/data/voice/sam-distill \\
        --target-total-min 95.0 \\
        --text-dataset agentlans/high-quality-english-sentences \\
        --text-cap 1500

`--target-total-min` is the total corpus duration after extension. The
script stops generating once `existing_min + new_min >= target-total-min`
OR text-cap sentences have been consumed.
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import soundfile as sf

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.extend_sam_distill")

SAMPLE_RATE = 24000
TARGET_LUFS = -23.0
MIN_WORDS = 5
MAX_WORDS = 40


def _lufs_normalize(audio: np.ndarray, target_lufs: float = TARGET_LUFS) -> np.ndarray:
    rms = np.sqrt(np.mean(audio**2))
    if rms < 1e-8:
        return audio
    target_rms = 10 ** ((target_lufs + 20) / 20)
    scale = target_rms / rms
    return np.clip(audio * scale, -1.0, 1.0)


def _normalize_text(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9 ''\-]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _good_sentence(s: str) -> bool:
    """Filter out unusable text (too short/long, contains URLs, brackets, etc.)."""
    if not s:
        return False
    s = s.strip()
    n_words = len(s.split())
    if n_words < MIN_WORDS or n_words > MAX_WORDS:
        return False
    if any(c in s for c in ["{", "}", "<", ">", "|", "©", "http", "www.", ".com", "@"]):
        return False
    if re.search(r"[^\x00-\x7f]", s):  # ASCII only
        return False
    if s.count('"') % 2 != 0:
        return False
    # Reject all-caps, mostly-numbers
    alpha = [c for c in s if c.isalpha()]
    if not alpha or sum(c.isupper() for c in alpha) / max(len(alpha), 1) > 0.5:
        return False
    digits = sum(c.isdigit() for c in s)
    if digits / max(len(s), 1) > 0.15:
        return False
    return True


def _load_text_pool(dataset_id: str, cap: int, seed: int) -> list[str]:
    """Stream sentences from a HF text dataset, filter, dedupe."""
    from datasets import load_dataset  # noqa: PLC0415

    log.info("streaming text dataset %s (cap=%d)", dataset_id, cap)
    ds = load_dataset(dataset_id, split="train", streaming=True)

    seen: set[str] = set()
    pool: list[str] = []
    for ex in ds:
        text = ex.get("text") or ex.get("sentence") or ""
        if not _good_sentence(text):
            continue
        if text in seen:
            continue
        seen.add(text)
        pool.append(text.strip())
        if len(pool) >= cap * 3:  # over-collect, we'll shuffle + truncate
            break

    rng = random.Random(seed)
    rng.shuffle(pool)
    return pool[:cap]


def _existing_state(out_dir: Path) -> dict[str, Any]:
    """Inspect prior synthesis state."""
    wavs_dir = out_dir / "wavs_norm"
    manifest_path = out_dir / "synthesis_manifest.jsonl"
    train_path = out_dir / "train_list.txt"
    val_path = out_dir / "val_list.txt"

    existing_manifest: list[dict[str, Any]] = []
    if manifest_path.exists():
        for line in manifest_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                existing_manifest.append(json.loads(line))

    existing_train = (
        [l for l in train_path.read_text(encoding="utf-8").splitlines() if l.strip()]
        if train_path.exists()
        else []
    )
    existing_val = (
        [l for l in val_path.read_text(encoding="utf-8").splitlines() if l.strip()]
        if val_path.exists()
        else []
    )

    max_idx = -1
    if wavs_dir.exists():
        for wav in wavs_dir.glob("synth_*.wav"):
            m = re.match(r"synth_(\d+)\.wav$", wav.name)
            if m:
                max_idx = max(max_idx, int(m.group(1)))

    total_s = sum(float(e.get("duration_s", 0.0)) for e in existing_manifest)

    return {
        "manifest": existing_manifest,
        "train_lines": existing_train,
        "val_lines": existing_val,
        "max_idx": max_idx,
        "total_s": total_s,
    }


def synthesize_extension(
    out_dir: Path,
    voice_bin: Path | None,
    voice_id: str,
    target_total_min: float,
    text_dataset: str,
    text_cap: int,
    val_fraction: float = 0.10,
    seed: int = 4242,
) -> dict[str, Any]:
    from kokoro import KPipeline  # type: ignore  # noqa: PLC0415

    random.seed(seed)
    np.random.seed(seed)

    state = _existing_state(out_dir)
    log.info(
        "existing corpus: %d clips, %.1f min, max_idx=%d",
        len(state["manifest"]),
        state["total_s"] / 60.0,
        state["max_idx"],
    )

    existing_min = state["total_s"] / 60.0
    deficit_min = max(0.0, target_total_min - existing_min)
    if deficit_min <= 0.0:
        log.info(
            "existing %.1f min already exceeds target %.1f min — nothing to do",
            existing_min,
            target_total_min,
        )
        return {"skipped": True, "existing_min": existing_min}

    log.info("need ~%.1f more min to reach %.1f min target", deficit_min, target_total_min)

    # Skip already-synthesized texts (drop duplicates by transcript hash)
    existing_transcripts = {e.get("transcript", "") for e in state["manifest"]}

    text_pool = _load_text_pool(text_dataset, cap=text_cap, seed=seed)
    text_pool = [t for t in text_pool if t not in existing_transcripts]
    log.info("text pool: %d candidates after dedup", len(text_pool))

    log.info("loading KPipeline lang_code=a")
    pipeline = KPipeline(lang_code="a")

    voice: Any = voice_id
    if voice_bin is not None and voice_bin.exists():
        import torch  # noqa: PLC0415

        log.info("teacher: sam mel-fit ref_s from %s (NOT af_bella)", voice_bin)
        arr = np.fromfile(str(voice_bin), dtype="<f4").reshape(510, 1, 256)
        voice = torch.from_numpy(arr)
    else:
        log.info("teacher fallback to stock voice id: %s", voice_id)

    wavs_out = out_dir / "wavs_norm"
    wavs_out.mkdir(parents=True, exist_ok=True)

    next_idx = state["max_idx"] + 1
    new_manifest: list[dict[str, Any]] = []
    new_lines: list[str] = []
    added_s = 0.0
    consumed = 0

    teacher_label = "sam-melfit-ref_s" if (voice_bin is not None and voice_bin.exists()) else voice_id

    for text in text_pool:
        consumed += 1
        if existing_min + (added_s / 60.0) >= target_total_min:
            log.info(
                "target %.1f min reached (%.1f existing + %.1f new)",
                target_total_min,
                existing_min,
                added_s / 60.0,
            )
            break

        clip_id = f"synth_{next_idx:04d}"
        t_start = time.time()

        try:
            audio_chunks = []
            for chunk in pipeline(text, voice=voice):
                if hasattr(chunk, "audio") and chunk.audio is not None:
                    a = chunk.audio
                    if hasattr(a, "numpy"):
                        a = a.numpy()
                    audio_chunks.append(a.astype(np.float32))
            if not audio_chunks:
                log.warning("no audio for %s: %r", clip_id, text[:40])
                next_idx += 1
                continue
            audio = np.concatenate(audio_chunks, axis=-1)
            if audio.ndim > 1:
                audio = audio.squeeze()
            duration_s = len(audio) / SAMPLE_RATE
            if duration_s < 0.5:
                log.warning("too short (%.2fs): %r", duration_s, text[:40])
                next_idx += 1
                continue
            audio = _lufs_normalize(audio)
            wall = time.time() - t_start
            rtf = duration_s / max(wall, 1e-6)
        except Exception as exc:  # noqa: BLE001
            log.warning("synthesis failed for %r: %s", text[:40], exc)
            next_idx += 1
            continue

        wav_path = wavs_out / f"{clip_id}.wav"
        sf.write(str(wav_path), audio, SAMPLE_RATE, subtype="PCM_16")
        norm_text = _normalize_text(text)

        new_lines.append(f"wavs_norm/{clip_id}.wav|{norm_text}|0")
        new_manifest.append(
            {
                "id": clip_id,
                "transcript": text,
                "norm_text": norm_text,
                "duration_s": round(duration_s, 3),
                "rtf": round(rtf, 2),
                "source": "synth-omnivoice-sam-extension",
                "teacher": teacher_label,
                "voice": str(voice_bin) if (voice_bin and voice_bin.exists()) else voice_id,
                "text_dataset": text_dataset,
            }
        )
        added_s += duration_s
        next_idx += 1

        if (consumed % 20) == 0:
            log.info(
                "extended %d clips / +%.1f min (target %.1f min total)",
                len(new_manifest),
                added_s / 60.0,
                target_total_min,
            )

    log.info(
        "extension complete: +%d clips / +%.1f min (consumed %d candidates)",
        len(new_manifest),
        added_s / 60.0,
        consumed,
    )

    # Combine + re-split train/val.
    # Strategy: keep existing val_lines intact (they correspond to clips already
    # written), partition new lines into train/val by the same ratio, append.
    rng = random.Random(seed + 1)
    rng.shuffle(new_lines)
    n_new_val = max(0, int(len(new_lines) * val_fraction))
    new_val = new_lines[:n_new_val]
    new_train = new_lines[n_new_val:]

    combined_train = state["train_lines"] + new_train
    combined_val = state["val_lines"] + new_val

    (out_dir / "train_list.txt").write_text("\n".join(combined_train) + "\n", encoding="utf-8")
    (out_dir / "val_list.txt").write_text("\n".join(combined_val) + "\n", encoding="utf-8")

    # Append to manifest (one JSON object per line — preserves prior history).
    with (out_dir / "synthesis_manifest.jsonl").open("a", encoding="utf-8") as fh:
        for entry in new_manifest:
            fh.write(json.dumps(entry) + "\n")

    combined_clips = len(state["manifest"]) + len(new_manifest)
    combined_s = state["total_s"] + added_s
    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "totalClips": combined_clips,
        "totalDurationS": round(combined_s, 2),
        "totalDurationMin": round(combined_s / 60.0, 2),
        "trainLines": len(combined_train),
        "valLines": len(combined_val),
        "extension": {
            "addedClips": len(new_manifest),
            "addedDurationS": round(added_s, 2),
            "addedDurationMin": round(added_s / 60.0, 2),
            "textDataset": text_dataset,
            "textCap": text_cap,
            "voiceBin": str(voice_bin) if (voice_bin and voice_bin.exists()) else None,
            "voiceId": voice_id,
            "teacher": teacher_label,
        },
        "targetTotalMinutes": target_total_min,
        "outDir": str(out_dir),
        "note": "L-kokoro-distill extension on top of G3's 60-min sam-distill base. Teacher = OmniVoice (Kokoro KPipeline + sam mel-fit ref_s).",
    }
    (out_dir / "synthesis_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--voice-bin", type=Path, default=None,
                   help="Path to sam voice.bin (mel-fit ref_s).")
    p.add_argument("--voice-id", type=str, default="af_heart",
                   help="Fallback stock voice id if voice-bin absent.")
    p.add_argument("--out-dir", type=Path, required=True,
                   help="Existing sam-distill output dir to extend.")
    p.add_argument("--target-total-min", type=float, default=95.0,
                   help="Total corpus duration target in minutes (default 95 = ≥1.5 h with margin).")
    p.add_argument("--text-dataset", type=str, default="agentlans/high-quality-english-sentences",
                   help="HF text dataset (streaming).")
    p.add_argument("--text-cap", type=int, default=1500,
                   help="Max candidate sentences to pull before stopping.")
    p.add_argument("--val-fraction", type=float, default=0.10)
    p.add_argument("--seed", type=int, default=4242)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    summary = synthesize_extension(
        out_dir=args.out_dir,
        voice_bin=args.voice_bin,
        voice_id=args.voice_id,
        target_total_min=args.target_total_min,
        text_dataset=args.text_dataset,
        text_cap=args.text_cap,
        val_fraction=args.val_fraction,
        seed=args.seed,
    )
    log.info("extension summary:\n%s", json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
