#!/usr/bin/env python3
"""Stage the `same` voice from `lalalune/ai_voices` into Kokoro LJSpeech form.

Voice Wave 2 / I7. The upstream corpus is **58 paired `samantha_NNN.{wav,txt}`
files** at 44.1 kHz mono 16-bit, totaling 3.51 minutes of audio. Note that
the upstream subset directory in `lalalune/ai_voices` is named `samantha/`;
we land it locally as `same` (the canonical name in this repo). This script
copies the raw clips and emits the `metadata.csv` + `source.json` artifacts
that `prep_ljspeech.py` and downstream tooling consume.

The wav files themselves are **NOT** committed to the repo — `packages/training/.gitignore`
ignores `data/` globally, and the ai_voices upstream license is research-only
(no LICENSE file, derivative of the 2013 film *Her*). What lives in git is
`source.json` (audit trail) + `metadata.csv` (the LJSpeech transcript index).

Side concern: the upstream transcript `samantha_002.txt = "641."` is a
known Whisper-base hallucination on a 1.37s clip. This script detects it and
either re-transcribes (when `--whisper-model` is passed and `openai-whisper`
is importable) or flags the row in `source.json` so the LoRA training run
can decide whether to drop the clip.

Usage:

    python3 stage_same_corpus.py \\
        --source /tmp/ai_voices/samantha \\
        --out packages/training/data/voice/same \\
        --upstream-sha <git sha of the ai_voices clone>

    # Re-transcribe samantha_002 with whisper-large-v3 (requires GPU + the
    # `openai-whisper` package; falls back to flagging if unavailable):
    python3 stage_same_corpus.py \\
        --source /tmp/ai_voices/samantha \\
        --out packages/training/data/voice/same \\
        --retranscribe-suspicious --whisper-model large-v3

    # CI smoke (no audio dependencies, 3 synthetic clips, validates schema):
    python3 stage_same_corpus.py --synthetic-smoke \\
        --out /tmp/same-smoke
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import shutil
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.stage_same_corpus")

# The Whisper-base hallucination flagged in R12-ai_voices.md §3.5. If the
# upstream transcript for samantha_002 still reads "641." we either re-
# transcribe or record a `suspicious` flag in source.json so downstream can
# drop/handle the clip.
SUSPICIOUS_CLIPS: dict[str, str] = {
    "samantha_002": "641.",
}


def _read_transcript(path: Path) -> str:
    text = path.read_text(encoding="utf-8").strip()
    if "|" in text:
        # The LJSpeech `metadata.csv` is `|`-delimited with QUOTE_NONE
        # (prep_ljspeech.py:96). A literal pipe inside the transcript
        # would corrupt every downstream parser; fail loud rather than
        # silently `.replace("|", "/")`.
        raise ValueError(
            f"transcript {path.name!r} contains a literal '|' character; "
            "this collides with the LJSpeech delimiter — reject and re-transcribe."
        )
    return text


def _retranscribe_with_whisper(wav_path: Path, model_name: str) -> str | None:
    """Best-effort Whisper retranscription. Returns None if unavailable."""
    try:
        import whisper  # type: ignore  # noqa: PLC0415
    except ImportError:
        log.warning(
            "whisper not installed; cannot retranscribe %s (suspicious clip will be flagged)",
            wav_path.name,
        )
        return None
    log.info("retranscribing %s with whisper-%s", wav_path.name, model_name)
    asr = whisper.load_model(model_name)
    result = asr.transcribe(str(wav_path))
    return str(result.get("text", "")).strip() or None


def _probe_wav(path: Path) -> dict[str, Any]:
    """Return basic PCM/WAV metadata via stdlib `wave`."""
    with wave.open(str(path), "rb") as w:
        frames = w.getnframes()
        sr = w.getframerate()
        chans = w.getnchannels()
        sw = w.getsampwidth()
        duration = frames / float(sr) if sr else 0.0
    return {
        "sample_rate": sr,
        "channels": chans,
        "bit_depth": sw * 8,
        "frames": frames,
        "duration_s": round(duration, 4),
    }


def _build_source_record(
    *,
    clip_id: str,
    wav: Path,
    text: str,
    suspicious: bool,
    retranscribed: bool,
) -> dict[str, Any]:
    probe = _probe_wav(wav)
    return {
        "id": clip_id,
        "wav": f"raw/{wav.name}",
        "transcript": text,
        "suspicious": suspicious,
        "retranscribed": retranscribed,
        **probe,
    }


def _stage(args: argparse.Namespace) -> int:
    source = Path(args.source).resolve()
    out_dir = Path(args.out).resolve()
    if not source.is_dir():
        log.error("source dir does not exist: %s", source)
        return 2

    wavs = sorted(p for p in source.glob("samantha_*.wav") if p.is_file())
    if not wavs:
        log.error("no samantha_*.wav files under %s", source)
        return 2

    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    records: list[dict[str, Any]] = []
    metadata_rows: list[tuple[str, str, str]] = []

    for wav in wavs:
        clip_id = wav.stem
        txt = wav.with_suffix(".txt")
        if not txt.is_file():
            log.error("missing transcript for %s", wav.name)
            return 2

        raw_text = _read_transcript(txt)

        # Suspicious transcript handling (Whisper-base hallucination known
        # for samantha_002; defensive on other future ids if added).
        suspicious_baseline = SUSPICIOUS_CLIPS.get(clip_id)
        is_suspicious = suspicious_baseline is not None and raw_text == suspicious_baseline
        retranscribed = False
        text = raw_text
        if is_suspicious and args.retranscribe_suspicious:
            new_text = _retranscribe_with_whisper(wav, args.whisper_model)
            if new_text and new_text != raw_text:
                log.info("retranscribed %s: %r -> %r", clip_id, raw_text, new_text)
                text = new_text
                retranscribed = True
                is_suspicious = False
                # Overwrite the local txt mirror so manifest agrees with corpus.
                (raw_dir / f"{clip_id}.txt").write_text(text + "\n", encoding="utf-8")

        # Copy raw wav + txt (no audio transform — prep_ljspeech.py handles
        # resampling + loudness norm + format checks).
        shutil.copy2(wav, raw_dir / wav.name)
        if not (raw_dir / f"{clip_id}.txt").is_file():
            (raw_dir / f"{clip_id}.txt").write_text(raw_text + "\n", encoding="utf-8")

        record = _build_source_record(
            clip_id=clip_id,
            wav=wav,
            text=text,
            suspicious=is_suspicious,
            retranscribed=retranscribed,
        )
        records.append(record)

        # The third column of metadata.csv is the normalized text; we use
        # the same text for both columns (prep_ljspeech.py falls back to
        # raw_text when normalized is missing, so this is the safest input).
        metadata_rows.append((clip_id, text, text))

    # Write LJSpeech-format metadata.csv. csv.QUOTE_NONE + delim='|' matches
    # prep_ljspeech.py:96 exactly.
    metadata_path = out_dir / "metadata.csv"
    with metadata_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, delimiter="|", quoting=csv.QUOTE_NONE, escapechar="\\")
        for row in metadata_rows:
            writer.writerow(row)

    # `wavs/` is what prep_ljspeech.py expects (`<dataset>/wavs/<id>.wav`).
    # Hard-link from raw/ so the corpus is single-sourced on disk.
    wavs_dir = out_dir / "wavs"
    wavs_dir.mkdir(parents=True, exist_ok=True)
    for record in records:
        src_wav = raw_dir / Path(record["wav"]).name
        dst_wav = wavs_dir / src_wav.name
        if dst_wav.exists() or dst_wav.is_symlink():
            dst_wav.unlink()
        try:
            dst_wav.hardlink_to(src_wav)
        except OSError:
            shutil.copy2(src_wav, dst_wav)

    # Audit trail. R12 spec: `{schemaVersion, kind, upstream, commitSha,
    # clipCount, generatedAt, licenseDeclared}`. We extend with per-clip
    # records (kept tiny — 58 rows total).
    source_record = {
        "schemaVersion": 1,
        "kind": "same-corpus-source",
        "upstream": "https://github.com/lalalune/ai_voices/tree/main/samantha",
        "commitSha": args.upstream_sha or "unknown",
        "clipCount": len(records),
        "totalDurationSeconds": round(sum(r["duration_s"] for r in records), 3),
        "licenseDeclared": "research-only (no LICENSE file upstream; derivative of *Her* 2013)",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "whisperRetranscribeModel": args.whisper_model if args.retranscribe_suspicious else None,
        "clips": records,
    }
    (out_dir / "source.json").write_text(json.dumps(source_record, indent=2) + "\n")

    log.info(
        "staged %d clips into %s (metadata.csv + wavs/ + raw/ + source.json)",
        len(records),
        out_dir,
    )
    suspicious_left = [r["id"] for r in records if r["suspicious"]]
    if suspicious_left:
        log.warning(
            "%d clip(s) flagged as suspicious (re-transcribe before publishing): %s",
            len(suspicious_left),
            ", ".join(suspicious_left),
        )
    return 0


def _run_synthetic_smoke(args: argparse.Namespace) -> int:
    """Materialize a 3-clip synthetic corpus so CI can validate the schema."""
    out_dir = Path(args.out).resolve()
    raw_dir = out_dir / "raw"
    wavs_dir = out_dir / "wavs"
    raw_dir.mkdir(parents=True, exist_ok=True)
    wavs_dir.mkdir(parents=True, exist_ok=True)

    metadata_rows: list[tuple[str, str, str]] = []
    records: list[dict[str, Any]] = []
    for i in range(1, 4):
        clip_id = f"samantha_{i:03d}"
        wav_path = raw_dir / f"{clip_id}.wav"
        # 0.5 s of digital silence at 44.1 kHz mono 16-bit — matches the
        # upstream samantha format and lets the downstream `wave` probe work.
        with wave.open(str(wav_path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(44100)
            w.writeframes(b"\x00\x00" * 22050)
        text = f"synthetic smoke clip {i}"
        (raw_dir / f"{clip_id}.txt").write_text(text + "\n", encoding="utf-8")
        wavs_dst = wavs_dir / f"{clip_id}.wav"
        if wavs_dst.exists():
            wavs_dst.unlink()
        try:
            wavs_dst.hardlink_to(wav_path)
        except OSError:
            shutil.copy2(wav_path, wavs_dst)
        metadata_rows.append((clip_id, text, text))
        records.append(
            _build_source_record(
                clip_id=clip_id,
                wav=wav_path,
                text=text,
                suspicious=False,
                retranscribed=False,
            )
        )

    with (out_dir / "metadata.csv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, delimiter="|", quoting=csv.QUOTE_NONE, escapechar="\\")
        for row in metadata_rows:
            writer.writerow(row)

    (out_dir / "source.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "kind": "same-corpus-source",
                "upstream": "synthetic://smoke",
                "commitSha": "synthetic",
                "clipCount": len(records),
                "totalDurationSeconds": round(sum(r["duration_s"] for r in records), 3),
                "licenseDeclared": "synthetic test fixture",
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "whisperRetranscribeModel": None,
                "synthetic": True,
                "clips": records,
            },
            indent=2,
        )
        + "\n"
    )
    log.info("synthetic-smoke staged 3 clips at %s", out_dir)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument(
        "--source",
        type=Path,
        default=Path("/tmp/ai_voices/samantha"),
        help="Directory containing samantha_NNN.wav + samantha_NNN.txt pairs.",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=Path("packages/training/data/voice/same"),
        help="Destination dataset root (will contain metadata.csv + raw/ + wavs/ + source.json).",
    )
    p.add_argument(
        "--upstream-sha",
        default="",
        help="Git SHA of the ai_voices clone (recorded in source.json for reproducibility).",
    )
    p.add_argument(
        "--retranscribe-suspicious",
        action="store_true",
        help="Re-run Whisper on clips with known hallucinated transcripts (samantha_002).",
    )
    p.add_argument(
        "--whisper-model",
        default="large-v3",
        help="Whisper model identifier for retranscription (default: large-v3).",
    )
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="Emit a 3-clip synthetic corpus for CI without touching the real upstream.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.synthetic_smoke:
        return _run_synthetic_smoke(args)
    return _stage(args)


if __name__ == "__main__":
    raise SystemExit(main())
