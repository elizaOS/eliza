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

from benchmarks.mmau.evaluator import extract_letter_from_option
from benchmarks.mmau.types import (
    MMAU_CATEGORIES,
    MMAUCategory,
    MMAUSample,
    MMAUSplit,
)

logger = logging.getLogger(__name__)

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "smoke.jsonl"


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

        stream = load_dataset(self.hf_repo, split=self.split.value, streaming=True)
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
            attrs.get("id")
            or data.get("id")
            or f"{category.value}_{len(self.samples)}"
        )

        question = str(data.get("instruction") or data.get("question") or "").strip()
        if not question:
            return None

        context = str(data.get("context") or "").strip()
        transcript = str(
            data.get("transcript")
            or attrs.get("transcript")
            or attrs.get("audio_transcript")
            or ""
        ).strip()

        audio_bytes: bytes | None = None
        audio_path: Path | None = None
        audio_field = data.get("audio")
        if isinstance(audio_field, dict):
            raw_bytes = audio_field.get("bytes")
            if isinstance(raw_bytes, (bytes, bytearray)):
                audio_bytes = bytes(raw_bytes)
            raw_path = audio_field.get("path")
            if isinstance(raw_path, str) and raw_path:
                audio_path = Path(raw_path)
        elif isinstance(audio_field, str) and audio_field:
            audio_path = Path(audio_field)

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
            transcript=transcript,
            context=context,
            metadata={k: v for k, v in attrs.items() if _json_safe(v)},
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
