#!/usr/bin/env python3
"""Build the same voice corpus manifest from `lalalune/ai_voices`.

The upstream repo ships clips under `sam/` named `samantha_NNN.wav` —
we land them in `packages/training/data/voice/same/` and rename clip IDs to
`same_NNN` so the canonical name across this repo is `same`.

Lands the same subset into
`packages/training/data/voice/same/` as:

    raw/<id>.wav             # untouched 44.1 kHz mono 16-bit PCM source
    audio/<id>.wav           # normalized 24 kHz mono 16-bit PCM, -23 LUFS
    manifest.jsonl           # one JSON record per clip (tracked)
    ljspeech/metadata.csv    # LJSpeech format: id|raw|normalized (tracked)
    ljspeech/wavs/<id>.wav   # symlinks/copies of normalized audio (ignored)

Re-transcribes every clip with `whisper-large-v3` if available — replaces
the upstream Whisper-base transcripts (which include the
`same_002.txt='641.'` hallucination flagged by R12). Falls back to the
upstream `.txt` when `--no-retranscribe` is passed (smoke / CI without
the whisper stack).

Upstream fetch uses `git clone --filter=blob:none --sparse` so CI only
pulls the same slice (not the full 258 MB repo). Skip the clone with
`--src <local_path>` when a checkout already exists.

Usage:

    # Sparse-clone the same slice + build manifest end-to-end:
    python3 scripts/voice/build_same_manifest.py --sparse-clone /tmp/ai_voices

    # Use an existing clone, write manifest only:
    python3 scripts/voice/build_same_manifest.py \\
        --src /tmp/ai_voices/sam \\
        --dst packages/training/data/voice/same

    # Dry run — validate inputs, emit manifest in memory, do not write
    # normalized audio or ljspeech mirror (still writes manifest.jsonl
    # + source.json + ljspeech/metadata.csv).
    python3 scripts/voice/build_same_manifest.py --src /tmp/ai_voices/sam --dry-run

Exit codes:
    0  success
    1  validation failure (missing files, bad format, drift)
    2  CLI / argument error
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import subprocess
import sys
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("voice.build_same_manifest")

# Hard contract: corpus shape verified by R12 against upstream commit
# c6db5b5dc703e212664a17cf58114f5ecfddc853.
EXPECTED_CLIP_COUNT = 58
EXPECTED_TOTAL_DURATION_RANGE_S = (180.0, 240.0)
EXPECTED_SOURCE_SAMPLE_RATE = 44100
EXPECTED_CHANNELS = 1
EXPECTED_SAMPLE_WIDTH_BYTES = 2
NORMALIZED_SAMPLE_RATE = 24000
NORMALIZED_LUFS = -23.0
UPSTREAM_URL = "https://github.com/lalalune/ai_voices.git"
# Upstream subset directory name in the ai_voices repo. The clips ship as
# `samantha_NNN.wav`; we re-label them as `same_NNN` on landing.
UPSTREAM_SUBSET = "sam"
UPSTREAM_CLIP_PREFIX = "samantha_"
LOCAL_CLIP_PREFIX = "same_"
LOCAL_SUBSET = "same"
HALLUCINATED_TRANSCRIPT = "641."  # R12 §3.5
HALLUCINATED_LOCAL_ID = "same_002"


@dataclass(frozen=True, slots=True)
class ClipProbe:
    clip_id: str  # local id, e.g. "same_001"
    raw_path: Path
    transcript_path: Path
    duration_s: float
    sample_rate: int
    channels: int
    bit_depth: int


def _probe_wav(path: Path) -> tuple[float, int, int, int]:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        bw = wf.getsampwidth()
        nf = wf.getnframes()
    return (nf / sr, sr, ch, bw * 8)


def _git_commit_sha(repo_root: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def sparse_clone(target_dir: Path, *, branch: str | None = None) -> Path:
    """Sparse-clone the same slice of `lalalune/ai_voices`.

    Pulls only `sam/` + `utils/` + `README.md` so CI doesn't fetch
    the full 258 MB repo (ava, c3po, data, hal, smith subsets).
    """
    if target_dir.exists():
        if (target_dir / ".git").exists() and (target_dir / UPSTREAM_SUBSET).exists():
            log.info("sparse_clone: reusing existing clone at %s", target_dir)
            return target_dir
        raise FileExistsError(
            f"{target_dir} exists but is not a sparse ai_voices clone. "
            "Delete it or pass a fresh path."
        )
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    log.info("sparse_clone: cloning %s into %s", UPSTREAM_URL, target_dir)
    clone_cmd = [
        "git",
        "clone",
        "--filter=blob:none",
        "--sparse",
        "--depth",
        "1",
    ]
    if branch:
        clone_cmd += ["--branch", branch]
    clone_cmd += [UPSTREAM_URL, str(target_dir)]
    subprocess.run(clone_cmd, check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(target_dir),
            "sparse-checkout",
            "set",
            UPSTREAM_SUBSET,
            "utils",
            "README.md",
        ],
        check=True,
    )
    return target_dir


def _local_id(upstream_stem: str) -> str:
    """Map upstream `samantha_NNN` → local `same_NNN`."""
    if not upstream_stem.startswith(UPSTREAM_CLIP_PREFIX):
        raise ValueError(f"unexpected upstream stem: {upstream_stem}")
    return LOCAL_CLIP_PREFIX + upstream_stem[len(UPSTREAM_CLIP_PREFIX):]


def collect_clips(src: Path) -> list[ClipProbe]:
    """Validate the upstream sam source directory and return per-clip probes.

    Clips are re-keyed to local IDs (`same_NNN`) in the returned probes; the
    source paths still point at the upstream `samantha_NNN.{wav,txt}` files.
    """
    if not src.is_dir():
        raise FileNotFoundError(f"same source dir not found: {src}")
    wavs = sorted(src.glob(f"{UPSTREAM_CLIP_PREFIX}*.wav"))
    txts = sorted(src.glob(f"{UPSTREAM_CLIP_PREFIX}*.txt"))
    if len(wavs) != EXPECTED_CLIP_COUNT:
        raise ValueError(
            f"expected {EXPECTED_CLIP_COUNT} wavs in {src}, found {len(wavs)}"
        )
    if len(txts) != EXPECTED_CLIP_COUNT:
        raise ValueError(
            f"expected {EXPECTED_CLIP_COUNT} txts in {src}, found {len(txts)}"
        )
    clips: list[ClipProbe] = []
    for wav in wavs:
        txt = wav.with_suffix(".txt")
        if not txt.is_file():
            raise FileNotFoundError(f"missing transcript {txt} for {wav}")
        duration_s, sr, ch, bd = _probe_wav(wav)
        if sr != EXPECTED_SOURCE_SAMPLE_RATE:
            raise ValueError(f"{wav} has sample rate {sr}, expected {EXPECTED_SOURCE_SAMPLE_RATE}")
        if ch != EXPECTED_CHANNELS:
            raise ValueError(f"{wav} has {ch} channels, expected mono")
        if bd != EXPECTED_SAMPLE_WIDTH_BYTES * 8:
            raise ValueError(f"{wav} has bit depth {bd}, expected 16")
        clips.append(
            ClipProbe(
                clip_id=_local_id(wav.stem),
                raw_path=wav,
                transcript_path=txt,
                duration_s=duration_s,
                sample_rate=sr,
                channels=ch,
                bit_depth=bd,
            )
        )
    total = sum(c.duration_s for c in clips)
    lo, hi = EXPECTED_TOTAL_DURATION_RANGE_S
    if not (lo <= total <= hi):
        raise ValueError(
            f"total duration {total:.1f}s out of expected range [{lo}, {hi}]"
        )
    log.info("collect_clips: %d clips, total %.1fs", len(clips), total)
    return clips


def _load_transcript(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def _retranscribe(model: Any, wav_path: Path) -> str:
    """Re-transcribe via whisper-large-v3. Caller owns model lifecycle."""
    result = model.transcribe(str(wav_path), language="en", fp16=False)
    return str(result["text"]).strip()


def _try_load_whisper_large_v3() -> Any | None:
    try:
        import whisper  # type: ignore  # noqa: PLC0415
    except ImportError:
        log.warning(
            "openai-whisper not installed; transcripts will use upstream Whisper-base. "
            "Install `openai-whisper` to re-transcribe with large-v3."
        )
        return None
    log.info("loading whisper-large-v3 (one-time, ~3 GB download on first run)")
    return whisper.load_model("large-v3")


def _copy_raw(clip: ClipProbe, dst_raw: Path) -> Path:
    """Copy upstream raw audio + txt into local raw_dir under the local id."""
    dst_raw.mkdir(parents=True, exist_ok=True)
    out_wav = dst_raw / f"{clip.clip_id}.wav"
    if not out_wav.exists() or out_wav.stat().st_size != clip.raw_path.stat().st_size:
        shutil.copy2(clip.raw_path, out_wav)
    out_txt = dst_raw / f"{clip.clip_id}.txt"
    if not out_txt.exists():
        shutil.copy2(clip.transcript_path, out_txt)
    return out_wav


def _ffmpeg_normalize(src_wav: Path, dst_wav: Path) -> None:
    """Normalize to 24 kHz mono PCM16 at -23 LUFS via ffmpeg."""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg not found; install it or pass --no-normalize to skip"
        )
    dst_wav.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src_wav),
            "-ac",
            str(EXPECTED_CHANNELS),
            "-ar",
            str(NORMALIZED_SAMPLE_RATE),
            "-sample_fmt",
            "s16",
            "-af",
            f"loudnorm=I={NORMALIZED_LUFS}:LRA=7:TP=-2",
            str(dst_wav),
        ],
        check=True,
    )


def _ljspeech_text_normalize(text: str) -> str:
    """LJSpeech-style normalization: collapse whitespace, strip control chars.

    LJSpeech's metadata.csv has three pipe-separated columns: id|raw|normalized.
    Both raw and normalized columns are plain UTF-8 sentences; the only
    difference in upstream is number/abbreviation expansion (which we do not
    perform here — Kokoro's `misaki[en]` phonemizer downstream handles it).
    """
    return " ".join(text.split()).strip()


def build_manifest(
    *,
    src: Path,
    dst: Path,
    clips: list[ClipProbe],
    retranscribe: bool,
    normalize_audio: bool,
    dry_run: bool,
) -> dict[str, Any]:
    """Materialize the corpus directory and return the manifest summary."""
    dst.mkdir(parents=True, exist_ok=True)
    raw_dir = dst / "raw"
    audio_dir = dst / "audio"
    ljspeech_dir = dst / "ljspeech"
    ljspeech_wavs = ljspeech_dir / "wavs"
    manifest_path = dst / "manifest.jsonl"
    ljspeech_csv = ljspeech_dir / "metadata.csv"

    raw_dir.mkdir(exist_ok=True)
    audio_dir.mkdir(exist_ok=True)
    ljspeech_dir.mkdir(exist_ok=True)
    ljspeech_wavs.mkdir(exist_ok=True)

    whisper_model = _try_load_whisper_large_v3() if retranscribe else None

    # Snapshot the upstream commit SHA before mutating anything downstream.
    try:
        commit_sha = _git_commit_sha(src.parent if src.name == UPSTREAM_SUBSET else src)
    except subprocess.CalledProcessError:
        log.warning("could not resolve git commit sha for %s", src)
        commit_sha = "unknown"

    records: list[dict[str, Any]] = []
    ljspeech_rows: list[str] = []
    excluded_ids: list[str] = []

    for clip in clips:
        upstream_text = _load_transcript(clip.transcript_path)
        rewritten_by: str
        if whisper_model is not None:
            new_text = _retranscribe(whisper_model, clip.raw_path)
            if not new_text:
                log.warning(
                    "whisper-large-v3 produced empty transcript for %s — keeping upstream",
                    clip.clip_id,
                )
                final_text = upstream_text
                rewritten_by = "upstream-whisper-base"
            else:
                final_text = new_text
                rewritten_by = "whisper-large-v3"
        else:
            final_text = upstream_text
            rewritten_by = "upstream-whisper-base"

        # Flag and optionally exclude the known hallucination on
        # same_002.wav (R12 §3.5). Once a real model re-transcribes,
        # it's auto-fixed; if we're still on the upstream Whisper-base
        # text, mark the clip excluded so downstream training does not
        # consume garbage.
        excluded = (
            clip.clip_id == HALLUCINATED_LOCAL_ID
            and final_text == HALLUCINATED_TRANSCRIPT
        )
        if excluded:
            excluded_ids.append(clip.clip_id)
            log.warning(
                "EXCLUDING %s: transcript still '%s' (Whisper-base hallucination, "
                "install whisper-large-v3 to re-transcribe)",
                clip.clip_id,
                HALLUCINATED_TRANSCRIPT,
            )

        if not dry_run:
            _copy_raw(clip, raw_dir)
            if normalize_audio:
                _ffmpeg_normalize(clip.raw_path, audio_dir / f"{clip.clip_id}.wav")
                # LJSpeech wavs symlink the normalized audio so
                # `prep_ljspeech.py` consumes 24 kHz input directly.
                lj_wav = ljspeech_wavs / f"{clip.clip_id}.wav"
                if lj_wav.exists() or lj_wav.is_symlink():
                    lj_wav.unlink()
                lj_wav.symlink_to(Path("..") / ".." / "audio" / f"{clip.clip_id}.wav")

        record = {
            "id": clip.clip_id,
            "audio_path": f"audio/{clip.clip_id}.wav",
            "raw_audio_path": f"raw/{clip.clip_id}.wav",
            "transcript": final_text,
            "transcript_source": rewritten_by,
            "duration_s": round(clip.duration_s, 4),
            "sample_rate": NORMALIZED_SAMPLE_RATE if normalize_audio else clip.sample_rate,
            "source_sample_rate": clip.sample_rate,
            "channels": clip.channels,
            "bit_depth": clip.bit_depth,
            "excluded": excluded,
            "source": f"github.com/lalalune/ai_voices@{commit_sha}",
            "subset": LOCAL_SUBSET,
        }
        records.append(record)
        if not excluded:
            norm_text = _ljspeech_text_normalize(final_text)
            ljspeech_rows.append(f"{clip.clip_id}|{final_text}|{norm_text}")

    # Always emit the manifest + ljspeech metadata.csv + source.json — these
    # are tracked artifacts. Audio writes are gated by `dry_run` /
    # `normalize_audio` above.
    manifest_path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False, sort_keys=True) for r in records) + "\n",
        encoding="utf-8",
    )
    ljspeech_csv.write_text("\n".join(ljspeech_rows) + "\n", encoding="utf-8")

    total_duration = sum(c.duration_s for c in clips)
    source_manifest = {
        "url": UPSTREAM_URL,
        "commitSha": commit_sha,
        "subset": LOCAL_SUBSET,
        "upstreamSubset": UPSTREAM_SUBSET,
        "clipCount": len(clips),
        "totalDurationS": round(total_duration, 2),
        "license": (
            "research-only (no upstream LICENSE; same is derivative "
            "of *Her* (2013))"
        ),
        "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "excludedIds": excluded_ids,
        "normalizedSampleRate": NORMALIZED_SAMPLE_RATE,
        "normalizedLufs": NORMALIZED_LUFS,
    }
    (dst / "source.json").write_text(
        json.dumps(source_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    summary = {
        "manifest_path": str(manifest_path),
        "ljspeech_csv_path": str(ljspeech_csv),
        "source_json_path": str(dst / "source.json"),
        "clip_count": len(clips),
        "excluded_ids": excluded_ids,
        "total_duration_s": round(total_duration, 2),
        "commit_sha": commit_sha,
        "dry_run": dry_run,
        "retranscribed": whisper_model is not None,
    }
    log.info("build_manifest: %s", json.dumps(summary, sort_keys=True))
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--src",
        type=Path,
        help="Path to the upstream sam subset (e.g. /tmp/ai_voices/sam). "
        "If omitted, --sparse-clone is required.",
    )
    parser.add_argument(
        "--sparse-clone",
        type=Path,
        help="Sparse-clone ai_voices to this path (filter=blob:none, "
        "sparse=sam+utils+README.md) before building.",
    )
    parser.add_argument(
        "--dst",
        type=Path,
        default=Path(__file__).resolve().parents[2]
        / "data"
        / "voice"
        / "same",
        help="Landing directory (default: packages/training/data/voice/same).",
    )
    parser.add_argument(
        "--no-retranscribe",
        dest="retranscribe",
        action="store_false",
        default=True,
        help="Skip whisper-large-v3 re-transcription; keep upstream "
        "Whisper-base text (CI / smoke).",
    )
    parser.add_argument(
        "--no-normalize",
        dest="normalize_audio",
        action="store_false",
        default=True,
        help="Skip ffmpeg normalization; only copy raw audio and emit manifest.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and emit the manifest in-memory without "
        "writing raw/normalized audio (still writes manifest.jsonl + "
        "source.json + ljspeech/metadata.csv).",
    )
    args = parser.parse_args(argv)

    if args.src is None and args.sparse_clone is None:
        parser.error("either --src or --sparse-clone is required")

    src: Path
    if args.sparse_clone is not None:
        clone_root = sparse_clone(args.sparse_clone)
        src = clone_root / UPSTREAM_SUBSET
    else:
        src = args.src

    clips = collect_clips(src)
    summary = build_manifest(
        src=src,
        dst=args.dst,
        clips=clips,
        retranscribe=args.retranscribe,
        normalize_audio=args.normalize_audio and not args.dry_run,
        dry_run=args.dry_run,
    )
    # Surface summary on stdout for CI consumers.
    sys.stdout.write(json.dumps(summary, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
