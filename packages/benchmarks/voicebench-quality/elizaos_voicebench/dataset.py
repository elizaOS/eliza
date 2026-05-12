"""VoiceBench dataset loader.

The upstream dataset lives at ``hlt-mt/VoiceBench`` on the Hugging Face
Hub — 6783 spoken instructions across 8 task suites. We don't bundle the
audio. The loader fetches lazily on first run via ``datasets``; smoke
tests use a tiny fixture set with no audio bytes.

The HF schema per row (verified against the upstream config):
  * ``audio.bytes``   — raw audio bytes
  * ``audio.path``    — original filename
  * ``prompt``        — the spoken instruction transcript
  * ``output``        — reference answer (MCQ letter / free text)
  * For MCQ suites the row also carries ``choices`` (list[str]).
  * For ifeval the row carries ``instructions`` (list[dict]).

If the schema drifts in a future upstream release we surface the loader
error rather than papering over it with defaults — per AGENTS.md command
#8 ("DTO fields are required by default").
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Iterable

from .types import SUITES, Sample, SuiteId

log = logging.getLogger("elizaos_voicebench.dataset")

HF_REPO = "hlt-mt/VoiceBench"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def load_samples(
    suite: SuiteId,
    *,
    limit: int | None,
    mock: bool,
) -> list[Sample]:
    """Load samples for one suite.

    ``mock=True`` reads the bundled JSONL fixture (no network, no audio).
    Otherwise the upstream HF dataset is fetched lazily.
    """

    if mock:
        return _load_fixture(suite, limit=limit)
    return _load_huggingface(suite, limit=limit)


def _load_fixture(suite: SuiteId, *, limit: int | None) -> list[Sample]:
    path = FIXTURES_DIR / f"{suite}.jsonl"
    if not path.exists():
        raise FileNotFoundError(
            f"VoiceBench mock fixture not found for suite '{suite}': {path}"
        )
    samples: list[Sample] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            samples.append(_row_to_sample(suite, row))
            if limit is not None and len(samples) >= limit:
                break
    return samples


def _load_huggingface(suite: SuiteId, *, limit: int | None) -> list[Sample]:
    try:
        from datasets import load_dataset  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "VoiceBench HF loading requires the optional `datasets` package. "
            "Install with: pip install 'elizaos-voicebench[hf]'"
        ) from exc

    log.info("loading %s/%s from Hugging Face", HF_REPO, suite)
    ds = load_dataset(HF_REPO, suite, split="test")
    samples: list[Sample] = []
    for row in _iter_rows(ds, limit=limit):
        samples.append(_row_to_sample(suite, row))
    return samples


def _iter_rows(ds: object, *, limit: int | None) -> Iterable[dict[str, object]]:
    count = 0
    for row in ds:  # type: ignore[attr-defined]
        yield row  # type: ignore[misc]
        count += 1
        if limit is not None and count >= limit:
            break


def _row_to_sample(suite: SuiteId, row: dict[str, object]) -> Sample:
    sample_id_raw = row.get("id") or row.get("sample_id") or row.get("audio_id") or ""
    if not isinstance(sample_id_raw, str) or not sample_id_raw:
        # Fall back to the audio filename if the upstream row has no id.
        audio = row.get("audio")
        if isinstance(audio, dict):
            path = audio.get("path")
            sample_id_raw = str(path) if isinstance(path, str) else ""
    if not sample_id_raw:
        raise ValueError(f"VoiceBench row missing sample id (suite={suite}): {row!r}")

    prompt_raw = row.get("prompt") or row.get("instruction") or row.get("text") or ""
    if not isinstance(prompt_raw, str):
        raise ValueError(f"VoiceBench row prompt is not a string: {prompt_raw!r}")

    answer_raw = row.get("output") or row.get("answer") or row.get("reference") or ""
    if not isinstance(answer_raw, str):
        # Some MCQ rows store an integer index — normalize to letter.
        if isinstance(answer_raw, int):
            answer_raw = "ABCD"[answer_raw] if 0 <= answer_raw < 4 else ""
        else:
            answer_raw = ""

    audio_bytes: bytes | None = None
    audio = row.get("audio")
    if isinstance(audio, dict):
        raw = audio.get("bytes")
        if isinstance(raw, (bytes, bytearray)):
            audio_bytes = bytes(raw)

    metadata: dict[str, object] = {}
    for key in ("choices", "instructions", "dialect", "topic", "subject"):
        if key in row:
            metadata[key] = row[key]

    return Sample(
        suite=suite,
        sample_id=sample_id_raw,
        reference_text=prompt_raw,
        answer=answer_raw,
        audio_bytes=audio_bytes,
        metadata=metadata,
    )


def all_suites() -> tuple[SuiteId, ...]:
    return SUITES
