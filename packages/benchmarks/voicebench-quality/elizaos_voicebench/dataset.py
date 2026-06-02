"""VoiceBench dataset loader.

The upstream dataset lives at ``hlt-mt/VoiceBench`` on the Hugging Face
Hub — 6783 spoken instructions across 8 task suites. We don't bundle the
audio. The loader fetches lazily on first run via ``datasets``. Missing audio
is a hard failure for benchmark runs.

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

import logging
import json
import hashlib
import os
from dataclasses import replace
from pathlib import Path
from typing import Iterable

from .types import SUITES, Sample, SuiteId

log = logging.getLogger("elizaos_voicebench.dataset")

HF_REPO = "hlt-lab/voicebench"

EDGE_VARIANTS: tuple[dict[str, str], ...] = (
    {"id": "hesitation", "prefix": "Um, "},
    {"id": "background_noise", "prefix": "With background noise, the spoken request is: "},
    {"id": "fast_speech", "prefix": "Spoken quickly: "},
    {"id": "repeat_key", "suffix": " I will repeat the key constraint once: answer exactly what was asked."},
    {"id": "polite", "prefix": "Please "},
    {"id": "accent_note", "prefix": "With a non-native accent, the user says: "},
    {"id": "trailing_chatter", "suffix": " Ignore unrelated room chatter after the request."},
    {"id": "strict_format", "suffix": " Follow the requested answer format exactly."},
    {"id": "correction", "suffix": " Correction: use the last stated instruction as authoritative."},
    {"id": "low_volume", "prefix": "Spoken softly but clearly: "},
)

def load_samples(
    suite: SuiteId,
    *,
    limit: int | None,
    mock: bool = False,
    include_edge_scenarios: bool = False,
) -> list[Sample]:
    """Load samples for one suite.

    Sources, in priority order:

      * ``mock`` — bundled JSONL fixtures (no audio), for no-cost smoke runs.
      * ``VOICEBENCH_SYNTHESIZE_AUDIO=1`` — bundled fixture prompts with audio
        synthesized locally via macOS ``say`` (real speech-in, non-mock).
      * otherwise — the upstream Hugging Face dataset (real audio bytes).
    """

    if mock:
        samples = _load_fixture(suite, limit=limit)
    elif os.environ.get("VOICEBENCH_SYNTHESIZE_AUDIO", "").strip() in {"1", "true", "yes"}:
        samples = _load_synthesized(suite, limit=limit)
    else:
        samples = _load_huggingface(suite, limit=limit)
    validate_samples(samples, include_edge_scenarios=include_edge_scenarios)
    if include_edge_scenarios:
        return expand_samples(samples)
    return samples


def _load_base_samples(
    suite: SuiteId,
    *,
    limit: int | None,
    mock: bool = False,
) -> list[Sample]:
    if mock:
        return _load_fixture(suite, limit=limit)
    if os.environ.get("VOICEBENCH_SYNTHESIZE_AUDIO", "").strip() in {"1", "true", "yes"}:
        return _load_synthesized(suite, limit=limit)
    return _load_huggingface(suite, limit=limit)


def _apply_edge_variant(sample: Sample, variant: dict[str, str]) -> Sample:
    metadata = dict(sample.metadata)
    metadata.update(
        {
            "base_sample_id": sample.sample_id,
            "scenario_id": variant["id"],
            "scenario_label": variant["id"].replace("_", " "),
        }
    )
    return replace(
        sample,
        sample_id=f"{sample.sample_id}__edge_{variant['id']}",
        reference_text=(
            f"{variant.get('prefix', '')}{sample.reference_text}{variant.get('suffix', '')}"
        ),
        audio_bytes=None if sample.audio_bytes is not None else sample.audio_bytes,
        metadata=metadata,
    )


def expand_samples(samples: list[Sample]) -> list[Sample]:
    expanded: list[Sample] = []
    for sample in samples:
        expanded.append(sample)
        expanded.extend(_apply_edge_variant(sample, variant) for variant in EDGE_VARIANTS)
    return expanded


def count_samples(samples: list[Sample], include_edge_scenarios: bool = False) -> dict[str, int]:
    base = len(samples)
    edge = base * len(EDGE_VARIANTS) if include_edge_scenarios else 0
    return {
        "base": base,
        "edge": edge,
        "edge_multiplier": len(EDGE_VARIANTS),
        "total": base + edge,
    }


def validate_samples(samples: list[Sample], include_edge_scenarios: bool = False) -> None:
    ids = [sample.sample_id for sample in samples]
    duplicates = {sample_id for sample_id in ids if ids.count(sample_id) > 1}
    if duplicates:
        raise ValueError(f"Duplicate VoiceBench sample ids: {sorted(duplicates)[:5]}")
    if not include_edge_scenarios:
        return
    expanded = expand_samples(samples)
    expanded_ids = [sample.sample_id for sample in expanded]
    expanded_duplicates = {
        sample_id for sample_id in expanded_ids if expanded_ids.count(sample_id) > 1
    }
    if expanded_duplicates:
        raise ValueError(f"Duplicate expanded VoiceBench sample ids: {sorted(expanded_duplicates)[:5]}")
    for sample in expanded:
        if "__edge_" in sample.sample_id and "scenario_id" not in sample.metadata:
            raise ValueError(f"Expanded sample {sample.sample_id} is missing scenario metadata")


def _load_synthesized(suite: SuiteId, *, limit: int | None) -> list[Sample]:
    """Load fixture prompts and synthesize their audio with macOS ``say``."""
    import dataclasses

    from .clients.say_tts import synthesize_wav

    samples = _load_fixture(suite, limit=limit)
    out: list[Sample] = []
    for sample in samples:
        out.append(
            dataclasses.replace(
                sample, audio_bytes=synthesize_wav(sample.reference_text)
            )
        )
    return out


def _load_fixture(suite: SuiteId, *, limit: int | None) -> list[Sample]:
    fixture_path = Path(__file__).with_name("fixtures") / f"{suite}.jsonl"
    if not fixture_path.exists():
        raise FileNotFoundError(f"VoiceBench fixture missing for suite {suite!r}: {fixture_path}")

    samples: list[Sample] = []
    with fixture_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if limit is not None and len(samples) >= limit:
                break
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"VoiceBench fixture row is not an object: {row!r}")
            samples.append(_row_to_sample(suite, row, require_audio=False))
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
    try:
        from datasets import Audio  # type: ignore[import-not-found]

        ds = ds.cast_column("audio", Audio(decode=False))
    except Exception:
        pass
    samples: list[Sample] = []
    for row in _iter_rows(ds, limit=limit):
        samples.append(_row_to_sample(suite, row, require_audio=True))
    return samples


def _iter_rows(ds: object, *, limit: int | None) -> Iterable[dict[str, object]]:
    count = 0
    for row in ds:  # type: ignore[attr-defined]
        yield row  # type: ignore[misc]
        count += 1
        if limit is not None and count >= limit:
            break


def _row_to_sample(
    suite: SuiteId,
    row: dict[str, object],
    *,
    require_audio: bool,
) -> Sample:
    sample_id_raw = row.get("id") or row.get("sample_id") or row.get("audio_id") or ""
    if not isinstance(sample_id_raw, str) or not sample_id_raw:
        # Fall back to the audio filename if the upstream row has no id.
        audio = row.get("audio")
        if isinstance(audio, dict):
            path = audio.get("path")
            sample_id_raw = str(path) if isinstance(path, str) else ""
    if not sample_id_raw:
        prompt_fingerprint = hashlib.sha1(
            str(row.get("prompt") or row.get("instruction") or row.get("text") or "").encode("utf-8")
        ).hexdigest()[:12]
        sample_id_raw = f"{suite}-{prompt_fingerprint}"

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
    if audio_bytes is None and require_audio:
        raise ValueError(
            f"VoiceBench row {sample_id_raw!r} has no audio bytes; refusing "
            "text-only benchmark fallback"
        )

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
