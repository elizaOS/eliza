"""Drive `stage_same_corpus.py` against a synthetic 3-clip fixture.

The real upstream corpus is 58 clips of human speech we do not redistribute,
so this test materializes a synthetic same-like corpus on disk and runs
the adapter end-to-end.
"""

from __future__ import annotations

import csv
import json
import wave
from pathlib import Path

import stage_same_corpus  # type: ignore  # noqa: E402


def _write_silent_wav(path: Path, *, sample_rate: int = 44100, duration_s: float = 0.5) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    n_frames = int(round(sample_rate * duration_s))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(b"\x00\x00" * n_frames)


def _make_upstream(tmp_path: Path) -> Path:
    """Materialize a /tmp/ai_voices/same-like fixture under tmp_path."""
    src = tmp_path / "upstream-samanthae"
    src.mkdir(parents=True, exist_ok=True)
    transcripts = {
        "samantha_001": "Yeah, I have been trying to figure out how to talk to you.",
        "samantha_002": "641.",  # The known Whisper-base hallucination.
        "samantha_003": "Sounds good.",
    }
    for clip_id, text in transcripts.items():
        _write_silent_wav(src / f"{clip_id}.wav")
        (src / f"{clip_id}.txt").write_text(text + "\n", encoding="utf-8")
    return src


def test_real_path_handles_suspicious_transcript(tmp_path: Path) -> None:
    src = _make_upstream(tmp_path)
    out = tmp_path / "out"
    rc = stage_same_corpus.main(
        [
            "--source",
            str(src),
            "--out",
            str(out),
            "--upstream-sha",
            "abc1234",
        ]
    )
    assert rc == 0

    source = json.loads((out / "source.json").read_text())
    assert source["commitSha"] == "abc1234"
    assert source["clipCount"] == 3
    by_id = {c["id"]: c for c in source["clips"]}
    # samantha_002 should be flagged but NOT retranscribed (no flag passed).
    assert by_id["samantha_002"]["suspicious"] is True
    assert by_id["samantha_002"]["retranscribed"] is False
    # Other clips are not suspicious.
    assert by_id["samantha_001"]["suspicious"] is False
    assert by_id["samantha_003"]["suspicious"] is False

    # metadata.csv carries the suspicious transcript verbatim — staging does
    # not silently drop or rewrite; the source.json flag is the audit trail.
    rows = [
        r
        for r in csv.reader(
            (out / "metadata.csv").open("r", encoding="utf-8"),
            delimiter="|",
            quoting=csv.QUOTE_NONE,
            escapechar="\\",
        )
    ]
    by_csv = {row[0]: row[1] for row in rows}
    assert by_csv["samantha_002"] == "641."

    # `wavs/` hardlinks or copies from `raw/` — Kokoro's prep_ljspeech.py looks
    # at `wavs/<id>.wav`.
    for clip_id in ("samantha_001", "samantha_002", "samantha_003"):
        assert (out / "wavs" / f"{clip_id}.wav").exists()
        assert (out / "raw" / f"{clip_id}.wav").exists()


def test_rejects_pipe_in_transcript(tmp_path: Path) -> None:
    src = tmp_path / "upstream"
    src.mkdir()
    _write_silent_wav(src / "samantha_001.wav")
    # Inject a literal `|` to confirm the adapter refuses to corrupt the
    # LJSpeech format silently.
    (src / "samantha_001.txt").write_text("hello | world\n", encoding="utf-8")

    try:
        rc = stage_same_corpus.main(
            ["--source", str(src), "--out", str(tmp_path / "out")]
        )
    except ValueError as exc:
        assert "|" in str(exc)
    else:
        raise AssertionError(f"expected ValueError, got rc={rc}")
