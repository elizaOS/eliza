"""Dataset loading for MMAU.

Two sources are supported:

* A bundled JSONL fixture (``fixtures/smoke.jsonl``) for offline / CI runs.
  Each line mirrors the upstream HF record shape so the same parser drives
  both paths.
* Hugging Face streaming via ``datasets.load_dataset``. The canonical IDs
  are ``gamma-lab-umd/MMAU-test-mini`` (1k) and ``gamma-lab-umd/MMAU-test``
  (9k). Streaming keeps memory bounded when only a prefix is consumed.

The 10k audio clips are never bundled with this package -- they're either
fetched from HF (which includes audio as a column) or pulled from the
official ``test-audios`` archive linked from https://github.com/Sakshi113/MMAU.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from elizaos_mmau_audio.evaluator import extract_letter_from_option
from elizaos_mmau_audio.types import (
    MMAU_CATEGORIES,
    MMAUCategory,
    MMAUSample,
    MMAUSplit,
)

logger = logging.getLogger(__name__)

FIXTURE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "smoke.jsonl"


class MMAUDataset:
    """Load MMAU samples from a JSONL fixture or Hugging Face streaming."""

    def __init__(
        self,
        *,
        fixture_path: Path | None = None,
        hf_repo: str = "gamma-lab-umd/MMAU-test-mini",
        split: MMAUSplit = MMAUSplit.TEST_MINI,
        categories: Iterable[MMAUCategory] = MMAU_CATEGORIES,
    ) -> None:
        self.fixture_path = fixture_path or FIXTURE_PATH
        self.hf_repo = hf_repo
        self.split = split
        self.categories = tuple(categories)
        self.samples: list[MMAUSample] = []
        self._loaded = False

    async def load(
        self,
        *,
        use_huggingface: bool = False,
        use_fixture: bool = True,
        max_samples: int | None = None,
    ) -> None:
        if self._loaded:
            return
        if use_huggingface:
            self._load_from_huggingface(max_samples=max_samples)
        elif use_fixture:
            self._load_from_jsonl(self.fixture_path, max_samples=max_samples)
        else:
            logger.warning("No MMAU source selected; falling back to bundled fixture")
            self._load_from_jsonl(FIXTURE_PATH, max_samples=max_samples)
        self._loaded = True
        logger.info("Loaded %d MMAU samples", len(self.samples))

    def _load_from_jsonl(self, path: Path, *, max_samples: int | None) -> None:
        if not path.exists():
            raise FileNotFoundError(f"MMAU fixture not found: {path}")
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                if max_samples is not None and len(self.samples) >= max_samples:
                    break
                line = line.strip()
                if not line:
                    continue
                sample = self._parse_record(json.loads(line))
                if sample and sample.category in self.categories:
                    self.samples.append(sample)

    def _load_from_huggingface(self, *, max_samples: int | None) -> None:
        try:
            from datasets import load_dataset  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(
                "Hugging Face loading requires the optional 'datasets' package. "
                "Install elizaos-mmau[hf] or pass --fixture."
            ) from exc

        stream = load_dataset(self.hf_repo, split=_hf_split_name(self.split), streaming=True)
        try:
            from datasets import Audio  # type: ignore[import-not-found]

            stream = stream.cast_column("context", Audio(decode=False))
        except (ImportError, ValueError, AttributeError):
            logger.debug("Could not cast MMAU context audio column to decode=False")
        for item in stream:
            if max_samples is not None and len(self.samples) >= max_samples:
                break
            sample = self._parse_record(dict(item))
            if sample is None:
                continue
            if sample.category not in self.categories:
                continue
            self.samples.append(sample)

    def _parse_record(self, data: dict[str, Any]) -> MMAUSample | None:
        attrs = data.get("other_attributes")
        if isinstance(attrs, str):
            try:
                attrs = json.loads(attrs)
            except json.JSONDecodeError:
                logger.warning("Skipping MMAU record with malformed other_attributes")
                return None
        if not isinstance(attrs, dict):
            attrs = {}

        raw_choices = data.get("choices")
        if not isinstance(raw_choices, list) or not raw_choices:
            return None
        choices = tuple(str(c) for c in raw_choices)

        raw_answer = data.get("answer")
        if not isinstance(raw_answer, str) or not raw_answer.strip():
            return None
        answer_letter = extract_letter_from_option(raw_answer)
        if not answer_letter:
            for idx, choice in enumerate(choices):
                if choice.strip().lower() == raw_answer.strip().lower():
                    answer_letter = chr(ord("A") + idx)
                    break
        if not answer_letter:
            logger.warning("Skipping MMAU record %r: unparseable answer", data.get("id"))
            return None

        task = str(attrs.get("task") or "").strip().lower()
        try:
            category = MMAUCategory(task)
        except ValueError:
            logger.warning("Skipping MMAU record %r: unknown task=%r", data.get("id"), task)
            return None

        sample_id = str(
            attrs.get("id") or data.get("id") or f"{category.value}_{len(self.samples)}"
        )

        question = str(data.get("instruction") or data.get("question") or "").strip()
        if not question:
            return None

        context = ""
        audio_bytes: bytes | None = None
        audio_path: Path | None = None
        audio_metadata: dict[str, Any] = {}

        raw_context = data.get("context")
        if isinstance(raw_context, str):
            context = raw_context.strip()
        else:
            audio_bytes, audio_path, audio_metadata = _parse_audio_field(raw_context)

        fallback_bytes, fallback_path, fallback_metadata = _parse_audio_field(data.get("audio"))
        if audio_bytes is None:
            audio_bytes = fallback_bytes
        if audio_path is None:
            audio_path = fallback_path
        audio_metadata.update(
            {k: v for k, v in fallback_metadata.items() if k not in audio_metadata}
        )

        return MMAUSample(
            id=sample_id,
            question=question,
            choices=choices,
            answer_letter=answer_letter,
            answer_text=raw_answer.strip(),
            category=category,
            skill=str(attrs.get("sub-category") or attrs.get("sub_category") or "unknown"),
            information_category=str(attrs.get("category") or "unknown"),
            difficulty=str(attrs.get("difficulty") or "unknown"),
            dataset=str(attrs.get("dataset") or "unknown"),
            audio_path=audio_path,
            audio_bytes=audio_bytes,
            context=context,
            metadata={
                **{k: v for k, v in attrs.items() if _json_safe(v)},
                **audio_metadata,
            },
        )

    def get_samples(self, limit: int | None = None) -> list[MMAUSample]:
        if limit is None:
            return list(self.samples)
        return self.samples[:limit]


def _json_safe(value: object) -> bool:
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return False
    return True


def _hf_split_name(split: MMAUSplit) -> str:
    """Map logical MMAU split names to the physical HF split name."""
    return {
        MMAUSplit.TEST_MINI: "test",
        MMAUSplit.TEST: "test",
    }[split]


def _parse_audio_field(value: object) -> tuple[bytes | None, Path | None, dict[str, Any]]:
    metadata: dict[str, Any] = {}
    if isinstance(value, list):
        for item in value:
            audio_bytes, audio_path, item_metadata = _parse_audio_field(item)
            if audio_bytes is not None or audio_path is not None or item_metadata:
                return audio_bytes, audio_path, item_metadata
        return None, None, metadata
    if isinstance(value, dict):
        raw_bytes = value.get("bytes")
        audio_bytes = bytes(raw_bytes) if isinstance(raw_bytes, (bytes, bytearray)) else None
        audio_path = _local_audio_path(value.get("path"))
        raw_src = value.get("src")
        if isinstance(raw_src, str) and raw_src.strip():
            metadata["audio_url"] = raw_src.strip()
        raw_type = value.get("type")
        if isinstance(raw_type, str) and raw_type.strip():
            metadata["audio_mime_type"] = raw_type.strip()
        if audio_path is not None:
            metadata["audio_path"] = str(audio_path)
        return audio_bytes, audio_path, metadata
    if isinstance(value, str) and value.strip():
        audio_path = _local_audio_path(value)
        if audio_path is not None:
            return None, audio_path, {"audio_path": str(audio_path)}
        return None, None, {"audio_url": value.strip()}
    return None, None, metadata


def _local_audio_path(value: object) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.startswith(("http://", "https://")):
        return None
    return Path(raw)
