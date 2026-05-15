"""Tests for the same voice corpus manifest builder.

These tests avoid all heavy deps (ffmpeg, openai-whisper, librosa) and
materialize a synthetic upstream-sam-shaped corpus on disk via the
stdlib `wave` module. They exercise `bsm.main` end-to-end
with `--no-retranscribe --no-normalize --dry-run`, which is the same
code path CI takes.
"""

from __future__ import annotations

import json
import subprocess
import wave
from pathlib import Path

import pytest

from scripts.voice import build_same_manifest as bsm


def _silence_wav(path: Path, duration_s: float = 2.0, sample_rate: int = 44100) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    n_frames = int(round(sample_rate * duration_s))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * n_frames)


def _materialize_upstream_samantha(
    root: Path,
    *,
    count: int = bsm.EXPECTED_CLIP_COUNT,
    hallucinated_002: bool = True,
) -> Path:
    """Build a fake upstream sam/ dir + a parent git repo so commit-sha resolves."""
    root.mkdir(parents=True, exist_ok=True)
    upstream = root / bsm.UPSTREAM_SUBSET
    upstream.mkdir(parents=True, exist_ok=True)
    # Materialize `count` clip pairs. ~3.5 s each → ~58*3.5 = 203 s,
    # inside the [180, 240] s acceptance window.
    for i in range(1, count + 1):
        stem = f"{bsm.UPSTREAM_CLIP_PREFIX}{i:03d}"
        _silence_wav(upstream / f"{stem}.wav", duration_s=3.5)
        # Make samantha_002 the canonical "641." Whisper-base hallucination.
        if i == 2 and hallucinated_002:
            text = bsm.HALLUCINATED_TRANSCRIPT
        else:
            text = f"transcript for {stem}."
        (upstream / f"{stem}.txt").write_text(text, encoding="utf-8")
    # Wrap in a git repo so _git_commit_sha can resolve.
    subprocess.run(
        ["git", "init", "-q", "-b", "main", str(root)],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.name", "test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    subprocess.run(
        ["git", "-C", str(root), "commit", "-q", "-m", "test fixture"],
        check=True,
    )
    return upstream


def test_collect_clips_validates_count_and_shape(tmp_path: Path) -> None:
    src = _materialize_upstream_samantha(tmp_path / "ai_voices")
    clips = bsm.collect_clips(src)
    assert len(clips) == bsm.EXPECTED_CLIP_COUNT
    for c in clips:
        assert c.sample_rate == bsm.EXPECTED_SOURCE_SAMPLE_RATE
        assert c.channels == bsm.EXPECTED_CHANNELS
        assert c.bit_depth == bsm.EXPECTED_SAMPLE_WIDTH_BYTES * 8
        # Clip ids are remapped to the local prefix.
        assert c.clip_id.startswith(bsm.LOCAL_CLIP_PREFIX)


def test_collect_clips_rejects_wrong_count(tmp_path: Path) -> None:
    src = _materialize_upstream_samantha(tmp_path / "ai_voices", count=10)
    with pytest.raises(ValueError, match="expected 58 wavs"):
        bsm.collect_clips(src)


def test_dry_run_emits_manifest_and_excludes_hallucination(tmp_path: Path) -> None:
    src = _materialize_upstream_samantha(tmp_path / "ai_voices")
    dst = tmp_path / "landing"
    rc = bsm.main(
        [
            "--src",
            str(src),
            "--dst",
            str(dst),
            "--no-retranscribe",
            "--no-normalize",
            "--dry-run",
        ]
    )
    assert rc == 0
    manifest_path = dst / "manifest.jsonl"
    source_path = dst / "source.json"
    csv_path = dst / "ljspeech" / "metadata.csv"
    assert manifest_path.exists()
    assert source_path.exists()
    assert csv_path.exists()

    records = [json.loads(line) for line in manifest_path.read_text().splitlines()]
    assert len(records) == bsm.EXPECTED_CLIP_COUNT
    # Every record carries the required schema fields.
    required_fields = {
        "id",
        "audio_path",
        "raw_audio_path",
        "transcript",
        "transcript_source",
        "duration_s",
        "sample_rate",
        "source_sample_rate",
        "channels",
        "bit_depth",
        "excluded",
        "source",
        "subset",
    }
    for r in records:
        missing = required_fields - r.keys()
        assert not missing, f"manifest record missing fields: {missing}"
        assert r["subset"] == bsm.LOCAL_SUBSET
        assert r["source"].startswith("github.com/lalalune/ai_voices@")

    # same_002 must be excluded because the upstream transcript is the
    # known '641.' Whisper-base hallucination.
    s002 = next(r for r in records if r["id"] == bsm.HALLUCINATED_LOCAL_ID)
    assert s002["excluded"] is True
    assert s002["transcript"] == bsm.HALLUCINATED_TRANSCRIPT

    # ljspeech/metadata.csv must skip the excluded clip — 57 rows for 58 clips.
    csv_rows = [ln for ln in csv_path.read_text().splitlines() if ln]
    assert len(csv_rows) == bsm.EXPECTED_CLIP_COUNT - 1
    assert all(not row.startswith(f"{bsm.HALLUCINATED_LOCAL_ID}|") for row in csv_rows)

    # source.json schema.
    source = json.loads(source_path.read_text())
    assert source["url"] == bsm.UPSTREAM_URL
    assert source["subset"] == bsm.LOCAL_SUBSET
    assert source["upstreamSubset"] == bsm.UPSTREAM_SUBSET
    assert source["clipCount"] == bsm.EXPECTED_CLIP_COUNT
    assert bsm.HALLUCINATED_LOCAL_ID in source["excludedIds"]
    assert source["normalizedSampleRate"] == bsm.NORMALIZED_SAMPLE_RATE
    assert source["normalizedLufs"] == bsm.NORMALIZED_LUFS
    # commit sha is a 40-char hex (or 'unknown' if git missing — but our
    # fixture creates a real repo so we should always have a real sha).
    assert len(source["commitSha"]) == 40


def test_no_hallucination_then_no_exclusion(tmp_path: Path) -> None:
    """When upstream transcripts are clean, no clip is excluded."""
    src = _materialize_upstream_samantha(tmp_path / "ai_voices", hallucinated_002=False)
    dst = tmp_path / "landing"
    rc = bsm.main(
        [
            "--src",
            str(src),
            "--dst",
            str(dst),
            "--no-retranscribe",
            "--no-normalize",
            "--dry-run",
        ]
    )
    assert rc == 0
    records = [
        json.loads(line) for line in (dst / "manifest.jsonl").read_text().splitlines()
    ]
    assert all(r["excluded"] is False for r in records)
    source = json.loads((dst / "source.json").read_text())
    assert source["excludedIds"] == []


def test_gitignore_carve_out_tracks_manifest_but_ignores_audio(tmp_path: Path) -> None:
    """Assert the carve-out in packages/training/.gitignore matches the contract.

    Runs `git check-ignore -v` against the live repo (not the test fixture) so
    we exercise the actual `.gitignore` that ships in the tree.
    """
    repo_root = Path(__file__).resolve().parents[4]
    same_root = (
        repo_root
        / "packages"
        / "training"
        / "data"
        / "voice"
        / "same"
    )
    # Tracked artifacts must NOT be ignored. `git check-ignore --no-index`
    # exits 1 when the path is NOT ignored.
    tracked = [
        same_root / "manifest.jsonl",
        same_root / "source.json",
        same_root / "README.md",
        same_root / "ljspeech" / "metadata.csv",
    ]
    for path in tracked:
        rel = path.relative_to(repo_root)
        proc = subprocess.run(
            ["git", "-C", str(repo_root), "check-ignore", "-q", str(rel)],
            check=False,
        )
        assert proc.returncode == 1, (
            f"expected {rel} to NOT be ignored (carve-out missing); "
            f"git check-ignore returned {proc.returncode}"
        )
    # Audio (raw + normalized) MUST be ignored. exit 0 means ignored.
    ignored = [
        same_root / "audio" / "same_001.wav",
        same_root / "raw" / "same_001.wav",
        same_root / "raw" / "same_001.txt",
        same_root / "ljspeech" / "wavs" / "same_001.wav",
    ]
    for path in ignored:
        rel = path.relative_to(repo_root)
        proc = subprocess.run(
            ["git", "-C", str(repo_root), "check-ignore", "-q", str(rel)],
            check=False,
        )
        assert proc.returncode == 0, (
            f"expected {rel} to be ignored by the gitignore stack; "
            f"git check-ignore returned {proc.returncode}"
        )
