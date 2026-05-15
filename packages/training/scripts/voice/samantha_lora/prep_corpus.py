#!/usr/bin/env python3
"""Prepare a Samantha corpus for Kokoro LoRA training.

Pipeline:

  1. Validate the corpus via validate_voice_corpus.py (reuses the helper).
  2. Resample every clip to 24 kHz mono PCM16 under <run-dir>/processed/wavs_norm/.
  3. Phonemize each transcript via misaki[en] (Kokoro's first-party
     phonemizer); fall back to passthrough only with --no-phonemize for
     smoke tests (rejected by train_lora.py).
  4. Run the privacy filter (privacy_filter_trajectories.py) over the
     transcript records BEFORE writing them to disk.
  5. Split 95/5 train/val (configurable via --val-frac, seeded by --seed).
  6. Emit train_list.txt + val_list.txt in the LJSpeech-style format the
     existing finetune_kokoro_full.py + train_lora.py both consume.
  7. Write prep_manifest.json with corpus stats + tool versions + sha256
     of every input file.

Usage:

    python3 prep_corpus.py \\
        --corpus ~/samantha-corpus \\
        --run-dir ~/eliza-training/samantha-lora-baseline

Exit codes:
    0  — prep succeeded; train_lora.py is ready to run.
    1  — pipeline error (validation failure, audio decode error, etc.).
    2  — invocation error.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import os
import random
import shutil
import subprocess
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

# We import the validator helpers directly so the prep + validation paths
# share one source of truth for floors/regexes.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from validate_voice_corpus import _read_transcripts, validate_corpus  # noqa: E402

log = logging.getLogger("samantha_lora.prep_corpus")

KOKORO_SAMPLE_RATE = 24_000
DEFAULT_VAL_FRAC = 0.05
DEFAULT_SEED = 0xE1124
PRIVACY_SCRIPT = (
    HERE.parent.parent.parent / "scripts" / "privacy_filter_trajectories.py"
)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _resample_to_24k(src: Path, dst: Path) -> tuple[int, float]:
    """Resample a WAV to 24 kHz mono PCM16. Returns (samples, duration_s).

    Uses ``soundfile`` + ``librosa`` (already required by the surrounding
    Kokoro scripts in this repo). Raises ImportError early when missing
    so the operator hits a clear ``pip install librosa soundfile`` message
    instead of a cryptic mid-run failure.
    """
    try:
        import librosa
        import numpy as np
        import soundfile as sf
    except ImportError as exc:  # pragma: no cover — exercised by the operator
        raise SystemExit(
            "[prep_corpus] missing audio dependency: install librosa + soundfile "
            "(pip install librosa soundfile)"
        ) from exc

    audio, sr = sf.read(str(src), dtype="float32", always_2d=False)
    if audio.ndim == 2:
        # Defence in depth — validator should have rejected stereo.
        audio = audio.mean(axis=1)
    if sr != KOKORO_SAMPLE_RATE:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=KOKORO_SAMPLE_RATE)
    # Peak-normalize to -3 dBFS to keep downstream loudness predictable.
    peak = float(np.max(np.abs(audio)) or 1.0)
    audio = audio * (10 ** (-3 / 20) / peak)
    audio_pcm = (audio * 32767.0).astype(np.int16)
    dst.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(dst), audio_pcm, KOKORO_SAMPLE_RATE, subtype="PCM_16")
    return int(audio_pcm.size), audio_pcm.size / float(KOKORO_SAMPLE_RATE)


def _phonemize(text: str, *, allow_passthrough: bool) -> str:
    """Phonemize one utterance via misaki[en].

    Misaki is Kokoro's first-party phonemizer (``pip install misaki[en]``).
    When the package is unavailable AND --no-phonemize was passed, the
    text passes through verbatim (smoke tests only — train_lora.py rejects
    any prep_manifest.json that records ``phonemizer=passthrough``).
    """
    try:
        from misaki import en  # type: ignore[import-not-found]
    except ImportError:
        if allow_passthrough:
            log.warning("misaki not installed; passthrough text used (smoke only)")
            return text
        raise SystemExit(
            "[prep_corpus] misaki[en] is required for phonemization; install via "
            "`pip install 'misaki[en]'` or pass --no-phonemize for a smoke run."
        )
    g2p = en.G2P()
    phonemes, _ = g2p(text)
    return phonemes


def _run_privacy_filter(records: list[dict], run_dir: Path) -> list[dict]:
    """Pipe transcript records through privacy_filter_trajectories.py.

    The privacy filter is a mandatory write-path gate (AGENTS.md §7 +
    repo CLAUDE.md). We materialise the records to a temp JSONL, invoke
    the filter as a subprocess, and re-load the filtered output. If the
    filter is missing OR the subprocess fails, we hard-fail — there is no
    "skip privacy" knob here on purpose.
    """
    if not PRIVACY_SCRIPT.is_file():
        raise SystemExit(
            f"[prep_corpus] privacy filter not found at {PRIVACY_SCRIPT} — refusing "
            "to write transcripts without redaction (AGENTS.md §7)."
        )
    tmp_dir = run_dir / "_privacy_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    raw_path = tmp_dir / "raw.jsonl"
    filtered_path = tmp_dir / "filtered.jsonl"
    with raw_path.open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False))
            fh.write("\n")

    cmd = [
        sys.executable,
        str(PRIVACY_SCRIPT),
        "--input",
        str(raw_path),
        "--output",
        str(filtered_path),
        "--source-kind",
        "user_export",
    ]
    log.info("running privacy filter: %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(
            f"[prep_corpus] privacy filter exited {proc.returncode}; refusing to proceed."
        )

    out: list[dict] = []
    with filtered_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            out.append(json.loads(line))
    return out


def _write_split(records: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(
                f"{rec['wav_rel']}|{rec['phonemes']}|{rec['speaker']}\n",
            )


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--val-frac", type=float, default=DEFAULT_VAL_FRAC)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--speaker-id",
        type=str,
        default="samantha",
        help="LJSpeech-list speaker tag. Kept stable across runs so train_lora.py keys consistently.",
    )
    parser.add_argument(
        "--no-phonemize",
        action="store_true",
        help="Smoke-only: skip phonemization. Rejected by train_lora.py downstream.",
    )
    parser.add_argument(
        "--skip-privacy",
        action="store_true",
        help=(
            "DANGEROUS — testing only. Bypasses the privacy filter. Disabled "
            "in production runs by train_lora.py's manifest gate."
        ),
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("LOG_LEVEL", "INFO"),
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    corpus = args.corpus.resolve()
    run_dir = args.run_dir.resolve()
    run_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: validate.
    log.info("validating corpus at %s", corpus)
    report = validate_corpus(corpus)
    if not report.passed:
        sys.stderr.write("[prep_corpus] corpus validation failed:\n")
        for failure in report.failures:
            sys.stderr.write(f"  - {failure}\n")
        return 1

    # Locate transcripts (validator already accepted either layout).
    csv_path = corpus / "transcripts.csv"
    if not csv_path.is_file():
        csv_path = corpus / "metadata.csv"
    rows = _read_transcripts(csv_path)

    # Step 2 + 3 + 4: resample + phonemize + assemble records (privacy
    # filter applied to the assembled records before write).
    processed_dir = run_dir / "processed"
    wavs_out_dir = processed_dir / "wavs_norm"
    records: list[dict] = []
    src_sha: dict[str, str] = {}
    for clip_id, text in rows:
        src = corpus / "wavs" / f"{clip_id}.wav"
        dst = wavs_out_dir / f"{clip_id}.wav"
        samples, duration = _resample_to_24k(src, dst)
        src_sha[clip_id] = _sha256(src)
        phonemes = _phonemize(text, allow_passthrough=args.no_phonemize)
        records.append(
            {
                "id": clip_id,
                "text": text,
                "phonemes": phonemes,
                "wav_rel": f"wavs_norm/{clip_id}.wav",
                "speaker": args.speaker_id,
                "samples": samples,
                "duration_s": duration,
            }
        )

    if args.skip_privacy:
        log.warning(
            "--skip-privacy was passed. The resulting prep_manifest is marked "
            "privacy_filter=skipped; train_lora.py will refuse to consume it."
        )
        privacy_filter_state = "skipped"
    else:
        records = _run_privacy_filter(records, run_dir)
        privacy_filter_state = "applied"

    # Step 5: split.
    rng = random.Random(args.seed)
    shuffled = sorted(records, key=lambda r: r["id"])
    rng.shuffle(shuffled)
    n_val = max(1, int(round(len(shuffled) * args.val_frac)))
    val_records = shuffled[:n_val]
    train_records = shuffled[n_val:]
    if not train_records:
        sys.stderr.write(
            "[prep_corpus] split left no train records; lower --val-frac or add clips.\n"
        )
        return 1

    # Step 6: write splits.
    _write_split(train_records, processed_dir / "train_list.txt")
    _write_split(val_records, processed_dir / "val_list.txt")

    # Phonemes JSONL — the LoRA trainer reads this for human-friendly debug.
    with (processed_dir / "phonemes.jsonl").open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False))
            fh.write("\n")

    # Step 7: manifest.
    total_duration = sum(r["duration_s"] for r in records)
    manifest = {
        "schema": "samantha_lora.prep_manifest.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "corpus_path": str(corpus),
        "run_dir": str(run_dir),
        "speaker_id": args.speaker_id,
        "sample_rate": KOKORO_SAMPLE_RATE,
        "phonemizer": "passthrough" if args.no_phonemize else "misaki",
        "privacy_filter": privacy_filter_state,
        "split": {
            "train": len(train_records),
            "val": len(val_records),
            "val_frac": args.val_frac,
            "seed": args.seed,
        },
        "stats": {
            "clips": len(records),
            "total_duration_s": total_duration,
            "total_duration_min": total_duration / 60.0,
        },
        "src_sha256": src_sha,
    }
    with (processed_dir / "prep_manifest.json").open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    # Clean up the privacy-filter scratch dir (the filter wrote a copy
    # there; the canonical filtered records are already in the records
    # list and emitted via _write_split).
    scratch = run_dir / "_privacy_tmp"
    if scratch.is_dir():
        shutil.rmtree(scratch, ignore_errors=True)

    log.info(
        "prep done: %d clips (%.1fs / %.2f min), train=%d val=%d -> %s",
        len(records),
        total_duration,
        total_duration / 60.0,
        len(train_records),
        len(val_records),
        processed_dir,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
